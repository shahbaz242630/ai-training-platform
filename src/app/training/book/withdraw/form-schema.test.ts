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
