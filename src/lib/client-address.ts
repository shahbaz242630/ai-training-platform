/**
 * Which address a rate limit should be counted against.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT. `X-Forwarded-For` is built by
 * APPENDING: each proxy adds the address it received the request from, to the
 * right. So the chain reads
 *
 *     &lt;whatever the client sent&gt;, &lt;client as seen by proxy 1&gt;, &lt;proxy 1 as seen by proxy 2&gt;
 *
 * The LEFTMOST entry is therefore the one the client wrote, and a client can
 * write anything. Taking `[0]` - which reads like "the original client" and is
 * the obvious thing to do - hands every caller a fresh rate-limit bucket per
 * request simply by sending a different value each time. That is not a partial
 * weakening of a rate limit; it removes it.
 *
 * Only entries appended by infrastructure WE control are worth anything, and
 * those are at the right-hand end. The one honest input here is how many
 * proxies actually sit in front of the application: counting from the right by
 * that number lands on the address our own edge observed.
 */

/**
 * How many proxies append to the header before the request reaches us.
 *
 * One is the shape of the current deployment: a managed host with a CDN in
 * front. It is deliberately a parameter rather than a constant, because the
 * right value is a fact about the deployment and getting it wrong in either
 * direction is silent - too high reads an address the client controls, too low
 * reads our own proxy and lumps every visitor into one bucket.
 *
 * VERIFY THIS AGAINST THE REAL DEPLOYMENT before trusting the limits:
 *   curl -H 'X-Forwarded-For: 1.2.3.4' https://&lt;host&gt;/ and see what arrives.
 */
export const DEFAULT_TRUSTED_PROXY_COUNT = 1;

/** Used when no usable address can be established. Shared, and that is deliberate. */
export const UNKNOWN_CALLER = "unknown";

export function clientAddressFrom(
  forwardedFor: string | null,
  trustedProxyCount: number = DEFAULT_TRUSTED_PROXY_COUNT,
): string {
  if (forwardedFor === null) return UNKNOWN_CALLER;

  const entries = forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) return UNKNOWN_CALLER;

  /*
    Count in from the right. With one trusted proxy that is the last entry -
    the address our own edge saw the connection come from, which a client
    cannot forge because the proxy appends it after discarding nothing.
  */
  const index = entries.length - Math.max(1, Math.trunc(trustedProxyCount));

  /*
    A chain SHORTER than the number of proxies we expect means the request did
    not arrive the way we think it does - a misconfiguration, or somebody
    reaching the app directly. Falling back to the leftmost entry there would
    quietly restore the exact bypass this module exists to close, so it falls
    back to the shared bucket instead: an unknown caller is limited MORE, not
    less.
  */
  if (index < 0) return UNKNOWN_CALLER;

  return entries[index] ?? UNKNOWN_CALLER;
}

/**
 * Whether a site URL is safe to hand to a payment processor as a return
 * address.
 *
 * NEXT_PUBLIC_SITE_URL defaults to http://localhost:3000 so local development
 * needs no configuration. In production that default is a trap: a deploy that
 * forgets the variable sends every paying customer back to their OWN machine
 * after checkout, and nothing errors - the payment succeeds, the customer sees
 * a dead page, and the only symptom is a support message.
 *
 * Kept as a pure predicate so the refusal can be tested without a deployment.
 */
export function isUsableReturnUrl(siteUrl: string, isProduction: boolean): boolean {
  if (!isProduction) return true;

  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "0.0.0.0";
}
