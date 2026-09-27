import { describe, it, expect } from "vitest";
import { startsWithinCancellationPeriod } from "./cancellation-period";

const bookedAt = new Date("2026-10-01T10:00:00Z");
const days = (n: number) => new Date(bookedAt.getTime() + n * 24 * 60 * 60 * 1000);

describe("startsWithinCancellationPeriod", () => {
  it("is true for a session tomorrow", () => {
    expect(startsWithinCancellationPeriod(days(1), bookedAt)).toBe(true);
  });

  it("is true one minute before the 14 days end", () => {
    expect(startsWithinCancellationPeriod(new Date(days(14).getTime() - 60_000), bookedAt)).toBe(
      true,
    );
  });

  // At exactly 14 days the period has run out, so no request is needed.
  it("is false at exactly 14 days and after", () => {
    expect(startsWithinCancellationPeriod(days(14), bookedAt)).toBe(false);
    expect(startsWithinCancellationPeriod(days(30), bookedAt)).toBe(false);
  });
});
