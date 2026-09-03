import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "@/lib/microsoft-graph";
import { GraphEmailProvider } from "./graph-provider";
import type { EmailMessage } from "./provider";

/**
 * The mail adapter against a scripted Graph. What is sent is asserted in
 * full, because the first real send should have nothing left to prove about
 * the request - only about the tenant's permission.
 */

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { method: string; url: string; body: unknown };

function scripted(answers: Scripted[]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body:
        typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null,
    });
    const next = answers.shift();
    if (!next) throw new Error("scripted graph ran out of answers");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const token = { status: 200, body: { access_token: "tok", expires_in: 3600 } };
const sleeps: number[] = [];

function provider(answers: Scripted[], fetchOverride?: typeof fetch) {
  const { fetchImpl, calls } = scripted([token, ...answers]);
  const client = new GraphClient({
    credentials: { tenantId: "t", clientId: "c", clientSecret: "s" },
    fetch: fetchOverride ?? fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxAttempts: 2,
  });
  return { mail: new GraphEmailProvider({ client, mailbox: "booking@example.com" }), calls };
}

const message: EmailMessage = {
  to: "amina@example.com",
  subject: "Booked: your session",
  html: "<p>Hello</p>",
  text: "Hello",
  idempotencyKey: "communication:abc-123",
};

describe("GraphEmailProvider", () => {
  it("sends from the mailbox with the HTML body, the recipient and our key as a header", async () => {
    const { mail, calls } = provider([{ status: 202 }]);

    const result = await mail.send(message);

    expect(result).toEqual({ ok: true, providerMessageId: "graph:communication:abc-123" });
    const [, send] = calls;
    expect(send?.method).toBe("POST");
    expect(send?.url).toBe("https://graph.microsoft.com/v1.0/users/booking%40example.com/sendMail");
    expect(send?.body).toEqual({
      message: {
        subject: "Booked: your session",
        body: { contentType: "HTML", content: "<p>Hello</p>" },
        toRecipients: [{ emailAddress: { address: "amina@example.com" } }],
        internetMessageHeaders: [
          { name: "X-Booking-Communication", value: "communication:abc-123" },
        ],
      },
      saveToSentItems: true,
    });
  });

  it("reports a refusal that will not change on retry as final, with Graph's code", async () => {
    const { mail } = provider([
      { status: 400, body: { error: { code: "ErrorInvalidRecipients", message: "bad address" } } },
    ]);

    expect(await mail.send(message)).toEqual({
      ok: false,
      code: "ErrorInvalidRecipients",
      message: "Graph 400 ErrorInvalidRecipients: bad address",
      retryable: false,
    });
  });

  it("reports a denied sender as final, which is what a missing permission looks like", async () => {
    const { mail } = provider([
      { status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied" } } },
    ]);
    expect(await mail.send(message)).toMatchObject({
      ok: false,
      code: "ErrorAccessDenied",
      retryable: false,
    });
  });

  it("lets the client absorb throttling, and reports exhaustion as retryable", async () => {
    sleeps.length = 0;
    const throttled = {
      status: 429,
      body: { error: { code: "TooManyRequests", message: "slow" } },
      headers: { "Retry-After": "3" },
    };
    const { mail } = provider([throttled, throttled]);

    expect(await mail.send(message)).toMatchObject({
      ok: false,
      code: "TooManyRequests",
      retryable: true,
    });
    expect(sleeps).toEqual([3000]);
  });

  it("treats a request that never got an answer as retryable", async () => {
    const dead = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const { mail } = provider([], dead);

    expect(await mail.send(message)).toEqual({
      ok: false,
      code: "network",
      message: "ECONNRESET",
      retryable: true,
    });
  });
});
