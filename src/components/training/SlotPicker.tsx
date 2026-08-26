"use client";

import { useState } from "react";
import { presentSlots } from "@/domain/scheduling/slot-presentation";
import { useCustomerTimeZone } from "./useCustomerTimeZone";

/**
 * The calendar a customer chooses a slot from.
 *
 * The slots are REAL RADIO INPUTS, not buttons wired to state alone. Arrow-key
 * navigation, the roving focus a radio group already has, and the value
 * arriving in a form submission all come free and correct.
 *
 * Which slots exist, and whether one is still free, is decided on the server -
 * the calendar lives there, and a browser must never be the authority on what
 * is bookable. This component only renders what it was given, in the
 * customer's own time zone.
 */

/** Enough to choose from without a wall of buttons. More is a click away. */
const DAYS_SHOWN_INITIALLY = 4;
const DAYS_PER_REVEAL = 4;

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

export function SlotPicker({
  slotStarts,
  durationMinutes,
  selectedIso = null,
  onSelect,
  name = "slotStart",
  disabled = false,
}: SlotPickerProps) {
  const timeZone = useCustomerTimeZone();
  const [daysShown, setDaysShown] = useState(DAYS_SHOWN_INITIALLY);

  if (slotStarts.length === 0) {
    return (
      <p className="text-ink-muted text-sm leading-relaxed">
        There are no times available at the moment. Please get in touch and we will find one.
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

  const visible = days.slice(0, daysShown);
  const remaining = days.length - visible.length;

  return (
    <div>
      <div className="space-y-6">
        {visible.map((day) => (
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

      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setDaysShown((shown) => shown + DAYS_PER_REVEAL)}
          className="border-line-strong text-ink hover:border-ink mt-6 w-full rounded-lg border py-2.5 text-sm font-medium"
        >
          Show more dates
        </button>
      )}

      <p className="text-ink-faint mt-6 text-xs leading-relaxed">
        Times are shown in your own time zone ({timeZone}). Sessions run from Dubai, so a Gulf
        Standard Time reference appears wherever it differs from yours.
      </p>
    </div>
  );
}
