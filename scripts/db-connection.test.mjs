import { describe, expect, it, vi } from "vitest";
import {
  SSL_PARAMS,
  connectionOptions,
  sanitiseConnectionString,
  tlsOptions,
} from "./db-connection.mjs";
import { sanitiseConnectionString as applicationSanitiser } from "../src/lib/postgres-url";

/**
 * The script copies the application's URL sanitiser because the application
 * is TypeScript with path aliases and the script is plain Node. A copy that
 * drifts would let a command-line tool connect with weaker TLS than the
 * application, on the same database. So the two are held to identical
 * behaviour here.
 */
describe("sanitiseConnectionString matches the application's", () => {
  const cases = [
    "postgresql://user:pass@db.example.com:5432/postgres",
    "postgresql://user:pass@db.example.com:5432/postgres?sslmode=require",
    "postgresql://user:pass@db.example.com:5432/postgres?sslmode=no-verify&application_name=x",
    "postgresql://u:p@h/db?sslcert=a&sslkey=b&sslrootcert=c&ssl=true",
    "postgresql://u:p@h/db?keep=me",
    "not a url at all",
  ];

  for (const input of cases) {
    it(`agrees on ${input}`, () => {
      expect(sanitiseConnectionString(input)).toEqual(applicationSanitiser(input));
    });
  }

  it("strips every parameter the driver reads as a TLS decision", () => {
    const url = `postgresql://u:p@h/db?${SSL_PARAMS.map((p) => `${p}=x`).join("&")}&other=1`;
    const result = sanitiseConnectionString(url);
    expect(result.stripped).toEqual(SSL_PARAMS.map((p) => `${p}=x`));
    expect(result.connectionString).toBe("postgresql://u:p@h/db?other=1");
  });
});

describe("tlsOptions", () => {
  it("verifies the chain when a certificate is available, and says nothing", () => {
    const warn = vi.fn();
    expect(tlsOptions("-----BEGIN CERTIFICATE-----", warn)).toEqual({
      ca: "-----BEGIN CERTIFICATE-----",
      rejectUnauthorized: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to unauthenticated TLS without one, and warns loudly", () => {
    const warn = vi.fn();
    expect(tlsOptions(undefined, warn)).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT verified/));
  });

  it("treats a blank certificate as absent", () => {
    const warn = vi.fn();
    expect(tlsOptions("", warn)).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("connectionOptions", () => {
  it("refuses to guess a database when DATABASE_URL is unset", () => {
    expect(() => connectionOptions({}, vi.fn())).toThrow(/DATABASE_URL is not set/);
  });

  it("removes TLS parameters from the URL and reports what it removed", () => {
    const warn = vi.fn();
    const options = connectionOptions(
      { DATABASE_URL: "postgresql://u:p@h/db?sslmode=require", DATABASE_CA_CERT: "cert" },
      warn,
    );
    expect(options.connectionString).toBe("postgresql://u:p@h/db");
    expect(options.ssl).toEqual({ ca: "cert", rejectUnauthorized: true });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sslmode=require/));
  });

  it("never puts the URL itself into a warning", () => {
    const warn = vi.fn();
    connectionOptions({ DATABASE_URL: "postgresql://u:secret@h/db?sslmode=require" }, warn);
    for (const [message] of warn.mock.calls) expect(message).not.toContain("secret");
  });
});
