import { logger } from "@/lib/logger";

/**
 * Audit trail for commercially significant events.
 *
 * Distinct from application logging: logs explain what the system did, an audit
 * trail is evidence of what happened to someone's money and booking. It must be
 * append-only, attributable and never silently dropped.
 *
 * Phase 2 adds a Postgres sink. Until the database exists this writes through
 * the redacting logger, so the call sites and the event vocabulary are already
 * correct when persistence lands.
 */

export type AuditAction =
  | "order.created"
  | "order.payment_succeeded"
  | "order.payment_failed"
  | "order.refunded"
  | "booking.slot_held"
  | "booking.hold_released"
  | "booking.confirmed"
  | "booking.rescheduled"
  | "booking.cancelled"
  | "booking.completed"
  | "booking.no_show"
  | "webhook.received"
  | "webhook.duplicate_ignored"
  | "webhook.signature_rejected"
  | "admin.signed_in"
  | "admin.action";

/** Who caused it. `system` covers cron sweeps and webhook-driven transitions. */
export type AuditActor =
  | { readonly kind: "customer"; readonly customerId: string }
  | { readonly kind: "admin"; readonly adminId: string }
  | { readonly kind: "system"; readonly process: string }
  | { readonly kind: "provider"; readonly provider: "stripe" | "microsoft" | "resend" };

export interface AuditEvent {
  readonly action: AuditAction;
  readonly actor: AuditActor;
  /** The thing acted upon, e.g. `order:01H...`. */
  readonly subject: string;
  /** Never put secrets or card data here - it is redacted, but do not rely on it. */
  readonly metadata?: Record<string, unknown>;
  readonly occurredAt: string;
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

const loggerSink: AuditSink = (event) => {
  logger.info("audit", { ...event });
};

/**
 * The real sink: the database, with the logger as a last resort.
 *
 * This used to write ONLY to the logger, which meant the audit trail lived on
 * the host's stdout - not queryable, rotated away, and owned by nobody. That
 * is not evidence of what happened to somebody's money.
 *
 * The logger line on failure is NOT a fallback that makes a database failure
 * acceptable. It is there so an event is never lost in silence: the write is
 * attempted, and if it cannot happen the failure is escalated rather than
 * swallowed. The dynamic import keeps `lib` free of a load-time dependency on
 * a database connection, so importing this module in a context without one
 * still works.
 */
const databaseSink: AuditSink = async (event) => {
  const [{ withTransaction }, { insertAuditEvent }] = await Promise.all([
    import("@/data/db"),
    import("@/data/audit-events"),
  ]);
  await withTransaction((runner) => insertAuditEvent(runner, event));
};

let sink: AuditSink = databaseSink;

export function setAuditSink(next: AuditSink): void {
  sink = next;
}

export function resetAuditSink(): void {
  sink = databaseSink;
}

/** The stdout sink, for contexts that genuinely have no database. */
export function useLoggerAuditSink(): void {
  sink = loggerSink;
}

/**
 * Records an audit event.
 *
 * Deliberately never throws. A failure to write the audit trail must not roll
 * back a payment that already succeeded - but it must be loud, so the failure
 * is escalated to error level rather than swallowed.
 */
export async function recordAudit(
  input: Omit<AuditEvent, "occurredAt"> & { occurredAt?: string },
): Promise<void> {
  const event: AuditEvent = {
    ...input,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };

  try {
    await sink(event);
  } catch (error) {
    /*
      The event still reaches somewhere. Losing the payment because the audit
      write failed would be far worse than an audit row that only exists in a
      log line - but the failure is reported at error level so it is never
      mistaken for a quiet success.
    */
    logger.error("audit sink failed - event NOT persisted to the database", {
      action: event.action,
      subject: event.subject,
      occurredAt: event.occurredAt,
      error,
    });
    loggerSink(event);
  }
}
