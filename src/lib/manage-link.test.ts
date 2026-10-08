import { describe, expect, it } from "vitest";
import { createManageToken, readManageToken } from "./manage-link";

// A plain run of one letter: long enough for the 32-character minimum, never mistaken for a key.
const SECRET = "x".repeat(40);
const BOOKING = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const NOW = new Date("2026-09-08T09:00:00.000Z");
const LATER = new Date("2026-09-10T15:00:00.000Z");

describe("manage links", () => {
  it("reads back the booking it was made for, until it expires", () => {
    const token = createManageToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    expect(readManageToken(token, NOW, SECRET)).toBe(BOOKING);
  });

  it("refuses a link after its expiry, and exactly at it", () => {
    const token = createManageToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    expect(readManageToken(token, LATER, SECRET)).toBeNull();
  });

  it("refuses a link signed with another secret", () => {
    const token = createManageToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    expect(readManageToken(token, NOW, "y".repeat(40))).toBeNull();
  });

  it("refuses a link whose booking or expiry was edited", () => {
    const token = createManageToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    const [version, , expiry, signature] = token.split(".");
    const otherBooking = "00000000-0000-4000-8000-000000000000";
    expect(
      readManageToken([version, otherBooking, expiry, signature].join("."), NOW, SECRET),
    ).toBeNull();
    const longer = String(Number(expiry) + 86_400);
    expect(
      readManageToken([version, BOOKING, longer, signature].join("."), NOW, SECRET),
    ).toBeNull();
  });

  it("refuses anything that is not a link at all", () => {
    for (const junk of [
      "",
      "x",
      "v1.a.b",
      "v1..1.",
      `v2.${BOOKING}.9999999999.abc`,
      "v1.not-a-uuid.9999999999.abc",
    ]) {
      expect(readManageToken(junk, NOW, SECRET)).toBeNull();
    }
  });

  it("is safe to put in a URL as it is", () => {
    const token = createManageToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("refuses to work with a short secret", () => {
    expect(() => createManageToken({ bookingId: BOOKING, expiresAt: LATER }, "short")).toThrow();
    expect(() => readManageToken("x", NOW, "short")).toThrow();
  });
});
