/**
 * Finance page: move an expense payout onto the account that paid,
 * and clear a refund that was posted as an expense.
 */
import crypto from 'node:crypto';
import express from 'express';
import { requirePermission } from '../auth.js';
import { listBranches } from '../branches.js';
import { listTreasuryAccounts } from '../readModel.js';
import {
  listDirectExpenseRefunds,
  listExpensePayoutsOnAccount,
  reassignExpensePayouts,
  releaseDirectExpenseRefunds,
  userMayMoveExpensePayout,
  userMayReleaseExpenseRefund,
} from '../finance/expensePayoutCorrectionOps.js';

export const EXPENSE_PAYOUT_CORRECTION_PATH = '/expense-payout-corrections';

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

function asIdList(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.map((id) => String(id || '').trim()).filter(Boolean);
}

/**
 * @param {object} model
 */
export function renderExpensePayoutCorrectionPage(model = {}) {
  const user = model.user || null;
  const canMove = Boolean(model.canMove);
  const canRelease = Boolean(model.canRelease);
  const signedIn = Boolean(user);
  const branches = Array.isArray(model.branches) ? model.branches : [];
  const accounts = Array.isArray(model.accounts) ? model.accounts : [];
  const payouts = Array.isArray(model.payouts) ? model.payouts : [];
  const refunds = Array.isArray(model.refunds) ? model.refunds : [];
  const who = esc(user?.displayName || user?.username || '');
  const selectedBranch = String(model.selectedBranchId || '');
  const fromId = String(model.fromTreasuryAccountId || '');
  const toId = String(model.toTreasuryAccountId || '');
  const q = String(model.q || '');

  const branchOptions = branches
    .map((b) => {
      const id = String(b.id);
      const label = `${b.name || id}${b.code ? ` (${b.code})` : ''}`;
      return `<option value="${esc(id)}"${id === selectedBranch ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
  const accountOptions = (selected) =>
    accounts
      .map((a) => {
        const id = String(a.id);
        const label = `${a.name || 'Account ' + id}${a.type ? ` · ${a.type}` : ''} · ₦${formatNgn(a.balance)}`;
        return `<option value="${esc(id)}"${id === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
      })
      .join('');

  const payoutRows = payouts
    .map(
      (row) => `<tr>
        <td><input type="checkbox" name="movementId" value="${esc(row.movementId)}" /></td>
        <td>${esc(String(row.expenseDate || row.postedAtISO || '').slice(0, 10))}</td>
        <td>${esc(row.expenseId || row.sourceId)}</td>
        <td>${esc(row.category)}</td>
        <td>${esc(row.reference)}</td>
        <td class="num">₦${esc(formatNgn(row.amountNgn))}</td>
      </tr>`
    )
    .join('');
  const refundRows = refunds
    .map(
      (row) => `<tr>
        <td><input type="checkbox" name="expenseId" value="${esc(row.expenseId)}" /></td>
        <td>${esc(String(row.expenseDate || '').slice(0, 10))}</td>
        <td>${esc(row.expenseId)}</td>
        <td>${esc(row.reference)}</td>
        <td>${esc(row.accountName)}</td>
        <td class="num">₦${esc(formatNgn(row.amountNgn))}</td>
      </tr>`
    )
    .join('');

  let body;
  if (!signedIn) {
    body = `<p class="lead">Sign in to Zarewa as Finance first, then open this page again.</p>
      <p><a class="btn" href="/">Go to sign in</a></p>`;
  } else if (!canMove && !canRelease) {
    body = `<p class="lead">Signed in as ${who}. Finance pay, post, or reverse permission is required for these corrections.</p>
      <p><a href="/">Back to Zarewa</a></p>`;
  } else {
    body = `
      <p class="lead">Signed in as ${who}. Use this page when an expense was paid from one bank but booked on another, or when a customer refund was entered as an expense and must be raised again under Sales → Refunds.</p>
      ${model.error ? `<p class="err">${esc(model.error)}</p>` : ''}
      ${model.notice ? `<p class="ok">${esc(model.notice)}</p>` : ''}
      <form method="get" action="${EXPENSE_PAYOUT_CORRECTION_PATH}" class="card">
        <label>Branch
          <select name="branchId" onchange="this.form.submit()">${branchOptions}</select>
        </label>
        <label>Booked on this account
          <select name="fromTreasuryAccountId" onchange="this.form.submit()">${accountOptions(fromId) || '<option value="">No account</option>'}</select>
        </label>
        <label>Find
          <input name="q" value="${esc(q)}" placeholder="Expense id, reference, or category" />
        </label>
        <button type="submit" class="secondary">Refresh</button>
      </form>
      <form method="post" action="${EXPENSE_PAYOUT_CORRECTION_PATH}" class="card">
        <h2>Move payouts to the account that paid</h2>
        <p class="hint">This puts the money back on the wrong account and charges the right one. It still works when the right account’s book balance is too low, because that cash has already left. If the original month is locked, the correction is dated today.</p>
        <input type="hidden" name="csrf" value="${esc(model.csrf || '')}" />
        <input type="hidden" name="action" value="move" />
        <input type="hidden" name="branchId" value="${esc(selectedBranch)}" />
        <input type="hidden" name="fromTreasuryAccountId" value="${esc(fromId)}" />
        <input type="hidden" name="q" value="${esc(q)}" />
        <label>Charge this account instead
          <select name="toTreasuryAccountId" required>${accountOptions(toId) || '<option value="">No account</option>'}</select>
        </label>
        ${
          payoutRows
            ? `<table><thead><tr><th></th><th>Date</th><th>Expense</th><th>Category</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${payoutRows}</tbody></table>`
            : `<p>No open expense payouts on this account.</p>`
        }
        <div class="row">
          <button type="submit"${canMove && payouts.length ? '' : ' disabled'}>Move selected payouts</button>
        </div>
        ${canMove ? '' : '<p class="hint">Moving a payout needs finance pay or finance post.</p>'}
      </form>
      <form method="post" action="${EXPENSE_PAYOUT_CORRECTION_PATH}" class="card">
        <h2>Expense refunds to raise again as a normal refund</h2>
        <p class="hint">These already left a till or bank. Removing them puts that cash back. Then raise the refund in Sales and pay it from the account that sent the money. Do not also move the same payout above.</p>
        <input type="hidden" name="csrf" value="${esc(model.csrf || '')}" />
        <input type="hidden" name="action" value="release" />
        <input type="hidden" name="branchId" value="${esc(selectedBranch)}" />
        <input type="hidden" name="fromTreasuryAccountId" value="${esc(fromId)}" />
        <input type="hidden" name="q" value="${esc(q)}" />
        ${
          refundRows
            ? `<table><thead><tr><th></th><th>Date</th><th>Expense</th><th>Reference</th><th>Booked on</th><th>Amount</th></tr></thead><tbody>${refundRows}</tbody></table>`
            : `<p>No Refund-category expenses on this branch still have a bank line.</p>`
        }
        <div class="row">
          <button type="submit"${canRelease && refunds.length ? '' : ' disabled'}>Remove selected and free them for a normal refund</button>
        </div>
        ${canRelease ? '' : '<p class="hint">Removing an expense refund needs finance reverse.</p>'}
      </form>
      <p><a href="/expense-cash-catchup">Imported expenses</a> · <a href="/">Back to Zarewa</a></p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Correct expense payouts — Zarewa</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f4f1ea; color: #1c1917; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
    h2 { font-size: 1.15rem; margin: 0 0 0.6rem; }
    .lead, .hint { line-height: 1.45; }
    .hint { color: #57534e; }
    .card { background: #fff; border: 1px solid #d6d3d1; border-radius: 12px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
    label { display: block; font-weight: 600; margin: 0.75rem 0; }
    input[type="text"], input:not([type]), select { display: block; width: 100%; margin-top: 0.35rem; padding: 0.55rem 0.6rem; font-size: 1rem; box-sizing: border-box; }
    .row { display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap; }
    button, .btn { background: #1e3a5f; color: #fff; border: 0; border-radius: 8px; padding: 0.7rem 1rem; font-size: 1rem; cursor: pointer; text-decoration: none; display: inline-block; }
    button.secondary { background: #57534e; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .ok { background: #dcfce7; color: #14532d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .err { background: #fee2e2; color: #7f1d1d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 0.35rem 0.4rem; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <main>
    <h1>Correct expense payouts</h1>
    ${body}
  </main>
</body>
</html>`;
}

function pageModel(db, req, extra = {}) {
  const branches = listBranches(db);
  const selectedBranchId =
    String(extra.selectedBranchId || req.body?.branchId || req.query?.branchId || req.workspaceBranchId || '').trim() ||
    branches[0]?.id ||
    '';
  const accounts = selectedBranchId ? listTreasuryAccounts(db, selectedBranchId) : [];
  const fromTreasuryAccountId = String(
    extra.fromTreasuryAccountId || req.body?.fromTreasuryAccountId || req.query?.fromTreasuryAccountId || accounts[0]?.id || ''
  );
  const toTreasuryAccountId = String(
    extra.toTreasuryAccountId || req.body?.toTreasuryAccountId || req.query?.toTreasuryAccountId || accounts[1]?.id || accounts[0]?.id || ''
  );
  const q = String(extra.q !== undefined ? extra.q : req.body?.q ?? req.query?.q ?? '');
  const payouts =
    selectedBranchId && fromTreasuryAccountId
      ? listExpensePayoutsOnAccount(db, {
          branchId: selectedBranchId,
          treasuryAccountId: fromTreasuryAccountId,
          q,
        })
      : [];
  const refunds = selectedBranchId ? listDirectExpenseRefunds(db, { branchId: selectedBranchId }) : [];
  return {
    user: req.user || null,
    csrf: req.csrfToken || '',
    canMove: userMayMoveExpensePayout(req.user),
    canRelease: userMayReleaseExpenseRefund(req.user),
    branches,
    accounts,
    selectedBranchId,
    fromTreasuryAccountId,
    toTreasuryAccountId,
    q,
    payouts,
    refunds,
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

function workspacePayload(req, body) {
  return {
    workspaceBranchId: String(body.branchId || req.workspaceBranchId || '').trim(),
    workspaceViewAll: false,
    note: String(body.note || '').trim(),
  };
}

function handlePost(db, req, res) {
  const body = req.body || {};
  const modelBase = pageModel(db, req, {
    selectedBranchId: body.branchId,
    fromTreasuryAccountId: body.fromTreasuryAccountId,
    toTreasuryAccountId: body.toTreasuryAccountId,
    q: body.q,
  });
  if (!req.user) {
    return sendPage(res, renderExpensePayoutCorrectionPage({ ...modelBase, error: 'Sign in first.' }), 401);
  }
  if (!csrfTokensEqual(req.csrfToken, body.csrf)) {
    return sendPage(
      res,
      renderExpensePayoutCorrectionPage({
        ...modelBase,
        error: 'Your session expired. Sign in again, then open this page and retry.',
      }),
      403
    );
  }
  const action = String(body.action || '').trim();
  const bid = String(body.branchId || '').trim();
  const redirectOk = (notice) => {
    const qs = new URLSearchParams({
      notice,
      branchId: bid,
      fromTreasuryAccountId: String(body.fromTreasuryAccountId || ''),
      q: String(body.q || ''),
    });
    return res.redirect(303, `${EXPENSE_PAYOUT_CORRECTION_PATH}?${qs.toString()}`);
  };

  if (action === 'move') {
    if (!userMayMoveExpensePayout(req.user)) {
      return sendPage(
        res,
        renderExpensePayoutCorrectionPage({
          ...modelBase,
          error: 'Finance pay or post permission is required to move a payout.',
        }),
        403
      );
    }
    const result = reassignExpensePayouts(
      db,
      {
        ...workspacePayload(req, body),
        movementIds: asIdList(body.movementId),
        toTreasuryAccountId: body.toTreasuryAccountId,
      },
      req.user
    );
    if (!result.ok) {
      return sendPage(res, renderExpensePayoutCorrectionPage({ ...modelBase, error: result.error }), 400);
    }
    return redirectOk(result.message);
  }

  if (action === 'release') {
    if (!userMayReleaseExpenseRefund(req.user)) {
      return sendPage(
        res,
        renderExpensePayoutCorrectionPage({
          ...modelBase,
          error: 'finance.reverse is required to remove an expense refund.',
        }),
        403
      );
    }
    const result = releaseDirectExpenseRefunds(
      db,
      {
        ...workspacePayload(req, body),
        expenseIds: asIdList(body.expenseId),
      },
      req.user
    );
    if (!result.ok) {
      return sendPage(res, renderExpensePayoutCorrectionPage({ ...modelBase, error: result.error }), 400);
    }
    return redirectOk(result.message);
  }

  return sendPage(res, renderExpensePayoutCorrectionPage({ ...modelBase, error: 'Choose a correction.' }), 400);
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerExpensePayoutCorrectionPage(app, db) {
  app.get(EXPENSE_PAYOUT_CORRECTION_PATH, (req, res) => {
    return sendPage(res, renderExpensePayoutCorrectionPage(pageModel(db, req)));
  });
  app.post(EXPENSE_PAYOUT_CORRECTION_PATH, express.urlencoded({ extended: true }), (req, res) => {
    return handlePost(db, req, res);
  });

  app.get(
    '/api/expenses/payout-corrections',
    requirePermission(['finance.pay', 'finance.post', 'finance.reverse']),
    (req, res) => {
      try {
        const branchId = String(req.query?.branchId || req.workspaceBranchId || '').trim();
        const treasuryAccountId = req.query?.fromTreasuryAccountId || req.query?.treasuryAccountId;
        return res.json({
          ok: true,
          payouts: listExpensePayoutsOnAccount(db, {
            branchId,
            treasuryAccountId,
            q: req.query?.q,
          }),
          expenseRefunds: listDirectExpenseRefunds(db, { branchId }),
        });
      } catch (e) {
        console.error('[expense-payout-corrections]', e);
        return res.status(500).json({ ok: false, error: 'Could not list payout corrections.' });
      }
    }
  );

  app.post(
    '/api/expenses/payout-reassign',
    requirePermission(['finance.pay', 'finance.post']),
    (req, res) => {
      try {
        const body = req.body || {};
        const result = reassignExpensePayouts(
          db,
          {
            movementIds: body.movementIds || body.movementId,
            toTreasuryAccountId: body.toTreasuryAccountId,
            note: body.note,
            workspaceBranchId: req.workspaceBranchId,
            workspaceViewAll: Boolean(req.workspaceViewAll),
          },
          req.user
        );
        return res.status(result.ok ? 200 : 400).json(result);
      } catch (e) {
        console.error('[expense-payout-reassign]', e);
        return res.status(400).json({ ok: false, error: 'Could not move the payout.' });
      }
    }
  );

  app.post(
    '/api/expenses/release-refund',
    requirePermission('finance.reverse'),
    (req, res) => {
      try {
        const body = req.body || {};
        const result = releaseDirectExpenseRefunds(
          db,
          {
            expenseIds: body.expenseIds || body.expenseId,
            note: body.note,
            workspaceBranchId: req.workspaceBranchId,
            workspaceViewAll: Boolean(req.workspaceViewAll),
          },
          req.user
        );
        return res.status(result.ok ? 200 : 400).json(result);
      } catch (e) {
        console.error('[expense-release-refund]', e);
        return res.status(400).json({ ok: false, error: 'Could not remove the expense refund.' });
      }
    }
  );
}
