import type { EmailProvider } from "./provider";
import { EmailNotConfiguredError } from "./provider";
import { GraphEmailProvider } from "./graph-provider";
import { serverEnv } from "@/lib/env";
import { graphCredentialsFromEnv, sharedGraphClient } from "@/lib/microsoft-graph";

/**
 * The email provider the application actually uses: the booking desk's own
 * mailbox, through Microsoft Graph, with the same registration the calendar
 * uses.
 *
 * The sender is its own setting, MS_MAIL_SENDER_ID, and deliberately not the
 * calendar's mailbox: the diary lives on one mailbox (where the coach's other
 * meetings block slots) while customers write to and hear from the booking
 * desk's shared mailbox. A missing sender is NOT replaced by the calendar's
 * mailbox, because a customer would then be emailed from, and reply to, an
 * address nobody reads for bookings.
 *
 * There is NO fallback to the mock when Graph is unconfigured, for the same
 * reason the payment factory has none: a sweep that "sends" every queued
 * message into memory would mark them sent, and a customer who paid would be
 * recorded as told when they were told nothing. Missing configuration
 * throws, the sweep reports that email is unavailable, and the queue keeps
 * waiting - which is recoverable, where a false "sent" is not.
 *
 * The mock is imported by tests only. Nothing here can reach it.
 */
export function getEmailProvider(): EmailProvider {
  const credentials = graphCredentialsFromEnv();
  if (!credentials) {
    throw new EmailNotConfiguredError("MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET");
  }
  const mailbox = serverEnv().MS_MAIL_SENDER_ID;
  if (!mailbox) throw new EmailNotConfiguredError("MS_MAIL_SENDER_ID");

  return new GraphEmailProvider({ client: sharedGraphClient(credentials), mailbox });
}

/** Whether sending is possible at all, without constructing anything. */
export function emailIsConfigured(): boolean {
  return graphCredentialsFromEnv() !== null && Boolean(serverEnv().MS_MAIL_SENDER_ID);
}
