import { describe, it, expect } from "vitest";
import {
  DIRECT_TOUCH,
  beginAttribution,
  isDirect,
  readTouchPoint,
  recordVisit,
  type VisitInput,
} from "./attribution";

const SITE_HOST = "example.com";
const MONDAY = new Date("2026-09-07T10:00:00.000Z");
const THURSDAY = new Date("2026-09-10T10:00:00.000Z");

const visit = (overrides: Partial<VisitInput> = {}): VisitInput => ({
  url: `https://${SITE_HOST}/training`,
  referrer: null,
  siteHost: SITE_HOST,
  anonymousSessionId: "anon_1",
  now: MONDAY,
  ...overrides,
});

const AD_CLICK = visit({
  url: `https://${SITE_HOST}/training?utm_source=google&utm_medium=cpc&utm_campaign=ai-training-q3&utm_content=headline-b&utm_term=ai%20course%20dubai`,
});

describe("readTouchPoint", () => {
  it("reads the full set of campaign parameters", () => {
    expect(readTouchPoint(AD_CLICK)).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "ai-training-q3",
      content: "headline-b",
      term: "ai course dubai",
    });
  });

  it("accepts a campaign tagged with only a source, or only a medium", () => {
    expect(
      readTouchPoint(visit({ url: `https://${SITE_HOST}/?utm_source=newsletter` })).source,
    ).toBe("newsletter");
    expect(readTouchPoint(visit({ url: `https://${SITE_HOST}/?utm_medium=email` })).medium).toBe(
      "email",
    );
  });

  // Google Ads auto-tagging sends gclid and no utm parameters at all. Without
  // this, every auto-tagged paid click is filed as organic search.
  it("treats a bare gclid as a paid Google click", () => {
    const touch = readTouchPoint(visit({ url: `https://${SITE_HOST}/?gclid=abc123` }));
    expect(touch.source).toBe("google");
    expect(touch.medium).toBe("cpc");
  });

  it("lets explicit tagging win over the gclid inference", () => {
    const touch = readTouchPoint(
      visit({ url: `https://${SITE_HOST}/?gclid=abc&utm_source=partner&utm_medium=affiliate` }),
    );
    expect(touch.source).toBe("partner");
    expect(touch.medium).toBe("affiliate");
  });

  // fbclid is NOT the equivalent of gclid: it rides on ordinary organic
  // Facebook links too, so calling it paid would invent spend that never
  // happened.
  it("does not treat a bare fbclid as paid", () => {
    const touch = readTouchPoint(visit({ url: `https://${SITE_HOST}/?fbclid=xyz` }));
    expect(touch.medium).not.toBe("cpc");
    expect(isDirect(touch)).toBe(true);
  });

  it("calls a visit with no referrer direct", () => {
    expect(readTouchPoint(visit())).toEqual(DIRECT_TOUCH);
    expect(readTouchPoint(visit({ referrer: "" }))).toEqual(DIRECT_TOUCH);
  });

  it("reads a search engine as organic", () => {
    for (const referrer of [
      "https://www.google.com/",
      "https://google.co.uk/search?q=x",
      "https://news.google.com/",
      "https://duckduckgo.com/",
      "https://bing.com/",
    ]) {
      expect(readTouchPoint(visit({ referrer })).medium).toBe("organic");
    }
  });

  // A substring test would file a competitor's domain as organic Google
  // traffic and quietly inflate a channel that sent nothing.
  it("does not mistake a lookalike domain for a search engine", () => {
    const touch = readTouchPoint(visit({ referrer: "https://notgoogle.com/" }));
    expect(touch.source).toBe("notgoogle.com");
    expect(touch.medium).toBe("referral");
  });

  it("reads any other site as a referral, without the www", () => {
    const touch = readTouchPoint(visit({ referrer: "https://www.news.ycombinator.com/item?id=1" }));
    expect(touch.source).toBe("news.ycombinator.com");
    expect(touch.medium).toBe("referral");
  });

  // Otherwise every internal click would register as a brand new arrival and
  // overwrite whatever actually brought the person in.
  it("does not treat a click between our own pages as an arrival", () => {
    const touch = readTouchPoint(visit({ referrer: `https://${SITE_HOST}/training` }));
    expect(touch.source).toBeNull();
    expect(touch.medium).toBeNull();
  });

  it("recognises our own site with or without the www", () => {
    const touch = readTouchPoint(
      visit({ referrer: `https://www.${SITE_HOST}/`, siteHost: SITE_HOST }),
    );
    expect(touch.source).toBeNull();
  });

  it("falls back to direct when the referrer is not a usable URL", () => {
    expect(readTouchPoint(visit({ referrer: "not a url" }))).toEqual(DIRECT_TOUCH);
  });
});

