"use client";

import { useEffect, useRef } from "react";

/**
 * Tells the server where this visit came from, once per page load.
 *
 * It has to happen in the browser because `document.referrer` exists nowhere
 * else: by the time somebody submits the booking form, the referrer that
 * brought them is long gone, and attributing at that point would credit the
 * wrong channel - or no channel at all.
 *
 * Renders nothing, blocks nothing, and its failure is deliberately invisible.
 * If reporting breaks, browsing and booking must carry on working.
 */
export function AttributionCapture() {
  /*
    React invokes effects twice in development. Without this the first visit
    of every page load would be recorded twice - harmless for a return visit,
    but it would make the numbers wrong while developing and quietly train us
    to distrust them.
  */
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;

    void fetch("/api/attribution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The cookie is how one browser's visits are tied together, so it has to
      // travel even though this is a same-origin request.
      credentials: "same-origin",
      body: JSON.stringify({
        url: window.location.href,
        referrer: document.referrer === "" ? null : document.referrer,
      }),
      // Survives the page being navigated away from immediately, which is
      // exactly when a bounce - the visit worth measuring - would be lost.
      keepalive: true,
      // Nothing here is worth showing anybody. An unreachable endpoint must
      // never surface as an error in a customer's console mid-booking.
    }).catch(() => {});
  }, []);

  return null;
}
