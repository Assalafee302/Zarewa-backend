/**
 * Phase 11B — operational reporting (pending approvals, production status).
 */
import { branchWhere, listManagementItems } from './readModel.js';
import { REFUND_MD_APPROVAL_THRESHOLD_NGN } from '../shared/workspaceGovernance.js';
import { metreVarianceExceedsThreshold } from '../shared/lib/productionMetreVariance.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function buildPendingApprovalsReport(db, branchScope = 'ALL') {
  const mgmt = listManagementItems(db, branchScope);
  const bRef = branchWhere(db, 'customer_refunds', branchScope);

  const approvedUnpaid = db
    .prepare(
      `SELECT refund_id, customer_name, quotation_ref, approved_amount_ngn, amount_ngn, approved_by, approval_date, branch_id
       FROM customer_refunds
       WHERE TRIM(COALESCE(LOWER(status), '')) = 'approved'
       ${bRef.sql}
       ORDER BY approval_date DESC LIMIT 100`
    )
    .all(...bRef.args);

  const mdThresholdPending = (mgmt.pendingRefunds || []).filter(
    (r) => (Number(r.amount_ngn) || 0) > REFUND_MD_APPROVAL_THRESHOLD_NGN
  );

  const dualControlWarnings = [];
  if (readFinanceFeatureFlags().enforceDualControlPayments) {
    const rows = db
      .prepare(
        `SELECT refund_id, requested_by_user_id, approved_by_user_id, requested_by, approved_by, paid_by_user_id, paid_by, status
         FROM customer_refunds
         WHERE TRIM(COALESCE(LOWER(status), '')) IN ('approved', 'paid')
         ${bRef.sql}`
      )
      .all(...bRef.args);
    for (const r of rows) {
      if (r.requested_by_user_id && r.approved_by_user_id && r.requested_by_user_id === r.approved_by_user_id) {
        dualControlWarnings.push({
          kind: 'same_requester_approver',
          refundId: r.refund_id,
          message: 'Requester and approver are the same user.',
        });
      }
      if (r.approved_by_user_id && r.paid_by_user_id && r.approved_by_user_id === r.paid_by_user_id) {
        dualControlWarnings.push({
          kind: 'same_approver_payer',
          refundId: r.refund_id,
          message: 'Approver and payer are the same user.',
        });
      }
    }
  }

  let adminTrialRows = [];
  try {
    adminTrialRows = db
      .prepare(
        `SELECT entity_id AS refundId, occurred_at_iso AS atISO, actor_name AS actorName, note
         FROM audit_log
         WHERE action = 'refund.dual_control.admin_trial'
         ORDER BY occurred_at_iso DESC LIMIT 30`
      )
      .all();
  } catch {
    /* optional */
  }

  const pendingApprovalCount =
    (mgmt.pendingRefunds?.length || 0) +
    (mgmt.pendingExpenses?.length || 0) +
    (mgmt.pendingConversionReviews?.length || 0) +
    (mgmt.pendingMaterialIncidents?.length || 0) +
    (mgmt.productionOverrides?.length || 0);

  const pendingPaymentCount = approvedUnpaid.length;

  return {
    ok: true,
    generatedAtISO: nowIso(),
    refunds: {
      pending: mgmt.pendingRefunds || [],
      approvedUnpaid,
      mdThresholdPending,
    },
    paymentRequests: {
      pending: mgmt.pendingExpenses || [],
    },
    productionGate: {
      awaitingBmOverride: mgmt.productionOverrides || [],
    },
    conversionReviews: {
      unsignedHighLow: mgmt.pendingConversionReviews || [],
    },
    materialIncidents: {
      submittedAwaitingApproval: mgmt.pendingMaterialIncidents || [],
    },
    dualControlWarnings,
    adminTrialBypasses: adminTrialRows,
    totals: {
      pendingApprovalCount,
      pendingPaymentCount,
    },
  };
}

