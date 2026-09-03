import type { EmailMessage, EmailProvider, SendResult } from "./provider";

/**
 * An email provider that sends nothing.
 *
 * Exists so the queue, the sweep and the templates can be built and tested
 * with no API key, no verified sending domain and no network - and so CI can
 * run the whole path. It is the only implementation that can.
 *
 * It is a real implementation of the contract rather than a stub that agrees
 * with the caller. In particular it honours idempotency the way the real
 * provider does: a repeated key returns the ORIGINAL result and records no
 * second send. A mock that quietly sent twice would hide exactly the
 * double-send bug the key exists to prevent.
 */
export class MockEmailProvider implements EmailProvider {
  /** Every message that was actually "sent", in order, so a test can read what a customer would have received. */
  readonly sent: EmailMessage[] = [];

  private readonly byIdempotencyKey = new Map<string, SendResult>();
  private readonly queuedFailures: Extract<SendResult, { ok: false }>[] = [];
  private counter = 0;

  /**
   * Make the next send fail with this result. Failures are not recorded
   * against the idempotency key, matching the real provider: a key is only
   * reserved by a request that succeeded, so the retry of a failed send goes
   * through.
   */
  failNext(result: Extract<SendResult, { ok: false }>): void {
    this.queuedFailures.push(result);
  }

  send(message: EmailMessage): Promise<SendResult> {
    const seen = this.byIdempotencyKey.get(message.idempotencyKey);
    if (seen) return Promise.resolve(seen);

    const failure = this.queuedFailures.shift();
    if (failure) return Promise.resolve(failure);

    this.counter += 1;
    const result: SendResult = { ok: true, providerMessageId: `email_mock_${this.counter}` };
    this.sent.push(message);
    this.byIdempotencyKey.set(message.idempotencyKey, result);
    return Promise.resolve(result);
  }
}
