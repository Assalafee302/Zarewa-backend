/**
 * Record a second supplier payment, and the reversal when that overpayment comes back.
 */
import crypto from 'node:crypto';
import express from 'express';
import { requirePermission, userHasPermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { listBranches } from '../branches.js';
import { getPurchaseOrder, listTreasuryAccounts } from '../readModel.js';
import { withWriteDelta } from '../workspaceWriteDelta.js';
import {
  listSupplierOverpaymentMovements,
  recordSupplierExcessPayment,
  recordSupplierOverpaymentReversal,
  supplierCashPosition,
} from '../finance/supplierOverpaymentOps.js';

export const SUPPLIER_OVERPAYMENT_PATH = '/supplier-overpayments';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function csrfTokensEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function formatNgn(n) {
  return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function canPost(user) {
  return userHasPermission(user, 'finance.pay') || userHasPermission(user, '*');
}

/**
 * @param {object} model
 */
export function renderSupplierOverpaymentPage(model = {}) {
  const user = model.user || null;
  const signedIn = Boolean(user);
  const allowed = Boolean(model.canPost);
  const position = model.position || null;
  const accounts = Array.isArray(model.accounts) ? model.accounts : [];
  const movements = Array.isArray(model.movements) ? model.movements : [];
  const poId = String(model.poId || '');
  const selectedAccount = String(model.treasuryAccountId || '');
  const accountOptions = accounts
    .map((a) => {
      const id = String(a.id);
      const label = `${a.name || 'Account ' + id}${a.type ? ` · ${a.type}` : ''} · ₦${formatNgn(a.balance)}`;
      return `<option value="${esc(id)}"${id === selectedAccount ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
  const movementRows = movements
    .map((row) => {
      const inbound = Number(row.amountNgn) > 0;
      return `<tr>
        <td>${esc(String(row.postedAtISO || '').slice(0, 10))}</td>
        <td>${esc(inbound ? 'Reversal (cash in)' : 'Extra payment (cash out)')}</td>
        <td>${esc(row.reference)}</td>
        <td>${esc(row.note)}</td>
        <td class="num">${inbound ? '' : '−'}₦${formatNgn(Math.abs(row.amountNgn))}</td>
      </tr>`;
    })
    .join('');

  let positionCard = '';
  if (position?.ok) {
    positionCard = `<section class="card">
      <h2>${esc(position.supplierName || 'Supplier')} · ${esc(position.poId)}</h2>
      <p class="hint">Status ${esc(position.status || '—')} · branch ${esc(position.branchId || '—')}</p>
      <table>
        <tbody>
          <tr><th>Order value</th><td class="num">₦${formatNgn(position.obligationNgn)}</td></tr>
          <tr><th>Already paid</th><td class="num">₦${formatNgn(position.supplierPaidNgn)}</td></tr>
          <tr><th>Still owed on this order</th><td class="num">₦${formatNgn(position.stillOwedNgn)}</td></tr>
          <tr><th>Above the order (supplier owes this back)</th><td class="num">₦${formatNgn(position.excessNgn)}</td></tr>
        </tbody>
      </table>
      ${
        movements.length
          ? `<h2>Already recorded here</h2><table><thead><tr><th>Date</th><th>Kind</th><th>Reference</th><th>Note</th><th>Amount</th></tr></thead><tbody>${movementRows}</tbody></table>`
          : '<p class="hint">Nothing has been recorded on this screen for this purchase order yet.</p>'
      }
    </section>
    <form method="post" action="${SUPPLIER_OVERPAYMENT_PATH}" class="card">
      <h2>Record the second payment</h2>
      <p class="hint">Use this when the money has already left the bank a second time, or the transfer was more than the order. The part that clears what is still owed settles the invoice. The rest is an amount the supplier owes back.</p>
      <input type="hidden" name="csrf" value="${esc(model.csrf)}" />
      <input type="hidden" name="action" value="excess" />
      <input type="hidden" name="poId" value="${esc(position.poId)}" />
      <label>Why<select name="reason">
        <option value="duplicate_payment">We paid this supplier twice</option>
        <option value="overpayment">We paid more than the order</option>
      </select></label>
      <label>Amount that left the bank (₦)<input name="amountNgn" inputmode="numeric" required /></label>
      <label>Bank / cash account<select name="treasuryAccountId" required>${accountOptions}</select></label>
      <label>Date<input type="date" name="dateISO" value="${esc(model.dateISO || todayISO())}" required /></label>
      <label>Bank reference<input name="reference" required /></label>
      <label>Note<input name="note" required placeholder="Which transfer, and why it is extra" /></label>
      <div class="row"><button type="submit"${allowed ? '' : ' disabled'}>Record extra payment</button></div>
    </form>
    <form method="post" action="${SUPPLIER_OVERPAYMENT_PATH}" class="card">
      <h2>Record the reversal of the overpayment</h2>
      <p class="hint">Use this when the supplier refunds the extra, or the bank reverses it. You cannot reverse more than the amount above the order (₦${formatNgn(position.excessNgn)}).</p>
      <input type="hidden" name="csrf" value="${esc(model.csrf)}" />
      <input type="hidden" name="action" value="reversal" />
      <input type="hidden" name="poId" value="${esc(position.poId)}" />
      <label>Why<select name="reason">
        <option value="supplier_refund">Supplier refunded the overpayment</option>
        <option value="bank_reversal">Bank reversed the extra payment</option>
      </select></label>
      <label>Amount coming back (₦)<input name="amountNgn" inputmode="numeric" required /></label>
      <label>Bank / cash account the money entered<select name="treasuryAccountId" required>${accountOptions}</select></label>
      <label>Date<input type="date" name="dateISO" value="${esc(model.dateISO || todayISO())}" required /></label>
      <label>Bank reference<input name="reference" required /></label>
      <label>Note<input name="note" required placeholder="Refund or reversal reference" /></label>
      <div class="row"><button type="submit" class="secondary"${allowed ? '' : ' disabled'}>Record reversal</button></div>
    </form>`;
  } else if (poId && model.lookupError) {
    positionCard = `<p class="err">${esc(model.lookupError)}</p>`;
  }

  const body = `
    ${signedIn ? `<p class="hint">Signed in as ${esc(user.displayName || user.username || '')}.</p>` : '<p class="err">Sign in first.</p>'}
    ${allowed || !signedIn ? '' : '<p class="err">Recording these payments needs finance pay permission.</p>'}
    ${model.notice ? `<p class="ok">${esc(model.notice)}</p>` : ''}
    ${model.error ? `<p class="err">${esc(model.error)}</p>` : ''}
    <p class="lead">A normal supplier payment stops once the purchase order is fully paid. Use this page for the two cases that payment cannot take: the <strong>second payment</strong> when a supplier was paid twice, and the <strong>reversal</strong> when an overpayment comes back.</p>
    <form method="get" action="${SUPPLIER_OVERPAYMENT_PATH}" class="card">
      <h2>Purchase order</h2>
      <label>PO number<input name="poId" value="${esc(poId)}" required /></label>
      <div class="row"><button type="submit">Show what is paid</button></div>
    </form>
    ${positionCard}
    <p><a href="/">Back to Zarewa</a></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Supplier overpayments — Zarewa</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f4f1ea; color: #1c1917; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
    h2 { font-size: 1.15rem; margin: 0 0 0.6rem; }
    .lead, .hint { line-height: 1.45; }
    .hint { color: #57534e; }
    .card { background: #fff; border: 1px solid #d6d3d1; border-radius: 12px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
    label { display: block; font-weight: 600; margin: 0.75rem 0; }
    input, select { display: block; width: 100%; margin-top: 0.35rem; padding: 0.55rem 0.6rem; font-size: 1rem; box-sizing: border-box; }
    .row { display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap; }
    button { background: #1e3a5f; color: #fff; border: 0; border-radius: 8px; padding: 0.7rem 1rem; font-size: 1rem; cursor: pointer; }
    button.secondary { background: #57534e; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .ok { background: #dcfce7; color: #14532d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .err { background: #fee2e2; color: #7f1d1d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 0.35rem 0.4rem; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <main>
    <h1>Supplier double payment and overpayment</h1>
    ${body}
  </main>
</body>
</html>`;
}

function pageModel(db, req, extra = {}) {
  const poId = String(extra.poId || req.query?.poId || req.body?.poId || '').trim();
  const branches = listBranches(db);
  const branchId =
    String(extra.branchId || req.workspaceBranchId || branches[0]?.id || '').trim();
  const accounts = branchId ? listTreasuryAccounts(db, branchId) : listTreasuryAccounts(db, 'ALL');
  const position = poId ? supplierCashPosition(db, poId) : null;
  return {
    user: req.user || null,
    csrf: req.csrfToken || '',
    canPost: canPost(req.user),
    poId,
    branchId,
    accounts,
    treasuryAccountId: String(extra.treasuryAccountId || req.body?.treasuryAccountId || accounts[0]?.id || ''),
    dateISO: String(extra.dateISO || req.body?.dateISO || todayISO()),
    position: position?.ok ? position : null,
    lookupError: position && !position.ok ? position.error : '',
    movements: position?.ok ? listSupplierOverpaymentMovements(db, poId) : [],
    notice: extra.notice || String(req.query?.notice || ''),
    error: extra.error || '',
  };
}

function sendPage(res, html, status = 200) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
}

function workspaceFields(req) {
  return {
    actor: req.user,
    createdBy: req.user?.displayName || req.user?.username || 'Finance',
    workspaceBranchId: req.workspaceBranchId,
    workspaceViewAll: Boolean(req.workspaceViewAll),
  };
}

function jsonResult(res, db, poId, result) {
  if (!result.ok) return apiError(res, { status: 400, code: 'SUPPLIER_OVERPAYMENT', error: result.error });
  const purchaseOrder = getPurchaseOrder(db, poId);
  return res.status(result.duplicate ? 200 : 201).json(
    withWriteDelta(
      { ...result, purchaseOrder },
      { purchaseOrders: purchaseOrder ? [purchaseOrder] : [] }
    )
  );
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerSupplierOverpaymentRoutes(app, db) {
  app.get(
    '/api/purchase-orders/:poId/supplier-overpayment',
    requirePermission('finance.pay'),
    (req, res) => {
      const position = supplierCashPosition(db, req.params.poId);
      if (!position.ok) return apiError(res, { status: 404, code: 'PO_NOT_FOUND', error: position.error });
      return res.json({
        ok: true,
        position,
        movements: listSupplierOverpaymentMovements(db, position.poId),
      });
    }
  );

  app.post(
    '/api/purchase-orders/:poId/supplier-excess-payment',
    requirePermission('finance.pay'),
    (req, res) => {
      const body = req.body || {};
      const result = recordSupplierExcessPayment(db, req.params.poId, {
        ...workspaceFields(req),
        amountNgn: body.amountNgn,
        treasuryAccountId: body.treasuryAccountId,
        dateISO: body.dateISO,
        reference: body.reference,
        note: body.note,
        reason: body.reason,
      });
      return jsonResult(res, db, req.params.poId, result);
    }
  );

  app.post(
    '/api/purchase-orders/:poId/supplier-overpayment-reversal',
    requirePermission('finance.pay'),
    (req, res) => {
      const body = req.body || {};
      const result = recordSupplierOverpaymentReversal(db, req.params.poId, {
        ...workspaceFields(req),
        amountNgn: body.amountNgn,
        treasuryAccountId: body.treasuryAccountId,
        dateISO: body.dateISO,
        reference: body.reference,
        note: body.note,
        reason: body.reason,
      });
      return jsonResult(res, db, req.params.poId, result);
    }
  );
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerSupplierOverpaymentPage(app, db) {
  app.get(SUPPLIER_OVERPAYMENT_PATH, (req, res) => {
    return sendPage(res, renderSupplierOverpaymentPage(pageModel(db, req)));
  });

  app.post(SUPPLIER_OVERPAYMENT_PATH, express.urlencoded({ extended: true }), (req, res) => {
    const body = req.body || {};
    const modelBase = pageModel(db, req, {
      poId: body.poId,
      treasuryAccountId: body.treasuryAccountId,
      dateISO: body.dateISO,
    });
    if (!req.user) {
      return sendPage(res, renderSupplierOverpaymentPage({ ...modelBase, error: 'Sign in first.' }), 401);
    }
    if (!csrfTokensEqual(req.csrfToken, body.csrf)) {
      return sendPage(
        res,
        renderSupplierOverpaymentPage({
          ...modelBase,
          error: 'Your session expired. Sign in again, then open this page and retry.',
        }),
        403
      );
    }
    if (!canPost(req.user)) {
      return sendPage(
        res,
        renderSupplierOverpaymentPage({
          ...modelBase,
          error: 'Recording these payments needs finance pay permission.',
        }),
        403
      );
    }
    const action = String(body.action || '').trim();
    const payload = {
      ...workspaceFields(req),
      amountNgn: body.amountNgn,
      treasuryAccountId: body.treasuryAccountId,
      dateISO: body.dateISO,
      reference: body.reference,
      note: body.note,
      reason: body.reason,
    };
    const result =
      action === 'excess'
        ? recordSupplierExcessPayment(db, body.poId, payload)
        : action === 'reversal'
          ? recordSupplierOverpaymentReversal(db, body.poId, payload)
          : { ok: false, error: 'Choose a payment or a reversal.' };
    if (!result.ok) {
      return sendPage(res, renderSupplierOverpaymentPage({ ...modelBase, error: result.error }), 400);
    }
    const poId = String(body.poId || '').trim();
    const notice = result.duplicate
      ? 'That bank reference was already recorded on this purchase order.'
      : action === 'excess'
        ? `Recorded ₦${formatNgn(result.amountNgn)} leaving the bank. ₦${formatNgn(result.advanceNgn)} is above the order.`
        : `Recorded ₦${formatNgn(result.amountNgn)} coming back. Paid on this order is now ₦${formatNgn(result.position?.supplierPaidNgn)}.`;
    const qs = new URLSearchParams({ poId, notice });
    return res.redirect(303, `${SUPPLIER_OVERPAYMENT_PATH}?${qs.toString()}`);
  });
}
