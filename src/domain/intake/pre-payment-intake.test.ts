import { describe, it, expect } from "vitest";
import {
  isValidTimeZone,
  parsePrePaymentIntake,
  type PrePaymentIntakeResult,
} from "./pre-payment-intake";

const valid = {
  name: "A Customer",
  email: "customer@example.com",
  primaryGoal: "Use AI properly for client research instead of guessing.",
  timezone: "Asia/Dubai",
};

const errorsFor = (result: PrePaymentIntakeResult) => (result.ok ? [] : result.errors);
const fieldsIn = (result: PrePaymentIntakeResult) => errorsFor(result).map((error) => error.field);

describe("parsePrePaymentIntake", () => {
  it("accepts the three fields plus a timezone, and nothing else is asked for", () => {
    const result = parsePrePaymentIntake(valid);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(Object.keys(result.value).toSorted()).toEqual([
        "email",
        "name",
        "primaryGoal",
        "timezone",
      ]);
  });

  it("trims whitespace, so a stray space is not stored or shown", () => {
    const result = parsePrePaymentIntake({ ...valid, name: "  A Customer  " });
    expect(result.ok && result.value.name).toBe("A Customer");
  });

  it("lower-cases the email, so the same person is one person", () => {
    const result = parsePrePaymentIntake({ ...valid, email: "  Customer@Example.COM " });
    expect(result.ok && result.value.email).toBe("customer@example.com");
  });

  it("rejects a missing name, email or goal", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, name: "   " }))).toContain("name");
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, primaryGoal: "" }))).toContain("primaryGoal");
    expect(fieldsIn(parsePrePaymentIntake({ email: valid.email }))).toContain("name");
  });

  it("rejects an address that is not an email", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, email: "not-an-email" }))).toContain("email");
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, email: "missing@tld" }))).toContain("email");
  });

  it("rejects fields long enough to be an attack rather than an answer", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, name: "a".repeat(101) }))).toContain("name");
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, primaryGoal: "a".repeat(1001) }))).toContain(
      "primaryGoal",
    );
    const longEmail = `${"a".repeat(250)}@example.com`;
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, email: longEmail }))).toContain("email");
  });

  it("rejects a value that is not a string at all", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, name: 42 }))).toContain("name");
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, email: null }))).toContain("email");
  });

  it("rejects something that is not an object", () => {
    expect(parsePrePaymentIntake("nope").ok).toBe(false);
    expect(parsePrePaymentIntake(null).ok).toBe(false);
    expect(parsePrePaymentIntake(undefined).ok).toBe(false);
  });

  /*
    The important one. Without a strict schema an extra key rides along into
    whatever the handler spreads into a record next - which is how a client
    ends up setting a field it was never offered.
  */
  it("refuses a request carrying fields it was never asked for", () => {
    const result = parsePrePaymentIntake({
      ...valid,
      paymentStatus: "paid",
      grossAmountFils: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("reports every problem at once, not one per submission", () => {
    const result = parsePrePaymentIntake({
      name: "",
      email: "nope",
      primaryGoal: "",
      timezone: "",
    });
    expect(fieldsIn(result).toSorted()).toEqual(["email", "name", "primaryGoal", "timezone"]);
  });

  it("names the field on every error, so a form can show it in the right place", () => {
    for (const error of errorsFor(parsePrePaymentIntake({}))) {
      expect(error.field).not.toBe("");
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  // Messages are shown to a customer as they are, so they must not echo what
  // was submitted back into the page.
  it("never repeats the submitted value in an error message", () => {
    const nasty = "<script>alert(1)</script>";
    const result = parsePrePaymentIntake({ ...valid, email: nasty, name: nasty });
    for (const error of errorsFor(result)) {
      expect(error.message).not.toContain("script");
      expect(error.message).not.toContain(nasty);
    }
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("Asia/Dubai")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("refuses anything the runtime does not recognise", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("../../etc/passwd")).toBe(false);
  });

  it("refuses a value too long to be a zone before asking the runtime about it", () => {
    expect(isValidTimeZone("A".repeat(5000))).toBe(false);
  });

  it("is what the schema uses, so a bad zone fails validation", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, timezone: "Nowhere/Fake" }))).toContain(
      "timezone",
    );
  });
});
