/**
 * Request-scoped treasury posting context (AsyncLocalStorage).
 * Money routes set: the user, the client idempotency key, and the confirmations the user
 * gave on screen (date reason, floor reason, duplicate reason / same-day confirm).
 * `insertTreasuryMovementTx` reads it when a caller did not pass those fields explicitly,
 * and records the last coded posting refusal so the route can tell the UI what to ask for.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * @typedef {{
 *   actor?: object | null,
 *   idempotencyKey?: string,
 *   confirmations?: {
 *     dateOverrideReason?: string,
 *     amountFloorReason?: string,
 *     duplicateOverrideReason?: string,
 *     duplicateSameDayConfirmed?: boolean,
 *   },
 *   lastRefusal?: { code: string, message: string, details?: object } | null,
 *   insertedIds?: Set<string>,
 * }} TreasuryRequestContext
 */

/**
 * @template T
 * @param {TreasuryRequestContext} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTreasuryContext(ctx, fn) {
  // Keep the caller's object: the HTTP layer reads `lastRefusal` from it after the handler runs.
  const store = ctx && typeof ctx === 'object' ? ctx : {};
  if (store.lastRefusal === undefined) store.lastRefusal = null;
  if (!(store.insertedIds instanceof Set)) store.insertedIds = new Set();
  return storage.run(store, fn);
}

/** @returns {TreasuryRequestContext | null} */
export function getTreasuryContext() {
  return storage.getStore() || null;
}

/** Remember a coded refusal (date, floor, duplicate, strict cache) for the HTTP layer. */
export function noteTreasuryRefusal(code, message, details = undefined) {
  const ctx = storage.getStore();
  if (ctx) ctx.lastRefusal = { code: String(code), message: String(message), ...(details ? { details } : {}) };
}

/** Confirmations as sent by the SPA, from the JSON body. */
export function treasuryConfirmationsFromBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const c = b.treasuryConfirm && typeof b.treasuryConfirm === 'object' ? b.treasuryConfirm : b;
  const str = (v) => String(v ?? '').trim();
  return {
    dateOverrideReason: str(c.dateOverrideReason),
    amountFloorReason: str(c.amountFloorReason),
    duplicateOverrideReason: str(c.duplicateOverrideReason),
    duplicateSameDayConfirmed: c.duplicateSameDayConfirmed === true,
  };
}
