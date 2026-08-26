import { Pool } from "pg";
import { serverEnv } from "@/lib/env";

/**
 * The database connection.
 *
 * A plain Postgres client rather than the Supabase SDK, for one decisive
 * reason: the SDK talks to PostgREST over HTTP and cannot run a
 * multi-statement transaction. A booking has to create an order AND its
 * bookings AND convert the slot hold, or do none of it - and a half-applied
 * booking is a customer charged for a session that does not exist. Everything
 * else follows: we use no Supabase auth, storage or realtime, and moving to
 * any other Postgres host stays a connection-string change.
 */

/**
 * Anything that can run a parameterised query. Deliberately the shape both the
 * real driver and an in-process Postgres satisfy, so the SAME repository code
 * that runs in production is what the tests exercise - against real SQL and
 * the real migrations, rather than a mock that agrees with whatever we wrote.
 */
export interface QueryRunner {
  query<Row>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not set, so no database connection can be made");
    this.name = "DatabaseNotConfiguredError";
  }
}

/*
  Next reloads modules on every change in development, and a new pool per
  reload exhausts the connection limit within minutes. Caching on globalThis is
  the documented way to survive that; in production the module is evaluated
  once and this is simply a module-level singleton.
*/
const globalForPool = globalThis as typeof globalThis & { bookingPool?: Pool };

export function getPool(): Pool {
  if (globalForPool.bookingPool) return globalForPool.bookingPool;

  // serverEnv() is lazy and refuses to run in a client bundle, so importing
  // this module from the wrong place fails loudly rather than shipping a
  // connection string to a browser.
  const connectionString = serverEnv().DATABASE_URL;
  // Asserted at the point of use rather than at startup, so the application
  // still boots without a database - and so a missing value fails loudly here
  // instead of becoming `undefined` somewhere inside a query.
  if (!connectionString) throw new DatabaseNotConfiguredError();

  const pool = new Pool({
    connectionString,
    // Supabase terminates TLS with a certificate chain Node does not ship a
    // root for. The connection is still encrypted; what is skipped is chain
    // verification. Revisit if the host publishes a bundle we can pin.
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  globalForPool.bookingPool = pool;
  return pool;
}

/** Run a set of statements so that either all of them apply, or none do. */
export async function withTransaction<T>(
  work: (runner: QueryRunner) => Promise<T>,
  pool: Pool = getPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
