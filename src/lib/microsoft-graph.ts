import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * A small client for Microsoft Graph, shared by the calendar and the mail
 * adapters.
 *
 * Deliberately not the vendor SDK. The SDK brings a middleware pipeline and
 * an authentication library for what is, for us, one token endpoint and a
 * handful of JSON requests over Node's own fetch. Fewer moving parts means
 * fewer things to audit and nothing that needs the host to be special.
 *
 * What it does own, because every caller would otherwise get it subtly
 * wrong:
 *
 *   - the app-only token: acquired with the client credentials, cached, and
 *     refreshed before it expires or when Graph says it has;
 *   - throttling: Graph answers 429 with Retry-After, and the right response
 *     is to wait exactly that long and try again, a bounded number of times;
 *   - errors: Graph's error envelope is turned into a typed error carrying
 *     the code and the request id, which is what support asks for;
 *   - paging: collections arrive in pages with a next link.
 *
 * The secret and the token never appear in a log line or an error message.
 */

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const TOKEN_SCOPE = "https://graph.microsoft.com/.default";
/** Refresh this long before the token actually expires, so a request never starts with a token about to die. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
/** When Graph throttles without saying for how long. */
const DEFAULT_RETRY_AFTER_MS = 2_000;
/** A safety net on paging: a runaway next link must not read a calendar forever. */
const MAX_PAGES = 50;

export interface GraphCredentials {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface GraphClientOptions {
  readonly credentials: GraphCredentials;
  /** Injected so tests can answer requests without a network. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
}

export interface GraphRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Relative to the v1.0 base, e.g. `/users/{id}/events`. An absolute URL is accepted for next links. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface GraphResponse<T> {
  readonly status: number;
  /** Parsed JSON, or null for an empty body (202, 204). */
  readonly body: T | null;
}

/** Graph refused or failed the request. `retryable` says whether trying again later could succeed. */
export class GraphError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    requestId?: string | null;
    retryable: boolean;
  }) {
    super(`Graph ${input.status} ${input.code}: ${input.message}`);
    this.name = "GraphError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.retryable = input.retryable;
  }
}

/** The thing does not exist on the other side. Its own type because callers branch on it. */
export class GraphNotFoundError extends GraphError {
  constructor(input: { code: string; message: string; requestId?: string | null }) {
    super({ status: 404, ...input, retryable: false });
    this.name = "GraphNotFoundError";
  }
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class GraphClient {
  private readonly credentials: GraphCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private token: CachedToken | null = null;

  constructor(options: GraphClientOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * One request, with the token attached, throttling honoured and the error
   * envelope decoded. Throws GraphError; never returns a failed status.
   */
  async request<T>(input: GraphRequest): Promise<GraphResponse<T>> {
    const url = this.urlFor(input);
    let refreshedOnce = false;

    for (let attempt = 1; ; attempt += 1) {
      const token = await this.accessToken();
      const response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...input.headers,
        },
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      });

      if (response.ok) {
        return { status: response.status, body: await readJson<T>(response) };
      }

      const failure = await describeFailure(response);

      /*
        One refresh on a 401. A token Graph rejects is a token we should not
        keep presenting, whatever our own clock said about its expiry - but
        a second 401 with a fresh token is a real authorisation problem, and
        looping on it would hide that behind a wall of retries.
      */
      if (response.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        this.token = null;
        continue;
      }

      if (response.status === 404) {
        throw new GraphNotFoundError(failure);
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxAttempts) {
        const wait = retryAfterMs(response);
        logger.warn("graph request throttled or failed, retrying", {
          status: response.status,
          code: failure.code,
          attempt,
          waitMs: wait,
          requestId: failure.requestId,
        });
        await this.sleep(wait);
        continue;
      }

      throw new GraphError({ status: response.status, ...failure, retryable });
    }
  }

  /** Every item of a collection, following next links. */
  async list<T>(input: Omit<GraphRequest, "method" | "body">): Promise<T[]> {
    const items: T[] = [];
    let next: GraphRequest | null = { method: "GET", ...input };

    for (let page = 0; next !== null && page < MAX_PAGES; page += 1) {
      const response: GraphResponse<{ value?: T[]; "@odata.nextLink"?: string }> =
        await this.request(next);
      items.push(...(response.body?.value ?? []));
      const link = response.body?.["@odata.nextLink"];
      // The next link is absolute and already carries the query.
      next = link ? { method: "GET", path: link, headers: input.headers } : null;
    }

    return items;
  }

  /**
   * The app-only token, from cache while it has more than a minute left.
   *
   * Client credentials, never a user's. The application acts as itself,
   * against the one mailbox it has been granted, and nothing here ever
   * touches a person's sign-in.
   */
  private async accessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > nowMs) {
      return this.token.value;
    }

    const { tenantId, clientId, clientSecret } = this.credentials;
    const response = await this.fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: TOKEN_SCOPE,
          grant_type: "client_credentials",
        }).toString(),
      },
    );

    const body = await readJson<{
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    }>(response);

    if (!response.ok || !body?.access_token) {
      /*
        The description from the identity platform is safe to surface - it
        names the problem (an expired secret, a wrong tenant) and never the
        secret itself. The secret is not in scope here and is not logged.
      */
      throw new GraphError({
        status: response.status,
        code: body?.error ?? "token_request_failed",
        message: body?.error_description ?? "the token endpoint did not return a token",
        retryable: response.status >= 500,
      });
    }

    this.token = {
      value: body.access_token,
      expiresAt: nowMs + (body.expires_in ?? 0) * 1000,
    };
    return this.token.value;
  }

  private urlFor(input: GraphRequest): string {
    const url = new URL(
      input.path.startsWith("https://") ? input.path : `${GRAPH_BASE_URL}${input.path}`,
    );
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

async function readJson<T>(response: Response): Promise<T | null> {
  if (response.status === 204 || response.status === 202) return null;
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface FailureDetail {
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

/** Graph's error envelope: `{ error: { code, message, innerError: { "request-id" } } }`. */
async function describeFailure(response: Response): Promise<FailureDetail> {
  const body = await readJson<{
    error?: { code?: string; message?: string; innerError?: { "request-id"?: string } };
  }>(response);
  return {
    code: body?.error?.code ?? `http_${response.status}`,
    message: body?.error?.message ?? response.statusText ?? "no message",
    requestId: body?.error?.innerError?.["request-id"] ?? null,
  };
}

/** Honour Retry-After in seconds when Graph sends it; otherwise a short fixed wait. */
function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  return DEFAULT_RETRY_AFTER_MS;
}

/** The credentials from the environment, or null when any part is missing. */
export function graphCredentialsFromEnv(): GraphCredentials | null {
  const env = serverEnv();
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return null;
  return {
    tenantId: env.MS_TENANT_ID,
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
  };
}
