import { describe, expect, it, vi } from "vitest";
import type { CreateEmailResponse } from "resend";
import { EmailNotConfiguredError } from "./provider";
import { ResendEmailProvider, type ResendClientLike } from "./resend-provider";

const message = {
  to: "amina@example.com",
  subject: "Your session",
  html: "<p>Hi</p>",
  text: "Hi",
  idempotencyKey: "communication:abc",
};

function client(
  response: CreateEmailResponse | Error,
): ResendClientLike & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { emails: { send }, send };
}

const success: CreateEmailResponse = { data: { id: "email_123" }, error: null, headers: null };
const failure = (name: string): CreateEmailResponse => ({
  data: null,
  error: { name: name as never, message: `because ${name}`, statusCode: 400 },
  headers: null,
});

describe("ResendEmailProvider", () => {
  it("refuses to construct without a sender, before any send is attempted", () => {
    expect(() => new ResendEmailProvider(client(success), undefined)).toThrow(
      EmailNotConfiguredError,
    );
  });

  it("sends from the configured address, with both bodies and the idempotency key", async () => {
    const fake = client(success);
    const provider = new ResendEmailProvider(fake, "Bookings <bookings@example.com>");

    const result = await provider.send(message);

    expect(result).toEqual({ ok: true, providerMessageId: "email_123" });
    expect(fake.send).toHaveBeenCalledWith(
      {
        from: "Bookings <bookings@example.com>",
        to: ["amina@example.com"],
        subject: "Your session",
        html: "<p>Hi</p>",
        text: "Hi",
      },
      { idempotencyKey: "communication:abc" },
    );
  });

  it("reports a transient API refusal as retryable", async () => {
    const provider = new ResendEmailProvider(
      client(failure("rate_limit_exceeded")),
      "b@example.com",
    );
    expect(await provider.send(message)).toEqual({
      ok: false,
      code: "rate_limit_exceeded",
      message: "because rate_limit_exceeded",
      retryable: true,
    });
  });

  it("reports a refusal that will not change on retry as final", async () => {
    for (const name of ["validation_error", "invalid_from_address", "missing_required_field"]) {
      const provider = new ResendEmailProvider(client(failure(name)), "b@example.com");
      expect(await provider.send(message)).toMatchObject({
        ok: false,
        code: name,
        retryable: false,
      });
    }
  });

  it("treats a request that never got an answer as retryable", async () => {
    const provider = new ResendEmailProvider(client(new Error("ECONNRESET")), "b@example.com");
    expect(await provider.send(message)).toEqual({
      ok: false,
      code: "network",
      message: "ECONNRESET",
      retryable: true,
    });
  });

  it("does not call a response with neither id nor error a success", async () => {
    const provider = new ResendEmailProvider(
      // A shape the types rule out and the wire can still produce.
      client({ data: null, error: null, headers: null } as unknown as CreateEmailResponse),
      "b@example.com",
    );
    expect(await provider.send(message)).toMatchObject({
      ok: false,
      code: "empty_response",
      retryable: true,
    });
  });
});
