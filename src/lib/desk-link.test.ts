import { describe, expect, it } from "vitest";
import { createDeclineToken, readDeclineToken } from "./desk-link";
import { createManageToken, readManageToken } from "./manage-link";

const SECRET = "a-test-secret-that-is-long-enough-000000";
const OTHER = "another-test-secret-long-enough-11111111";
const BOOKING = "3f9a1c2b-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-19T12:00:00Z");
const LATER = new Date("2026-11-03T12:00:00Z");

describe("the desk's decline link", () => {
  it("names its booking until it expires", () => {
    const token = createDeclineToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    expect(readDeclineToken(token, NOW, SECRET)).toBe(BOOKING);
    expect(readDeclineToken(token, LATER, SECRET)).toBeNull();
  });

  it("reads as nothing when edited or signed with another secret", () => {
    const token = createDeclineToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    const other = BOOKING.replace("0001", "0002");
    expect(readDeclineToken(token.replace(BOOKING, other), NOW, SECRET)).toBeNull();
    expect(readDeclineToken(token, NOW, OTHER)).toBeNull();
    expect(readDeclineToken("d1.nonsense", NOW, SECRET)).toBeNull();
  });

  it("cannot be made from a customer's manage link, nor used as one", () => {
    const manage = createManageToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    const decline = createDeclineToken({ bookingId: BOOKING, expiresAt: LATER }, SECRET);
    expect(readDeclineToken(manage, NOW, SECRET)).toBeNull();
    expect(readDeclineToken(manage.replace(/^v1\./, "d1."), NOW, SECRET)).toBeNull();
    expect(readManageToken(decline, NOW, SECRET)).toBeNull();
    expect(readManageToken(decline.replace(/^d1\./, "v1."), NOW, SECRET)).toBeNull();
  });

  it("refuses a short secret", () => {
    expect(() => createDeclineToken({ bookingId: BOOKING, expiresAt: LATER }, "short")).toThrow();
  });
});
