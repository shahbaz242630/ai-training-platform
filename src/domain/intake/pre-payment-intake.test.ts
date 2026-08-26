import { describe, it, expect } from "vitest";
import {
  isPlausiblePhone,
  isValidTimeZone,
  parsePrePaymentIntake,
  type PrePaymentIntakeResult,
} from "./pre-payment-intake";

const valid = {
  firstName: "Amina",
  lastName: "Khan",
  email: "customer@example.com",
  phone: "+971 50 123 4567",
  primaryGoal: "Use AI properly for client research instead of guessing.",
  timezone: "Asia/Dubai",
};

const errorsFor = (result: PrePaymentIntakeResult) => (result.ok ? [] : result.errors);

/** A copy without one key, for checking what happens when a field is absent entirely. */
function without<T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}
const fieldsIn = (result: PrePaymentIntakeResult) => errorsFor(result).map((error) => error.field);

describe("parsePrePaymentIntake", () => {
  it("asks for a name, an email, an optional phone and a goal, and nothing else", () => {
    const result = parsePrePaymentIntake(valid);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(Object.keys(result.value).toSorted()).toEqual([
        "email",
        "firstName",
        "lastName",
        "marketingConsent",
        "phone",
        "primaryGoal",
        "timezone",
      ]);
  });

  it("trims whitespace, so a stray space is not stored or shown", () => {
    const result = parsePrePaymentIntake({ ...valid, firstName: "  Amina  " });
    expect(result.ok && result.value.firstName).toBe("Amina");
  });

  it("lower-cases the email, so the same person is one person", () => {
    const result = parsePrePaymentIntake({ ...valid, email: "  Customer@Example.COM " });
    expect(result.ok && result.value.email).toBe("customer@example.com");
  });

  it("rejects a missing first name, last name, email or goal", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, firstName: "   " }))).toContain("firstName");
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, lastName: "" }))).toContain("lastName");
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, primaryGoal: "" }))).toContain("primaryGoal");
    expect(fieldsIn(parsePrePaymentIntake({ email: valid.email }))).toContain("firstName");
  });

  it("rejects an address that is not an email", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, email: "not-an-email" }))).toContain("email");
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, email: "missing@tld" }))).toContain("email");
  });

  it("rejects fields long enough to be an attack rather than an answer", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, firstName: "a".repeat(61) }))).toContain(
      "firstName",
    );
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, primaryGoal: "a".repeat(1001) }))).toContain(
      "primaryGoal",
    );
    const longEmail = `${"a".repeat(250)}@example.com`;
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, email: longEmail }))).toContain("email");
  });

  it("rejects a value that is not a string at all", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, firstName: 42 }))).toContain("firstName");
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
      firstName: "",
      lastName: "",
      email: "nope",
      primaryGoal: "",
      timezone: "",
    });
    expect(fieldsIn(result).toSorted()).toEqual([
      "email",
      "firstName",
      "lastName",
      "primaryGoal",
      "timezone",
    ]);
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
    const result = parsePrePaymentIntake({ ...valid, email: nasty, firstName: nasty });
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

describe("phone", () => {
  it("is optional - absent, empty and whitespace all mean not given", () => {
    for (const phone of [undefined, "", "   "]) {
      const result = parsePrePaymentIntake({ ...valid, phone });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.phone).toBeNull();
    }
  });

  it("is null rather than missing when not given, so storage has one shape", () => {
    const result = parsePrePaymentIntake(without(valid, "phone"));
    expect(result.ok && result.value.phone).toBeNull();
  });

  /*
    Deliberately permissive. International numbers vary far more than any tidy
    pattern allows, and rejecting a real number costs a lead outright while
    accepting an odd one costs nothing - the field is optional and nothing
    automated depends on it yet.
  */
  it("accepts the shapes real people actually type", () => {
    for (const phone of [
      "+971 50 123 4567",
      "+44 7700 900123",
      "050 123 4567",
      "(050) 123-4567",
      "+9715012345678",
      "0501234567",
    ]) {
      expect(parsePrePaymentIntake({ ...valid, phone }).ok).toBe(true);
    }
  });

  it("refuses something that is not a phone number at all", () => {
    for (const phone of ["not a number", "12345", "+", "<script>alert(1)</script>"]) {
      expect(fieldsIn(parsePrePaymentIntake({ ...valid, phone }))).toContain("phone");
    }
  });

  it("refuses one long enough to be an attack rather than a number", () => {
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, phone: "1".repeat(40) }))).toContain("phone");
  });
});

describe("isPlausiblePhone", () => {
  it("wants enough digits to be a number", () => {
    expect(isPlausiblePhone("123456")).toBe(true);
    expect(isPlausiblePhone("12345")).toBe(false);
  });

  it("allows the punctuation people type and nothing else", () => {
    expect(isPlausiblePhone("+971 (50) 123-4567")).toBe(true);
    expect(isPlausiblePhone("0501234567 ext 9")).toBe(false);
  });
});

describe("marketing consent", () => {
  /*
    The legal distinction this field exists for: emails about a session
    somebody paid for are transactional and need no consent, while offers sent
    later are marketing and do. Defaulting to false means the safe state is the
    one you get by forgetting.
  */
  it("defaults to false when nobody said anything", () => {
    const result = parsePrePaymentIntake(
      without({ ...valid, marketingConsent: true }, "marketingConsent"),
    );
    expect(result.ok && result.value.marketingConsent).toBe(false);
  });

  it("is only true when it was deliberately set", () => {
    expect(parsePrePaymentIntake({ ...valid, marketingConsent: true }).ok).toBe(true);
    const opted = parsePrePaymentIntake({ ...valid, marketingConsent: true });
    expect(opted.ok && opted.value.marketingConsent).toBe(true);

    const declined = parsePrePaymentIntake({ ...valid, marketingConsent: false });
    expect(declined.ok && declined.value.marketingConsent).toBe(false);
  });

  it("refuses a value that is not a yes or a no", () => {
    // "on" from a raw checkbox, or "false" as a string, must not become true.
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, marketingConsent: "on" }))).toContain(
      "marketingConsent",
    );
    expect(fieldsIn(parsePrePaymentIntake({ ...valid, marketingConsent: "false" }))).toContain(
      "marketingConsent",
    );
  });
});
