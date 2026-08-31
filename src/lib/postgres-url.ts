/**
 * Taking TLS decisions away from the connection string.
 *
 * THE DEFECT THIS EXISTS FOR. `db.ts` passes both a connection string and an
 * explicit `ssl` option. The driver does:
 *
 *     config = Object.assign({}, config, parse(config.connectionString))
 *     -- pg/lib/connection-parameters.js
 *
 * The parsed URL is the SECOND argument, so it overwrites what we passed. And
 * the parser sets `config.ssl = {}` whenever the URL carries any of sslmode,
 * sslcert, sslkey or sslrootcert - discarding our CA outright.
 *
 * So a connection string ending `?sslmode=require` silently threw away
 * certificate verification while our own code took the secure branch and
 * logged nothing, and `SECURITY.md` asserted verification was on. A
 * `?sslmode=no-verify` string reproduced the original defect exactly.
 *
 * Both are ordinary: Supabase hands out connection strings carrying
 * `?sslmode=require`, and `no-verify` is the usual paste-in workaround when a
 * pinned certificate makes a handshake fail. Neither should be able to decide
 * how we verify a database certificate - that decision belongs in code, next
 * to the certificate.
 */

/** Everything the driver's parser reads as "let the URL decide about TLS". */
const SSL_PARAMS = ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"];

export interface SanitisedConnectionString {
  readonly connectionString: string;
  /** What was removed, so the caller can say so out loud rather than silently differ. */
  readonly stripped: readonly string[];
}

/**
 * Remove every TLS parameter, so the explicit `ssl` option is the only thing
 * deciding.
 *
 * Stripping rather than honouring is deliberate in both directions. A URL
 * asking for LESS security than we configure must not get it. A URL asking
 * for more cannot be satisfied anyway, because the driver discards our CA
 * while trying.
 *
 * A string that cannot be parsed is returned untouched: refusing to connect
 * because a URL looks unusual would take the application down for a format we
 * simply did not anticipate, and the driver is the better judge of that.
 */
export function sanitiseConnectionString(connectionString: string): SanitisedConnectionString {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString, stripped: [] };
  }

  const stripped: string[] = [];
  for (const param of SSL_PARAMS) {
    if (url.searchParams.has(param)) {
      stripped.push(`${param}=${url.searchParams.get(param) ?? ""}`);
      url.searchParams.delete(param);
    }
  }

  if (stripped.length === 0) return { connectionString, stripped: [] };
  return { connectionString: url.toString(), stripped };
}
