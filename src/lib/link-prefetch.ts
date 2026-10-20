import { TRAINING_BASE } from "@/config/site";

const BOOKING_PATH = `${TRAINING_BASE}/book/`;

/**
 * Whether a link may prefetch its page.
 *
 * Every request under /training/book/ counts towards Cloudflare's rate rule
 * for the booking pages (per address, 20 in 10 seconds, then a 10-second
 * block). Prefetching them spent most of that allowance on pages nobody had
 * asked for, so links into the booking pages load only when clicked. Every
 * other link keeps the framework's default.
 */
export function prefetchFor(href: string): false | undefined {
  return href.startsWith(BOOKING_PATH) ? false : undefined;
}

/**
 * Whether a link must load its page in full rather than move inside the app.
 *
 * A move inside the app keeps the security policy of the page it started on.
 * The catalogue's policy has no nonce, so a booking page reached from it ran
 * under the weaker policy, and the person check's frame (audit s101 #3) was
 * not allowed at all (Turnstile design review, s103). A full load gets the
 * booking pages' own policy, with this request's nonce.
 */
export function loadsFully(href: string): boolean {
  return href.startsWith(BOOKING_PATH);
}
