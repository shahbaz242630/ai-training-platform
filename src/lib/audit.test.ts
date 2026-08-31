import { describe, it, expect, afterEach, vi } from "vitest";
import {
  recordAudit,
  setAuditSink,
  resetAuditSink,
  useLoggerAuditSink,
  type AuditEvent,
} from "./audit";
import { setLogSink, resetLogSink, REDACTED } from "./logger";

afterEach(() => {
  resetAuditSink();
  resetLogSink();
});

describe("recordAudit", () => {
  it("stamps occurredAt when the caller does not supply one", async () => {
    const seen: AuditEvent[] = [];
    setAuditSink((event) => void seen.push(event));

    await recordAudit({
      action: "order.payment_succeeded",
      actor: { kind: "provider", provider: "stripe" },
      subject: "order:abc",
    });

    expect(seen[0]!.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("never throws when the sink fails, and escalates to error", async () => {
    const logs: { level: string; message: string }[] = [];
    setLogSink((record) => logs.push(record));
    setAuditSink(() => {
      throw new Error("database unreachable");
    });

    // A failed audit write must not roll back a payment that already succeeded.
    await expect(
      recordAudit({
        action: "order.payment_succeeded",
        actor: { kind: "provider", provider: "stripe" },
        subject: "order:abc",
      }),
    ).resolves.toBeUndefined();

    expect(logs.some((l) => l.level === "error")).toBe(true);
  });

  it("redacts sensitive metadata on the way to the log sink", async () => {
    const logs: { context?: Record<string, unknown> }[] = [];
    setLogSink((record) => logs.push(record));
    /*
      The default sink is now the DATABASE. This test is about what the logger
      does to a value on the way through, so it asks for the logger sink
      explicitly rather than relying on it being the default - which it was
      when this test was written and no longer is.
    */
    useLoggerAuditSink();

    await recordAudit({
      action: "webhook.received",
      actor: { kind: "provider", provider: "stripe" },
      subject: "evt_123",
      metadata: { signingSecret: "whsec_real" },
    });

    const context = logs[0]!.context as { metadata: Record<string, unknown> };
    expect(context.metadata.signingSecret).toBe(REDACTED);
  });

  it("awaits an async sink so a persisted write cannot be lost", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    setAuditSink(write);

    await recordAudit({
      action: "booking.confirmed",
      actor: { kind: "system", process: "stripe-webhook" },
      subject: "booking:1",
    });

    expect(write).toHaveBeenCalledOnce();
  });
});
