import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
  The time step showed the customer's name and email on one truncated line,
  but nothing let that line shrink: the booking page's grid had no column
  definition below lg, so its one track sized to the longest unbroken content,
  and the line sat in a flex row without min-w-0. A long email widened the
  whole page instead of being cut off (KC D4, 2026-10-17: 683px wide on a
  375px phone with a 90-character name and email), right before payment.

  Components are not rendered in this suite (environment "node"), so the two
  rules that keep the page inside the screen are pinned in the source.
*/
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("booking page fits a phone", () => {
  it("lets the stacked single column shrink below its content", () => {
    const page = read("src/app/training/book/[slug]/page.tsx");
    expect(page).toMatch(/className="grid grid-cols-\[minmax\(0,1fr\)\] gap-10 lg:grid-cols-/);
  });

  it("lets the name and email line truncate inside its row", () => {
    const panel = read("src/components/training/BookingPanel.tsx");
    expect(panel).toContain('className="text-ink-muted min-w-0 truncate text-[13px]"');
  });
});
