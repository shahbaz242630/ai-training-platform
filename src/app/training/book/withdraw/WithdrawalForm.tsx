"use client";

import { useState, useTransition } from "react";
import { confirmWithdrawalAction, lookUpWithdrawalAction } from "./actions";
import type { WithdrawalReceipt, WithdrawalSummary } from "./flow";

/**
 * The two steps: identify the booking and see what withdrawing means, then
 * confirm. Nothing here decides anything; the server checks it all again at
 * each step. The form keeps only what the customer typed.
 */

type Step =
  | { readonly kind: "details" }
  | { readonly kind: "confirm"; readonly summary: WithdrawalSummary }
  | {
      readonly kind: "done";
      readonly summary: WithdrawalSummary | null;
      readonly receipt: WithdrawalReceipt;
    };

const FIELD =
  "mt-1.5 box-border w-full min-w-0 rounded-[10px] border border-line-strong bg-surface px-[13px] py-[11px] text-[15px] text-ink outline-none transition-shadow focus:border-accent-ring focus:shadow-[0_0_0_3px_rgba(127,174,142,.2)]";
const PRIMARY =
  "bg-ink hover:bg-deep-soft text-on-deep mt-5 w-full rounded-full px-6 py-3.5 text-[15.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";

export function WithdrawalForm({ initialReference }: { readonly initialReference: string }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [reference, setReference] = useState(initialReference);
  const [consumer, setConsumer] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "details" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const form = { fullName, email, reference, consumer };

  function lookUp(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await lookUpWithdrawalAction(form);
      if (!result.ok) return setError(result.message);
      setStep(
        result.alreadyReceived
          ? { kind: "done", summary: result.summary, receipt: result.alreadyReceived }
          : { kind: "confirm", summary: result.summary },
      );
    });
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await confirmWithdrawalAction(form);
      if (!result.ok) return setError(result.message);
      setStep({
        kind: "done",
        summary: step.kind === "confirm" ? step.summary : null,
        receipt: result.receipt,
      });
    });
  }

  const errorBox = error ? (
    <p
      role="alert"
      className="bg-error-soft border-error-soft-line text-error mt-4 rounded-[10px] border px-[13px] py-[11px] text-[13.5px] leading-normal"
    >
      {error}
    </p>
  ) : null;

  if (step.kind === "done") {
    return (
      <Card
        title={
          step.receipt.isNew
            ? "We have received your withdrawal"
            : "We already have your withdrawal"
        }
      >
        <Facts
          rows={[
            ["Received", step.receipt.received],
            ...(step.summary
              ? ([
                  ["Session", step.summary.sessionTitle],
                  ["Booking reference", step.summary.reference],
                ] as const)
              : []),
            ["Refund", step.receipt.refundDue],
          ]}
        />
        <p className="text-ink-soft mt-4 text-[14.5px] leading-relaxed">
          Your booking is cancelled. We will refund {step.receipt.refundDue} to the card you paid
          with within 14 days, at no cost to you.{" "}
          {step.receipt.isNew
            ? "We are emailing you a copy of this confirmation."
            : "We emailed you a confirmation when we received it."}
        </p>
      </Card>
    );
  }

  if (step.kind === "confirm") {
    const { summary } = step;
    return (
      <Card title="Check and confirm">
        <Facts
          rows={[
            ["Session", summary.sessionTitle],
            ["Time", summary.sessionTime ?? "Not arranged yet"],
            ["Booking reference", summary.reference],
            ["Paid", summary.amountPaid],
            ["Refund", summary.refundDue],
          ]}
        />
        <div className="border-line-strong bg-canvas mt-4 rounded-[12px] border px-4 py-3.5">
          <p className="text-ink-faint font-mono text-xs">Your notice</p>
          <p className="text-ink mt-1.5 text-[14.5px] leading-relaxed">{summary.statement}</p>
        </div>
        {errorBox}
        <button type="button" onClick={confirm} disabled={pending} className={PRIMARY}>
          {pending ? "Sending…" : "Confirm withdrawal"}
        </button>
        <button
          type="button"
          onClick={() => setStep({ kind: "details" })}
          disabled={pending}
          className="text-accent hover:text-accent-hover mt-3 w-full text-[14px] font-medium underline underline-offset-[3px]"
        >
          Go back
        </button>
      </Card>
    );
  }

  return (
    <Card title="Withdraw from contract here">
      <form onSubmit={lookUp} noValidate>
        <label className="block">
          <span className="text-ink text-[13.5px] font-medium">Your full name</span>
          <input
            className={FIELD}
            value={fullName}
            autoComplete="name"
            maxLength={200}
            onChange={(e) => setFullName(e.target.value)}
          />
        </label>
        <label className="mt-3.5 block">
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
          <span className="text-ink text-[13.5px] font-medium">Booking reference</span>
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
        <label className="mt-4 flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={consumer}
            onChange={(e) => setConsumer(e.target.checked)}
            className="accent-accent-ring mt-0.5 h-4 w-4 shrink-0"
          />
          <span className="text-ink-soft text-[13px] leading-[1.55]">
            I live in the United Kingdom or the European Union and booked this session for myself,
            not for my business.
          </span>
        </label>
        {errorBox}
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Checking…" : "Continue"}
        </button>
      </form>
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
