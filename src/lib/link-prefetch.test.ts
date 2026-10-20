import { describe, expect, it } from "vitest";
import { loadsFully, prefetchFor } from "./link-prefetch";
import { ButtonLink } from "@/components/ui/Button";

/*
  A move between pages inside the app keeps the policy of the page it started
  on. The catalogue's policy has no nonce, so a booking page reached from it
  ran under the weaker policy, and the person check's frame was not allowed at
  all (Turnstile design review, s103). Links into the booking pages therefore
  load the page in full, and get the booking pages' own policy.
*/
describe("loadsFully", () => {
  it("is true for every booking page", () => {
    for (const href of [
      "/training/book/claude-claude-code",
      "/training/book/withdraw",
      "/training/book/ai-agents/confirming",
    ]) {
      expect(loadsFully(href)).toBe(true);
    }
  });

  it("is false for every other link", () => {
    for (const href of ["/training", "/training#sessions", "https://zaaheen.com/"]) {
      expect(loadsFully(href)).toBe(false);
    }
  });

  it("makes the button into a plain link for a booking page, and only then", () => {
    const booking = ButtonLink({ href: "/training/book/ai-agents", children: "Book" });
    expect(booking.type).toBe("a");
    expect(booking.props.href).toBe("/training/book/ai-agents");
    const other = ButtonLink({ href: "/training#sessions", children: "Back" });
    expect(other.type).not.toBe("a");
  });
});

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
