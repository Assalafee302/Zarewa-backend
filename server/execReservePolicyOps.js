/**
 * Reserve policy configuration for executive treasury (Phase 3C).
 * No indicative expansion headroom calculation in this phase.
 */
import crypto from 'node:crypto';
import { orgPolicyTablesReady } from './orgPolicy.js';
import { userHasPermission } from './auth.js';

export const RESERVE_POLICY_MANAGE_PERMISSION = 'treasury.reserve_policy.manage';

const POLICY_NOTES_MAX_LEN = 2000;

const LEGACY_HEADROOM_KEYS = {
  'treasury.headroom.include_receivables': ['treasury.withdrawal.include_receivables'],
  'treasury.headroom.include_inventory': ['treasury.withdrawal.include_inventory'],
};

/** @type {const} */
export const RESERVE_POLICY_KEY_DEFS = [
  {
    key: 'treasury.reserves.operating_ngn',
    field: 'operatingReserveNgn',
    type: 'ngn',
    label: 'Operating reserve',
    required: true,
  },
  {
    key: 'treasury.reserves.emergency_ngn',
    field: 'emergencyReserveNgn',
    type: 'ngn',
    label: 'Emergency reserve',
    required: true,
  },
  {
    key: 'treasury.reserves.payroll_ngn',
    field: 'payrollReserveNgn',
    type: 'ngn',
    label: 'Payroll reserve',
    required: true,
  },
  {
    key: 'treasury.reserves.supplier_payment_ngn',
    field: 'supplierPaymentReserveNgn',
    type: 'ngn',
    label: 'Supplier payment reserve',
    required: true,
  },
  {
    key: 'treasury.reserves.stock_purchase_ngn',
    field: 'stockPurchaseReserveNgn',
    type: 'ngn',
    label: 'Stock purchase reserve',
    required: true,
  },
  {
    key: 'treasury.reserves.tax_statutory_ngn',
    field: 'taxStatutoryReserveNgn',
    type: 'ngn',
    label: 'Tax / statutory reserve',
    required: true,
  },
  {
    key: 'treasury.headroom.include_receivables',
    field: 'includeReceivables',
    type: 'boolean',
    label: 'Receivables in indicative expansion headroom',
    required: true,
    recommended: false,
  },
  {
    key: 'treasury.headroom.include_inventory',
    field: 'includeInventory',
    type: 'boolean',
    label: 'Inventory in indicative expansion headroom',
    required: true,
    recommended: false,
  },
  {
    key: 'treasury.headroom.include_po_commitments',
    field: 'includePoCommitments',
    type: 'boolean',
    label: 'PO commitments in indicative expansion headroom',
    required: true,
    recommended: true,
  },
  {
    key: 'treasury.headroom.policy_notes',
    field: 'policyNotes',
    type: 'string',
    label: 'Reserve policy notes',
    required: false,
  },
];

/** Required policy keys (for readiness / completion). */
export const RESERVE_POLICY_KEYS = RESERVE_POLICY_KEY_DEFS.filter((d) => d.required).map((d) => ({
  key: d.key,
  label: d.label,
}));

function nowIso() {
  return new Date().toISOString();
}

function newPolicyAuditId() {
  return `OPA-${crypto.randomUUID()}`;
}

/**
 * @param {string | null | undefined} valueJson
 * @param {'ngn' | 'boolean' | 'string'} type
 */
