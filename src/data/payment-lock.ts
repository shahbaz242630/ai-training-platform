import type { QueryRunner } from "./db";

/**
 * One payment's events, one at a time (review s104).
 *
 * A refund, dispute or fraud warning about a payment finds its order by the
 * payment id, which settlement writes. Two transactions running together
 * cannot see each other's work: the refund finds no order and is held, the
 * settlement finds nothing held, and both commit. Taking this lock first, in
 * every path that settles a payment or acts on one by its id, makes the
 * second wait for the first, so it sees what the first did.
 *
 * Always before the order lock (lockOrder), in every path, so two paths can
 * never wait on each other. Released when the transaction ends.
 */
export async function lockPayment(
  runner: QueryRunner,
  paymentIntentId: string | null,
): Promise<void> {
  if (paymentIntentId === null) return;
  await runner.query(`select pg_advisory_xact_lock(hashtextextended('payment:' || $1, 0))`, [
    paymentIntentId,
  ]);
}
