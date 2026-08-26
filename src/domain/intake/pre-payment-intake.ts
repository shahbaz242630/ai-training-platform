import { z } from "zod";

/**
 * The intake taken BEFORE payment.
 *
 * Three fields the customer types, plus the timezone their browser reports.
 * Everything else the business wants to know - experience level, tools already
 * used, the real task, and the longer project questions for the advanced
 * sessions - is collected AFTER payment through a tokenised link.
 *
 * That split is deliberate and commercial: every field in front of the payment
 * step costs conversion, and none of the rest is needed in order to take money
 * or hold a slot. Adding a field here is therefore a commercial decision, not
 * a technical one.
 */

/** Long enough for any real answer; short enough that nothing unbounded is stored. */
const MAX_NAME = 100;
const MAX_EMAIL = 254; // the longest address the email standards permit
const MAX_GOAL = 1000;
const MAX_TIMEZONE = 100;

/**
 * Whether the runtime recognises this as a real IANA zone.
 *
 * The value arrives from the browser and is later handed to a date formatter,
 * so it is checked here rather than trusted. `Intl.DateTimeFormat` throws on a
 * zone it does not know, which is the check.
 */
export function isValidTimeZone(value: string): boolean {
  if (value.length > MAX_TIMEZONE) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * `strictObject` matters here, and not only for tidiness: it rejects any key
 * the schema does not name. Without it, a request can carry extra fields that
 * later code spreads into a record - which is how a client ends up setting
 * something it was never meant to, a price or a status among them.
 */
export const prePaymentIntakeSchema = z.strictObject({
  name: z
    .string({ error: "Please enter your name." })
    .trim()
    .min(1, "Please enter your name.")
    .max(MAX_NAME, `Please keep your name under ${MAX_NAME} characters.`),

  email: z
    .string({ error: "Please enter your email address." })
    .trim()
    .toLowerCase()
    .max(MAX_EMAIL, "Please enter a shorter email address.")
    .pipe(z.email("Please enter a valid email address.")),

  primaryGoal: z
    .string({ error: "Please tell us what you want to get out of the session." })
    .trim()
    .min(1, "Please tell us what you want to get out of the session.")
    .max(MAX_GOAL, `Please keep this under ${MAX_GOAL} characters.`),

  /** Derived from the browser, editable by the customer, used to render their times. */
  timezone: z
    .string({ error: "We could not read your time zone. Please choose one." })
    .trim()
    .refine(isValidTimeZone, "We could not read your time zone. Please choose one."),
});

export type PrePaymentIntake = z.infer<typeof prePaymentIntakeSchema>;

export interface IntakeFieldError {
  readonly field: string;
  readonly message: string;
}

export type PrePaymentIntakeResult =
  | { readonly ok: true; readonly value: PrePaymentIntake }
  | { readonly ok: false; readonly errors: readonly IntakeFieldError[] };

/**
 * Validate what a customer submitted.
 *
 * Returns a result rather than throwing: a person mistyping their email is an
 * expected outcome of a form, not an exceptional one, and modelling it as an
 * exception pushes callers towards a catch block that swallows real failures
 * along with it.
 *
 * Every message is written to be shown to the customer as it is. None of them
 * repeats what was submitted, so nothing a customer typed can be reflected
 * back into a page.
 */
export function parsePrePaymentIntake(input: unknown): PrePaymentIntakeResult {
  const result = prePaymentIntakeSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };

  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      field: issue.path.map(String).join(".") || "form",
      message: issue.message,
    })),
  };
}
