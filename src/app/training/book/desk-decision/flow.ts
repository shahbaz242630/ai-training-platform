import { getSessionBySlug } from "@/config/sessions";
import type { QueryRunner } from "@/data/db";
import { declineWithdrawal, loadDeskNotice } from "@/data/withdrawals";
import { bookingReference } from "@/domain/booking/withdrawal";
import { describeInstant } from "@/domain/scheduling/slot-presentation";
import { readDeclineToken } from "@/lib/desk-link";
import { formatAed } from "@/lib/money";
import { GST_TIMEZONE } from "@/lib/time";

/**
 * The desk's decline of a withdrawal, from the link in its alert. Opening the
 * page only shows the notice; pressing the button is the decision. The link
 * is the authority, checked again at the press.
 */

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface DeskDeps {
  readonly transaction: TransactionRunner;
  readonly now: Date;
  readonly secret: string;
}

/** Where the notice stands, so the page offers the button only when there is a decision left. */
export type DeskNoticeState = "open" | "declined" | "refunded";

export interface DeskNoticeView {
  readonly reference: string;
  readonly sessionTitle: string;
  readonly received: string;
  readonly cardCountry: string;
  readonly amount: string;
  readonly state: DeskNoticeState;
  /** A refund no longer cancels a session that has started: the page must not say it does. */
  readonly sessionStarted: boolean;
}

export type DeskResult<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly message: string };

export const LINK_NOT_VALID =
  "This link is not valid or has expired. Open the latest reminder email for this withdrawal.";

function viewOf(
  notice: NonNullable<Awaited<ReturnType<typeof loadDeskNotice>>>,
  now: Date,
): DeskNoticeView {
  return {
    reference: bookingReference(notice.bookingId),
    sessionTitle: getSessionBySlug(notice.sessionSlug)?.title ?? "a session",
    received: describeInstant(notice.receivedAt, GST_TIMEZONE),
    cardCountry: notice.cardCountry ?? "could not be read",
    amount: formatAed(notice.amountFils),
    state: notice.paymentStatus === "refunded" ? "refunded" : notice.declined ? "declined" : "open",
    sessionStarted:
      notice.scheduledStart !== null && notice.scheduledStart.getTime() <= now.getTime(),
  };
}

async function noticeFor(token: string, deps: DeskDeps) {
  const bookingId = readDeclineToken(token, deps.now, deps.secret);
  if (bookingId === null) return null;
  const notice = await deps.transaction((runner) => loadDeskNotice(runner, bookingId));
  return notice?.route === "desk" ? notice : null;
}

/** What the link is about. Writes nothing. */
export async function loadDeskDecision(
  token: string,
  deps: DeskDeps,
): Promise<DeskResult<{ view: DeskNoticeView }>> {
  const notice = await noticeFor(token, deps);
  if (notice === null) return { ok: false, message: LINK_NOT_VALID };
  return { ok: true, view: viewOf(notice, deps.now) };
}

/** The press: record the decline, once. */
export async function confirmDecline(
  token: unknown,
  deps: DeskDeps,
): Promise<DeskResult<{ view: DeskNoticeView; bookingId: string; newlyDeclined: boolean }>> {
  if (typeof token !== "string" || token.length > 300) {
    return { ok: false, message: LINK_NOT_VALID };
  }
  const bookingId = readDeclineToken(token, deps.now, deps.secret);
  if (bookingId === null) return { ok: false, message: LINK_NOT_VALID };
  const outcome = await deps.transaction((runner) =>
    declineWithdrawal(runner, bookingId, deps.now),
  );
  const notice = await noticeFor(token, deps);
  if (notice === null) return { ok: false, message: LINK_NOT_VALID };
  return {
    ok: true,
    view: viewOf(notice, deps.now),
    bookingId,
    newlyDeclined: outcome === "declined",
  };
}
