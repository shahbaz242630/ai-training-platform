import { NextResponse } from "next/server";
import { withTransaction } from "@/data/db";
import { claimDueCommunications, countFailedCommunications } from "@/data/communications";
import { getEmailProvider } from "@/domain/messaging/factory";
import type { EmailProvider } from "@/domain/messaging/provider";
import { authoriseCronRequest } from "@/lib/cron-auth";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { deliver, type Outcome } from "./deliver";

/**
 * Send what is due.
 *
 * Called every five minutes by a database-scheduled job that carries a shared
 * secret. It takes a bounded batch of queued messages whose time has come,
 * renders each from the current template, sends it, and records the result.
 *
 * TWO RULES SHAPE EVERYTHING HERE:
 *
 *   A failed send never breaks a booking. Every failure is recorded against
 *   its own row and the loop moves on. Only the infrastructure failing - no
 *   database, no provider configured - fails the run, and it fails with a
 *   500 so it is never mistaken for a quiet period.
 *
 *   A customer gets one email, not two. The row is claimed and its attempt
 *   counted BEFORE the send, and the claim keeps every other sender off it
 *   for longer than the slowest send can take (data/communications.ts). The
 *   email service does not dedupe, so the claim is what does. One row is
 *   claimed at a time: a row claimed for a batch would sit behind the sends
 *   before it, its lease running down while nothing was being sent.
 */

export const dynamic = "force-dynamic";

/** Enough to drain a normal five minutes many times over; small enough that a backlog drains in steps. */
const BATCH_SIZE = 50;

export async function POST(request: Request): Promise<NextResponse> {
  const auth = authoriseCronRequest(request.headers.get("authorization"), serverEnv().CRON_SECRET);

  if (auth === "not_configured") {
    logger.error("cron secret is not configured, so no messages can be sent");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  if (auth === "unauthorised") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let provider: EmailProvider;
  try {
    provider = getEmailProvider();
  } catch {
    /*
      Nothing is claimed while email is unconfigured. The queue waits, which
      is recoverable; a run that claimed rows and could not send them would
      count attempts against messages nobody tried to send.
    */
    logger.error("email is not configured, so queued messages are waiting");
    return NextResponse.json({ error: "Email not configured" }, { status: 500 });
  }

  try {
    const outcomes: Record<Outcome, number> = { sent: 0, retry: 0, failed: 0, withdrawn: 0 };
    let claimed = 0;
    // Claim, send, record, then the next: at most BATCH_SIZE a run, as before.
    while (claimed < BATCH_SIZE) {
      const now = new Date();
      const [row] = await withTransaction((runner) => claimDueCommunications(runner, now, 1));
      if (!row) break;
      claimed += 1;
      outcomes[await deliver(row, provider, now)] += 1;
    }

    const failedInTotal = await withTransaction((runner) => countFailedCommunications(runner));
    if (failedInTotal > 0) {
      /*
        A standing alarm, on every run, until somebody deals with it. These
        are messages a customer was promised and will not get without a
        human - the same shape as a paid booking with no slot.
      */
      logger.error("messages have been given up on and need a person", { failed: failedInTotal });
    }

    return NextResponse.json({ ok: true, claimed, ...outcomes, failedInTotal });
  } catch (error) {
    logger.error("the send run could not complete", { error: (error as Error).name });
    return NextResponse.json({ error: "Send run failed" }, { status: 500 });
  }
}
