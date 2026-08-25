/**
 * Refund claiming-staff directory, default payee from quotation maker, inline bank capture.
 */
import { requirePermission } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import {
  claimingStaffPayeeForUserId,
  defaultRefundPayeeForQuotation,
  listClaimingStaffForRefunds,
  listHandledByStaffForQuotations,
} from '../sales/customerPayoutAccount.js';
import { saveRefundPayoutBank } from '../sales/refundPayoutBankOps.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerRefundClaimingStaffRoutes(app, db) {
  /** Company-wide HR-linked staff — branch filter used to hide the quote maker. */
  app.get(
    '/api/refunds/claiming-staff',
    requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']),
    (req, res) => {
      try {
        const claimingStaff = listClaimingStaffForRefunds(db, 'ALL');
        res.json({ ok: true, claimingStaff });
      } catch (e) {
        console.error('[refunds/claiming-staff]', e);
        res.status(500).json({ ok: false, error: 'Failed to load claiming staff.' });
      }
    }
  );

  /**
   * Default sales payee for a refund = quotation handled-by login → HR bank.
   * Ensures sales-customer link when missing.
   */
  app.get(
    '/api/refunds/default-payee',
    requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']),
    (req, res) => {
      try {
        const quotationRef = String(req.query.quotationRef || '').trim();
        const r = defaultRefundPayeeForQuotation(db, quotationRef);
        if (!r.ok) return res.status(r.error === 'Quotation not found.' ? 404 : 400).json(r);
        res.json(r);
      } catch (e) {
        console.error('[refunds/default-payee]', e);
        res.status(500).json({ ok: false, error: 'Failed to resolve default payee.' });
      }
    }
  );

  /** Active HR staff for quotation “Handled by” (available to sales, not settings-gated). */
  app.get(
    '/api/quotations/handled-by-staff',
    requirePermission(['quotations.manage', 'sales.view', 'sales.manage', 'refunds.request']),
    (req, res) => {
      try {
        const branchId = String(req.query.branchId || req.workspaceBranchId || '').trim();
        const staff = listHandledByStaffForQuotations(db, { branchId });
        res.json({ ok: true, staff });
      } catch (e) {
        console.error('[quotations/handled-by-staff]', e);
        res.status(500).json({ ok: false, error: 'Failed to load handled-by staff.' });
      }
    }
  );

  /** Capture bank on customer / associated staff without leaving the refund form. */
  app.post(
    '/api/refunds/payout-bank',
    requirePermission(['refunds.request', 'refunds.approve', 'finance.approve', 'customers.manage']),
    (req, res) => {
      try {
        const body = req.body || {};
        const r = saveRefundPayoutBank(db, {
          ...body,
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        });
        if (!r.ok) return res.status(400).json(r);
        res.json(r);
      } catch (e) {
        console.error('[refunds/payout-bank]', e);
        res.status(500).json({ ok: false, error: 'Failed to save payout bank.' });
      }
    }
  );
}

/** After quote save: ensure handled-by user has an HR sales customer for refunds. */
export function ensureQuotationHandlerSalesCustomer(db, quotationId) {
  const qid = String(quotationId || '').trim();
  if (!qid || !hasColumn(db, 'quotations', 'handled_by_user_id')) return;
  const row = db
    .prepare(`SELECT handled_by_user_id FROM quotations WHERE id = ?`)
    .get(qid);
  const uid = String(row?.handled_by_user_id || '').trim();
  if (!uid) return;
  try {
    claimingStaffPayeeForUserId(db, uid);
    const cid = db
      .prepare(`SELECT sales_customer_id FROM hr_staff_profiles WHERE user_id = ?`)
      .get(uid)?.sales_customer_id;
    const salesCid = String(cid || '').trim();
    if (!salesCid) return;
    const u = db
      .prepare(`SELECT display_name, username FROM app_users WHERE id = ?`)
      .get(uid);
    const label = String(u?.display_name || u?.username || '').trim();
    db.prepare(
      `UPDATE quotations
       SET agent_customer_id = COALESCE(NULLIF(trim(agent_customer_id), ''), ?),
           agent_customer_name = COALESCE(NULLIF(trim(agent_customer_name), ''), ?)
       WHERE id = ?`
    ).run(salesCid, label || null, qid);
  } catch (e) {
    console.warn('[ensureQuotationHandlerSalesCustomer]', qid, e?.message || e);
  }
}
