"use client";

import { useSyncExternalStore } from "react";
import { GST_TIMEZONE } from "@/lib/time";
import { isKnownTimeZone, presentSlots } from "@/domain/scheduling/slot-presentation";

/**
 * The calendar a customer chooses a slot from.
 *
 * Two deliberate choices here.
 *
 * The slots are REAL RADIO INPUTS, not buttons wired to React state. Arrow-key
 * navigation, the roving focus a radio group already has, and the value
 * arriving in a form submission all come free and correct.
 *
 * This component is a client component for ONE reason: only the browser knows
 * what time zone the customer is in. Everything else - which slots exist, and
 * whether one is still free - is decided on the server, because the calendar
 * lives there and a browser must never be the authority on what is bookable.
 */

export interface SelectedSlot {
  /** The UTC instant. This is what gets posted back, never the string on screen. */
  readonly isoStart: string;
  readonly localTime: string;
  readonly gstReference: string | null;
  readonly dayLabel: string;
}

export interface SlotPickerProps {
  /** UTC instants as ISO strings. The server decided these; the browser only renders them. */
  readonly slotStarts: readonly string[];
  readonly durationMinutes: number;
  readonly selectedIso?: string | null;
  readonly onSelect?: (slot: SelectedSlot) => void;
  /** Name of the radio group, so a form submission carries the chosen instant. */
  readonly name?: string;
  readonly disabled?: boolean;
}

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

export function SlotPicker({
  slotStarts,
  durationMinutes,
  selectedIso = null,
  onSelect,
  name = "slotStart",
  disabled = false,
}: SlotPickerProps) {
  /*
    The customer's zone is a value the server genuinely cannot know, and
    useSyncExternalStore is the API for exactly that: it hands React a server
    snapshot and a client snapshot, so the first render matches what was sent
    and the browser's own zone takes over immediately afterwards - with no
    hydration mismatch and no setState inside an effect.
  */
  const timeZone = useSyncExternalStore(subscribeToNothing, browserTimeZone, gulfStandardTime);

  if (slotStarts.length === 0) {
    return (
      <p className="text-ink-muted text-sm leading-relaxed">
        Nothing is free this week. Try a later week, or get in touch and we will find a time.
      </p>
    );
  }

  const days = presentSlots(
    slotStarts.map((iso) => {
      const start = new Date(iso);
      return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
    }),
    timeZone,
  );

  return (
    <div>
      <div className="space-y-6">
        {days.map((day) => (
          <fieldset key={day.isoDate}>
            <legend className="text-ink text-sm font-semibold">{day.label}</legend>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {day.slots.map((slot) => (
                <label
                  key={slot.isoStart}
                  className="has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55"
                >
                  <input
                    type="radio"
                    name={name}
                    value={slot.isoStart}
                    disabled={disabled}
                    checked={selectedIso === slot.isoStart}
                    onChange={() => onSelect?.({ ...slot, dayLabel: day.label })}
                    className="peer sr-only"
                  />
                  <span className="border-line-strong text-ink hover:border-ink peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent peer-focus-visible:outline-accent block cursor-pointer rounded-lg border px-3 py-2.5 text-center text-sm font-medium tabular-nums transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:cursor-not-allowed">
                    {slot.localTime}
                    {slot.gstReference !== null && (
                      <span className="text-ink-faint mt-0.5 block text-xs font-normal">
                        {slot.gstReference}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <p className="text-ink-faint mt-6 text-xs leading-relaxed">
        Times are shown in your own time zone ({timeZone}). Sessions run from Dubai, so a Gulf
        Standard Time reference is shown wherever it differs from yours.
      </p>
    </div>
  );
}
