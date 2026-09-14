/**
 * Refund claiming-staff directory, default payee from quotation maker, inline bank capture.
 */
import { requirePermission } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import {
  claimingStaffPayeeForUserId,
  defaultRefundPayeeForQuotation,
  listClaimingStaffForRefunds,
  listHandledByStaffForQuotations,
} from '../sales/customerPayoutAccount.js';
import { saveRefundPayoutBank } from '../sales/refundPayoutBankOps.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import {
  assertCustomerIdInWorkspace,
  assertQuotationIdInWorkspace,
} from '../workspaceBranchGuards.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerRefundClaimingStaffRoutes(app, db) {
  /** Branch-scoped HR staff for refund payout picker (quotation default payee may still pin outside). */
  app.get(
    '/api/refunds/claiming-staff',
    requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']),
    (req, res) => {
      try {
        // Trust session workspace only — never client ?branchId= (Yola leak on Kaduna desk).
        const branchScope = resolveBootstrapBranchScope(req);
        const claimingStaff = listClaimingStaffForRefunds(db, branchScope);
        res.json({ ok: true, branchId: branchScope, claimingStaff });
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
        if (!quotationRef) {
          return res.status(400).json({ ok: false, error: 'quotationRef is required.' });
        }
        const qg = assertQuotationIdInWorkspace(db, req, quotationRef);
        if (!qg.ok) return res.status(qg.status).json({ ok: false, error: qg.error });
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
        const branchScope = resolveBootstrapBranchScope(req);
        const staff = listHandledByStaffForQuotations(db, {
          branchId: branchScope === 'ALL' ? '' : branchScope,
        });
        res.json({ ok: true, branchId: branchScope, staff });
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
        const kind = String(body.kind || '').trim().toLowerCase();
        const id = String(body.id || '').trim();
        if (kind === 'customer' && id) {
          const cg = assertCustomerIdInWorkspace(db, req, id);
          if (!cg.ok) return res.status(cg.status).json({ ok: false, error: cg.error });
        }
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

  /** Ensure an HR login has a sales-customer link so they can receive a refund allocation. */
  app.post(
    '/api/refunds/claiming-staff/ensure',
    requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']),
    (req, res) => {
      try {
        const userId = String(req.body?.userId || '').trim();
        if (!userId) return res.status(400).json({ ok: false, error: 'userId is required.' });
        const payee = claimingStaffPayeeForUserId(db, userId);
        if (!payee?.customerID) {
          return res.status(400).json({
            ok: false,
            error: 'Could not link this login to an HR sales customer. Check the staff HR profile.',
          });
        }
        res.json({ ok: true, payee });
      } catch (e) {
        console.error('[refunds/claiming-staff/ensure]', e);
        res.status(500).json({ ok: false, error: 'Failed to ensure claiming staff link.' });
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
       SET agent_customer_id = ?,
           agent_customer_name = ?
       WHERE id = ?`
    ).run(salesCid, label || null, qid);
  } catch (e) {
    console.warn('[ensureQuotationHandlerSalesCustomer]', qid, e?.message || e);
  }
}
