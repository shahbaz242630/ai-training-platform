import { describe, expect, it, vi } from "vitest";
import {
  GraphClient,
  GraphError,
  GraphNotFoundError,
  graphCredentialsFromEnv,
  type GraphCredentials,
} from "./microsoft-graph";
import { resetLogSink, setLogSink, type LogRecord } from "./logger";

const env = vi.hoisted(() => ({
  MS_TENANT_ID: undefined as string | undefined,
  MS_CLIENT_ID: undefined as string | undefined,
  MS_CLIENT_SECRET: undefined as string | undefined,
}));

vi.mock("@/lib/env", () => ({ serverEnv: () => ({ ...env }) }));

/**
 * The client against a scripted fetch. Every behaviour a real tenant would
 * exercise - token caching, refresh on 401, throttling, the error envelope,
 * paging - is driven here so the first real call has nothing left to prove
 * about the client itself.
 */

const CREDENTIALS: GraphCredentials = {
  tenantId: "tenant-id",
  clientId: "client-id",
  clientSecret: "super-secret-value",
};

type Scripted = {
  status: number;
  body?: unknown;
  /** Sent verbatim instead of JSON, for answers that are not JSON at all. */
  raw?: string;
  headers?: Record<string, string>;
};

/** A fetch that answers from a queue and records what it was asked. */
function scriptedFetch(answers: Scripted[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("scripted fetch ran out of answers");
    // A 204 or 202 must be constructed with no body at all, not an empty one.
    const text =
      next.raw !== undefined
        ? next.raw
        : next.body === undefined
          ? null
          : JSON.stringify(next.body);
    return new Response(text, {
      status: next.status,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const token = (expiresIn = 3600) => ({
  status: 200,
  body: { access_token: "tok_1", expires_in: expiresIn, token_type: "Bearer" },
});

let clock = new Date("2026-09-10T10:00:00Z");
const now = () => clock;
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

function client(answers: Scripted[], maxAttempts = 3) {
  const { impl, calls } = scriptedFetch(answers);
  return {
    graph: new GraphClient({ credentials: CREDENTIALS, fetch: impl, now, sleep, maxAttempts }),
    calls,
  };
}

describe("tokens", () => {
  it("acquires a token with the client credentials, then reuses it", async () => {
    const { graph, calls } = client([
      token(),
      { status: 200, body: { id: "a" } },
      { status: 200, body: { id: "b" } },
    ]);

    await graph.request({ method: "GET", path: "/users/x/events/a" });
    await graph.request({ method: "GET", path: "/users/x/events/b" });

    expect(calls[0]?.url).toBe("https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token");
    const form = String(calls[0]?.init.body);
    expect(form).toContain("grant_type=client_credentials");
    expect(form).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
    expect(form).toContain("client_secret=super-secret-value");
    expect(calls).toHaveLength(3);
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
    expect((calls[2]?.init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
  });

  it("refreshes a token that is about to expire", async () => {
    const { graph, calls } = client([
      token(90),
      { status: 200, body: {} },
      token(3600),
      { status: 200, body: {} },
    ]);

    await graph.request({ method: "GET", path: "/a" });
    clock = new Date(clock.getTime() + 45_000); // 45s left: inside the one-minute margin
    await graph.request({ method: "GET", path: "/b" });

    expect(calls.filter((c) => c.url.includes("/oauth2/"))).toHaveLength(2);
    clock = new Date("2026-09-10T10:00:00Z");
  });

  it("refreshes once on a 401 and retries, but does not loop on a second 401", async () => {
    const { graph, calls } = client([
      token(),
      { status: 401, body: { error: { code: "InvalidAuthenticationToken", message: "expired" } } },
      token(),
      { status: 401, body: { error: { code: "InvalidAuthenticationToken", message: "still no" } } },
    ]);

    await expect(graph.request({ method: "GET", path: "/a" })).rejects.toMatchObject({
      status: 401,
      code: "InvalidAuthenticationToken",
      retryable: false,
    });
    expect(calls.filter((c) => c.url.includes("/oauth2/"))).toHaveLength(2);
  });

  it("surfaces a token refusal with the identity platform's reason, never the secret", async () => {
    const { graph } = client([
      {
        status: 401,
        body: {
          error: "invalid_client",
          error_description: "AADSTS7000222: the client secret has expired",
        },
      },
    ]);

    const error = await graph.request({ method: "GET", path: "/a" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphError);
    expect((error as GraphError).code).toBe("invalid_client");
    expect((error as GraphError).message).toContain("AADSTS7000222");
    expect((error as GraphError).message).not.toContain("super-secret-value");
  });
});

describe("requests", () => {
  it("builds the URL from the base, the path and the query", async () => {
    const { graph, calls } = client([token(), { status: 200, body: { value: [] } }]);

    await graph.request({
      method: "GET",
      path: "/users/booking@example.com/calendarView",
      query: { startDateTime: "2026-09-10T00:00:00Z", $select: "id,start" },
    });

    expect(calls[1]?.url).toBe(
      "https://graph.microsoft.com/v1.0/users/booking@example.com/calendarView?startDateTime=2026-09-10T00%3A00%3A00Z&%24select=id%2Cstart",
    );
  });

  it("sends a JSON body with the content type, and passes extra headers through", async () => {
    const { graph, calls } = client([token(), { status: 201, body: { id: "evt_1" } }]);

    const response = await graph.request<{ id: string }>({
      method: "POST",
      path: "/users/x/events",
      body: { subject: "Session" },
      headers: { Prefer: 'outlook.timezone="UTC"' },
    });

    expect(response).toEqual({ status: 201, body: { id: "evt_1" } });
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Prefer).toBe('outlook.timezone="UTC"');
    expect(calls[1]?.init.body).toBe('{"subject":"Session"}');
  });

  it("returns a null body for an empty 204 or 202", async () => {
    const { graph } = client([token(), { status: 204 }, { status: 202 }]);
    expect(await graph.request({ method: "DELETE", path: "/a" })).toEqual({
      status: 204,
      body: null,
    });
    expect(await graph.request({ method: "POST", path: "/b", body: {} })).toEqual({
      status: 202,
      body: null,
    });
  });
});

describe("failures", () => {
  it("turns a 404 into GraphNotFoundError carrying the code and request id", async () => {
    const { graph } = client([
      token(),
      {
        status: 404,
        body: {
          error: {
            code: "ErrorItemNotFound",
            message: "The specified object was not found in the store.",
            innerError: { "request-id": "req-123" },
          },
        },
      },
    ]);

    const error = await graph.request({ method: "GET", path: "/a" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphNotFoundError);
    expect(error).toMatchObject({
      status: 404,
      code: "ErrorItemNotFound",
      requestId: "req-123",
      retryable: false,
    });
  });

  it("does not retry a 400, and says what Graph said", async () => {
    const { graph, calls } = client([
      token(),
      { status: 400, body: { error: { code: "ErrorInvalidRequest", message: "bad start time" } } },
    ]);

    await expect(graph.request({ method: "POST", path: "/a", body: {} })).rejects.toMatchObject({
      status: 400,
      code: "ErrorInvalidRequest",
      message: "Graph 400 ErrorInvalidRequest: bad start time",
      retryable: false,
    });
    expect(calls).toHaveLength(2);
  });

  it("waits exactly Retry-After on a 429, then succeeds", async () => {
    sleeps.length = 0;
    const logs: LogRecord[] = [];
    setLogSink((r) => {
      logs.push(r);
    });
    const { graph } = client([
      token(),
      {
        status: 429,
        body: { error: { code: "TooManyRequests", message: "slow down" } },
        headers: { "Retry-After": "7" },
      },
      { status: 200, body: { ok: true } },
    ]);

    const response = await graph.request({ method: "GET", path: "/a" });

    expect(response.body).toEqual({ ok: true });
    expect(sleeps).toEqual([7000]);
    expect(logs.some((l) => l.level === "warn" && l.message.includes("throttled"))).toBe(true);
    resetLogSink();
  });

  it("gives up after the attempt limit and reports the failure as retryable", async () => {
    sleeps.length = 0;
    const { graph, calls } = client(
      [
        token(),
        { status: 503, body: { error: { code: "ServiceUnavailable", message: "down" } } },
        { status: 503, body: { error: { code: "ServiceUnavailable", message: "down" } } },
        { status: 503, body: { error: { code: "ServiceUnavailable", message: "down" } } },
      ],
      3,
    );

    await expect(graph.request({ method: "GET", path: "/a" })).rejects.toMatchObject({
      status: 503,
      code: "ServiceUnavailable",
      retryable: true,
    });
    expect(calls).toHaveLength(4);
    // No Retry-After: a short fixed wait, twice.
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("caps an absurd Retry-After so one header cannot park the job for an hour", async () => {
    sleeps.length = 0;
    const { graph } = client([
      token(),
      { status: 429, body: {}, headers: { "Retry-After": "3600" } },
      { status: 200, body: {} },
    ]);
    await graph.request({ method: "GET", path: "/a" });
    expect(sleeps).toEqual([60_000]);
  });
});

describe("list", () => {
  it("follows next links and concatenates every page", async () => {
    const { graph, calls } = client([
      token(),
      {
        status: 200,
        body: {
          value: [{ id: 1 }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/x/events?$skip=1",
        },
      },
      { status: 200, body: { value: [{ id: 2 }, { id: 3 }] } },
    ]);

    const items = await graph.list<{ id: number }>({
      path: "/users/x/events",
      query: { $top: "1" },
    });

    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(calls[2]?.url).toBe("https://graph.microsoft.com/v1.0/users/x/events?$skip=1");
  });

  it("returns an empty list for an empty collection", async () => {
    const { graph } = client([token(), { status: 200, body: { value: [] } }]);
    expect(await graph.list({ path: "/users/x/events" })).toEqual([]);
  });
});

describe("answers that are not what the API documents", () => {
  it("treats a body that is not JSON as no body", async () => {
    const { graph } = client([token(), { status: 200, raw: "<html>gateway page</html>" }]);
    expect(await graph.request({ method: "GET", path: "/a" })).toEqual({ status: 200, body: null });
  });

  it("names a failure by status when there is no error envelope to read", async () => {
    const { graph } = client([token(), { status: 502, raw: "" }], 1);
    await expect(graph.request({ method: "GET", path: "/a" })).rejects.toMatchObject({
      status: 502,
      code: "http_502",
      retryable: true,
    });
  });

  it("falls back to a short fixed wait when Retry-After is not a number", async () => {
    sleeps.length = 0;
    const { graph } = client([
      token(),
      { status: 429, body: {}, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } },
      { status: 200, body: {} },
    ]);
    await graph.request({ method: "GET", path: "/a" });
    expect(sleeps).toEqual([2000]);
  });

  it("treats a token with no expiry as already expired, so it is never reused", async () => {
    const { graph, calls } = client([
      { status: 200, body: { access_token: "tok_noexp" } },
      { status: 200, body: {} },
      { status: 200, body: { access_token: "tok_noexp_2" } },
      { status: 200, body: {} },
    ]);
    await graph.request({ method: "GET", path: "/a" });
    await graph.request({ method: "GET", path: "/b" });
    expect(calls.filter((c) => c.url.includes("/oauth2/"))).toHaveLength(2);
  });

  it("reports a token endpoint that answers with nothing usable", async () => {
    const { graph } = client([{ status: 500, raw: "" }]);
    await expect(graph.request({ method: "GET", path: "/a" })).rejects.toMatchObject({
      code: "token_request_failed",
      retryable: true,
    });
  });

  it("constructs with the real clock, fetch and sleep when told nothing", () => {
    expect(new GraphClient({ credentials: CREDENTIALS })).toBeInstanceOf(GraphClient);
  });
});

describe("graphCredentialsFromEnv", () => {
  it("is null while any part of the registration is missing", () => {
    env.MS_TENANT_ID = "t";
    env.MS_CLIENT_ID = "c";
    env.MS_CLIENT_SECRET = undefined;
    expect(graphCredentialsFromEnv()).toBeNull();
    env.MS_CLIENT_SECRET = "s";
    env.MS_TENANT_ID = undefined;
    expect(graphCredentialsFromEnv()).toBeNull();
  });

  it("returns the three values once they all exist", () => {
    env.MS_TENANT_ID = "t";
    env.MS_CLIENT_ID = "c";
    env.MS_CLIENT_SECRET = "s";
    expect(graphCredentialsFromEnv()).toEqual({ tenantId: "t", clientId: "c", clientSecret: "s" });
  });
});
