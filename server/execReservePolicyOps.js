/**
 * Reserve policy readiness for exec dashboard (read-only; no headroom calculation in Phase 3B).
 */
import { orgPolicyTablesReady } from './orgPolicy.js';

export const RESERVE_POLICY_KEYS = [
  { key: 'treasury.reserves.operating_ngn', label: 'Operating reserve' },
  { key: 'treasury.reserves.emergency_ngn', label: 'Emergency reserve' },
  { key: 'treasury.reserves.payroll_ngn', label: 'Payroll reserve' },
  { key: 'treasury.reserves.supplier_payment_ngn', label: 'Supplier payment reserve' },
  { key: 'treasury.reserves.stock_purchase_ngn', label: 'Stock purchase reserve' },
  { key: 'treasury.reserves.tax_statutory_ngn', label: 'Tax / statutory reserve' },
  { key: 'treasury.withdrawal.include_receivables', label: 'Receivables in headroom policy' },
  { key: 'treasury.withdrawal.include_inventory', label: 'Inventory in headroom policy' },
];

/**
 * @param {import('better-sqlite3').Database} db
 */
export function buildReservePolicyReadiness(db) {
  const missingKeys = [];
  if (!orgPolicyTablesReady(db)) {
    return {
      configured: false,
      missingKeys: RESERVE_POLICY_KEYS.map((k) => k.key),
      missingLabels: RESERVE_POLICY_KEYS.map((k) => k.label),
      note: 'Reserve policy is not configured. Indicative expansion headroom is hidden until MD/Finance approves reserve assumptions.',
      headroomHidden: true,
    };
  }

  for (const { key, label } of RESERVE_POLICY_KEYS) {
    const row = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(key);
    if (row?.value_json == null || String(row.value_json).trim() === '') {
      missingKeys.push({ key, label });
      continue;
    }
    try {
      const parsed = JSON.parse(String(row.value_json));
      if (parsed === null || parsed === undefined) missingKeys.push({ key, label });
    } catch {
      missingKeys.push({ key, label });
    }
  }

  const configured = missingKeys.length === 0;
  return {
    configured,
    missingKeys: missingKeys.map((m) => m.key),
    missingLabels: missingKeys.map((m) => m.label),
    note: configured
      ? 'Reserve policy keys are present. Indicative expansion headroom calculation remains disabled until MD/Finance approves the formula.'
      : 'Reserve policy is not configured. Indicative expansion headroom is hidden until MD/Finance approves reserve assumptions.',
    headroomHidden: true,
  };
}
