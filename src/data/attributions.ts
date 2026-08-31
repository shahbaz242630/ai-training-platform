import type { QueryRunner } from "./db";
import {
  beginAttribution,
  recordVisit,
  type Attribution,
  type VisitInput,
} from "@/domain/attribution/attribution";

/**
 * Storing where a customer came from.
 *
 * The two rules that make these numbers worth having live in the DOMAIN, not
 * here - first touch is never overwritten, and a direct return never replaces
 * last touch. This module reads a row, hands it to those rules, and writes
 * back what they decided. Re-expressing them in SQL would give us two places
 * that must agree about which channel gets the credit for a sale.
 *
 * Nothing stored here identifies a person. The key is a random value in a
 * first-party cookie, and every campaign field arrives in a query string
 * anybody can write, so all of it is stripped and length-capped by the domain
 * before it reaches a bound parameter.
 */

export interface StoredAttribution {
  readonly id: string;
  readonly attribution: Attribution;
  /** True only for a browser's very first visit. Useful for a sanity check, not for logic. */
  readonly isFirstVisit: boolean;
}

interface AttributionRow {
  readonly id: string;
  readonly first_touch_source: string | null;
  readonly first_touch_medium: string | null;
  readonly first_touch_campaign: string | null;
  readonly first_touch_content: string | null;
  readonly first_touch_term: string | null;
  readonly last_touch_source: string | null;
  readonly last_touch_medium: string | null;
  readonly last_touch_campaign: string | null;
  readonly referrer: string | null;
  readonly landing_page: string;
  readonly gclid: string | null;
  readonly fbclid: string | null;
  readonly anonymous_session_id: string;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
}

/**
 * The schema keeps no last-touch content or term columns, so those are null on
 * the way back. Deliberate rather than lost: last touch is used to credit a
 * channel, and the campaign is as fine-grained as that needs. First touch
 * keeps the full set because it is written once and can never be recovered.
 */
function toAttribution(row: AttributionRow): Attribution {
  return {
    firstTouch: {
      source: row.first_touch_source,
      medium: row.first_touch_medium,
      campaign: row.first_touch_campaign,
      content: row.first_touch_content,
      term: row.first_touch_term,
    },
    lastTouch: {
      source: row.last_touch_source,
      medium: row.last_touch_medium,
      campaign: row.last_touch_campaign,
      content: null,
      term: null,
    },
    referrer: row.referrer,
    landingPage: row.landing_page,
    gclid: row.gclid,
    fbclid: row.fbclid,
    anonymousSessionId: row.anonymous_session_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

const COLUMNS = `id, first_touch_source, first_touch_medium, first_touch_campaign,
                 first_touch_content, first_touch_term,
                 last_touch_source, last_touch_medium, last_touch_campaign,
                 referrer, landing_page, gclid, fbclid,
                 anonymous_session_id, first_seen_at, last_seen_at`;

/**
 * Record a visit, creating the browser's attribution on its first one.
 *
 * `on conflict do nothing` rather than select-then-insert: two requests can
 * arrive from the same browser at the same moment - a page load and a
 * prefetch, say - and check-then-act would give that browser two first
 * touches. Whichever one the eventual order linked to would then be arbitrary.
 *
 * The loser of that race gets no row back, reads the winner's, and continues
 * as an ordinary return visit. No exception is thrown, so nothing has to
 * unwind a transaction to recover.
 */
export async function recordAttributionVisit(
  runner: QueryRunner,
  input: VisitInput,
): Promise<StoredAttribution> {
  const first = beginAttribution(input);

  const inserted = await runner.query<AttributionRow>(
    `insert into attributions (
       first_touch_source, first_touch_medium, first_touch_campaign,
       first_touch_content, first_touch_term,
       last_touch_source, last_touch_medium, last_touch_campaign,
       referrer, landing_page, gclid, fbclid,
       anonymous_session_id, first_seen_at, last_seen_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (anonymous_session_id) do nothing
     returning ${COLUMNS}`,
    [
      first.firstTouch.source,
      first.firstTouch.medium,
      first.firstTouch.campaign,
      first.firstTouch.content,
      first.firstTouch.term,
      first.lastTouch.source,
      first.lastTouch.medium,
      first.lastTouch.campaign,
      first.referrer,
      first.landingPage,
      first.gclid,
      first.fbclid,
      first.anonymousSessionId,
      first.firstSeenAt,
      first.lastSeenAt,
    ],
  );

  const newRow = inserted.rows[0];
  if (newRow) {
    return { id: newRow.id, attribution: toAttribution(newRow), isFirstVisit: true };
  }

  const found = await runner.query<AttributionRow>(
    `select ${COLUMNS} from attributions where anonymous_session_id = $1`,
    [input.anonymousSessionId],
  );
  const existingRow = found.rows[0];
  if (!existingRow) {
    throw new Error(
      "An attribution row was neither inserted nor found, which should be impossible",
    );
  }

  // The domain decides what moves. First touch is not in the SET clause below
  // at all, so it cannot be overwritten even by a future edit to this query.
  const updated = recordVisit(toAttribution(existingRow), input);

  await runner.query(
    `update attributions set
       last_touch_source   = $2,
       last_touch_medium   = $3,
       last_touch_campaign = $4,
       gclid               = $5,
       fbclid              = $6,
       last_seen_at        = $7
     where id = $1`,
    [
      existingRow.id,
      updated.lastTouch.source,
      updated.lastTouch.medium,
      updated.lastTouch.campaign,
      updated.gclid,
      updated.fbclid,
      updated.lastSeenAt,
    ],
  );

  return { id: existingRow.id, attribution: updated, isFirstVisit: false };
}
