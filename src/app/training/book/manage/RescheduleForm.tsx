"use client";

import { useState, useTransition } from "react";
import { BOOKING_POLICY, TRAINING_BASE } from "@/config/site";
import { moveBookingAction } from "./actions";
import type { ManageView } from "./flow";

/** The other thing a UK or EU customer may want to do here: the withdrawal page, prefilled. */
function WithdrawNote({ reference }: { readonly reference: string }) {
  return (
    <p className="text-ink-muted mt-4 text-[12.5px] leading-normal">
      Live in the UK or EU and want to cancel within {BOOKING_POLICY.cancellationDays} days instead?{" "}
      <a
        href={`${TRAINING_BASE}/book/withdraw?ref=${reference}`}
        className="text-accent underline underline-offset-[3px]"
      >
        Withdraw from contract here
      </a>
      .
    </p>
  );
}

/**
 * Pick a new time, then confirm. Nothing here decides anything: the server
 * checks the link, the policy and that the time is still open when the
 * customer confirms.
 */

const PRIMARY =
  "bg-ink hover:bg-deep-soft text-on-deep mt-5 w-full rounded-full px-6 py-3.5 text-[15.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";

export function RescheduleForm({
  token,
  view,
}: {
  readonly token: string;
  readonly view: ManageView;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const facts = (
    <Facts
      rows={[
        ["Session", view.sessionTitle],
        [movedTo ? "Was" : "Time", view.sessionTime],
        ...(movedTo ? ([["Now", movedTo]] as const) : []),
        ["Booking reference", view.reference],
      ]}
    />
  );

  if (movedTo) {
    return (
      <Card title="Your session has moved">
        {facts}
        <p className="text-ink-soft mt-4 text-[14.5px] leading-relaxed">
          We are emailing you the new details, with the joining link and a file to update your
          calendar. This was your one move, so the new time is final.
        </p>
      </Card>
    );
  }

  if (view.notMovable !== null || view.days === null) {
    return (
      <Card title="Your booking">
        {facts}
        <p className="text-ink-soft mt-4 text-[14.5px] leading-relaxed">{view.notMovable}</p>
        <WithdrawNote reference={view.reference} />
      </Card>
    );
  }

  function confirm() {
    if (chosen === null) return setError("Please choose a new time.");
    setError(null);
    startTransition(async () => {
      const result = await moveBookingAction({ token, slotStart: chosen });
      if (!result.ok) return setError(result.message);
      setMovedTo(result.newTime);
    });
  }

  return (
    <Card title="Move your session">
      {facts}
      {view.days.length === 0 ? (
        <p className="text-ink-soft mt-4 text-[14.5px] leading-relaxed">
          There are no open times to move to right now. Please check again later.
        </p>
      ) : (
        <fieldset className="mt-5">
          <legend className="text-ink text-[13.5px] font-medium">Choose a new time</legend>
          <div className="mt-2 max-h-[360px] space-y-4 overflow-y-auto pr-1">
            {view.days.map((day) => (
              <div key={day.label}>
                <p className="text-ink-muted text-[13px]">{day.label}</p>
                <div className="mt-1.5 grid gap-2">
                  {day.slots.map((slot) => (
                    <label
                      key={slot.isoStart}
                      className="border-line-strong has-[:checked]:border-accent-ring flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2.5"
                    >
                      <input
                        type="radio"
                        name="slot"
                        value={slot.isoStart}
                        checked={chosen === slot.isoStart}
                        onChange={() => setChosen(slot.isoStart)}
                        className="accent-accent-ring h-4 w-4 shrink-0"
                      />
                      <span className="text-ink text-[14.5px] tabular-nums">
                        {slot.localTime}
                        {slot.gstReference ? (
                          <span className="text-ink-muted"> · {slot.gstReference}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {error ? (
        <p
          role="alert"
          className="bg-error-soft border-error-soft-line text-error mt-4 rounded-[10px] border px-[13px] py-[11px] text-[13.5px] leading-normal"
        >
          {error}
        </p>
      ) : null}
      {view.days.length > 0 ? (
        <button type="button" onClick={confirm} disabled={pending} className={PRIMARY}>
          {pending ? "Moving…" : "Reschedule my session"}
        </button>
      ) : null}
      <p className="text-ink-muted mt-3 text-[12.5px] leading-normal">
        You can move a booking once. After that, the new time is final.
      </p>
      <WithdrawNote reference={view.reference} />
    </Card>
  );
}

function Card({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="border-line-strong bg-surface overflow-hidden rounded-2xl border shadow-[0_24px_60px_rgba(38,34,28,.08)]">
      <div className="border-line bg-raised border-b px-6 py-5">
        <h2 className="text-ink font-serif text-[21px] font-medium">{title}</h2>
      </div>
      <div className="px-6 pt-[22px] pb-6">{children}</div>
    </div>
  );
}

function Facts({ rows }: { readonly rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
          <dt className="text-ink-muted text-sm">{label}</dt>
          <dd className="text-ink text-[14.5px] font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
