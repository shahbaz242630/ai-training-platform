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

let sink: AuditSink = loggerSink;

export function setAuditSink(next: AuditSink): void {
  sink = next;
}

export function resetAuditSink(): void {
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
    logger.error("audit sink failed - event not persisted", {
      action: event.action,
      subject: event.subject,
      error,
    });
  }
}