function parseStoredValue(valueJson, type) {
  if (valueJson == null || String(valueJson).trim() === '') {
    return { value: null, configured: false };
  }
  try {
    const parsed = JSON.parse(String(valueJson));
    if (type === 'ngn') {
      const n = Number(parsed);
      if (!Number.isFinite(n) || n < 0) return { value: null, configured: false };
      return { value: Math.round(n), configured: true };
    }
    if (type === 'boolean') {
      if (typeof parsed !== 'boolean') return { value: null, configured: false };
      return { value: parsed, configured: true };
    }
    const s = String(parsed ?? '').trim();
    return { value: s || null, configured: s.length > 0 };
  } catch {
    return { value: null, configured: false };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string[]} [legacyKeys]
 */
function readPolicyRow(db, key, legacyKeys = []) {
  if (!orgPolicyTablesReady(db)) {
    return {
      value: null,
      configured: false,
      updatedBy: null,
      updatedAtISO: null,
      note: null,
      source: 'org_policy_kv',
    };
  }
  const keysToTry = [key, ...(legacyKeys || [])];
  for (const k of keysToTry) {
    const row = db
      .prepare(
        `SELECT value_json, updated_at_iso, updated_by_user_id, updated_by_display
         FROM org_policy_kv WHERE policy_key = ?`
      )
      .get(k);
    if (row?.value_json != null && String(row.value_json).trim() !== '') {
      return {
        rawJson: row.value_json,
        updatedAtISO: row.updated_at_iso || null,
        updatedBy: row.updated_by_display || row.updated_by_user_id || null,
        source: 'org_policy_kv',
        storedKey: k,
      };
    }
  }
  return {
    rawJson: null,
    updatedAtISO: null,
    updatedBy: null,
    source: 'org_policy_kv',
    storedKey: null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function buildReservePolicyState(db) {
  /** @type {string[]} */
  const missingKeys = [];
  /** @type {string[]} */
  const missingLabels = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, object>} */
  const policy = {};
  let latestUpdatedAtISO = null;
  let latestUpdatedBy = null;

  if (!orgPolicyTablesReady(db)) {
    for (const def of RESERVE_POLICY_KEY_DEFS.filter((d) => d.required)) {
      missingKeys.push(def.key);
      missingLabels.push(def.label);
    }
    return {
      tablesReady: false,
      configured: false,
      completionPct: 0,
      missingKeys,
      missingLabels,
      policy: buildEmptyPolicyShape(),
      warnings: ['Policy tables are not available. Run migrations.'],
      updatedAtISO: null,
      updatedBy: null,
    };
  }

  let configuredRequired = 0;
  const requiredCount = RESERVE_POLICY_KEY_DEFS.filter((d) => d.required).length;

  for (const def of RESERVE_POLICY_KEY_DEFS) {
    const legacy = LEGACY_HEADROOM_KEYS[def.key] || [];
    const row = readPolicyRow(db, def.key, legacy);
    const parsed = parseStoredValue(row.rawJson, def.type);
    const entry = {
      value: parsed.value,
      configured: parsed.configured,
      label: def.label,
      updatedBy: row.updatedBy,
      updatedAtISO: row.updatedAtISO,
      note: null,
      source: row.source,
      key: def.key,
    };
    if (def.type === 'boolean' && 'recommended' in def) {
      entry.recommended = def.recommended;
    }
    policy[def.field] = entry;

    if (def.required) {
      if (!parsed.configured) {
        missingKeys.push(def.key);
        missingLabels.push(def.label);
      } else {
        configuredRequired += 1;
      }
    }

    if (row.updatedAtISO && (!latestUpdatedAtISO || row.updatedAtISO > latestUpdatedAtISO)) {
      latestUpdatedAtISO = row.updatedAtISO;
      latestUpdatedBy = row.updatedBy;
    }
  }

  if (policy.includeReceivables?.value === true) {
    warnings.push(
      'Receivables are included in headroom policy. Outstanding customer debt is not cash until collected.'
    );
  }
  if (policy.includeInventory?.value === true) {
    warnings.push(
      'Inventory is included in headroom policy. Stock valuation is estimated and may not be realizable as cash.'
    );
  }
  if (policy.includePoCommitments?.value === false) {
    warnings.push(
      'PO commitments are excluded from headroom policy. Open purchase orders may still create cash pressure.'
    );
  }

  const configured = missingKeys.length === 0;
  const completionPct =
    requiredCount > 0 ? Math.round((configuredRequired / requiredCount) * 1000) / 10 : 0;

  if (!configured) {
    warnings.unshift('Reserve policy is incomplete. Indicative expansion headroom is hidden.');
  }

  return {
    tablesReady: true,
    configured,
    completionPct,
    missingKeys,
    missingLabels,
    policy,
    warnings,
    updatedAtISO: latestUpdatedAtISO,
    updatedBy: latestUpdatedBy,
  };
}

function buildEmptyPolicyShape() {
  /** @type {Record<string, object>} */
  const policy = {};
  for (const def of RESERVE_POLICY_KEY_DEFS) {
    const entry = {
      value: def.type === 'boolean' ? null : def.type === 'string' ? null : null,
      configured: false,
      label: def.label,
      updatedBy: null,
      updatedAtISO: null,
      note: null,
      source: 'org_policy_kv',
    };
    if (def.type === 'boolean' && 'recommended' in def) {
      entry.recommended = def.recommended;
    }
    policy[def.field] = entry;
  }
  return policy;
}

function stripPolicyForApi(policy) {
  const out = {};
  for (const def of RESERVE_POLICY_KEY_DEFS) {
    const e = policy[def.field];
    if (!e) continue;
    const base = {
      value: e.value,
      configured: e.configured,
      label: e.label,
    };
    if (def.type === 'boolean' && 'recommended' in def) {
      out[def.field] = { ...base, recommended: def.recommended };
    } else {
      out[def.field] = base;
    }
  }
  return out;
}

/**
 * @param {object} user
 */
export function actorCanManageReservePolicy(user) {
  return userHasPermission(user, RESERVE_POLICY_MANAGE_PERMISSION) || userHasPermission(user, '*');
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getExecReservePolicyResponse(db) {
  const state = buildReservePolicyState(db);
  const note = state.configured
    ? 'Reserve policy is configured. Indicative expansion headroom can be enabled in the next phase.'
    : 'Reserve policy is incomplete. Indicative expansion headroom is hidden.';

  return {
    ok: true,
    generatedAtISO: nowIso(),
    configured: state.configured,
    completionPct: state.completionPct,
    missingKeys: state.missingKeys,
    policy: stripPolicyForApi(state.policy),
    warnings: state.warnings,
    headroomHidden: true,
    updatedAtISO: state.updatedAtISO,
    updatedBy: state.updatedBy,
    note,
    phaseNote: 'Indicative expansion headroom remains hidden until reserve policy is configured and approved.',
    notWithdrawalInstruction: true,
  };
}

/**
 * Dashboard slice (extends Phase 3B readiness).
 * @param {import('better-sqlite3').Database} db
 */
export function buildReservePolicyReadiness(db) {
  const state = buildReservePolicyState(db);
  const note = state.configured
    ? 'Reserve policy is configured. Indicative expansion headroom can be enabled in the next phase.'
    : 'Reserve policy is incomplete. Indicative expansion headroom is hidden.';

  return {
    configured: state.configured,
    completionPct: state.completionPct,
    missingKeys: state.missingKeys,
    missingLabels: state.missingLabels,
    policy: stripPolicyForApi(state.policy),
    warnings: state.warnings,
    updatedAtISO: state.updatedAtISO,
    updatedBy: state.updatedBy,
    note,
    headroomHidden: true,
    phaseNote: 'Indicative expansion headroom remains hidden in this phase.',
    notWithdrawalInstruction: true,
  };
}

/**
 * @param {unknown} body
 */
export function validateReservePolicyPutBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];

  const ngnFields = [
    'operatingReserveNgn',
    'emergencyReserveNgn',
    'payrollReserveNgn',
    'supplierPaymentReserveNgn',
    'stockPurchaseReserveNgn',
    'taxStatutoryReserveNgn',
  ];
  /** @type {Record<string, number>} */
  const amounts = {};
  for (const f of ngnFields) {
    if (b[f] === undefined || b[f] === null) {
      errors.push(`${f} is required.`);
      continue;
    }
    const n = Number(b[f]);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`${f} must be a non-negative number.`);
    } else {
      amounts[f] = Math.round(n);
    }
  }

  const boolFields = ['includeReceivables', 'includeInventory', 'includePoCommitments'];
  /** @type {Record<string, boolean>} */
  const flags = {};
  for (const f of boolFields) {
    if (b[f] === undefined) {
      errors.push(`${f} is required.`);
      continue;
    }
    if (typeof b[f] !== 'boolean') {
      errors.push(`${f} must be a boolean.`);
    } else {
      flags[f] = b[f];
    }
  }

  let policyNotes = '';
  if (b.policyNotes !== undefined && b.policyNotes !== null) {
    if (typeof b.policyNotes !== 'string') {
      errors.push('policyNotes must be a string.');
    } else {
      policyNotes = String(b.policyNotes).trim();
      if (policyNotes.length > POLICY_NOTES_MAX_LEN) {
        errors.push(`policyNotes must be at most ${POLICY_NOTES_MAX_LEN} characters.`);
      }
    }
  }

  if (errors.length) return { ok: false, error: errors.join(' ') };
  return { ok: true, amounts, flags, policyNotes };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} policyKey
 * @param {unknown} newValue
 * @param {{ id?: string; displayName?: string } | null} actor
 * @param {string} t
 */
