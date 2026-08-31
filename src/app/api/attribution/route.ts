import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { withTransaction } from "@/data/db";
import { recordAttributionVisit } from "@/data/attributions";
import { clientEnv } from "@/lib/env";
import { createRateLimiter } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Recording where a visit came from.
 *
 * Called once per page load by a small client component, and deliberately
 * fire-and-forget: nothing a customer can see depends on the answer. If this
 * endpoint is broken, browsing and booking carry on working and we lose
 * reporting, which is the right way round.
 *
 * It still answers honestly. A failure returns 500 rather than a cheerful 200,
 * so a broken endpoint is visible in monitoring instead of looking like a
 * quiet week for advertising.
 */

export const dynamic = "force-dynamic";

/** The random id that ties one browser's visits together. Not a person. */
const COOKIE_NAME = "ats";

/**
 * Long enough to cover the gap between first hearing about us and booking.
 * A shorter window silently re-attributes a slow decision to whatever channel
 * happened to be last, which is the mistake this whole module exists to avoid.
 */
const COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/*
  Twenty a minute per address. A real browser sends one per page view; this
  only has to stop somebody manufacturing campaign rows in bulk.
*/
const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

const visitSchema = z
  .object({
    /** window.location.href. Only its path, query and click ids are kept. */
    url: z.string().url().max(2000),
    referrer: z.string().max(2000).nullable().optional(),
  })
  .strict();

async function callerKey(headerList: Headers): Promise<string> {
  const forwarded = headerList.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

export async function POST(request: Request): Promise<NextResponse> {
  const rate = limiter.check(await callerKey(request.headers), new Date());
  if (!rate.allowed) return new NextResponse(null, { status: 429 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const parsed = visitSchema.safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 400 });

  const jar = await cookies();
  const existing = jar.get(COOKIE_NAME)?.value;
  /*
    A supplied id is only ever reused if it looks like one we issued. Accepting
    any string would let a caller write to somebody else's attribution row, or
    fill the table with keys of their choosing.
  */
  const anonymousSessionId = isIssuedId(existing) ? existing : randomUUID();

  try {
    const stored = await withTransaction((runner) =>
      recordAttributionVisit(runner, {
        url: parsed.data.url,
        referrer: parsed.data.referrer ?? null,
        /*
          OUR host, from configuration - never from the request. It decides
          whether a referrer counts as a new arrival or as a click between our
          own pages, and letting the browser assert it would let any visit
          claim to be a fresh arrival from anywhere.
        */
        siteHost: new URL(clientEnv.NEXT_PUBLIC_SITE_URL).host,
        anonymousSessionId,
        now: new Date(),
      }),
    );

    const response = new NextResponse(null, { status: 204 });
    response.cookies.set(COOKIE_NAME, anonymousSessionId, {
      // Not readable by JavaScript. Nothing in the browser needs it, and a
      // value scripts cannot reach is one an injected script cannot harvest.
      httpOnly: true,
      // Lax, not Strict: the cookie must survive the click from an ad or a
      // search result, which is the entire point of measuring attribution.
      sameSite: "lax",
      secure: clientEnv.NEXT_PUBLIC_SITE_ENV !== "development",
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });

    if (stored.isFirstVisit) logger.info("first visit attributed", { attributionId: stored.id });
    return response;
  } catch (error) {
    // No campaign values in the log line - they arrive from a query string
    // anybody can write, and this ends up in a shared log.
    logger.error("attribution could not be recorded", { error: (error as Error).message });
    return new NextResponse(null, { status: 500 });
  }
}

/** A UUID we issued, rather than whatever a caller decided to put in the jar. */
function isIssuedId(value: string | undefined): value is string {
  if (value === undefined) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
