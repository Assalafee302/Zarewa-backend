/**
 * AP1d — credit exception policy limits (env + org_policy_kv; not hard-coded).
 */
import { orgPolicyTablesReady } from './orgPolicy.js';

const KEY_BRANCH_LIMIT = 'credit.branch_manager_limit_ngn';
const KEY_MD_ABOVE = 'credit.md_required_above_ngn';
const KEY_DEFAULT_TERMS = 'credit.default_terms_days';
const KEY_MAX_TERMS = 'credit.max_terms_days';

function envNgn(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envDays(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readKvNumber(db, key, fallback) {
  if (!orgPolicyTablesReady(db)) return fallback;
  try {
    const row = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(key);
    if (row?.value_json == null) return fallback;
    const n = Number(JSON.parse(String(row.value_json)));
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  } catch {
    /* keep fallback */
  }
  return fallback;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getCreditPolicyConfig(db) {
  const branchLimitEnv = envNgn('CREDIT_BRANCH_MANAGER_LIMIT_NGN', NaN);
  const mdAboveEnv = envNgn('CREDIT_MD_REQUIRED_ABOVE_NGN', NaN);
  const defaultTermsEnv = envDays('CREDIT_DEFAULT_TERMS_DAYS', NaN);
  const maxTermsEnv = envDays('CREDIT_MAX_TERMS_DAYS', NaN);

  const branchManagerLimitNgn = Number.isFinite(branchLimitEnv)
    ? branchLimitEnv
    : readKvNumber(db, KEY_BRANCH_LIMIT, null);
  const mdRequiredAboveNgn = Number.isFinite(mdAboveEnv)
    ? mdAboveEnv
    : readKvNumber(db, KEY_MD_ABOVE, null);
  const defaultTermsDays = Number.isFinite(defaultTermsEnv)
    ? defaultTermsEnv
    : readKvNumber(db, KEY_DEFAULT_TERMS, 14) || 14;
  const maxTermsDays = Number.isFinite(maxTermsEnv)
    ? maxTermsEnv
    : readKvNumber(db, KEY_MAX_TERMS, 90) || 90;

  const branchLimitConfigured = branchManagerLimitNgn != null && branchManagerLimitNgn > 0;
  const mdThresholdConfigured = mdRequiredAboveNgn != null && mdRequiredAboveNgn > 0;

  return {
    branchManagerLimitNgn: branchManagerLimitNgn ?? null,
    mdRequiredAboveNgn: mdRequiredAboveNgn ?? null,
    defaultTermsDays: Math.max(1, defaultTermsDays),
    maxTermsDays: Math.max(1, maxTermsDays),
    branchLimitConfigured,
    mdThresholdConfigured,
    policyNote: !branchLimitConfigured
      ? 'MD credit policy limit not configured — branch managers may request; MD/admin must approve.'
      : null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} amountNgn
 */
export function requiredApprovalLevelForCreditAmount(db, amountNgn) {
  const cfg = getCreditPolicyConfig(db);
  const amt = Math.round(Number(amountNgn) || 0);
  if (!cfg.branchLimitConfigured && !cfg.mdThresholdConfigured) {
    return { level: 'md', reason: 'policy_not_configured' };
  }
  const mdAbove = cfg.mdRequiredAboveNgn ?? cfg.branchManagerLimitNgn ?? 0;
  if (cfg.mdThresholdConfigured && amt > mdAbove) {
    return { level: 'md', reason: 'above_md_threshold' };
  }
  if (cfg.branchLimitConfigured && amt <= (cfg.branchManagerLimitNgn ?? 0)) {
    return { level: 'branch_manager', reason: 'within_branch_limit' };
  }
  if (cfg.branchLimitConfigured && amt > (cfg.branchManagerLimitNgn ?? 0)) {
    return { level: 'md', reason: 'above_branch_limit' };
  }
  return { level: 'md', reason: 'default_executive' };
}
