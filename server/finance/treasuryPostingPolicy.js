/**
 * Org policy for treasury posting dates, amount floor, and the Kaduna stored-vs-computed display.
 * Keys live in org_policy_kv (same pattern as credit policy). Missing keys use defaults.
 */
import { TREASURY_AMOUNT_FLOOR_NGN_DEFAULT } from '../../shared/lib/treasuryAmountPolicy.js';
import {
  TREASURY_DATE_WINDOW_DAYS_DEFAULT,
  isPrivilegedTreasuryActor,
  lagosCalendarDay,
} from '../../shared/lib/isoTimestamp.js';

export const TREASURY_POLICY_KEYS = {
  displayComputedBranchIds: 'treasury.integrity.display_computed_branch_ids',
  amountFloorNgn: 'treasury.amount_floor_ngn',
  dateWindowDays: 'treasury.date_window_days',
};

export const TREASURY_POLICY_DEFAULTS = {
  displayComputedBranchIds: ['BR-KD'],
  amountFloorNgn: TREASURY_AMOUNT_FLOOR_NGN_DEFAULT,
  dateWindowDays: TREASURY_DATE_WINDOW_DAYS_DEFAULT,
};

/** Hard duplicate block window (seconds). Same source + amount + account + type. */
export const TREASURY_DUPLICATE_HARD_WINDOW_SECONDS = 120;

function policyTableReady(db) {
  try {
    db.prepare(`SELECT 1 FROM org_policy_kv LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function readKv(db, key) {
  if (!policyTableReady(db)) return null;
  try {
    const row = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(key);
    if (row?.value_json == null) return null;
    return parseJson(row.value_json, null);
  } catch {
    return null;
  }
}

function asBranchIdList(value, fallback) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseJson(value, null);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
  }
  return [...fallback];
}

function nonNegativeInt(raw, fallback) {
  const n = Number(raw);
  return raw != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getTreasuryPostingPolicy(db) {
  return {
    displayComputedBranchIds: asBranchIdList(
      readKv(db, TREASURY_POLICY_KEYS.displayComputedBranchIds),
      TREASURY_POLICY_DEFAULTS.displayComputedBranchIds
    ),
    amountFloorNgn: nonNegativeInt(
      readKv(db, TREASURY_POLICY_KEYS.amountFloorNgn),
      TREASURY_POLICY_DEFAULTS.amountFloorNgn
    ),
    dateWindowDays: nonNegativeInt(
      readKv(db, TREASURY_POLICY_KEYS.dateWindowDays),
      TREASURY_POLICY_DEFAULTS.dateWindowDays
    ),
  };
}

/** Additive: inserts missing keys only, never overwrites a value Finance has set. */
export function seedTreasuryPostingPolicyIfAbsent(db) {
  if (!policyTableReady(db)) return { ok: false, skipped: true };
  const now = new Date().toISOString();
  const seeds = [
    [TREASURY_POLICY_KEYS.displayComputedBranchIds, JSON.stringify(TREASURY_POLICY_DEFAULTS.displayComputedBranchIds)],
    [TREASURY_POLICY_KEYS.amountFloorNgn, JSON.stringify(TREASURY_POLICY_DEFAULTS.amountFloorNgn)],
    [TREASURY_POLICY_KEYS.dateWindowDays, JSON.stringify(TREASURY_POLICY_DEFAULTS.dateWindowDays)],
  ];
  let inserted = 0;
  const ins = db.prepare(
    `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
     VALUES (?,?,?,?,?)`
  );
  for (const [key, value] of seeds) {
    try {
      const exists = db.prepare(`SELECT policy_key FROM org_policy_kv WHERE policy_key = ?`).get(key);
      if (exists) continue;
      ins.run(key, value, now, null, 'migrate');
      inserted += 1;
    } catch {
      /* host may already have the row */
    }
  }
  return { ok: true, inserted };
}

function envFlagOn(name) {
  return String(process.env[name] || '').trim() === '1';
}

/** Date window / future rules. Off under vitest unless a test opts in. */
export function treasuryDatePolicyEnabled() {
  if (envFlagOn('ZAREWA_TREASURY_STRICT_DATES')) return true;
  return process.env.NODE_ENV !== 'test';
}

export function treasuryAmountFloorEnabled() {
  if (envFlagOn('ZAREWA_TREASURY_STRICT_AMOUNTS')) return true;
  return process.env.NODE_ENV !== 'test';
}

export function treasuryDuplicatePolicyEnabled() {
  if (envFlagOn('ZAREWA_TREASURY_STRICT_DUPLICATES')) return true;
  return process.env.NODE_ENV !== 'test';
}

export function branchDisplaysComputedBalance(policy, branchId) {
  const bid = String(branchId || '').trim();
  return (policy?.displayComputedBranchIds || []).includes(bid);
}

/**
 * Reasons and confirmations for one posting. Payload wins over the request context.
 * @param {object | null} actor
 * @param {Record<string, unknown>} payload
 * @param {{ actor?: object, confirmations?: Record<string, unknown> } | null} ctx
 */
export function postingOverrideContext(actor, payload = {}, ctx = null) {
  const conf = ctx?.confirmations || {};
  const pick = (...vals) => {
    for (const v of vals) {
      const s = String(v ?? '').trim();
      if (s) return s;
    }
    return '';
  };
  return {
    isPrivileged: isPrivilegedTreasuryActor(actor || payload.actor || ctx?.actor),
    dateReason: pick(
      payload.dateOverrideReason,
      payload.postingDateReason,
      conf.dateOverrideReason
    ),
    amountFloorReason: pick(payload.amountFloorReason, conf.amountFloorReason),
    duplicateReason: pick(payload.duplicateOverrideReason, conf.duplicateOverrideReason),
    duplicateSameDayConfirmed:
      payload.duplicateSameDayConfirmed === true ||
      conf.duplicateSameDayConfirmed === true ||
      Boolean(pick(payload.duplicateOverrideReason, conf.duplicateOverrideReason)),
    todayDay: lagosCalendarDay(),
  };
}
