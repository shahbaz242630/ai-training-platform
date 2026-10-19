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
