/**
 * Phase 11C — go-live governance pack (mirrors scripts/phase11-analyze-exports.py against live DB).
 */
import { branchWhere } from './branches.js';
import { REFUND_MD_APPROVAL_THRESHOLD_NGN } from '../shared/workspaceGovernance.js';
import { buildPendingApprovalsReport, buildProductionStatusReport } from './operationalReportsOps.js';
import {
  refundProductionAlignmentWarnings,
  validateRefundProductionAlignmentAtSubmit,
} from './refundProductionAlignment.js';

function nowIso() {
  return new Date().toISOString();
}

function parseRefundCategories(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* plain text */
  }
  const s = String(raw).trim();
  return s && s !== '—' ? [s] : [];
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.header)).join(',');
  const body = (rows || []).map((row) =>
    columns.map((c) => csvEscape(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(',')
  );
  return [header, ...body].join('\n');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function findMisalignedActiveRefunds(db, branchScope = 'ALL') {
  const bRef = branchWhere(db, 'customer_refunds', branchScope);
  const rows = db
    .prepare(
      `SELECT refund_id, quotation_ref, reason_category, status, amount_ngn, requested_by, requested_at_iso
       FROM customer_refunds
       WHERE TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')
       ${bRef.sql}
       ORDER BY requested_at_iso DESC
       LIMIT 500`
    )
    .all(...bRef.args);

  const misaligned = [];
  for (const r of rows) {
    const cats = parseRefundCategories(r.reason_category);
    const issues = refundProductionAlignmentWarnings(db, r.quotation_ref, cats);
    const hard = issues.filter((i) => i.code === 'cancellation_with_production');
    if (hard.length === 0) continue;
    misaligned.push({
      refundId: r.refund_id,
      quotationRef: r.quotation_ref,
      status: r.status,
      amountNgn: r.amount_ngn,
      requestedBy: r.requested_by,
      requestedAtIso: r.requested_at_iso,
      issues: hard.map((i) => i.message),
    });
  }
  return misaligned;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function buildGovernancePack(db, branchScope = 'ALL') {
  const pending = buildPendingApprovalsReport(db, branchScope);
  const production = buildProductionStatusReport(db, branchScope);
  const misalignedRefunds = findMisalignedActiveRefunds(db, branchScope);

  const bRef = branchWhere(db, 'customer_refunds', branchScope);
  const refundStatusRows = db
    .prepare(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(amount_ngn), 0) AS sum_ngn
       FROM customer_refunds
       WHERE 1=1 ${bRef.sql}
       GROUP BY status`
    )
    .all(...bRef.args);

  const aboveMd = db
    .prepare(
      `SELECT refund_id, amount_ngn, status, quotation_ref
       FROM customer_refunds
       WHERE amount_ngn > ?
         AND TRIM(COALESCE(LOWER(status), '')) IN ('pending', 'approved')
       ${bRef.sql}
       ORDER BY amount_ngn DESC
       LIMIT 50`
    )
    .all(REFUND_MD_APPROVAL_THRESHOLD_NGN, ...bRef.args);

  return {
    ok: true,
    generatedAtISO: nowIso(),
    branchScope,
    phase: '11C',
    counts: {
      pendingApprovals: pending.totals?.pendingApprovalCount ?? 0,
      pendingPayments: pending.totals?.pendingPaymentCount ?? 0,
      productionJobs: production.totalJobs ?? 0,
      qcGaps: production.qcGaps?.length ?? 0,
      paymentGateExceptions: production.paymentGateExceptions?.length ?? 0,
      dualControlWarnings: pending.dualControlWarnings?.length ?? 0,
      misalignedRefunds: misalignedRefunds.length,
    },
    refundByStatus: refundStatusRows.map((r) => ({
      status: r.status,
      count: Number(r.c) || 0,
      sumRequestedNgn: Math.round(Number(r.sum_ngn) || 0),
    })),
    aboveMdThresholdPending: aboveMd.map((r) => ({
      refundId: r.refund_id,
      amountNgn: r.amount_ngn,
      status: r.status,
      quotationRef: r.quotation_ref,
    })),
    dualControlWarnings: pending.dualControlWarnings || [],
    adminTrialBypasses: pending.adminTrialBypasses || [],
    paymentGateExceptions: production.paymentGateExceptions || [],
    qcGaps: production.qcGaps || [],
    plannedActualOutliers: production.plannedActualOutliers || [],
    productionGateAwaitingBm: pending.productionGate?.awaitingBmOverride || [],
    misalignedRefunds,
    productionStatusMix: production.statusMix || {},
    jobTypes: production.jobTypes || {},
  };
}

/**
 * @param {ReturnType<typeof buildGovernancePack>} pack
 */
export function governancePackToCsv(pack) {
  const sections = [];

  sections.push('# Governance pack summary');
  sections.push(
    rowsToCsv(
      [
        { label: 'Pending approvals', value: pack.counts.pendingApprovals },
        { label: 'Pending payments', value: pack.counts.pendingPayments },
        { label: 'Production jobs', value: pack.counts.productionJobs },
        { label: 'QC gaps', value: pack.counts.qcGaps },
        { label: 'Payment gate exceptions', value: pack.counts.paymentGateExceptions },
        { label: 'Dual-control warnings', value: pack.counts.dualControlWarnings },
        { label: 'Misaligned refunds', value: pack.counts.misalignedRefunds },
      ],
      [
        { header: 'metric', key: 'label' },
        { header: 'value', key: 'value' },
      ]
    )
  );

  sections.push('\n# Misaligned refunds (Order cancellation vs production)');
  sections.push(
    rowsToCsv(pack.misalignedRefunds || [], [
      { header: 'refund_id', key: 'refundId' },
      { header: 'quotation_ref', key: 'quotationRef' },
      { header: 'status', key: 'status' },
      { header: 'amount_ngn', key: 'amountNgn' },
      { header: 'requested_by', key: 'requestedBy' },
    ])
  );

  sections.push('\n# Dual-control warnings');
  sections.push(
    rowsToCsv(pack.dualControlWarnings || [], [
      { header: 'kind', key: 'kind' },
      { header: 'refund_id', key: 'refundId' },
      { header: 'message', key: 'message' },
    ])
  );

  sections.push('\n# Payment gate exceptions');
  sections.push(
    rowsToCsv(pack.paymentGateExceptions || [], [
      { header: 'job_id', key: 'jobId' },
      { header: 'quotation_ref', key: 'quotationRef' },
      { header: 'paid_pct', key: 'paidPct' },
    ])
  );

  return sections.join('\n');
}

export { validateRefundProductionAlignmentAtSubmit };
