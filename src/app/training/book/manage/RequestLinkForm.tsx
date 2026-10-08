"use client";

import { useState, useTransition } from "react";
import { requestManageLinkAction } from "./actions";

/**
 * Ask for a link by email. The answer is the same whether or not a booking
 * exists for the address: the link only ever arrives in that inbox.
 */

const FIELD =
  "mt-1.5 box-border w-full min-w-0 rounded-[10px] border border-line-strong bg-surface px-[13px] py-[11px] text-[15px] text-ink outline-none transition-shadow focus:border-accent-ring focus:shadow-[0_0_0_3px_rgba(127,174,142,.2)]";
const PRIMARY =
  "bg-ink hover:bg-deep-soft text-on-deep mt-5 w-full rounded-full px-6 py-3.5 text-[15.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";

export function RequestLinkForm({ notice }: { readonly notice?: string | null }) {
  const [email, setEmail] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await requestManageLinkAction({ email, reference });
      if (!result.ok) return setError(result.message);
      setDone(result.message);
    });
  }

  return (
    <div className="border-line-strong bg-surface overflow-hidden rounded-2xl border shadow-[0_24px_60px_rgba(38,34,28,.08)]">
      <div className="border-line bg-raised border-b px-6 py-5">
        <h2 className="text-ink font-serif text-[21px] font-medium">Get a link to your booking</h2>
      </div>
      <div className="px-6 pt-[22px] pb-6">
        {notice ? (
          <p className="text-ink-soft mb-4 text-[14.5px] leading-relaxed">{notice}</p>
        ) : null}
        {done ? (
          <p role="status" className="text-ink-soft text-[14.5px] leading-relaxed">
            {done}
          </p>
        ) : (
          <form onSubmit={submit} noValidate>
            <label className="block">
              <span className="text-ink text-[13.5px] font-medium">
                The email address you booked with
              </span>
              <input
                className={FIELD}
                type="email"
                value={email}
                autoComplete="email"
                maxLength={320}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="mt-3.5 block">
              <span className="text-ink text-[13.5px] font-medium">
                Booking reference <span className="text-ink-muted font-normal">(optional)</span>
              </span>
              <input
                className={`${FIELD} font-mono uppercase`}
                value={reference}
                autoComplete="off"
                maxLength={40}
                onChange={(e) => setReference(e.target.value)}
              />
              <span className="text-ink-muted mt-1.5 block text-[12.5px]">
                8 letters and numbers, in your booking emails.
              </span>
            </label>
            {error ? (
              <p
                role="alert"
                className="bg-error-soft border-error-soft-line text-error mt-4 rounded-[10px] border px-[13px] py-[11px] text-[13.5px] leading-normal"
              >
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? "Sending…" : "Email me a link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
