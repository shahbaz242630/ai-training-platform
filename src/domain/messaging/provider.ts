/**
 * The email port.
 *
 * Everything that sends a message to a customer talks to this interface and
 * never to a vendor SDK, for the same reasons as the payment port: a route
 * that calls the vendor directly cannot be tested without a live key, cannot
 * run for a contributor who has none, and welds the booking flow to one
 * supplier. Two implementations sit behind it - an in-memory one for tests
 * and the real adapter.
 *
 * The result is a VALUE, not an exception. The caller is a queue sweep that
 * has to decide, per message, whether to try again later or give up, and
 * that decision needs the reason in a shape it can branch on. A thrown error
 * would collapse "the provider is rate-limiting us" and "this address does
 * not exist" into one path, and only one of those is worth retrying.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /** Always sent alongside the HTML. Some clients show only this, and it is what a screen reader gets. */
  readonly text: string;
  /**
   * Sent to the provider so a retried request cannot deliver twice. Derived
   * from the queue row, never random: a retry must present the same key or
   * it is not idempotent at all.
   */
  readonly idempotencyKey: string;
}

export type SendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | {
      readonly ok: false;
      /** The provider's own code, or `network` when the request never got an answer. */
      readonly code: string;
      readonly message: string;
      /**
       * Whether trying again later could succeed. A rate limit is; a
       * malformed address is not, and retrying it five times only delays
       * the moment somebody looks at it.
       */
      readonly retryable: boolean;
    };

export interface EmailProvider {
  send(message: EmailMessage): Promise<SendResult>;
}

/** The provider is not configured - no key, no sender. Distinct from a failed send. */
export class EmailNotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured, so email cannot be sent`);
    this.name = "EmailNotConfiguredError";
  }
}
