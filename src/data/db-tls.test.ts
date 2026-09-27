import { describe, it, expect } from "vitest";
import { DatabaseTlsNotConfiguredError, databaseTls } from "./db";

/*
  The database connection carries every customer's name, email, phone and
  intake notes. Without the CA certificate it is encrypted but not
  authenticated: anything on the network path can present any certificate and
  read or rewrite the traffic. The September 2026 security reviews found this
  still allowed in production, with only a log line. It is now refused there.
*/
const CA = "-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----";

describe("databaseTls", () => {
  it("verifies the chain against the configured certificate", () => {
    expect(databaseTls(CA, true)).toEqual({ ca: CA, rejectUnauthorized: true });
    expect(databaseTls(CA, false)).toEqual({ ca: CA, rejectUnauthorized: true });
  });

  it("refuses to connect unauthenticated in production", () => {
    expect(() => databaseTls(undefined, true)).toThrow(DatabaseTlsNotConfiguredError);
    expect(() => databaseTls("", true)).toThrow(/DATABASE_CA_CERT/);
  });

  it("allows an unverified connection only outside production", () => {
    expect(databaseTls(undefined, false)).toEqual({ rejectUnauthorized: false });
  });
});