function upsertPolicyKey(db, policyKey, newValue, actor, t) {
  const uid = String(actor?.id || '').trim() || null;
  const dname = String(actor?.displayName || '').trim() || null;
  const newV = JSON.stringify(newValue);
  const oldRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(policyKey);
  const oldV = oldRow?.value_json != null ? String(oldRow.value_json) : null;

  db.prepare(
    `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
     VALUES (?,?,?,?,?)
     ON CONFLICT(policy_key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at_iso = excluded.updated_at_iso,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_by_display = excluded.updated_by_display`
  ).run(policyKey, newV, t, uid, dname);

  db.prepare(
    `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
     VALUES (?,?,?,?,?,?,?)`
  ).run(newPolicyAuditId(), policyKey, oldV, newV, uid, dname, t);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {{ id?: string; displayName?: string; roleKey?: string } | null} actor
 */
export function setExecReservePolicy(db, body, actor) {
  if (!orgPolicyTablesReady(db)) {
    return { ok: false, error: 'Policy tables are not available. Run migrations.' };
  }

  const v = validateReservePolicyPutBody(body);
  if (!v.ok) return v;

  const fieldToKey = Object.fromEntries(RESERVE_POLICY_KEY_DEFS.map((d) => [d.field, d.key]));
  const t = nowIso();

  db.transaction(() => {
    for (const [field, amount] of Object.entries(v.amounts)) {
      upsertPolicyKey(db, fieldToKey[field], amount, actor, t);
    }
    for (const [field, flag] of Object.entries(v.flags)) {
      upsertPolicyKey(db, fieldToKey[field], flag, actor, t);
    }
    const notesKey = fieldToKey.policyNotes;
    if (v.policyNotes) {
      upsertPolicyKey(db, notesKey, v.policyNotes, actor, t);
    } else {
      const existing = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(notesKey);
      if (existing) {
        upsertPolicyKey(db, notesKey, '', actor, t);
      }
    }
  })();

  return { ok: true, ...getExecReservePolicyResponse(db) };
}
