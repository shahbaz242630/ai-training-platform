import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
  Where the person check sits in checkout start (audit s101 #3 part 2). The
  action is a server entry point with no unit tests of its own; the check's
  logic is tested in src/lib/turnstile.test.ts, and these pin the wiring.

  It must run BEFORE anything is held, so a caller who has not passed it
  never takes a slot off the calendar. It runs AFTER the cheap refusals (rate
  limit, request shape, session, details, payments configured, the ticks), so
  a customer who forgot a tick does not spend their single-use token on a
  refusal that had nothing to do with it.
*/
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const action = read("src/app/training/book/[slug]/actions.ts");
const body = action.slice(action.indexOf("export async function startCheckoutAction"));

describe("the person check in checkout start", () => {
  it("is asked, with the settings read on the server and the site's own address", () => {
    // The whole statement, so the call cannot be short-circuited or skipped
    // while still appearing in the source.
    expect(body).toMatch(
      /\n\s*const challenge = await checkoutChallenge\(\{\s*settings: turnstileSettings\(\),\s*token: parsed\.data\.turnstileToken,\s*siteUrl: clientEnv\.NEXT_PUBLIC_SITE_URL,/,
    );
    expect(body).toMatch(
      /if \(challenge !== null\) \{?\s*return \{ ok: false, reason: "challenge_failed"/,
    );
  });

  it("comes after the ticks are checked and before any slot is looked at or held", () => {
    const at = (needle: string) => {
      const index = body.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const check = at("checkoutChallenge(");
    expect(check).toBeGreaterThan(at("consentRefusal("));
    expect(check).toBeGreaterThan(at("getPaymentProvider()"));
    expect(check).toBeLessThan(at("offeredSlots("));
    expect(check).toBeLessThan(at("holdSlot("));
  });

  it("is asked exactly once", () => {
    expect(body.split("checkoutChallenge(").length - 1).toBe(1);
  });
});

/*
  The page hands the site key to the booking box from the server, at request
  time, and only from the same settings the action checks against: the two can
  never disagree about whether the check is on.
*/
describe("the booking page", () => {
  it("passes the site key from the server's own settings", () => {
    const page = read("src/app/training/book/[slug]/page.tsx");
    expect(page).toContain("turnstileSettings()");
    expect(page).toMatch(/turnstileSiteKey=\{challenge\?\.siteKey \?\? null\}/);
  });

  /*
    Code review (s103): going back to edit the details unmounts the check but
    kept its token, so Continue was enabled at once with a token that may have
    expired; and the back-button reload must not change the box while the
    check is off.
  */
  it("drops the token when the customer goes back to edit their details", () => {
    const panel = read("src/components/training/BookingPanel.tsx");
    expect(panel).toMatch(/setStep\("details"\);\s*setChallengeToken\(null\);/);
  });

  it("reloads a page restored from the browser's cache only while the check is on", () => {
    const panel = read("src/components/training/BookingPanel.tsx");
    expect(panel).toMatch(/if \(!challengeNeeded\) return;\s*const onShow/);
  });

  it("tells a customer whose check never arrives how to carry on", () => {
    const panel = read("src/components/training/BookingPanel.tsx");
    expect(panel).toContain("This is taking longer than usual.");
  });

  it("sends the token and asks for a fresh one after every refusal", () => {
    const panel = read("src/components/training/BookingPanel.tsx");
    expect(panel).toMatch(/turnstileToken: challengeToken \?\? undefined/);
    const reserve = panel.slice(panel.indexOf("function reserveAndContinue"));
    const failure = reserve.slice(reserve.indexOf("if (!result.ok) {"));
    expect(failure.slice(0, 400)).toContain("renewChallenge()");
  });
});
