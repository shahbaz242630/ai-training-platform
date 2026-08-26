"use client";

import { useState, type ReactNode } from "react";
import { SlotPicker, type SelectedSlot } from "./SlotPicker";

/**
 * The booking box: pick a time, then continue to payment.
 *
 * It keeps the calendar and what happens next in ONE panel, so choosing a time
 * and paying for it never feel like two separate errands. The calendar scrolls
 * inside the panel rather than pushing the page down, so the summary and the
 * button stay in view while somebody is still deciding.
 *
 * THE BUTTON IS DEACTIVATED, and says so. Payment is not connected yet, and a
 * slot that can be chosen but not paid for is a promise we cannot keep.
 * Choosing a time here reserves nothing - a real hold is created against the
 * calendar only once checkout begins.
 */

export interface BookingPanelProps {
  readonly slotStarts: readonly string[];
  readonly durationMinutes: number;
  /** Already formatted by the server from the catalogue price. Never built here. */
  readonly priceLabel: string;
  /** Week navigation links, rendered on the server so they work without JavaScript. */
  readonly weekNav?: ReactNode;
}

export function BookingPanel({
  slotStarts,
  durationMinutes,
  priceLabel,
  weekNav,
}: BookingPanelProps) {
  const [selected, setSelected] = useState<SelectedSlot | null>(null);

  return (
    <div className="border-line bg-surface overflow-hidden rounded-xl border">
      <div className="border-line bg-raised border-b px-6 py-5">
        <h2 className="text-ink text-base font-semibold">Choose a time</h2>
        <p className="text-ink-muted mt-1 text-sm">One to one · {durationMinutes} minutes</p>
      </div>

      {/*
        The calendar scrolls inside the panel. Capped in viewport units rather
        than a fixed height so it still fits on a short laptop screen, where a
        fixed 26rem would push the button below the fold.
      */}
      <div className="max-h-[min(28rem,50vh)] overflow-y-auto px-6 py-5">
        <SlotPicker
          slotStarts={slotStarts}
          durationMinutes={durationMinutes}
          selectedIso={selected?.isoStart ?? null}
          onSelect={setSelected}
        />
        {weekNav}
      </div>

      <div className="border-line bg-raised border-t px-6 py-5">
        {selected === null ? (
          <p className="text-ink-muted text-sm">Select a time to continue.</p>
        ) : (
          <div>
            <p className="text-ink-faint text-xs tracking-[0.14em] uppercase">Your session</p>
            <p className="text-ink mt-2 text-sm font-semibold">{selected.dayLabel}</p>
            <p className="text-ink mt-0.5 text-sm tabular-nums">
              {selected.localTime}
              {selected.gstReference !== null && (
                <span className="text-ink-muted ml-2 text-xs">{selected.gstReference}</span>
              )}
            </p>

            <div className="border-line mt-4 flex items-baseline justify-between border-t pt-4">
              <span className="text-ink-muted text-sm">Total</span>
              <span className="text-ink text-lg font-semibold tabular-nums">{priceLabel}</span>
            </div>

            <button
              type="button"
              disabled
              className="bg-ink mt-4 w-full cursor-not-allowed rounded-lg px-6 py-3.5 text-sm font-semibold text-white opacity-45"
            >
              Continue to payment
            </button>
            <p className="text-ink-muted mt-3 text-xs leading-relaxed">
              Payment is not connected yet, so this cannot be completed. Choosing a time here
              reserves nothing — the slot is only held once checkout begins, and the booking is
              confirmed only after payment has been verified.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
