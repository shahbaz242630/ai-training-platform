import { describe, it, expect } from "vitest";
import { authoriseCronRequest } from "./cron-auth";

/**
 * The only thing between a stranger and our job runner.
 *
 * These routes are reachable by anyone who can send an HTTP request, so the
 * test that matters most is the one asserting an UNSET secret refuses
 * everything rather than waving everything through.
 */

const SECRET = "a-long-enough-cron-secret-value";

describe("authoriseCronRequest", () => {
  it("admits the configured secret", () => {
    expect(authoriseCronRequest(`Bearer ${SECRET}`, SECRET)).toBe("authorised");
  });

  /*
    THE one. A deploy that forgets CRON_SECRET must break the job loudly, not
    publish an endpoint anyone can use to expire bookings. Failing closed costs
    a missed sweep; failing open costs control of the job runner.
  */
  it("refuses everything when no secret is configured", () => {
    expect(authoriseCronRequest(`Bearer ${SECRET}`, undefined)).toBe("not_configured");
    expect(authoriseCronRequest("Bearer anything", undefined)).toBe("not_configured");
    expect(authoriseCronRequest(null, undefined)).toBe("not_configured");
  });

  /*
    A blank value is what a `.env` line waiting to be filled in produces. It
    must count as absent, never as a secret that happens to be empty - which
    an empty presented value would then match.
  */
  it("treats a blank configured secret as not configured", () => {
    expect(authoriseCronRequest("Bearer ", "")).toBe("not_configured");
    expect(authoriseCronRequest("Bearer ", "")).not.toBe("authorised");
  });

  it("refuses a wrong secret", () => {
    expect(authoriseCronRequest("Bearer not-the-secret", SECRET)).toBe("unauthorised");
  });

  // A prefix of the real secret must not pass. Length is checked before content.
  it("refuses a secret that is merely a prefix of the real one", () => {
    expect(authoriseCronRequest(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe("unauthorised");
    expect(authoriseCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe("unauthorised");
  });

  it("refuses a missing header", () => {
    expect(authoriseCronRequest(null, SECRET)).toBe("unauthorised");
  });

  it("requires the Bearer scheme rather than a bare value", () => {
    expect(authoriseCronRequest(SECRET, SECRET)).toBe("unauthorised");
    expect(authoriseCronRequest(`Basic ${SECRET}`, SECRET)).toBe("unauthorised");
    // Case matters: the scheme we document is the scheme we accept.
    expect(authoriseCronRequest(`bearer ${SECRET}`, SECRET)).toBe("unauthorised");
  });

  it("does not trim its way into a match", () => {
    expect(authoriseCronRequest(`Bearer  ${SECRET}`, SECRET)).toBe("unauthorised");
    expect(authoriseCronRequest(`Bearer ${SECRET} `, SECRET)).toBe("unauthorised");
  });

  /*
    Multi-byte characters are compared as bytes. Two different strings of the
    same character length can differ in byte length, and the comparison must
    not throw on that - it must simply refuse.
  */
  it("refuses a multi-byte value of the same character length without throwing", () => {
    expect(authoriseCronRequest("Bearer \u00e9\u00e9\u00e9", "abc")).toBe("unauthorised");
  });
});
