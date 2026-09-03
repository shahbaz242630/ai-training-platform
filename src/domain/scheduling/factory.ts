import { clientEnv, serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { graphCredentialsFromEnv, sharedGraphClient } from "@/lib/microsoft-graph";
import { GraphSchedulingProvider } from "./graph-provider";
import { MockSchedulingProvider } from "./mock-provider";
import { SchedulingError, type SchedulingProvider } from "./provider";

/**
 * The calendar the application actually uses.
 *
 * Graph whenever the four Microsoft values exist. Otherwise it depends on
 * where we are running:
 *
 *   production   REFUSES. An in-memory calendar in production would offer
 *                times the founder is busy, block nothing on the real diary,
 *                and issue no meeting link - all while looking exactly like
 *                it worked. The booking page already knows how to say that
 *                availability could not be read.
 *
 *   anything     the in-memory provider, with a warning on first use. It
 *   else         applies the real rules, so a booking flow that works against
 *                it is exercising real logic; it just knows nothing about the
 *                real diary. Staging and local development need this to be
 *                usable before a tenant is wired in.
 *
 * One instance per process, because the Graph client caches its token and a
 * new client per request would fetch a new token per page view.
 */

export class SchedulingNotConfiguredError extends SchedulingError {
  constructor() {
    super(
      "The calendar is not configured: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_CALENDAR_USER_ID are all required in production",
    );
    this.name = "SchedulingNotConfiguredError";
  }
}

const shared = globalThis as typeof globalThis & { schedulingProvider?: SchedulingProvider };

export function getSchedulingProvider(): SchedulingProvider {
  if (shared.schedulingProvider) return shared.schedulingProvider;
  shared.schedulingProvider = create();
  return shared.schedulingProvider;
}

/** Whether the real calendar is wired in, without constructing anything. */
export function calendarIsConfigured(): boolean {
  return graphCredentialsFromEnv() !== null && Boolean(serverEnv().MS_CALENDAR_USER_ID);
}

/** Test helper: forget the shared instance so the next call decides again. */
export function resetSchedulingProvider(): void {
  delete shared.schedulingProvider;
}

function create(): SchedulingProvider {
  const credentials = graphCredentialsFromEnv();
  const mailbox = serverEnv().MS_CALENDAR_USER_ID;

  if (credentials && mailbox) {
    return new GraphSchedulingProvider({ client: sharedGraphClient(credentials), mailbox });
  }

  if (clientEnv.NEXT_PUBLIC_SITE_ENV === "production") {
    throw new SchedulingNotConfiguredError();
  }

  logger.warn(
    "the calendar is not configured, so the in-memory scheduling provider is in use - " +
      "it applies the real rules but knows nothing about the real diary",
  );
  return new MockSchedulingProvider();
}
