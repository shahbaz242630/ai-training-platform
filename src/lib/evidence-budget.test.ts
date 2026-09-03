import { describe, expect, it } from "vitest";
import { createEvidenceBudget } from "./evidence-budget";

const T0 = new Date("2027-01-01T00:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("createEvidenceBudget", () => {
  it("records the first few rejections from a source, then stops", () => {
    const budget = createEvidenceBudget({ perSource: 3, total: 100, windowMs: 60_000 });

    const decisions = Array.from({ length: 5 }, () => budget.shouldRecord("203.0.113.7", T0));

    expect(decisions).toEqual([true, true, true, false, false]);
  });

  it("keeps recording for a different source", () => {
    const budget = createEvidenceBudget({ perSource: 1, total: 100, windowMs: 60_000 });

    expect(budget.shouldRecord("203.0.113.7", T0)).toBe(true);
    expect(budget.shouldRecord("203.0.113.7", T0)).toBe(false);
    expect(budget.shouldRecord("203.0.113.8", T0)).toBe(true);
  });

  it("bounds the total across every source, so many addresses cannot add up to unlimited", () => {
    const budget = createEvidenceBudget({ perSource: 10, total: 4, windowMs: 60_000 });

    const decisions = Array.from({ length: 6 }, (_, i) =>
      budget.shouldRecord(`198.51.100.${i}`, T0),
    );

    expect(decisions).toEqual([true, true, true, true, false, false]);
  });

  it("does not let a source over its own allowance spend the shared total", () => {
    const budget = createEvidenceBudget({ perSource: 1, total: 2, windowMs: 60_000 });

    // One source: first recorded, then refused ten times. Those refusals must
    // not touch the total, or the noisy source would silence everybody else.
    expect(budget.shouldRecord("noisy", T0)).toBe(true);
    for (let i = 0; i < 10; i += 1) expect(budget.shouldRecord("noisy", T0)).toBe(false);

    expect(budget.shouldRecord("quiet", T0)).toBe(true);
  });

  it("starts again when the window has passed", () => {
    const budget = createEvidenceBudget({ perSource: 1, total: 1, windowMs: 60_000 });

    expect(budget.shouldRecord("203.0.113.7", T0)).toBe(true);
    expect(budget.shouldRecord("203.0.113.7", later(59_000))).toBe(false);
    expect(budget.shouldRecord("203.0.113.7", later(60_000))).toBe(true);
  });
});
