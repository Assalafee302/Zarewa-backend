/**
 * Legacy factory demo pack (CUS-NDA / QT-2026-027 / RC-2026-1849 / CL-2026-1592):
 * - Skipped in production unless ZAREWA_LEGACY_DEMO_PACK=1|true|yes|on.
 * - Skipped when ZAREWA_LEGACY_DEMO_PACK=0|false|no|off (any NODE_ENV).
 * - After an admin "operations_core" data reset, org_policy_kv marks suppression so
 *   the pack is not re-seeded on the next API boot (and ensureLegacyDemoPack is skipped).
 */
import { isEmptySeedMode } from './emptySeed.js';
import { orgPolicyTablesReady } from './orgPolicy.js';

export const DEMO_CUSTOMER_ID = 'CUS-NDA';
export const DEMO_QUOTE_ID = 'QT-2026-027';
export const DEMO_RECEIPT_ID = 'RC-2026-1849';
export const DEMO_CL_ID = 'CL-2026-1592';

export const LEGACY_DEMO_CUSTOMER_IDS = new Set([DEMO_CUSTOMER_ID]);
export const LEGACY_DEMO_QUOTATION_IDS = new Set([DEMO_QUOTE_ID]);

export const POLICY_KEY_SUPPRESS_LEGACY_DEMO = 'bootstrap.suppress_legacy_demo_pack';

function envLegacyExplicitOff() {
  const v = process.env.ZAREWA_LEGACY_DEMO_PACK;
  if (v == null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no' || s === 'off';
}

function envLegacyExplicitOn() {
  const v = process.env.ZAREWA_LEGACY_DEMO_PACK;
  if (v == null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
export function legacyDemoPackSuppressedInDb(db) {
  if (!orgPolicyTablesReady(db)) return false;
  try {
    const row = db
      .prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`)
      .get(POLICY_KEY_SUPPRESS_LEGACY_DEMO);
    if (row?.value_json == null) return false;
    const v = JSON.parse(String(row.value_json));
    return v === true || v === 1 || String(v).toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether transactional seed + ensureLegacyDemoPack may include the NDA legacy demo pack.
 * @param {import('better-sqlite3').Database} db
 */
export function legacyDemoPackActive(db) {
  if (isEmptySeedMode()) return false;
  if (envLegacyExplicitOff()) return false;
  if (legacyDemoPackSuppressedInDb(db)) return false;
  if (process.env.NODE_ENV === 'production') return envLegacyExplicitOn();
  return true;
}

/**
 * Persist suppression after admin reset cleared sales/customers (operations_core).
 * @param {import('better-sqlite3').Database} db
 * @param {{ actorId?: string|null }} [meta]
 */
export function setSuppressLegacyDemoPackAfterOperationsReset(db, meta = {}) {
  if (!orgPolicyTablesReady(db)) return;
  const t = new Date().toISOString();
  const uid = String(meta.actorId ?? '').trim() || null;
  const newV = JSON.stringify(true);
  db.prepare(
    `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
     VALUES (?,?,?,?,?)
     ON CONFLICT(policy_key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at_iso = excluded.updated_at_iso,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_by_display = excluded.updated_by_display`
  ).run(POLICY_KEY_SUPPRESS_LEGACY_DEMO, newV, t, uid, null);
}
