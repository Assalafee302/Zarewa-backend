/**
 * Phase 11B — production job intelligence payload for register UI.
 */
import { DEFAULT_BRANCH_ID, getBranch } from './branches.js';
import {
  metreVarianceExceedsThreshold,
  metreVariancePct,
  PRODUCTION_METRE_VARIANCE_WARN_PCT,
} from '../shared/lib/productionMetreVariance.js';
import {
  productionGateOverrideEffective,
  quotationHasRecordedPayment,
} from './productionGateAccess.js';

function tableExists(db, name) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
  );
}

function quotePaidFraction(quote) {
  const total = Number(quote?.total_ngn) || 0;
  const paid = Number(quote?.paid_ngn) || 0;
  if (total <= 0) return paid > 0 ? 1 : 0;
  return Math.round((paid / total) * 1000) / 1000;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobId
 */
export function getProductionJobIntel(db, jobId) {
  const id = String(jobId || '').trim();
  if (!id) return { ok: false, error: 'jobId is required.' };
  const job = db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(id);
  if (!job) return { ok: false, error: 'Production job not found.' };

  const quote = job.quotation_ref
    ? db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(job.quotation_ref)
    : null;

  const branchId = String(job.branch_id || quote?.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const branch = getBranch(db, branchId);
  const minPaidFraction = Number(branch?.cuttingListMinPaidFraction ?? 0.7) || 0.7;

  const paidFraction = quote ? quotePaidFraction(quote) : null;
  const bookPaidNgn = Math.round(Number(quote?.paid_ngn) || 0);
  const paymentGateRequired = quote && paidFraction != null && paidFraction < minPaidFraction;
  const overrideEffective = quote ? productionGateOverrideEffective(quote) : false;
  const zeroPaymentGate = paymentGateRequired && !quotationHasRecordedPayment(bookPaidNgn);
  const bmOverrideAt = overrideEffective ? quote?.manager_production_approved_at_iso || null : null;
  const paymentGateBreached =
    String(job.status || '').trim().toLowerCase() === 'completed' &&
    paymentGateRequired &&
    !overrideEffective;

  const planned = Number(job.planned_meters) || 0;
  const actual = Number(job.actual_meters) || 0;
  const variancePct = metreVariancePct(planned, actual);
  const varianceFlag = metreVarianceExceedsThreshold(planned, actual);

  let accessoryLines = [];
  if (tableExists(db, 'production_job_accessory_usage')) {
    accessoryLines = db
      .prepare(
        `SELECT name, ordered_qty, supplied_qty FROM production_job_accessory_usage WHERE job_id = ? ORDER BY name`
      )
      .all(id)
      .map((r) => ({
        name: r.name,
        orderedQty: Number(r.ordered_qty) || 0,
        suppliedQty: Number(r.supplied_qty) || 0,
      }));
  }

  let stoneLines = [];
  if (tableExists(db, 'production_job_stone_flatsheet_usage')) {
    stoneLines = db
      .prepare(
        `SELECT name, ordered_m2, supplied_m2, deduction_m2 FROM production_job_stone_flatsheet_usage WHERE job_id = ? ORDER BY name`
      )
      .all(id)
      .map((r) => ({
        name: r.name,
        orderedM2: Number(r.ordered_m2) || 0,
        suppliedM2: Number(r.supplied_m2) || 0,
        deductionM2: Number(r.deduction_m2) || 0,
      }));
  }

  const alert = String(job.conversion_alert_state || '').trim();
  const needsBmAttention =
    paymentGateBreached ||
    Boolean(job.manager_review_required) ||
    ['High', 'Low'].includes(alert) ||
    varianceFlag;
  const needsMdAttention = Boolean(job.coil_spec_mismatch_pending);

  return {
    ok: true,
    intel: {
      jobId: id,
      status: job.status,
      plannedMeters: planned,
      actualMeters: actual,
      metreVariancePct: variancePct,
      metreVarianceFlag: varianceFlag,
      metreVarianceThresholdPct: PRODUCTION_METRE_VARIANCE_WARN_PCT,
      conversionAlertState: alert || null,
      conversionVarianceReasonCode: job.conversion_variance_reason_code || null,
      conversionVarianceBand: job.conversion_variance_band || null,
      managerReviewRequired: Boolean(job.manager_review_required),
      managerReviewSignedAtISO: job.manager_review_signed_at_iso || null,
      managerReviewSignedByName: job.manager_review_signed_by_name || null,
      coilSpecMismatchPending: Boolean(job.coil_spec_mismatch_pending),
      quotationRef: job.quotation_ref || null,
      quotePaidFraction: paidFraction,
      quotePaidPct: paidFraction != null ? Math.round(paidFraction * 1000) / 10 : null,
      quotePaidNgn: bookPaidNgn,
      paymentGateMinFraction: minPaidFraction,
      paymentGateRequired: Boolean(paymentGateRequired),
      paymentGateBreached,
      zeroPaymentMdGateRequired: Boolean(zeroPaymentGate && !overrideEffective),
      branchManagerMayOverride: Boolean(paymentGateRequired && quotationHasRecordedPayment(bookPaidNgn)),
      managerProductionApprovedAtISO: bmOverrideAt,
      managerProductionApprovalLevel: quote?.manager_production_approval_level || null,
      managerProductionApprovedByName: quote?.manager_production_approved_by_name || null,
      managerProductionApprovalNote: quote?.manager_production_approval_note || null,
      managerProductionPaidFractionAtApproval: quote?.manager_production_paid_fraction_at_approval ?? null,
      accessorySummary: {
        lineCount: accessoryLines.length,
        totalSuppliedQty: accessoryLines.reduce((s, l) => s + l.suppliedQty, 0),
        lines: accessoryLines,
      },
      stoneFlatsheetSummary: {
        lineCount: stoneLines.length,
        totalSuppliedM2: stoneLines.reduce((s, l) => s + l.suppliedM2, 0),
        lines: stoneLines,
      },
      needsBmAttention,
      needsMdAttention,
    },
  };
}
