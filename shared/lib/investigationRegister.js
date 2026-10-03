/**
 * Investigation register — case vocabulary and the suspense tie-out.
 * Suspense tracks cash actually taken off a bank for an open case (suspended receipts),
 * not the wider "amount at risk" which can include linked refunds that were not suspended.
 */

export const INVESTIGATION_CASE_TYPES = [
  'unbacked_receipt',
  'duplicate_receipt',
  'double_payment',
  'over_refund',
  'unknown_payment',
  'staff_account_payout',
  'other',
];

export const INVESTIGATION_STATUSES = ['open', 'under_review', 'recovered', 'written_off', 'cleared'];

export const INVESTIGATION_OPEN_STATUSES = ['open', 'under_review'];

export const INVESTIGATION_ENTITY_TYPES = [
  'receipt',
  'receipt_line',
  'refund',
  'treasury_movement',
  'quotation',
  'payment_request',
  'customer',
  'staff',
  'cutting_list',
  'production_job',
  'ledger_entry',
];

export const INVESTIGATION_SUSPENSE_GL_CODE = '1060';
export const INVESTIGATION_LOSS_GL_CODE = '6190';

export const RECEIPT_SUSPENDED_STATUS = 'Suspended - investigation';

const MANAGE_ROLES = new Set(['md', 'head_of_accounts', 'operations_manager', 'ops_manager']);

export function userMayManageInvestigations(actor) {
  if (!actor) return false;
  const perms = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (perms.includes('*') || perms.includes('investigation.manage')) return true;
  const rk = String(actor.roleKey || actor.role_key || '').trim().toLowerCase();
  if (MANAGE_ROLES.has(rk)) return true;
  const title = String(actor.jobTitle || actor.title || '').trim().toLowerCase();
  if (title === 'head of accounts' || title === 'operations manager') return true;
  return false;
}

export function userMayWriteOffInvestigation(actor) {
  if (!actor) return false;
  const perms = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (perms.includes('*')) return true;
  const rk = String(actor.roleKey || actor.role_key || '').trim().toLowerCase();
  return rk === 'md';
}

export function isInvestigationOpenStatus(status) {
  return INVESTIGATION_OPEN_STATUSES.includes(String(status || '').trim());
}

/** Cash still sitting in suspense for open cases. */
export function openSuspenseExpectedNgn(cases) {
  return (Array.isArray(cases) ? cases : [])
    .filter((c) => isInvestigationOpenStatus(c.status))
    .reduce((sum, c) => sum + Math.max(0, Math.round(Number(c.suspendedNgn) || 0) - Math.round(Number(c.recoveredNgn) || 0)), 0);
}

export function investigationTotals(cases) {
  const list = Array.isArray(cases) ? cases : [];
  const open = list.filter((c) => isInvestigationOpenStatus(c.status));
  return {
    openCases: open.length,
    amountAtRiskNgn: open.reduce((s, c) => s + Math.round(Number(c.amountAtRiskNgn) || 0), 0),
    amountRecoveredNgn: list.reduce((s, c) => s + Math.round(Number(c.recoveredNgn ?? c.amountRecoveredNgn) || 0), 0),
    suspenseExpectedNgn: openSuspenseExpectedNgn(list),
  };
}

export function casesPastReviewDate(cases, asOfISO) {
  const day = String(asOfISO || '').slice(0, 10);
  return (Array.isArray(cases) ? cases : []).filter((c) => {
    if (!isInvestigationOpenStatus(c.status)) return false;
    const review = String(c.reviewDate || c.review_date || '').slice(0, 10);
    return Boolean(review) && review < day;
  });
}

export function investigationCasesToCsv(cases) {
  const header = [
    'id',
    'title',
    'case_type',
    'status',
    'amount_at_risk_ngn',
    'amount_recovered_ngn',
    'suspended_ngn',
    'owner_user_id',
    'review_date',
    'branch_id',
  ];
  const lines = [header.join(',')];
  for (const c of Array.isArray(cases) ? cases : []) {
    const cells = [
      c.id,
      c.title,
      c.caseType || c.case_type,
      c.status,
      c.amountAtRiskNgn ?? c.amount_at_risk_ngn,
      c.recoveredNgn ?? c.amount_recovered_ngn,
      c.suspendedNgn ?? c.suspended_ngn,
      c.ownerUserId || c.owner_user_id,
      c.reviewDate || c.review_date,
      c.branchId || c.branch_id,
    ].map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

/** Receipts that still count toward quotation paid. */
export function receiptCountsTowardQuotationPaidSql(statusExpr = 'status') {
  return `(${statusExpr} IS NULL OR (TRIM(LOWER(${statusExpr})) NOT IN ('reversed') AND LOWER(${statusExpr}) NOT LIKE 'suspended%investigation'))`;
}
