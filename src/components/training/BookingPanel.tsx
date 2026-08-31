"use client";

import { useMemo, useState, useTransition } from "react";
import { SlotPicker, type SelectedSlot } from "./SlotPicker";
import { useCustomerTimeZone } from "./useCustomerTimeZone";
import { captureLeadAction, reserveSlotAction } from "@/app/training/book/[slug]/actions";
import { parsePrePaymentIntake, type IntakeFieldError } from "@/domain/intake/pre-payment-intake";
import { formatClockTime } from "@/domain/scheduling/slot-presentation";

/**
 * The booking box: who you are, then when, then payment.
 *
 * Details come FIRST on purpose. This is the only point in the funnel where
 * somebody identifies themselves, so it is both the start of the booking and
 * the only lead ever captured - asking after a slot is chosen means everyone
 * who browses times and leaves is lost entirely.
 *
 * The steps live in one panel rather than across pages, so choosing a time and
 * paying for it never feel like separate errands.
 *
 * NOTE: validation here is for the person filling the form in. It is not a
 * security boundary. The same schema runs again on the server when this is
 * submitted for real - a browser can be told anything, so nothing it says is
 * ever the last word.
 */

type Step = "details" | "slot";

interface DetailsDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  primaryGoal: string;
  marketingConsent: boolean;
}

const EMPTY_DRAFT: DetailsDraft = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  primaryGoal: "",
  marketingConsent: false,
};

export interface BookingPanelProps {
  /** Which session is being booked. Sent back when reserving, and checked server-side. */
  readonly slug: string;
  readonly slotStarts: readonly string[];
  readonly durationMinutes: number;
  /** Already formatted by the server from the catalogue price. Never built here. */
  readonly priceLabel: string;
  /** The server could not read availability. Not the same as having none. */
  readonly availabilityFailed?: boolean;
}

/** The claim on a time, once the server has granted it. */
interface HeldSlot {
  readonly holdId: string;
  readonly expiresAt: string;
}