describe("beginAttribution", () => {
  it("records the same touch as both first and last", () => {
    const attribution = beginAttribution(AD_CLICK);
    expect(attribution.firstTouch.campaign).toBe("ai-training-q3");
    expect(attribution.lastTouch).toEqual(attribution.firstTouch);
    expect(attribution.firstSeenAt).toEqual(MONDAY);
    expect(attribution.lastSeenAt).toEqual(MONDAY);
  });

  it("keeps only the path and query of the landing page, never the host", () => {
    const attribution = beginAttribution(AD_CLICK);
    expect(attribution.landingPage.startsWith("/training?")).toBe(true);
    expect(attribution.landingPage).not.toContain(SITE_HOST);
  });

  it("captures the click ids", () => {
    const attribution = beginAttribution(
      visit({ url: `https://${SITE_HOST}/?gclid=g-1&fbclid=f-1` }),
    );
    expect(attribution.gclid).toBe("g-1");
    expect(attribution.fbclid).toBe("f-1");
  });

  it("leaves click ids null when there are none", () => {
    const attribution = beginAttribution(visit());
    expect(attribution.gclid).toBeNull();
    expect(attribution.fbclid).toBeNull();
  });

  it("falls back to direct for an internal referrer on a first visit", () => {
    const attribution = beginAttribution(visit({ referrer: `https://${SITE_HOST}/other` }));
    expect(attribution.firstTouch).toEqual(DIRECT_TOUCH);
  });

  it("survives a URL it cannot parse", () => {
    const attribution = beginAttribution(visit({ url: "://broken" }));
    expect(attribution.landingPage).toBe("/");
    expect(attribution.firstTouch).toEqual(DIRECT_TOUCH);
  });
});

describe("recordVisit", () => {
  const first = beginAttribution(AD_CLICK);

  // The rule that decides whether a campaign gets credit for what it started.
  it("never moves first touch, however many times somebody comes back", () => {
    const later = recordVisit(
      first,
      visit({ url: `https://${SITE_HOST}/?utm_source=newsletter&utm_medium=email`, now: THURSDAY }),
    );
    expect(later.firstTouch).toEqual(first.firstTouch);
    expect(later.firstTouch.source).toBe("google");
    expect(later.firstSeenAt).toEqual(MONDAY);
  });

  it("moves last touch for a genuinely new campaign", () => {
    const later = recordVisit(
      first,
      visit({ url: `https://${SITE_HOST}/?utm_source=newsletter&utm_medium=email`, now: THURSDAY }),
    );
    expect(later.lastTouch.source).toBe("newsletter");
    expect(later.lastSeenAt).toEqual(THURSDAY);
  });

  /*
    Somebody who clicks an ad on Monday and types the address from memory on
    Thursday was still brought in by that ad. Overwriting last touch with
    "direct" is how a working campaign disappears from its own report.
  */
  it("does not let a direct return overwrite the campaign that brought them in", () => {
    const later = recordVisit(first, visit({ now: THURSDAY }));
    expect(later.lastTouch.source).toBe("google");
    expect(later.lastTouch.medium).toBe("cpc");
    expect(later.lastSeenAt).toEqual(THURSDAY);
  });

  it("does not let a click between our own pages overwrite it either", () => {
    const later = recordVisit(
      first,
      visit({ referrer: `https://${SITE_HOST}/training`, now: THURSDAY }),
    );
    expect(later.lastTouch.source).toBe("google");
  });

  it("still updates the last seen time on a visit that changes nothing else", () => {
    expect(recordVisit(first, visit({ now: THURSDAY })).lastSeenAt).toEqual(THURSDAY);
  });

  it("keeps an earlier click id when a later visit carries none", () => {
    const withIds = beginAttribution(visit({ url: `https://${SITE_HOST}/?gclid=g-1&fbclid=f-1` }));
    const later = recordVisit(withIds, visit({ now: THURSDAY }));
    expect(later.gclid).toBe("g-1");
    expect(later.fbclid).toBe("f-1");
  });

  it("prefers a newer click id when there is one", () => {
    const withIds = beginAttribution(visit({ url: `https://${SITE_HOST}/?gclid=g-1` }));
    const later = recordVisit(withIds, visit({ url: `https://${SITE_HOST}/?gclid=g-2` }));
    expect(later.gclid).toBe("g-2");
  });

  it("does not mutate what it was given", () => {
    recordVisit(first, visit({ url: `https://${SITE_HOST}/?utm_source=x&utm_medium=y` }));
    expect(first.lastTouch.source).toBe("google");
  });
});

describe("cleaning what arrives in a query string", () => {
  it("caps a field somebody has stuffed", () => {
    const stuffed = "a".repeat(500);
    const touch = readTouchPoint(visit({ url: `https://${SITE_HOST}/?utm_source=${stuffed}` }));
    expect(touch.source).toHaveLength(200);
  });

  it("strips control characters before anything stores or displays them", () => {
    const nasty = `camp${String.fromCodePoint(0)}aign${String.fromCodePoint(7)}`;
    const url = `https://${SITE_HOST}/?utm_source=x&utm_campaign=${encodeURIComponent(nasty)}`;
    expect(readTouchPoint(visit({ url })).campaign).toBe("campaign");
  });

  it("treats a blank or whitespace-only parameter as absent, not as tagging", () => {
    const touch = readTouchPoint(
      visit({ url: `https://${SITE_HOST}/?utm_source=%20%20&utm_medium=&utm_campaign=%20` }),
    );
    // Blank tagging is not tagging. The visit falls through to being read as
    // direct rather than being stored with empty strings for source and
    // medium, which would show up in a report as a channel called "".
    expect(touch.campaign).toBeNull();
    expect(isDirect(touch)).toBe(true);
  });
});
