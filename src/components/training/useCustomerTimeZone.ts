"use client";

import { useSyncExternalStore } from "react";
import { GST_TIMEZONE } from "@/lib/time";
import { isKnownTimeZone } from "@/domain/scheduling/slot-presentation";

/**
 * The customer's own time zone.
 *
 * This is a value the server genuinely cannot know, and useSyncExternalStore
 * is the API for exactly that: it hands React a server snapshot and a client
 * snapshot, so the first render matches what was sent and the browser's own
 * zone takes over immediately afterwards - with no hydration mismatch and no
 * setState inside an effect.
 *
 * Falls back to Gulf Standard Time when the browser reports something the
 * runtime does not recognise, because a session with no readable time is worse
 * than one shown in the zone it is delivered from.
 */

/*
  A time zone does not change while somebody is looking at the page, so there
  is nothing to subscribe to. The unsubscribe function is what React expects
  back.
*/
const subscribeToNothing = () => () => {};

const gulfStandardTime = () => GST_TIMEZONE;

/*
  Cached because getSnapshot is called on every render and must return a stable
  value - and because building an Intl formatter is not free.
*/
let detectedTimeZone: string | null = null;

function browserTimeZone(): string {
  if (detectedTimeZone === null) {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    detectedTimeZone = detected && isKnownTimeZone(detected) ? detected : GST_TIMEZONE;
  }
  return detectedTimeZone;
}

export function useCustomerTimeZone(): string {
  return useSyncExternalStore(subscribeToNothing, browserTimeZone, gulfStandardTime);
}
