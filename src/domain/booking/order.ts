import type { Currency, Fils } from "@/lib/money";
import { assertTransition, type TransitionResult, type TransitionTable } from "./transitions";

/**
 * An Order is ONE PAYMENT. It owns payment state and owns nothing else.
 *
 * The matching rule lives on Booking: scheduling state is never stored here,
 * and payment state is never stored there. Duplicating either is how the two
 * drift apart and a customer ends up charged for a session that shows no
 * booking, or holding a booking nobody was charged for.
 *
 * An Order has one or more Bookings. A single-session order has one; a pathway
 * order has two, at two different times - which is precisely why payment and
 * scheduling cannot share a row.
 */

export type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "partially_refunded";

export type OrderType = "single" | "pathway";

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly orderType: OrderType;
  /**
   * Which catalogue entry was bought. Exactly one of these is set.
   *
   * Slugs rather than generated ids: the catalogue is configuration in
   * `src/config`, and the slug is already the stable key the price resolver
   * and the URLs both use.
   */
  readonly sessionSlug: string | null;
  readonly pathwaySlug: string | null;
  /** Resolved server-side from the catalogue. A client-supplied price is never trusted. */
  readonly grossAmountFils: Fils;
  readonly currency: Currency;
  readonly taxTreatment: "inclusive";
  readonly taxRateBasisPoints: number;
  readonly paymentStatus: PaymentStatus;
  readonly stripeCheckoutSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly attributionId: string | null;
  readonly intakeId: string | null;
  /** UTC. Every timestamp in this domain is UTC; rendering converts, storage does not. */
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Permitted payment moves.
 *
 * `failed -> paid` is deliberate: a Stripe Checkout session can see a declined
 * attempt followed by a successful one, and the successful webhook must not be
 * rejected because an earlier attempt failed.
 *
 * Nothing returns to `pending`. Once money has moved, the record of that is
 * not reversible by a state change - a refund is its own state.
 */
const PAYMENT_TRANSITIONS: TransitionTable<PaymentStatus> = {
  pending: ["paid", "failed"],
  failed: ["paid"],
  paid: ["refunded", "partially_refunded"],
  partially_refunded: ["refunded"],
  refunded: [],
};

export class OrderShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderShapeError";
  }
}

export interface CreateOrderInput {
  readonly id: string;
  readonly customerId: string;
  readonly orderType: OrderType;
  readonly sessionSlug?: string | null;
  readonly pathwaySlug?: string | null;
  readonly grossAmountFils: Fils;
  readonly currency: Currency;
  readonly taxRateBasisPoints: number;
  readonly stripeCheckoutSessionId?: string | null;
  readonly attributionId?: string | null;
  readonly intakeId?: string | null;
  readonly now: Date;
}

/**
 * The only way to make an Order. It starts `pending` - there is no argument for
 * an initial payment status, because an order that begins life already paid is
 * an order nobody verified a webhook for.
 */
export function createOrder(input: CreateOrderInput): Order {
  const sessionSlug = input.sessionSlug ?? null;
  const pathwaySlug = input.pathwaySlug ?? null;

  if (input.orderType === "single" && (sessionSlug === null || pathwaySlug !== null)) {
    throw new OrderShapeError("A single order must carry a sessionSlug and no pathwaySlug");
  }
  if (input.orderType === "pathway" && (pathwaySlug === null || sessionSlug !== null)) {
    throw new OrderShapeError("A pathway order must carry a pathwaySlug and no sessionSlug");
  }
  if (!Number.isInteger(input.grossAmountFils) || input.grossAmountFils <= 0) {
    throw new OrderShapeError("grossAmountFils must be a positive whole number of fils");
  }

  return {
    id: input.id,
    customerId: input.customerId,
    orderType: input.orderType,
    sessionSlug,
    pathwaySlug,
    grossAmountFils: input.grossAmountFils,
    currency: input.currency,
    taxTreatment: "inclusive",
    taxRateBasisPoints: input.taxRateBasisPoints,
    paymentStatus: "pending",
    stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null,
    stripePaymentIntentId: null,
    attributionId: input.attributionId ?? null,
    intakeId: input.intakeId ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface PaymentTransitionDetail {
  readonly stripePaymentIntentId?: string;
}

/**
 * Move an order's payment state.
 *
 * Returns `changed: false` when the order is already in the target state, so a
 * duplicate webhook delivery is a no-op rather than an error or a second side
 * effect. Persisting the Stripe event id remains the caller's job - this
 * function guards the state, not the ledger.
 */
export function transitionPayment(
  order: Order,
  to: PaymentStatus,
  now: Date,
  detail: PaymentTransitionDetail = {},
): TransitionResult<Order> {
  const changed = assertTransition("Order", PAYMENT_TRANSITIONS, order.paymentStatus, to);
  if (!changed) return { entity: order, changed: false };

  return {
    entity: {
      ...order,
      paymentStatus: to,
      stripePaymentIntentId: detail.stripePaymentIntentId ?? order.stripePaymentIntentId,
      updatedAt: now,
    },
    changed: true,
  };
}
