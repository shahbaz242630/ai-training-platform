"use client";

import { useMemo, useState, useTransition } from "react";
import { SlotPicker, type SelectedSlot } from "./SlotPicker";
import { useCustomerTimeZone } from "./useCustomerTimeZone";
import { captureLeadAction, startCheckoutAction } from "@/app/training/book/[slug]/actions";
import { parsePrePaymentIntake, type IntakeFieldError } from "@/domain/intake/pre-payment-intake";
import { startsWithinCancellationPeriod } from "@/domain/booking/cancellation-period";
import {
  AGREEMENT_TEXT,
  EXPRESS_REQUEST_TEXT,
  KEY_TERMS,
  TERMS_VERSION,
} from "@/config/booking-terms";
import { POLICY_LINKS } from "@/config/site";
import { ContactLink } from "@/components/ui/ContactLink";

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
  /** Whether a payment can be taken at all. Decided on the server. */
  readonly paymentsAvailable?: boolean;
}

export function BookingPanel({
  slug,
  slotStarts,
  durationMinutes,
  priceLabel,
  availabilityFailed = false,
  paymentsAvailable = true,
}: BookingPanelProps) {
  const timeZone = useCustomerTimeZone();
  const [step, setStep] = useState<Step>("details");
  const [draft, setDraft] = useState<DetailsDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<readonly IntakeFieldError[]>([]);
  const [selected, setSelected] = useState<SelectedSlot | null>(null);
  const [saving, startSaving] = useTransition();
  const [reserving, startReserving] = useTransition();
  const [slotError, setSlotError] = useState<string | null>(null);
  // Never pre-ticked. What they say is stored word for word by the server.
  const [agreed, setAgreed] = useState(false);
  const [expressRequest, setExpressRequest] = useState(false);

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
   * Claim the chosen time and go and pay for it.
   *
   * Selecting a radio button deliberately reserves nothing. Somebody weighing
   * up four times would otherwise take four slots off the calendar for fifteen
   * minutes each without paying for any of them.
   *
   * On success the browser leaves for the payment page, so there is no
   * success state to render here - only the ways it can fail.
   */
  function reserveAndContinue() {
    if (selected === null || !ticksComplete) return;
    const wanted = selected.isoStart;

    startReserving(async () => {
      const result = await startCheckoutAction({
        slug,
        slotStart: wanted,
        consent: { agreedToTerms: agreed, expressRequest, termsVersion: TERMS_VERSION },
      });

      if (!result.ok) {
        setSlotError(result.message ?? "That time is no longer available.");
        /*
          Losing a race clears the selection on purpose. Leaving the taken time
          highlighted invites a second click on a slot that cannot succeed.
        */
        if (result.slotStarts !== undefined) setSlots(result.slotStarts);
        if (result.reason === "slot_taken" || result.reason === "not_offered") setSelected(null);
        return;
      }

      if (result.redirectUrl === undefined) {
        setSlotError("We could not reach the payment page. Please try again in a moment.");
        return;
      }

      /*
        A full navigation rather than a router push. The destination is the
        payment provider, not a route in this application, and the browser
        must genuinely leave.
      */
      window.location.assign(result.redirectUrl);
    });
  }

  /*
    Whether this slot needs the 14-day express request. Shown here so the box
    appears with the time that needs it; the server decides again from the
    slot and refuses a booking without it.
  */
  const needsExpressRequest =
    selected !== null && startsWithinCancellationPeriod(new Date(selected.isoStart), new Date());
  const ticksComplete = agreed && (!needsExpressRequest || expressRequest);

  /*
    Said once, at the top, before anybody types anything. Letting somebody
    complete a form for an outcome that cannot happen wastes their time and
    captures a lead for a booking that could never have completed.
  */
  if (!paymentsAvailable) {
    return (
      <div className="border-line-strong bg-surface overflow-hidden rounded-2xl border shadow-[0_24px_60px_rgba(38,34,28,.08)]">
        <div className="border-line bg-raised border-b px-6 py-5">
          <h2 className="text-ink font-serif text-[21px] font-medium">Booking is not open yet</h2>
        </div>
        <div className="px-6 py-5">
          <p className="text-ink-soft text-[14.5px] leading-relaxed">
            We cannot take payment online at the moment, so this session cannot be booked here yet.
            Please email <ContactLink showAddress /> and we will arrange a time with you directly.
          </p>
          <p className="text-ink-faint mt-3 text-[13px] leading-relaxed">
            Nothing you enter here would be saved, so there is no form to fill in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-line-strong bg-surface overflow-hidden rounded-2xl border shadow-[0_24px_60px_rgba(38,34,28,.08)]">
      <div className="border-line bg-raised flex items-start justify-between gap-3 border-b px-6 py-5">
        <div>
          <h2 className="text-ink font-serif text-[21px] font-medium">
            {step === "details" ? "Your details" : "Choose a time"}
          </h2>
          <p className="text-ink-muted mt-1 text-sm">
            {step === "details"
              ? "So we know who the session is for."
              : `One to one · ${durationMinutes} minutes`}
          </p>
        </div>
        <p className="text-ink-faint shrink-0 pt-[5px] font-mono text-xs">
          {step === "details" ? "1 of 2" : "2 of 2"}
        </p>
      </div>

      {step === "details" ? (
        <div className="px-6 pt-[22px] pb-6">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3.5">
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
            className="mt-3.5"
          />
          <Field
            label="Phone"
            optional
            type="tel"
            value={draft.phone}
            onChange={(value) => set("phone", value)}
            error={errorFor("phone")}
            autoComplete="tel"
            className="mt-3.5"
          />
          <Field
            label="What do you want to get out of this session?"
            value={draft.primaryGoal}
            onChange={(value) => set("primaryGoal", value)}
            error={errorFor("primaryGoal")}
            multiline
            className="mt-3.5"
          />

          {/*
            Unticked by default and never pre-ticked. Emails about a session
            somebody paid for are transactional; anything sent later is
            marketing, and that needs a recorded opt-in.
          */}
          <label className="mt-4 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={draft.marketingConsent}
              onChange={(event) => set("marketingConsent", event.target.checked)}
              className="accent-accent-ring mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="text-ink-muted text-[13px] leading-[1.55]">
              Email me occasionally about new sessions and offers. You will get the emails about
              this booking either way.
            </span>
          </label>

          {formError !== null && (
            <p className="text-error mt-4 text-[12.5px] leading-relaxed">{formError}</p>
          )}

          <button
            type="button"
            onClick={continueToSlots}
            disabled={saving}
            className="bg-ink hover:bg-deep-soft text-on-deep mt-5 w-full rounded-full px-6 py-3.5 text-[15.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Continue to choose a time"}
          </button>
        </div>
      ) : (
        <>
          <div className="border-line bg-canvas flex items-center justify-between gap-3 border-b px-6 py-2.5">
            <p className="text-ink-muted truncate text-[13px]">
              {draft.firstName} {draft.lastName} · {draft.email}
            </p>
            <button
              type="button"
              onClick={() => setStep("details")}
              className="text-accent hover:text-accent-hover shrink-0 text-[13px] font-medium underline underline-offset-[3px]"
            >
              Edit
            </button>
          </div>

          {/*
            The calendar scrolls inside the panel. Capped in viewport units
            rather than a fixed height so it still fits on a short laptop
            screen, where a fixed height would push the button below the fold.
          */}
          <div className="max-h-[min(25rem,45vh)] overflow-y-auto px-6 py-5">
            {availabilityFailed ? (
              /*
                Deliberately NOT "no times available". The server could not read
                the calendar, and telling somebody the diary is empty when we
                simply do not know would be a lie that costs a booking.
              */
              <p className="text-ink-soft text-[14.5px] leading-relaxed">
                We could not load available times just now. Please refresh the page in a moment, or
                email <ContactLink showAddress /> and we will arrange one directly.
              </p>
            ) : (
              <SlotPicker
                slotStarts={slots}
                durationMinutes={durationMinutes}
                selectedIso={selected?.isoStart ?? null}
                onSelect={(slot) => {
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
                className="bg-error-soft border-error-soft-line text-error mb-4 rounded-[10px] border px-[13px] py-[11px] text-[13.5px] leading-normal"
              >
                {slotError}
              </p>
            )}

            {selected === null ? (
              <p className="text-ink-muted text-sm">Select a time to continue.</p>
            ) : (
              <div className="animate-z-in">
                <p className="text-ink-faint font-mono text-xs">Your session</p>
                <p className="text-ink mt-2 text-[15px] font-medium">{selected.dayLabel}</p>
                <p className="text-ink text-[15px] tabular-nums">
                  {selected.localTime}
                  {selected.gstReference !== null && (
                    <span className="text-ink-muted ml-2 text-xs">{selected.gstReference}</span>
                  )}
                </p>

                <div className="border-line-strong mt-3.5 flex items-baseline justify-between border-t pt-3.5">
                  <span className="text-ink-muted text-sm">Total</span>
                  <span className="text-ink font-serif text-[22px] font-medium tabular-nums">
                    {priceLabel}
                  </span>
                </div>

                <KeyTerms />

                <label className="mt-3.5 flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(event) => setAgreed(event.target.checked)}
                    className="accent-accent-ring mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span className="text-ink-soft text-[13px] leading-[1.55]">
                    {AGREEMENT_TEXT}{" "}
                    <span className="text-ink-muted">
                      Read the{" "}
                      <a
                        href={POLICY_LINKS.terms}
                        target="_blank"
                        rel="noopener"
                        className="text-accent underline underline-offset-[3px]"
                      >
                        Coaching Terms
                      </a>{" "}
                      and the{" "}
                      <a
                        href={POLICY_LINKS.bookingAndRefunds}
                        target="_blank"
                        rel="noopener"
                        className="text-accent underline underline-offset-[3px]"
                      >
                        Booking and Refund Policy
                      </a>
                      .
                    </span>
                  </span>
                </label>

                {needsExpressRequest && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={expressRequest}
                      onChange={(event) => setExpressRequest(event.target.checked)}
                      className="accent-accent-ring mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span className="text-ink-soft text-[13px] leading-[1.55]">
                      {EXPRESS_REQUEST_TEXT}
                    </span>
                  </label>
                )}

                <button
                  type="button"
                  onClick={reserveAndContinue}
                  disabled={reserving || !ticksComplete}
                  className="bg-ink hover:bg-deep-soft text-on-deep mt-3.5 w-full rounded-full px-6 py-3.5 text-[15.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reserving ? "Taking you to payment…" : "Continue to payment"}
                </button>
                <p className="text-ink-muted mt-3 text-[12.5px] leading-[1.55]">
                  Choosing a time reserves nothing on its own. Your slot is held while you pay, and
                  the booking is confirmed only once the payment is verified.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The key terms, in bold, directly above the boxes and the payment button.
 * The same lines are stored with the booking, so this must render KEY_TERMS
 * exactly and add nothing of its own.
 */
function KeyTerms() {
  return (
    <div className="border-line-strong bg-surface mt-4 rounded-[12px] border px-4 py-3.5">
      <p className="text-ink text-[13.5px] font-semibold">Before you pay: the key terms</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-4">
        {KEY_TERMS.map((line) => (
          <li key={line} className="text-ink text-[13px] leading-[1.5] font-semibold">
            {line}
          </li>
        ))}
      </ul>
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
  const shared = `mt-1.5 box-border w-full min-w-0 rounded-[10px] border bg-surface px-[13px] py-[11px] text-[15px] text-ink outline-none transition-shadow focus:border-accent-ring focus:shadow-[0_0_0_3px_rgba(127,174,142,.2)] ${
    error === null ? "border-line-strong" : "border-error-line"
  }`;

  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="text-ink text-[13.5px] font-medium">
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
      {error !== null && <span className="text-error mt-1.5 block text-[12.5px]">{error}</span>}
    </label>
  );
}
