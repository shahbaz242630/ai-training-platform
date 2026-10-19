import { describe, expect, it } from "vitest";
import { prefetchFor } from "./link-prefetch";

/*
  Cloudflare's rate rule counts every request under /training/book/ per
  address (20 in 10 s, then a 10 s block). Prefetching those pages spent 12 of
  the 20 before a customer had clicked anything (measured live, session 100),
  so a customer browsing back and forth could be blocked at the payment step.
*/
describe("prefetchFor", () => {
  it("never prefetches a booking page", () => {
    for (const href of [
      "/training/book/claude-claude-code",
      "/training/book/withdraw",
      "/training/book/manage",
      "/training/book/ai-agents/confirming",
    ]) {
      expect(prefetchFor(href)).toBe(false);
    }
  });

  it("leaves every other link to the framework's default", () => {
    for (const href of [
      "/training",
      "/training#sessions",
      "https://zaaheen.com/knowledge-centre/",
    ]) {
      expect(prefetchFor(href)).toBeUndefined();
    }
  });
});
