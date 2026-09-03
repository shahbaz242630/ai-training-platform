import { addMinutes } from "@/lib/time";
import type { TemplateKey } from "./sending-policy";

/**
 * When each message about a booking should go, and what to do when a send
 * fails.
 *
 * Every instant here is UTC. The customer's time zone matters when the email
 * is RENDERED, not when it is scheduled: "24 hours before the session" is the
 * same moment everywhere.
 */

/** A send that has failed this many times is left for a person. */
export const MAX_SEND_ATTEMPTS = 5;

const REMINDER_24H_MINUTES = 24 * 60;
const REMINDER_3H_MINUTES = 3 * 60;
/** Long enough that a session which overran has still ended; short enough that the day is still in mind. */
const FOLLOW_UP_DELAY_MINUTES = 60;

export interface ScheduledMessage {
  readonly templateKey: TemplateKey;
  readonly scheduledFor: Date;
}

/** The moment a payment settles: an acknowledgement, straight away. */
export function messagesOnSettlement(now: Date): readonly ScheduledMessage[] {
  return [{ templateKey: "payment_receipt", scheduledFor: now }];
}

export interface ConfirmationInput {
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly now: Date;
}

/**
 * The moment a booking is confirmed with a joining link.
 *
 * A reminder whose moment has already passed is not sent late. Somebody who
 * books a session for later today would otherwise get the confirmation and
 * "your session is tomorrow" in the same minute, which reads as a mistake and
 * makes the next message easier to ignore.
 */
export function messagesOnConfirmation(input: ConfirmationInput): readonly ScheduledMessage[] {
  const messages: ScheduledMessage[] = [
    { templateKey: "booking_confirmation", scheduledFor: input.now },
  ];

  const reminder24h = addMinutes(input.scheduledStart, -REMINDER_24H_MINUTES);
  if (reminder24h.getTime() > input.now.getTime()) {
    messages.push({ templateKey: "reminder_24h", scheduledFor: reminder24h });
  }

  const reminder3h = addMinutes(input.scheduledStart, -REMINDER_3H_MINUTES);
  if (reminder3h.getTime() > input.now.getTime()) {
    messages.push({ templateKey: "reminder_3h", scheduledFor: reminder3h });
  }

  messages.push({
    templateKey: "follow_up",
    scheduledFor: addMinutes(input.scheduledEnd, FOLLOW_UP_DELAY_MINUTES),
  });

  return messages;
}

/**
 * When to try a failed send again, given how many attempts have been made
 * INCLUDING the one that just failed. Null means stop: the message is marked
 * failed and left for a person.
 *
 * Doubling from one minute, so a provider having a bad few minutes is retried
 * quickly and a provider having a bad hour is not hammered.
 */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_SEND_ATTEMPTS) return null;
  return addMinutes(now, 2 ** (attempts - 1));
}