function classifyJobType(job, coilCount, stoneCount) {
  if (stoneCount > 0) return 'stone';
  if (coilCount > 0) return 'coil';
  if (Number(job.offcut_inventory_meters) > 0) return 'offcut';
  if (coilCount === 0 && stoneCount === 0) return 'no_coil_stone';
  return 'other';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function buildProductionStatusReport(db, branchScope = 'ALL') {
  const bJob = branchWhere(db, 'production_jobs', branchScope);
  const jobs = db
    .prepare(`SELECT * FROM production_jobs WHERE 1=1${bJob.sql}`)
    .all(...bJob.args);

  const statusMix = { Planned: 0, Running: 0, Completed: 0, Cancelled: 0 };
  const jobTypes = { coil: 0, stone: 0, offcut: 0, no_coil_stone: 0, other: 0 };
  const plannedActualOutliers = [];
  const paymentGateExceptions = [];
  const specMismatchJobs = [];
  const qcGaps = [];

  for (const job of jobs) {
    const st = String(job.status || 'Planned').trim();
    if (statusMix[st] != null) statusMix[st] += 1;

    let coilCount = 0;
    let stoneCount = 0;
    try {
      coilCount =
        db.prepare(`SELECT COUNT(*) AS c FROM production_job_coils WHERE job_id = ?`).get(job.job_id)?.c || 0;
    } catch {
      /* optional */
    }
    try {
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_job_stone_flatsheet_usage'`).get()) {
        stoneCount =
          db.prepare(`SELECT COUNT(*) AS c FROM production_job_stone_flatsheet_usage WHERE job_id = ?`).get(job.job_id)
            ?.c || 0;
      }
    } catch {
      /* optional */
    }

    const jt = classifyJobType(job, coilCount, stoneCount);
    jobTypes[jt] = (jobTypes[jt] || 0) + 1;

    if (metreVarianceExceedsThreshold(job.planned_meters, job.actual_meters)) {
      plannedActualOutliers.push({
        jobId: job.job_id,
        quotationRef: job.quotation_ref,
        status: st,
        plannedMeters: job.planned_meters,
        actualMeters: job.actual_meters,
      });
    }

    if (job.coil_spec_mismatch_pending) {
      specMismatchJobs.push({ jobId: job.job_id, quotationRef: job.quotation_ref, status: st });
    }

    const alert = String(job.conversion_alert_state || '').trim();
    if (
      st === 'Completed' &&
      (['High', 'Low'].includes(alert) || job.manager_review_required) &&
      !job.manager_review_signed_at_iso
    ) {
      qcGaps.push({
        jobId: job.job_id,
        quotationRef: job.quotation_ref,
        alertState: alert,
        missingReasonCode: ['High', 'Low'].includes(alert) && !job.conversion_variance_reason_code,
      });
    }

    if (st === 'Completed' && job.quotation_ref) {
      const q = db.prepare(`SELECT total_ngn, paid_ngn, manager_production_approved_at_iso FROM quotations WHERE id = ?`).get(
        job.quotation_ref
      );
      if (q) {
        const total = Number(q.total_ngn) || 0;
        const paid = Number(q.paid_ngn) || 0;
        const frac = total > 0 ? paid / total : 1;
        if (frac < 0.7 && !q.manager_production_approved_at_iso) {
          paymentGateExceptions.push({
            jobId: job.job_id,
            quotationRef: job.quotation_ref,
            paidPct: Math.round(frac * 1000) / 10,
          });
        }
      }
    }
  }

  return {
    ok: true,
    generatedAtISO: nowIso(),
    statusMix,
    jobTypes,
    totalJobs: jobs.length,
    plannedActualOutliers: plannedActualOutliers.slice(0, 50),
    paymentGateExceptions: paymentGateExceptions.slice(0, 50),
    specMismatchJobs: specMismatchJobs.slice(0, 50),
    qcGaps: qcGaps.slice(0, 50),
  };
}
