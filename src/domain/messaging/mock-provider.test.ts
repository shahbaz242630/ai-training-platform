import { describe, expect, it } from "vitest";
import { MockEmailProvider } from "./mock-provider";
import type { EmailMessage } from "./provider";

const message = (key: string): EmailMessage => ({
  to: "amina@example.com",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
  idempotencyKey: key,
});

describe("MockEmailProvider", () => {
  it("records what it sent, with a distinct id per message", async () => {
    const provider = new MockEmailProvider();

    const first = await provider.send(message("a"));
    const second = await provider.send(message("b"));

    expect(first).toEqual({ ok: true, providerMessageId: "email_mock_1" });
    expect(second).toEqual({ ok: true, providerMessageId: "email_mock_2" });
    expect(provider.sent.map((m) => m.idempotencyKey)).toEqual(["a", "b"]);
  });

  it("returns the original result for a repeated key and sends nothing new", async () => {
    const provider = new MockEmailProvider();
    const first = await provider.send(message("same"));

    const again = await provider.send(message("same"));

    expect(again).toEqual(first);
    expect(provider.sent).toHaveLength(1);
  });

  it("fails once when told to, then recovers, and does not reserve the key for the failure", async () => {
    const provider = new MockEmailProvider();
    provider.failNext({
      ok: false,
      code: "rate_limit_exceeded",
      message: "slow down",
      retryable: true,
    });

    const failed = await provider.send(message("k"));
    const retried = await provider.send(message("k"));

    expect(failed).toMatchObject({ ok: false, code: "rate_limit_exceeded" });
    expect(retried).toMatchObject({ ok: true });
    expect(provider.sent).toHaveLength(1);
  });
});
