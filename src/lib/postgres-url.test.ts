import { describe, it, expect } from "vitest";
import { sanitiseConnectionString } from "./postgres-url";

/**
 * The connection string must not be able to decide how we verify a database
 * certificate.
 *
 * The driver lets a parsed URL overwrite the ssl option passed beside it, and
 * sets ssl to an empty object whenever the URL mentions TLS at all - so
 * `?sslmode=require` silently discarded our CA, and `?sslmode=no-verify`
 * reproduced the original unverified-connection defect while the code took
 * its secure branch and logged nothing.
 */

const BASE = "postgresql://user:pass@db.example:5432/postgres";

describe("sanitiseConnectionString", () => {
  it("leaves a string with no TLS parameters untouched", () => {
    const result = sanitiseConnectionString(BASE);
    expect(result.connectionString).toBe(BASE);
    expect(result.stripped).toEqual([]);
  });

  /*
    THE one. This is what Supabase hands out, and it discarded our CA.
  */
  it("strips sslmode=require, which is what a copied Supabase URL carries", () => {
    const result = sanitiseConnectionString(`${BASE}?sslmode=require`);
    expect(result.connectionString).not.toContain("sslmode");
    expect(result.stripped).toEqual(["sslmode=require"]);
  });

  /*
    And THE dangerous one: the standard paste-in workaround when a pinned
    certificate makes a handshake fail. It reproduced the original defect.
  */
  it("strips sslmode=no-verify, which reproduced the original defect exactly", () => {
    const result = sanitiseConnectionString(`${BASE}?sslmode=no-verify`);
    expect(result.connectionString).not.toContain("sslmode");
  });

  it("strips every TLS parameter the driver reads, not only sslmode", () => {
    const result = sanitiseConnectionString(
      `${BASE}?sslcert=a&sslkey=b&sslrootcert=c&ssl=true&sslmode=require`,
    );
    for (const param of ["sslcert", "sslkey", "sslrootcert", "ssl=", "sslmode"]) {
      expect(result.connectionString, param).not.toContain(param);
    }
    expect(result.stripped).toHaveLength(5);
  });

  // Everything else about the connection has to survive untouched.
  it("keeps the host, credentials, database and non-TLS parameters", () => {
    const result = sanitiseConnectionString(
      `${BASE}?sslmode=require&application_name=booking&connect_timeout=10`,
    );
    expect(result.connectionString).toContain("db.example:5432");
    expect(result.connectionString).toContain("user:pass");
    expect(result.connectionString).toContain("/postgres");
    expect(result.connectionString).toContain("application_name=booking");
    expect(result.connectionString).toContain("connect_timeout=10");
  });

  /*
    Refusing to connect because a URL looks unusual would take the application
    down for a format we simply did not anticipate. The driver is the better
    judge of that, so an unparseable string passes through.
  */
  it("passes an unparseable string through rather than refusing to connect", () => {
    const result = sanitiseConnectionString("not a url at all");
    expect(result.connectionString).toBe("not a url at all");
    expect(result.stripped).toEqual([]);
  });

  it("reports what it removed, so the difference is never silent", () => {
    const result = sanitiseConnectionString(`${BASE}?sslmode=no-verify`);
    expect(result.stripped[0]).toContain("no-verify");
  });
});
