/**
 * Where a customer came from.
 *
 * This decides which advertising is working and which is burning money, so the
 * rules below are worth understanding rather than skimming. Two of them are the
 * difference between usable numbers and numbers that quietly flatter whichever
 * channel a customer happened to return through.
 *
 *  1. FIRST TOUCH IS WRITTEN ONCE AND NEVER OVERWRITTEN. It is what introduced
 *     someone to the business. Letting a later visit overwrite it credits the
 *     channel that closed the sale with the work of the one that started it.
 *
 *  2. A DIRECT VISIT DOES NOT REPLACE LAST TOUCH. Somebody who clicks an ad on
 *     Monday and types the address from memory on Thursday was still brought in
 *     by that ad. Treating Thursday as a fresh "direct" arrival is how a
 *     working campaign disappears from its own report.
 *
 * Everything stored here arrives in a query string that anybody can write, so
 * every value is stripped and length-capped before it is kept.
 */

/** Analytics fields, not money. Long enough for any real campaign name. */
const MAX_FIELD = 200;

/** Search engines we recognise well enough to call a visit organic rather than a referral. */
const SEARCH_ENGINE_HOSTS = [
  "google",
  "bing",
  "duckduckgo",
  "yahoo",
  "ecosia",
  "brave",
  "baidu",
  "yandex",
] as const;

export interface TouchPoint {
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
  readonly content: string | null;
  readonly term: string | null;
}

export const DIRECT_TOUCH: TouchPoint = {
  source: "direct",
  medium: "none",
  campaign: null,
  content: null,
  term: null,
};

export interface Attribution {
  readonly firstTouch: TouchPoint;
  readonly lastTouch: TouchPoint;
  readonly referrer: string | null;
  /** The page they arrived on: path and query only, never the host. */
  readonly landingPage: string;
  readonly gclid: string | null;
  readonly fbclid: string | null;
  /** A random id in a cookie. Not a person, and never derived from one. */
  readonly anonymousSessionId: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface VisitInput {
  /** The full URL of the page that was landed on. */
  readonly url: string;
  /** `document.referrer`, or the Referer header. Absent or empty means direct. */
  readonly referrer?: string | null;
  /** Our own host, so a click from one of our pages to another is not a new arrival. */
  readonly siteHost: string;
  readonly anonymousSessionId: string;
  readonly now: Date;
}

/** Read the campaign a visit carries, without deciding what to do with it. */
export function readTouchPoint(input: VisitInput): TouchPoint {
  const url = safeUrl(input.url);
  const params = url?.searchParams;

  const utm: TouchPoint = {
    source: clean(params?.get("utm_source")),
    medium: clean(params?.get("utm_medium")),
    campaign: clean(params?.get("utm_campaign")),
    content: clean(params?.get("utm_content")),
    term: clean(params?.get("utm_term")),
  };
  if (utm.source !== null || utm.medium !== null) return utm;

  // Google Ads auto-tagging appends gclid and no utm parameters at all. A
  // gclid is only ever produced by a paid click, so this inference is safe.
  // fbclid is NOT equivalent - it rides on ordinary organic Facebook links
  // too, so it is left to the referrer below rather than guessed at.
  if (clean(params?.get("gclid")) !== null) {
    return { ...utm, source: "google", medium: "cpc" };
  }

  return fromReferrer(input.referrer, input.siteHost, utm);
}

function fromReferrer(
  referrer: string | null | undefined,
  siteHost: string,
  base: TouchPoint,
): TouchPoint {
  const host = hostOf(referrer);
  if (host === null) return { ...base, ...DIRECT_TOUCH };

  // A link from one of our own pages is navigation, not an arrival.
  if (sameSite(host, siteHost)) return { ...base, source: null, medium: null };

  const engine = SEARCH_ENGINE_HOSTS.find((name) => isEngineHost(host, name));
  return {
    ...base,
    source: truncate(host),
    medium: engine ? "organic" : "referral",
  };
}

/** The first visit we have ever seen from this browser. */
export function beginAttribution(input: VisitInput): Attribution {
  const touch = readTouchPoint(input);
  const resolved = isEmptyTouch(touch) ? DIRECT_TOUCH : touch;
  const url = safeUrl(input.url);

  return {
    firstTouch: resolved,
    lastTouch: resolved,
    referrer: clean(input.referrer),
    landingPage: url ? truncate(`${url.pathname}${url.search}`) : "/",
    gclid: clean(url?.searchParams.get("gclid")),
    fbclid: clean(url?.searchParams.get("fbclid")),
    anonymousSessionId: input.anonymousSessionId,
    firstSeenAt: input.now,
    lastSeenAt: input.now,
  };
}

/**
 * A later visit from a browser we have seen before.
 *
 * First touch never moves. Last touch moves only for a genuine new campaign or
 * referrer - a direct return, or a click between our own pages, leaves it
 * alone, so the channel that actually brought someone in keeps the credit.
 */
export function recordVisit(existing: Attribution, input: VisitInput): Attribution {
  const touch = readTouchPoint(input);
  const meaningful = !isEmptyTouch(touch) && !isDirect(touch);

  const url = safeUrl(input.url);
  const gclid = clean(url?.searchParams.get("gclid"));
  const fbclid = clean(url?.searchParams.get("fbclid"));

  return {
    ...existing,
    lastTouch: meaningful ? touch : existing.lastTouch,
    // A click id from a newer visit is the more useful one to report a
    // conversion against, but an older one is never discarded for nothing.
    gclid: gclid ?? existing.gclid,
    fbclid: fbclid ?? existing.fbclid,
    lastSeenAt: input.now,
  };
}

export function isDirect(touch: TouchPoint): boolean {
  return touch.source === DIRECT_TOUCH.source && touch.medium === DIRECT_TOUCH.medium;
}

function isEmptyTouch(touch: TouchPoint): boolean {
  return touch.source === null && touch.medium === null;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = safeUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  return host === "" ? null : stripWww(host);
}

function sameSite(host: string, siteHost: string): boolean {
  return host === stripWww(siteHost.toLowerCase());
}

/**
 * Matches google.com, google.co.uk and news.google.com - but NOT notgoogle.com.
 * A substring test would count a competitor's domain as organic search traffic.
 */
function isEngineHost(host: string, name: string): boolean {
  return host === name || host.startsWith(`${name}.`) || host.includes(`.${name}.`);
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Control characters are removed by code point rather than by a regular
 * expression, so nothing depends on an escape sequence surviving a copy-paste
 * or a file rewrite. These values reach an admin screen and a log line.
 */
function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || code === 0x7f;
    if (!isControl) out += character;
  }
  return out;
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const stripped = stripControlCharacters(value).trim();
  return stripped === "" ? null : truncate(stripped);
}

function truncate(value: string): string {
  return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) : value;
}
