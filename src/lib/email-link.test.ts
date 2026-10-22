import { describe, expect, it } from "vitest";
import { createManageToken, readManageToken } from "./manage-link";
import { createEmailLinkToken, readEmailLinkToken } from "./email-link";

const SECRET = "s".repeat(32);
const OTHER_SECRET = "t".repeat(32);
const CUSTOMER = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

describe("email links", () => {
  it("reads back the customer a link was made for, for the same purpose", () => {
    for (const purpose of ["confirm", "unsubscribe"] as const) {
      const token = createEmailLinkToken({ purpose, customerId: CUSTOMER }, SECRET);
      expect(readEmailLinkToken(token, purpose, SECRET)).toBe(CUSTOMER);
    }
  });

  it("refuses a link made for the other purpose", () => {
    const confirm = createEmailLinkToken({ purpose: "confirm", customerId: CUSTOMER }, SECRET);
    const unsubscribe = createEmailLinkToken(
      { purpose: "unsubscribe", customerId: CUSTOMER },
      SECRET,
    );
    expect(readEmailLinkToken(confirm, "unsubscribe", SECRET)).toBeNull();
    expect(readEmailLinkToken(unsubscribe, "confirm", SECRET)).toBeNull();
  });

  it("refuses an edited link, a link signed with another secret, and junk", () => {
    const token = createEmailLinkToken({ purpose: "confirm", customerId: CUSTOMER }, SECRET);
    const otherCustomer = token.replace(CUSTOMER, "2b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
    expect(readEmailLinkToken(otherCustomer, "confirm", SECRET)).toBeNull();
    expect(readEmailLinkToken(`${token.slice(0, -1)}A`, "confirm", SECRET)).toBeNull();
    expect(readEmailLinkToken(token, "confirm", OTHER_SECRET)).toBeNull();
    for (const junk of ["", "e1", "e1.confirm.not-a-uuid.sig", `${token}.extra`]) {
      expect(readEmailLinkToken(junk, "confirm", SECRET)).toBeNull();
    }
  });

  it("never reads as a booking link, and a booking link never reads as an email link", () => {
    const email = createEmailLinkToken({ purpose: "confirm", customerId: CUSTOMER }, SECRET);
    const manage = createManageToken(
      { bookingId: CUSTOMER, expiresAt: new Date("2099-01-01T00:00:00Z") },
      SECRET,
    );
    expect(readManageToken(email, new Date("2026-10-22T00:00:00Z"), SECRET)).toBeNull();
    expect(readEmailLinkToken(manage, "confirm", SECRET)).toBeNull();
  });

  it("carries no email address or name, only the customer's random id", () => {
    const token = createEmailLinkToken({ purpose: "unsubscribe", customerId: CUSTOMER }, SECRET);
    expect(token.split(".")).toHaveLength(4);
    expect(token).not.toContain("@");
  });

  it("refuses a short secret rather than signing weakly", () => {
    expect(() =>
      createEmailLinkToken({ purpose: "confirm", customerId: CUSTOMER }, "short"),
    ).toThrow();
    expect(() => readEmailLinkToken("e1.confirm.x.y", "confirm", "short")).toThrow();
  });
});
