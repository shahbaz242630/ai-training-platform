import { describe, expect, it } from "vitest";
import { withdrawalFormSchema } from "./flow";

/*
  The name on the withdrawal form is printed in the acknowledgement email sent
  from the booking desk, so it follows the same rule as the booking form's
  names (security audit, 2026-10-17): no links, markup or invisible tricks.
*/
const form = {
  fullName: "Amina Khan",
  email: "customer@example.com",
  reference: "AB12CD34",
  consumer: true as const,
};

describe("withdrawal form name", () => {
  it("accepts a real name", () => {
    expect(withdrawalFormSchema.safeParse(form).success).toBe(true);
    expect(withdrawalFormSchema.safeParse({ ...form, fullName: "محمد بن راشد" }).success).toBe(
      true,
    );
  });

  it("refuses a link, markup or a direction override in the name", () => {
    for (const fullName of [
      "Visit www.pay-here.example",
      "https://pay-here.example",
      "<b>Amina</b>",
      "Amina‮moc.live",
    ]) {
      expect(withdrawalFormSchema.safeParse({ ...form, fullName }).success, fullName).toBe(false);
    }
  });
});

/*
  The form is only for the UK and EU statutory right. Somebody elsewhere who
  leaves the box unticked is told what they can do instead, not just refused
  (founder, session 100: a UAE customer was left with nowhere to go).
*/
describe("withdrawal form residence", () => {
  it("tells somebody outside the UK and EU what they can do instead", () => {
    const result = withdrawalFormSchema.safeParse({ ...form, consumer: false });
    expect(result.success).toBe(false);
    const message = result.error?.issues.find((issue) => issue.path[0] === "consumer")?.message;
    expect(message).toBe(
      "This form is for the 14-day cancellation right that UK and EU consumers have. Living elsewhere? You can move your session once, free, from the Reschedule link in your booking email, or email knowledgecentre@zaaheen.com.",
    );
  });
});
