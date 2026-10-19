"use client";

import { useState, useTransition } from "react";
import { declineWithdrawalAction } from "./actions";
import type { DeskNoticeView } from "./flow";

/** The one press that records the decline. The page shows the notice; this decides. */
export function DeclineButton({ token }: { readonly token: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<DeskNoticeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <p role="status" className="text-ink-soft mt-5 text-[15px] leading-relaxed">
        {done.state === "refunded"
          ? "This payment has already been refunded, so the withdrawal was approved. Nothing was declined."
          : "Declined. The booking stands and nothing was refunded, and the daily alert stops. If you have not written to the customer yet, do it now from the knowledgecentre@ inbox: their withdrawal page already says a reply is on its way."}
      </p>
    );
  }
  return (
    <>
      {error ? (
        <p role="alert" className="text-ink-soft mt-4 text-[14.5px] leading-relaxed">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await declineWithdrawalAction(token);
            if (result.ok) setDone(result.view);
            else setError(result.message);
          })
        }
        className="bg-ink hover:bg-deep-soft text-on-deep mt-5 w-full rounded-full px-6 py-3.5 text-[15.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Recording…" : "Decline this withdrawal"}
      </button>
    </>
  );
}
