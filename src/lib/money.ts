/**
 * Money is stored and computed in fils - the smallest AED unit (1 AED = 100 fils).
 *
 * Never use floating point for money. Stripe also expects the smallest currency
 * unit, so this representation passes straight through with no conversion step.
 */
export type Fils = number;

export const AED = "AED" as const;
export type Currency = typeof AED;

export function aedToFils(aed: number): Fils {
  return Math.round(aed * 100);
}

export function filsToAed(fils: Fils): number {
  return fils / 100;
}

/** Display form, e.g. 129900 -> "AED 1,299". Whole dirhams only when exact. */
export function formatAed(fils: Fils): string {
  const aed = filsToAed(fils);
  const hasFraction = fils % 100 !== 0;
  return `AED ${aed.toLocaleString("en-AE", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
