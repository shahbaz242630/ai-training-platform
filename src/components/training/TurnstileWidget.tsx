"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

/**
 * The person check before payment (audit s101 #3 part 2): Cloudflare
 * Turnstile, rendered explicitly into one container that lives for the whole
 * "choose a time" step, so losing a slot never throws the check away.
 *
 * Invisible unless Cloudflare wants a click ("interaction-only"); then the box
 * appears here and is scrolled into view, which matters on a phone. The token
 * goes up to the booking box through onToken; it is single-use and lasts 300
 * seconds, so the box asks for a fresh one (renewKey) after every refusal, and
 * an expired or failed check clears it. Cloudflare retries and refreshes on
 * its own; nothing here fights that.
 *
 * The script is loaded through next/script, which the page's nonce policy
 * trusts through 'strict-dynamic'. The site key comes from the server at
 * request time (turnstileSettings), never from the build.
 */

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function TurnstileWidget({
  siteKey,
  renewKey,
  onToken,
  scrollOnInteractive = true,
}: {
  siteKey: string;
  /** Changes whenever the booking box needs a new token. */
  renewKey: number;
  /** A stable setter (a state dispatch or a useCallback): the token, or null when there is none. */
  onToken: (token: string | null) => void;
  /**
   * Scroll the box into view when Cloudflare wants a click. Off on the details
   * step: it mounts as the page loads, and on a phone it would pull a reader
   * from the description to the bottom of the form (audit s104 review).
   */
  scrollOnInteractive?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const turnstile = window.turnstile;
    const box = container.current;
    // Guarded so React's development double-run never makes a second widget.
    if (!ready || turnstile === undefined || box === null || widgetId.current !== null) return;
    widgetId.current = turnstile.render(box, {
      sitekey: siteKey,
      action: "checkout",
      appearance: "interaction-only",
      size: "flexible",
      callback: (token: string) => onToken(token),
      "expired-callback": () => onToken(null),
      "error-callback": () => onToken(null),
      "before-interactive-callback": () => {
        if (scrollOnInteractive) box.scrollIntoView({ block: "nearest" });
      },
    });
    return () => {
      if (widgetId.current !== null) turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [ready, siteKey, onToken, scrollOnInteractive]);

  useEffect(() => {
    if (renewKey > 0 && widgetId.current !== null) window.turnstile?.reset(widgetId.current);
  }, [renewKey]);

  return (
    <>
      <Script src={SCRIPT_URL} strategy="afterInteractive" onReady={() => setReady(true)} />
      <div ref={container} className="mb-4 empty:hidden" />
    </>
  );
}
