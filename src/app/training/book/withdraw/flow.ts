import { z } from "zod";
import { contactLine } from "@/components/ui/ContactLink";
import { getSessionBySlug } from "@/config/sessions";
import type { QueryRunner } from "@/data/db";
import {
  findBookingForWithdrawal,
  recordWithdrawal,
  type BookingForWithdrawal,
} from "@/data/withdrawals";
import {
  bookingReference,
  decideWithdrawal,
  normaliseReference,
  withdrawalStatement,
  type WithdrawalRefusal,
} from "@/domain/booking/withdrawal";
import { describeInstant, presentSlots } from "@/domain/scheduling/slot-presentation";
import { formatAed } from "@/lib/money";

/**
 * The "withdraw from contract here" function, in two steps, as the law
 * describes it: the customer identifies the booking and sees what withdrawing
 * means (step 1, "Continue"), then confirms (step 2, "Confirm withdrawal").
 *
 * Everything is decided again on the server at step 2. The browser only ever
 * holds what the customer typed; the booking, the refund and the statement are
 * recomputed from the database at the moment of confirming.
 */

const MAX_NAME = 200;

export const withdrawalFormSchema = z
  .object({
    fullName: z.string().trim().min(1, "Please enter your name.").max(MAX_NAME),
    email: z.string().trim().max(320).email("Please enter the email address you booked with."),
    reference: z.string().max(40),
    consumer: z.literal(true, {
      error: "Please confirm you live in the UK or EU and booked for yourself.",
    }),
  })
  .strict();

export type WithdrawalForm = z.infer<typeof withdrawalFormSchema>;

export interface WithdrawalSummary {
  readonly reference: string;
  readonly sessionTitle: string;
  /** e.g. "Friday, 20 November 2026, 15:00 - 16:30"; null while no time is arranged. */
  readonly sessionTime: string | null;
  readonly amountPaid: string;
  readonly refundDue: string;
  readonly statement: string;
}

export interface WithdrawalReceipt {
  readonly received: string;
  readonly refundDue: string;
  /** False when the notice had already been received earlier: no new email goes. */
  readonly isNew: boolean;
}

export type FlowResult<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly message: string };

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface FlowDeps {
  readonly transaction: TransactionRunner;
  readonly now: Date;
}

export const NOT_FOUND_MESSAGE = (): string =>
  "We could not find a paid booking with that reference and email address. Please check both " +
  `against your booking emails, or ${contactLine()} and we will help.`;

const REFUSALS: Record<WithdrawalRefusal, () => string> = {
  not_paid: () =>
    `That booking has no payment to refund. If you think this is wrong, please ${contactLine()}.`,
  closed: () =>
    `That booking is already cancelled or has taken place. If you need help, please ${contactLine()}.`,
  period_over: () =>
    "The 14 days to withdraw from this booking have ended. Our Booking and Refund Policy " +
    `explains your other options, or ${contactLine()}.`,
  session_started: () =>
    "Your session has already started, so we need to work out together what was delivered. " +
    `Please ${contactLine()}.`,
};

function parse(input: unknown): FlowResult<{ form: WithdrawalForm; reference: string }> {
  const parsed = withdrawalFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const reference = normaliseReference(parsed.data.reference);
  if (reference === null) {
    return {
      ok: false,
      message: "The booking reference is the 8 letters and numbers in your booking emails.",
    };
  }
  return { ok: true, form: parsed.data, reference };
}

function describe(
  booking: BookingForWithdrawal,
  form: WithdrawalForm,
  refundDueFils: number,
): WithdrawalSummary | null {
  const session = getSessionBySlug(booking.sessionSlug);
  if (!session) return null;
  const reference = bookingReference(booking.bookingId);
  let sessionTime: string | null = null;
  if (booking.scheduledStart !== null) {
    const end = new Date(booking.scheduledStart.getTime() + session.durationMinutes * 60_000);
    const [day] = presentSlots([{ start: booking.scheduledStart, end }], booking.customerTimezone);
    const slot = day?.slots[0];
    if (day && slot) sessionTime = `${day.label}, ${slot.localTime} (${booking.customerTimezone})`;
  }
  return {
    reference,
    sessionTitle: session.title,
    sessionTime,
    amountPaid: formatAed(booking.amountPaidFils),
    refundDue: formatAed(refundDueFils),
    statement: withdrawalStatement({
      fullName: form.fullName,
      sessionTitle: session.title,
      reference,
    }),
  };
}

/** Step 1: find the booking and show what withdrawing means. Writes nothing. */
export async function lookUpWithdrawal(
  input: unknown,
  deps: FlowDeps,
): Promise<FlowResult<{ summary: WithdrawalSummary; alreadyReceived: WithdrawalReceipt | null }>> {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;

  const booking = await deps.transaction((runner) =>
    findBookingForWithdrawal(runner, parsed.reference, parsed.form.email),
  );
  if (booking === null) return { ok: false, message: NOT_FOUND_MESSAGE() };

  if (booking.withdrawal !== null) {
    const summary = describe(booking, parsed.form, booking.withdrawal.refundDueFils);
    if (!summary) return { ok: false, message: NOT_FOUND_MESSAGE() };
    return {
      ok: true,
      summary,
      alreadyReceived: {
        received: describeInstant(booking.withdrawal.receivedAt, booking.customerTimezone),
        refundDue: formatAed(booking.withdrawal.refundDueFils),
        isNew: false,
      },
    };
  }

  const decision = decideWithdrawal({ ...booking, now: deps.now });
  if (!decision.ok) return { ok: false, message: REFUSALS[decision.reason]() };

  const summary = describe(booking, parsed.form, decision.refundDueFils);
  if (!summary) return { ok: false, message: NOT_FOUND_MESSAGE() };
  return { ok: true, summary, alreadyReceived: null };
}

export interface ConfirmContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** Step 2: decide again from the database, then keep the notice. */
export async function confirmWithdrawal(
  input: unknown,
  deps: FlowDeps,
  context: ConfirmContext,
): Promise<FlowResult<{ receipt: WithdrawalReceipt; bookingId: string }>> {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;

  return deps.transaction(async (runner) => {
    const booking = await findBookingForWithdrawal(runner, parsed.reference, parsed.form.email);
    if (booking === null) return { ok: false, message: NOT_FOUND_MESSAGE() };

    let refundDueFils: number;
    if (booking.withdrawal !== null) {
      refundDueFils = booking.withdrawal.refundDueFils;
    } else {
      const decision = decideWithdrawal({ ...booking, now: deps.now });
      if (!decision.ok) return { ok: false, message: REFUSALS[decision.reason]() };
      refundDueFils = decision.refundDueFils;
    }

    const summary = describe(booking, parsed.form, refundDueFils);
    if (!summary) return { ok: false, message: NOT_FOUND_MESSAGE() };

    const recorded = await recordWithdrawal(runner, {
      bookingId: booking.bookingId,
      fullName: parsed.form.fullName,
      email: parsed.form.email,
      statement: summary.statement,
      refundDueFils,
      receivedAt: deps.now,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return {
      ok: true,
      bookingId: booking.bookingId,
      receipt: {
        received: describeInstant(recorded.receivedAt, booking.customerTimezone),
        refundDue: formatAed(recorded.refundDueFils),
        isNew: recorded.created,
      },
    };
  });
}
