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
 * A copy of `src/lib/pem.ts`: the certificate rebuilt from a one-line settings
 * box (spaces, no breaks, or literal `\n`), each block in canonical PEM form.
 * A value with no complete block is returned untouched.
 */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

export function normalisePem(value) {
  const unescaped = value.replace(/\\n/g, "\n");
  const blocks = [...unescaped.matchAll(PEM_BLOCK)];
  if (blocks.length === 0) return value;

  return blocks
    .map(([, label, body]) => {
      const base64 = (body ?? "").replace(/\s+/g, "");
      const lines = [];
      for (let start = 0; start < base64.length; start += 64) {
        lines.push(base64.slice(start, start + 64));
      }
      return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join("\n");
    })
    .join("\n");
}

/** A database on this machine, where there is no network path to intercept. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Verified whenever a certificate is available. Without one, the tool refuses
 * any database that is not on this machine (security scan, 2026-09-28): it runs
 * from a laptop, over whatever network the laptop is on, against the live
 * database, and an unauthenticated connection there is the easiest one to
 * intercept. The application refuses the same in production. A database on
 * this machine may still be reached unverified, loudly.
 */
export function tlsOptions(caCert, warn, host) {
  if (caCert) return { ca: normalisePem(caCert), rejectUnauthorized: true };
  if (!LOCAL_HOSTS.has(host ?? "")) {
    throw new Error(
      "DATABASE_CA_CERT is not set, so the database certificate cannot be verified; refusing an " +
        "unauthenticated connection to a database that is not on this machine. Supabase publishes " +
        "the certificate under Project Settings -> Database -> SSL Configuration.",
    );
  }
  warn(
    "DATABASE_CA_CERT is not set, so the database certificate chain is NOT verified. " +
      "The connection is encrypted but not authenticated. Set it before any real customer data exists.",
  );
  return { rejectUnauthorized: false };
}

function hostOf(connectionString) {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
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
    ssl: tlsOptions(env.DATABASE_CA_CERT, warn, hostOf(sanitised.connectionString)),
    connectionTimeoutMillis: 15_000,
  };
}
