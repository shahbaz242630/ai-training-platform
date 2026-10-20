import { describe, expect, it, vi } from "vitest";
import { checkoutChallenge, TURNSTILE_ACTION, verifyTurnstile } from "./turnstile";
import { logger } from "./logger";

/*
  The person check in front of checkout start (audit s101 #3 part 2): one
  caller starting checkouts without paying could hold every slot. A hold is
  taken only after Cloudflare says this token was solved, on this host, for
  this action. Everything that is not a clear yes is a no: "could not check"
  must never pass. No network: Cloudflare's answers are shaped like the real
  siteverify responses.
*/

const SECRET = "0x4AAAAAAAtestsecret-not-real";
const HOST = "coaching.zaaheen.com";

const answer = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const passed = (extra: Record<string, unknown> = {}) =>
  answer({
    success: true,
    action: TURNSTILE_ACTION,
    hostname: HOST,
    "error-codes": [],
    ...extra,
  });

function recorder(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
    const next = answers.shift();
    if (next === undefined) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const verify = (token: unknown, fetchImpl: typeof fetch) =>
  verifyTurnstile({ token, secret: SECRET, expectedHostname: HOST, fetchImpl });

describe("verifyTurnstile", () => {
  it("passes a token Cloudflare solved for this host and this action", async () => {
    const { calls, fetchImpl } = recorder(passed());
    expect(await verify("tok", fetchImpl)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(calls[0]!.body.get("secret")).toBe(SECRET);
    expect(calls[0]!.body.get("response")).toBe("tok");
    expect(calls[0]!.body.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/);
    // Not sent: behind two proxies our idea of the caller's address may be wrong.
    expect(calls[0]!.body.has("remoteip")).toBe(false);
  });

  it("refuses what Cloudflare refuses", async () => {
    const { fetchImpl } = recorder(
      answer({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    );
    expect(await verify("tok", fetchImpl)).toEqual({ ok: false, kind: "refused" });
  });

  it("refuses a token solved for another action", async () => {
    const { fetchImpl } = recorder(passed({ action: "login" }));
    expect(await verify("tok", fetchImpl)).toEqual({ ok: false, kind: "refused" });
  });

  it("refuses a token solved on another host", async () => {
    const { fetchImpl } = recorder(passed({ hostname: "evil.example" }));
    expect(await verify("tok", fetchImpl)).toEqual({ ok: false, kind: "refused" });
  });

  it("compares the host without regard to case", async () => {
    const { fetchImpl } = recorder(passed({ hostname: "Coaching.Zaaheen.com" }));
    expect(await verify("tok", fetchImpl)).toEqual({ ok: true });
  });

  it("refuses a missing, empty, non-string or oversized token without asking Cloudflare", async () => {
    for (const token of [undefined, null, "", 42, {}, "x".repeat(2049)]) {
      const { calls, fetchImpl } = recorder(passed());
      expect(await verify(token, fetchImpl)).toEqual({ ok: false, kind: "refused" });
      expect(calls).toHaveLength(0);
    }
  });

  it("accepts a token of exactly the longest length Cloudflare issues", async () => {
    const { fetchImpl } = recorder(passed());
    expect(await verify("x".repeat(2048), fetchImpl)).toEqual({ ok: true });
  });

  it("retries once with the same key when Cloudflare reports its own error", async () => {
    const { calls, fetchImpl } = recorder(
      answer({ success: false, "error-codes": ["internal-error"] }),
      passed(),
    );
    expect(await verify("tok", fetchImpl)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.get("idempotency_key")).toBe(calls[0]!.body.get("idempotency_key"));
  });

  it("retries once after a network failure, then says it could not check", async () => {
    const { calls, fetchImpl } = recorder(new Error("offline"), new Error("offline"));
    expect(await verify("tok", fetchImpl)).toEqual({ ok: false, kind: "unreachable" });
    expect(calls).toHaveLength(2);
  });

  it("treats a server error or an unreadable answer as could-not-check, never as a pass", async () => {
    const bad = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Response;
    for (const first of [answer({}, 502), bad]) {
      const { fetchImpl } = recorder(first, answer({}, 503));
      expect(await verify("tok", fetchImpl)).toEqual({ ok: false, kind: "unreachable" });
    }
  });

  it("does not take success that is merely truthy", async () => {
    const { fetchImpl } = recorder(passed({ success: "true" }));
    expect(await verify("tok", fetchImpl)).toEqual({ ok: false, kind: "refused" });
  });

  /*
    A wrong secret, or keys from two different widgets, refuses every customer
    with "couldn't check that you're a person": our fault, not theirs. Logged
    as an error so it is noticed, where a customer's failed check is a warning.
  */
  it("reports our own misconfiguration as an error, and a customer's failure as a warning", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    for (const code of ["invalid-input-secret", "missing-input-secret", "bad-request"]) {
      const { fetchImpl } = recorder(answer({ success: false, "error-codes": [code] }));
      expect(await verify("tok", fetchImpl)).toEqual({ ok: false, kind: "refused" });
    }
    expect(error).toHaveBeenCalledTimes(3);
    error.mockClear();
    const { fetchImpl } = recorder(
      answer({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    await verify("tok", fetchImpl);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it("stops after a pass on the retry without a third call", async () => {
    const { calls, fetchImpl } = recorder(new Error("offline"), passed());
    expect(await verify("tok", fetchImpl)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe("checkoutChallenge", () => {
  const settings = { secret: SECRET, siteKey: "0x4AAAAAAAsitekey" };
  const siteUrl = "https://coaching.zaaheen.com";
  const contact = "email knowledgecentre@zaaheen.com";

  it("asks nothing while the check is switched off", async () => {
    const { calls, fetchImpl } = recorder();
    expect(
      await checkoutChallenge({ settings: null, token: undefined, siteUrl, contact, fetchImpl }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("lets a person through", async () => {
    const { fetchImpl } = recorder(passed());
    expect(
      await checkoutChallenge({ settings, token: "tok", siteUrl, contact, fetchImpl }),
    ).toBeNull();
  });

  it("checks against the host of the site's own address", async () => {
    const { fetchImpl } = recorder(passed({ hostname: "khaki-mosquito-667632.hostingersite.com" }));
    const refusal = await checkoutChallenge({
      settings,
      token: "tok",
      siteUrl,
      contact,
      fetchImpl,
    });
    expect(refusal?.reason).toBe("challenge_failed");
  });

  it("refuses a missing token with a plain way forward", async () => {
    const { fetchImpl } = recorder();
    const refusal = await checkoutChallenge({
      settings,
      token: undefined,
      siteUrl,
      contact,
      fetchImpl,
    });
    expect(refusal).toEqual({
      reason: "challenge_failed",
      message: "We couldn't check that you're a person. Please try again.",
    });
  });

  it("says so, with how to reach us, when the check could not be made at all", async () => {
    const { fetchImpl } = recorder(new Error("offline"), new Error("offline"));
    const refusal = await checkoutChallenge({
      settings,
      token: "tok",
      siteUrl,
      contact,
      fetchImpl,
    });
    expect(refusal).toEqual({
      reason: "challenge_failed",
      message:
        "We couldn't check that you're a person just now. Please try again in a minute, or email knowledgecentre@zaaheen.com and we will book you in.",
    });
  });

  it("names no provider in what the customer reads", async () => {
    for (const answers of [[], [new Error("x"), new Error("x")]] as const) {
      const { fetchImpl } = recorder(...answers);
      const refusal = await checkoutChallenge({
        settings,
        token: answers.length ? "tok" : undefined,
        siteUrl,
        contact,
        fetchImpl,
      });
      expect(refusal?.message).not.toMatch(/cloudflare|turnstile|captcha/i);
    }
  });
});

/*
  The log lines name the step that asked (audit s104 review): lead capture
  now asks too, and the refusals are only useful as a signal when the two can
  be counted apart.
*/
describe("the log lines", () => {
  it("name lead capture when it asked, and checkout by default", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const settings = { secret: "s", siteKey: "k" };
      const base = { settings, token: undefined, siteUrl: "https://example.test", contact: "c" };
      await checkoutChallenge({ ...base, purpose: "lead capture" });
      await checkoutChallenge(base);
      expect(warn.mock.calls.map((call) => call[0])).toEqual([
        "lead capture refused: no usable person-check token",
        "checkout refused: no usable person-check token",
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