export function BookingPanel({
  slug,
  slotStarts,
  durationMinutes,
  priceLabel,
  availabilityFailed = false,
}: BookingPanelProps) {
  const timeZone = useCustomerTimeZone();
  const [step, setStep] = useState<Step>("details");
  const [draft, setDraft] = useState<DetailsDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<readonly IntakeFieldError[]>([]);
  const [selected, setSelected] = useState<SelectedSlot | null>(null);
  const [saving, startSaving] = useTransition();
  const [reserving, startReserving] = useTransition();
  const [held, setHeld] = useState<HeldSlot | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);

  /*
    The times on offer start as what the server rendered, but a lost race
    replaces them with what is actually left. Kept in state for that reason
    alone - and re-synced if the server sends a fresh list, so a navigation
    back to this page never shows a stale calendar.
  */
  const [slots, setSlots] = useState<readonly string[]>(slotStarts);
  const [renderedSlots, setRenderedSlots] = useState<readonly string[]>(slotStarts);
  if (renderedSlots !== slotStarts) {
    setRenderedSlots(slotStarts);
    setSlots(slotStarts);
    setHeld(null);
    setSelected(null);
  }

  const errorFor = useMemo(() => {
    const byField = new Map(errors.map((error) => [error.field, error.message]));
    return (field: string) => byField.get(field) ?? null;
  }, [errors]);

  /** Problems that belong to the form as a whole rather than to one field. */
  const formError = errorFor("form");

  const set = <K extends keyof DetailsDraft>(field: K, value: DetailsDraft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));

  function continueToSlots() {
    // Checked here first so an obvious typo is caught without a round trip.
    // This is NOT the boundary - the server validates the same payload again,
    // because a browser can be told anything.
    const local = parsePrePaymentIntake({ ...draft, timezone: timeZone });
    if (!local.ok) {
      setErrors(local.errors);
      return;
    }

    startSaving(async () => {
      const result = await captureLeadAction({ ...draft, timezone: timeZone });
      if (!result.ok) {
        setErrors(result.errors ?? []);
        return;
      }
      setErrors([]);
      setStep("slot");
    });
  }

  /**
   * Claim the chosen time, at the moment checkout begins and not before.
   *
   * Selecting a radio button deliberately reserves nothing. Somebody weighing
   * up four times would otherwise take four slots off the calendar for fifteen
   * minutes each without paying for any of them.
   */
  function reserveAndContinue() {
    if (selected === null) return;
    const wanted = selected.isoStart;

    startReserving(async () => {
      const result = await reserveSlotAction({ slug, slotStart: wanted });

      if (!result.ok) {
        setSlotError(result.message ?? "That time is no longer available.");
        setHeld(null);
        /*
          Losing a race clears the selection on purpose. Leaving the taken time
          highlighted invites a second click on a slot that cannot succeed.
        */
        if (result.slotStarts !== undefined) setSlots(result.slotStarts);
        setSelected(null);
        return;
      }

      setSlotError(null);
      setHeld({ holdId: result.holdId ?? "", expiresAt: result.expiresAt ?? "" });
    });
  }

  return (
    <div className="border-line bg-surface overflow-hidden rounded-xl border">
      <div className="border-line bg-raised border-b px-6 py-5">
        <h2 className="text-ink text-base font-semibold">
          {step === "details" ? "Your details" : "Choose a time"}
        </h2>
        <p className="text-ink-muted mt-1 text-sm">
          {step === "details"
            ? "So we know who the session is for."
            : `One to one · ${durationMinutes} minutes`}
        </p>
      </div>

      {step === "details" ? (
        <div className="px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="First name"
              value={draft.firstName}
              onChange={(value) => set("firstName", value)}
              error={errorFor("firstName")}
              autoComplete="given-name"
            />
            <Field
              label="Last name"
              value={draft.lastName}
              onChange={(value) => set("lastName", value)}
              error={errorFor("lastName")}
              autoComplete="family-name"
            />
          </div>
          <Field
            label="Email address"
            type="email"
            value={draft.email}
            onChange={(value) => set("email", value)}
            error={errorFor("email")}
            autoComplete="email"
            className="mt-3"
          />
          <Field
            label="Phone"
            optional
            type="tel"
            value={draft.phone}
            onChange={(value) => set("phone", value)}
            error={errorFor("phone")}
            autoComplete="tel"
            className="mt-3"
          />
          <Field
            label="What do you want to get out of this session?"
            value={draft.primaryGoal}
            onChange={(value) => set("primaryGoal", value)}
            error={errorFor("primaryGoal")}
            multiline
            className="mt-3"
          />

          {/*
            Unticked by default and never pre-ticked. Emails about a session
            somebody paid for are transactional; anything sent later is
            marketing, and that needs a recorded opt-in.
          */}
          <label className="mt-4 flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={draft.marketingConsent}
              onChange={(event) => set("marketingConsent", event.target.checked)}
              className="accent-accent mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="text-ink-muted text-xs leading-relaxed">
              Email me occasionally about new sessions and offers. You will get the emails about
              this booking either way.
            </span>
          </label>

          {formError !== null && (
            <p className="mt-4 text-xs leading-relaxed text-red-700">{formError}</p>
          )}

          <button
            type="button"
            onClick={continueToSlots}
            disabled={saving}
            className="bg-ink hover:bg-deep-soft mt-5 w-full rounded-lg px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Continue to choose a time"}
          </button>
        </div>
      ) : (
        <>
          <div className="border-line bg-canvas flex items-center justify-between border-b px-6 py-3">
            <p className="text-ink-muted truncate text-xs">
              {draft.firstName} {draft.lastName} · {draft.email}
            </p>
            <button
              type="button"
              onClick={() => setStep("details")}
              className="text-accent hover:text-accent-hover ml-3 shrink-0 text-xs font-semibold underline underline-offset-2"
            >
              Edit
            </button>
          </div>

          {/*
            The calendar scrolls inside the panel. Capped in viewport units
            rather than a fixed height so it still fits on a short laptop
            screen, where a fixed height would push the button below the fold.
          */}
          <div className="max-h-[min(26rem,45vh)] overflow-y-auto px-6 py-5">
            {availabilityFailed ? (
              /*
                Deliberately NOT "no times available". The server could not read
                the calendar, and telling somebody the diary is empty when we
                simply do not know would be a lie that costs a booking.
              */
              <p className="text-ink-muted text-sm leading-relaxed">
                We could not load available times just now. Please refresh the page in a moment, or
                get in touch and we will arrange one directly.
              </p>
            ) : (
              <SlotPicker
                slotStarts={slots}
                durationMinutes={durationMinutes}
                selectedIso={selected?.isoStart ?? null}
                onSelect={(slot) => {
                  // Choosing a different time abandons any claim on the old one.
                  setHeld(null);
                  setSlotError(null);
                  setSelected(slot);
                }}
                disabled={reserving}
              />
            )}
          </div>

          <div className="border-line bg-raised border-t px-6 py-5">
            {slotError !== null && (
              <p
                role="status"
                className="mb-4 rounded-lg bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-800"
              >
                {slotError}
              </p>
            )}

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

                {held === null ? (
                  <>
                    <button
                      type="button"
                      onClick={reserveAndContinue}
                      disabled={reserving}
                      className="bg-ink hover:bg-deep-soft mt-4 w-full rounded-lg px-6 py-3.5 text-sm font-semibold text-white transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {reserving ? "Holding your time…" : "Continue to payment"}
                    </button>
                    <p className="text-ink-muted mt-3 text-xs leading-relaxed">
                      Choosing a time reserves nothing on its own. The slot is held when you
                      continue, and the booking is confirmed only after payment is verified.
                    </p>
                  </>
                ) : (
                  <>
                    <p
                      role="status"
                      className="border-line bg-surface text-ink mt-4 rounded-lg border px-3 py-2.5 text-xs leading-relaxed"
                    >
                      This time is held for you until{" "}
                      <span className="font-semibold tabular-nums">
                        {formatClockTime(new Date(held.expiresAt), timeZone)}
                      </span>
                      .
                    </p>
                    {/*
                      Honest about where the flow actually stops. The hold is
                      real and the slot really is blocked; what does not exist
                      yet is the payment step that would convert it.
                    */}
                    <p className="text-ink-muted mt-3 text-xs leading-relaxed">
                      Payment is not connected yet, so the booking cannot be completed. The hold is
                      released automatically when it expires, and nothing has been charged.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  error,
  type = "text",
  optional = false,
  multiline = false,
  autoComplete,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  type?: string;
  optional?: boolean;
  multiline?: boolean;
  autoComplete?: string;
  className?: string;
}) {
  const shared = `mt-1.5 w-full rounded-lg border bg-surface px-3 py-2.5 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
    error === null ? "border-line-strong" : "border-red-600"
  }`;

  return (
    <label className={`block ${className}`}>
      <span className="text-ink text-xs font-semibold">
        {label}
        {optional && <span className="text-ink-faint font-normal"> (optional)</span>}
      </span>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${shared} resize-none`}
        />
      ) : (
        <input
          type={type}
          value={value}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
          className={shared}
        />
      )}
      {error !== null && <span className="mt-1.5 block text-xs text-red-700">{error}</span>}
    </label>
  );
}
