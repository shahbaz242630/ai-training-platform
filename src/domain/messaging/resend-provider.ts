import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
} from "resend";
import { serverEnv } from "@/lib/env";
import {
  EmailNotConfiguredError,
  type EmailMessage,
  type EmailProvider,
  type SendResult,
} from "./provider";

/**
 * The real adapter.
 *
 * The SDK reports API failures as a value on the response rather than by
 * throwing, so a throw here means the request never got an answer - the
 * network, DNS, the process - and that is the one class of failure a retry
 * can always fix. Everything the API itself refuses comes back with a name,
 * and the names below are the ones worth trying again for. Anything else -
 * a bad address, a missing field, a rejected sender - will fail identically
 * next time, and retrying it only delays the moment somebody looks.
 */
const RETRYABLE = new Set([
  "rate_limit_exceeded",
  "internal_server_error",
  "application_error",
  "daily_quota_exceeded",
]);

/**
 * The slice of the SDK this adapter uses. Structural, so a test can hand in
 * an object with just this method while a real client satisfies it unchanged.
 */
export interface EmailsApi {
  send(
    payload: CreateEmailOptions,
    options?: CreateEmailRequestOptions,
  ): Promise<CreateEmailResponse>;
}

export interface ResendClientLike {
  readonly emails: EmailsApi;
}

export class ResendEmailProvider implements EmailProvider {
  private readonly client: ResendClientLike;
  private readonly from: string;

  /**
   * Constructed as an instance with its own key, never by setting a global.
   * Both the key and the sender are asserted here rather than at the first
   * send, so a misconfigured deployment fails when the sweep starts and not
   * when the first customer is waiting for a message.
   */
  constructor(client?: ResendClientLike, from?: string) {
    const env = serverEnv();

    const sender = from ?? env.EMAIL_FROM;
    if (!sender) throw new EmailNotConfiguredError("EMAIL_FROM");
    this.from = sender;

    if (client) {
      this.client = client;
    } else {
      if (!env.RESEND_API_KEY) throw new EmailNotConfiguredError("RESEND_API_KEY");
      this.client = new Resend(env.RESEND_API_KEY);
    }
  }

  async send(message: EmailMessage): Promise<SendResult> {
    let response: CreateEmailResponse;
    try {
      response = await this.client.emails.send(
        {
          from: this.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        },
        { idempotencyKey: message.idempotencyKey },
      );
    } catch (error) {
      return {
        ok: false,
        code: "network",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }

    if (response.error) {
      return {
        ok: false,
        code: response.error.name,
        message: response.error.message,
        retryable: RETRYABLE.has(response.error.name),
      };
    }

    if (!response.data) {
      // Neither an id nor an error is not a shape the API documents. Treated
      // as a transient fault rather than a success, because a success with
      // no id cannot be reconciled against anything later.
      return {
        ok: false,
        code: "empty_response",
        message: "the provider returned neither a message id nor an error",
        retryable: true,
      };
    }

    return { ok: true, providerMessageId: response.data.id };
  }
}
