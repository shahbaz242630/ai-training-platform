/**
 * Shared machinery for the booking state machines.
 *
 * Every state change in this domain goes through a table of permitted moves
 * rather than an `if` somewhere in a route handler. Two reasons:
 *
 *  1. The permitted moves are then readable in one place, by a human, without
 *     tracing call sites.
 *  2. A move that is not in the table cannot happen by accident. In a system
 *     that takes money and books a calendar, an accidental state change is a
 *     customer either charged twice or left without the session they paid for.
 */

/** A state change that the table does not permit. Always a programming error. */
export class InvalidTransitionError extends Error {
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(`${entity} cannot move from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/**
 * The outcome of a state change.
 *
 * `changed: false` means the entity was already in the target state and
 * nothing was written. This is the normal, expected result of a duplicate
 * webhook delivery - Stripe retries, and a retry must be a no-op rather than
 * an error or a second side effect.
 */
export interface TransitionResult<T> {
  readonly entity: T;
  readonly changed: boolean;
}

/** A table of `from` state -> the states it may move to. */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export function isTransitionAllowed<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return from === to || table[from].includes(to);
}

/**
 * Throws unless the move is permitted. Returns `true` when the caller should
 * write, `false` when the entity is already in the target state.
 */
export function assertTransition<S extends string>(
  entity: string,
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  if (from === to) return false;
  if (!table[from].includes(to)) throw new InvalidTransitionError(entity, from, to);
  return true;
}
