import { GraphClient, GraphError } from "@/lib/microsoft-graph";
import type { EmailMessage, EmailProvider, SendResult } from "./provider";

/**
 * Email from the booking mailbox, through Microsoft Graph.
 *
 * The same mailbox that owns the calendar sends the mail, so a customer gets
 * the calendar invitation and every email from one address, and there is one
 * tenant, one registration and one secret to look after rather than a second
 * vendor. The permission is `Mail.Send` on that one mailbox, scoped by the
 * same application access policy as the calendar permission.
 *
 * Two things about Graph's send-mail call shape this adapter:
 *
 *   - It answers 202 Accepted with no identifier. So the id recorded against
 *     the queue row is our own key, and that key is also written into the
 *     message as a custom header, which is how the copy in Sent Items and the
 *     row can be matched later.
 *   - It has no idempotency key. The queue counts the attempt before the
 *     send and hands the same key each time, so the only way to deliver twice
 *     is a crash in the moments between Graph accepting and the row being
 *     marked - and the header makes even that visible.
 *
 * A message has one body. HTML is sent; the plain-text rendering is not
 * attached as an alternative part because the API has nowhere to put it.
 */

export interface GraphEmailProviderOptions {
  readonly client: GraphClient;
  /** The mailbox that sends: an address or a directory object id. */
  readonly mailbox: string;
}

/** Custom headers must start with `X-`; this is ours. */
const KEY_HEADER = "X-Booking-Communication";

/**
 * Failures the API names that will fail identically next time. Everything
 * else Graph refuses with a 4xx is treated the same way; only throttling and
 * server errors are worth a retry.
 */
export class GraphEmailProvider implements EmailProvider {
  private readonly client: GraphClient;
  private readonly mailbox: string;

  constructor(options: GraphEmailProviderOptions) {
    this.client = options.client;
    this.mailbox = options.mailbox;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      await this.client.request({
        method: "POST",
        path: `/users/${encodeURIComponent(this.mailbox)}/sendMail`,
        body: {
          message: {
            subject: message.subject,
            body: { contentType: "HTML", content: message.html },
            toRecipients: [{ emailAddress: { address: message.to } }],
            internetMessageHeaders: [{ name: KEY_HEADER, value: message.idempotencyKey }],
          },
          saveToSentItems: true,
        },
      });
    } catch (error) {
      if (error instanceof GraphError) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
      }
      return {
        ok: false,
        code: "network",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }

    return { ok: true, providerMessageId: `graph:${message.idempotencyKey}` };
  }
}
