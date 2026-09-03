/**
 * How a command-line tool connects to the database.
 *
 * This mirrors `src/lib/postgres-url.ts` and the TLS decision in
 * `src/data/db.ts`, and it is a copy rather than an import because the
 * application modules are TypeScript with path aliases and the scripts are
 * plain Node. A test holds the two sanitisers to the same behaviour, so they
 * cannot drift apart unnoticed.
 *
 * The rule is the same in both places: the connection string does not get to
 * decide how we verify a certificate. The driver lets a parsed URL overwrite
 * the explicit `ssl` option, so `?sslmode=require` - which is what Supabase
 * hands out - would silently discard our CA. Every TLS parameter is removed
 * from the URL, and what was removed is said out loud.
 */

/** Everything the driver's parser reads as "let the URL decide about TLS". */
export const SSL_PARAMS = ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"];

export function sanitiseConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString, stripped: [] };
  }

  const stripped = [];
  for (const param of SSL_PARAMS) {
    if (url.searchParams.has(param)) {
      stripped.push(`${param}=${url.searchParams.get(param) ?? ""}`);
      url.searchParams.delete(param);
    }
  }

  if (stripped.length === 0) return { connectionString, stripped: [] };
  return { connectionString: url.toString(), stripped };
}

/**
 * Verified whenever a certificate is available; encrypted but unauthenticated
 * when it is not, and loudly so. The same choice the application makes, for
 * the same reason - refusing outright would stop the tool working on the
 * one database that most needs migrating.
 */
export function tlsOptions(caCert, warn) {
  if (caCert) return { ca: caCert, rejectUnauthorized: true };
  warn(
    "DATABASE_CA_CERT is not set, so the database certificate chain is NOT verified. " +
      "The connection is encrypted but not authenticated. Set it before any real customer data exists.",
  );
  return { rejectUnauthorized: false };
}

export function connectionOptions(env, warn) {
  const raw = env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL is not set. Put it in .env.local (it is loaded automatically) or in the environment.",
    );
  }

  const sanitised = sanitiseConnectionString(raw);
  if (sanitised.stripped.length > 0) {
    warn(
      `TLS parameters removed from DATABASE_URL (${sanitised.stripped.join(", ")}); ssl is decided in code.`,
    );
  }

  return {
    connectionString: sanitised.connectionString,
    ssl: tlsOptions(env.DATABASE_CA_CERT, warn),
    connectionTimeoutMillis: 15_000,
  };
}
