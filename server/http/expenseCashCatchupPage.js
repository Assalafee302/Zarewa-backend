/**
 * Finance HTML form to post imported expenses onto the cashier till.
 * Full-page GET/POST /expense-cash-catchup — no console.
 *
 * Expense import can write memo-only `expenses` rows. Those show on the expense
 * list but never create `treasury_movements` or change `treasury_accounts.balance`.
 */
import crypto from 'node:crypto';
import express from 'express';
import { listBranches } from '../branches.js';
import { userHasPermission } from '../auth.js';
import { listTreasuryAccounts } from '../readModel.js';
import { resolveDefaultBranchTreasuryAccount } from '../expenseBulkImport.js';
import {
  attachTreasuryToImportedExpenses,
  listExpensesMissingBankPosting,
} from '../finance/expenseTreasuryCatchUpOps.js';

export const EXPENSE_CASH_CATCHUP_PATH = '/expense-cash-catchup';

const PREVIEW_ROWS = 40;
const POST_LIMIT = 500;

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

/** Finance/admin may post imported expenses onto till/bank. */
export function userMayCatchUpExpenseCash(user) {
  return userHasPermission(user, 'finance.post') || userHasPermission(user, 'expenses.create');
}

/**
 * @param {{
 *   user?: { displayName?: string; username?: string; roleKey?: string } | null;
 *   csrf?: string;
 *   canPost?: boolean;
 *   branches?: Array<{ id: string; name?: string; code?: string }>;
 *   selectedBranchId?: string;
 *   category?: string;
 *   accounts?: Array<{ id: number; name?: string; type?: string; balance?: number }>;
 *   selectedTreasuryAccountId?: number | string;
 *   rows?: Array<{ expenseID: string; date?: string; category?: string; amountNgn?: number; reference?: string; missingTreasury?: boolean }>;
 *   notice?: string;
 *   error?: string;
 * }} model
 */
export function renderExpenseCashCatchupPage(model = {}) {
  const user = model.user || null;
  const canPost = Boolean(model.canPost);
  const branches = Array.isArray(model.branches) ? model.branches : [];
  const accounts = Array.isArray(model.accounts) ? model.accounts : [];
  const rows = Array.isArray(model.rows) ? model.rows : [];
  const missing = rows.filter((r) => r.missingTreasury);
  const selectedBranch =
    String(model.selectedBranchId || '').trim() ||
    branches.find((b) => String(b.id) === 'BR-YL')?.id ||
    branches[0]?.id ||
    '';
  const category = String(model.category || 'Refund').trim();
  const selectedTill = String(model.selectedTreasuryAccountId || '');
  const who = esc(user?.displayName || user?.username || '');
  const totalMissing = missing.reduce((s, r) => s + (Number(r.amountNgn) || 0), 0);
  const shown = missing.slice(0, PREVIEW_ROWS);
  const extra = Math.max(0, missing.length - shown.length);

  const branchOptions = branches
    .map((b) => {
      const id = String(b.id);
      const label = `${b.name || id}${b.code ? ` (${b.code})` : ''}`;
      return `<option value="${esc(id)}"${id === selectedBranch ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');

  const accountOptions = accounts
    .map((a) => {
      const id = String(a.id);
      const label = `${a.name || `#${a.id}`}${a.type ? ` (${a.type})` : ''} — ₦${formatNgn(a.balance)}`;
      return `<option value="${esc(id)}"${id === selectedTill ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');

  const tableRows = shown
    .map(
      (r) => `<tr>
        <td>${esc(r.date || '')}</td>
        <td>${esc(r.category || '')}</td>
        <td class="num">₦${esc(formatNgn(r.amountNgn))}</td>
        <td>${esc(r.reference || r.expenseID || '')}</td>
      </tr>`
    )
    .join('');

  let body = '';
  if (!user) {
    body = `
      <p class="lead">Sign in to Zarewa as Finance or Administrator first, then open this page again.</p>
      <p><a class="btn" href="/">Go to sign in</a></p>`;
  } else if (!canPost) {
    body = `
      <p class="lead">Signed in as ${who}. Only Finance or an Administrator can post imported expenses onto the cashier book.</p>
      <p><a href="/">Back to Zarewa</a></p>`;
  } else {
    body = `
      <p class="lead">Signed in as ${who}. Uploaded expenses sit on the expense list until they are posted to a till. Posting reduces that till’s <strong>balance</strong> and adds lines on its <strong>statement</strong>.</p>
      ${model.error ? `<p class="err">${esc(model.error)}</p>` : ''}
      ${model.notice ? `<p class="ok">${esc(model.notice)}</p>` : ''}
      <form method="get" action="${EXPENSE_CASH_CATCHUP_PATH}" class="card">
        <label>Branch
          <select name="branchId" onchange="this.form.submit()">${branchOptions}</select>
        </label>
        <label>Category
          <select name="category" onchange="this.form.submit()">
            <option value="Refund"${category === 'Refund' ? ' selected' : ''}>Refund</option>
            <option value=""${category === '' ? ' selected' : ''}>All categories</option>
          </select>
        </label>
        <button type="submit" class="secondary">Show unposted</button>
      </form>
      <div class="card">
        <h2>${missing.length} unposted expense${missing.length === 1 ? '' : 's'} — ₦${esc(formatNgn(totalMissing))}</h2>
        ${
          missing.length
            ? `<table><thead><tr><th>Date</th><th>Category</th><th>Amount</th><th>Reference</th></tr></thead><tbody>${tableRows}</tbody></table>
               ${extra ? `<p class="hint">Showing ${shown.length} of ${missing.length}. Posting will include up to ${POST_LIMIT} rows.</p>` : ''}`
            : `<p>Nothing on this branch is missing a cash line${category ? ` for category “${esc(category)}”` : ''}. Either they already hit the till, or you are on the wrong branch.</p>`
        }
      </div>
      ${
        missing.length
          ? `<form method="post" action="${EXPENSE_CASH_CATCHUP_PATH}" class="card">
        <input type="hidden" name="csrf" value="${esc(model.csrf || '')}" />
        <input type="hidden" name="branchId" value="${esc(selectedBranch)}" />
        <input type="hidden" name="category" value="${esc(category)}" />
        <label>Cashier / bank account to deduct
          <select name="treasuryAccountId" required>${accountOptions || '<option value="">No till on this branch</option>'}</select>
        </label>
        <div class="row">
          <button type="submit"${accounts.length ? '' : ' disabled'}>Post to statement and reduce balance</button>
        </div>
        <p class="hint">Open Cashier desk on this same account after posting. Older dates sit below newer lines — filter by date if the first page looks unchanged.</p>
      </form>`
          : ''
      }
      <p><a href="/">Back to Zarewa</a></p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Post imported expenses to cash — Zarewa</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f4f1ea; color: #1c1917; }
    main { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
    h2 { font-size: 1.1rem; margin: 0 0 0.6rem; }
    .lead { line-height: 1.45; }
    .card { background: #fff; border: 1px solid #d6d3d1; border-radius: 12px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
    label { display: block; font-weight: 600; margin: 0.75rem 0; }
    input, select { display: block; width: 100%; margin-top: 0.35rem; padding: 0.55rem 0.6rem; font-size: 1rem; box-sizing: border-box; }
    .row { display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap; }
    button, .btn { background: #1e3a5f; color: #fff; border: 0; border-radius: 8px; padding: 0.7rem 1rem; font-size: 1rem; cursor: pointer; text-decoration: none; display: inline-block; }
    button.secondary { background: #57534e; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .ok { background: #dcfce7; color: #14532d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .err { background: #fee2e2; color: #7f1d1d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .hint { color: #57534e; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 0.35rem 0.4rem; border-bottom: 1px solid #e7e5e4; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <main>
    <h1>Post imported expenses to cash</h1>
    ${body}
  </main>
</body>
</html>`;
}

function pageModel(db, req, extra = {}) {
  const branches = listBranches(db);
  const selectedBranchId =
    String(extra.selectedBranchId || req.body?.branchId || req.query?.branchId || req.workspaceBranchId || '').trim() ||
    branches.find((b) => String(b.id) === 'BR-YL')?.id ||
    branches[0]?.id ||
    '';
  const categoryRaw = extra.category !== undefined ? extra.category : req.body?.category ?? req.query?.category;
  const category = categoryRaw === undefined || categoryRaw === null ? 'Refund' : String(categoryRaw).trim();
  const accounts = selectedBranchId ? listTreasuryAccounts(db, selectedBranchId) : [];
  const fallbackTill = selectedBranchId ? resolveDefaultBranchTreasuryAccount(db, selectedBranchId) : { id: null };
  const rows = selectedBranchId
    ? listExpensesMissingBankPosting(db, selectedBranchId, {
        category: category || undefined,
        limit: POST_LIMIT,
      })
    : [];
  return {
    user: req.user || null,
    csrf: req.csrfToken || '',
    canPost: userMayCatchUpExpenseCash(req.user),
    branches,
    selectedBranchId,
    category,
    accounts,
    selectedTreasuryAccountId:
      extra.selectedTreasuryAccountId || req.body?.treasuryAccountId || fallbackTill.id || accounts[0]?.id || '',
    rows,
    notice: extra.notice || String(req.query?.notice || ''),
    error: extra.error || String(req.query?.error || ''),
  };
}

function sendPage(res, html, status = 200) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerExpenseCashCatchupPage(app, db) {
  app.get(EXPENSE_CASH_CATCHUP_PATH, (req, res) => {
    return sendPage(res, renderExpenseCashCatchupPage(pageModel(db, req)));
  });

  app.post(EXPENSE_CASH_CATCHUP_PATH, express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body || {};
    const modelBase = pageModel(db, req, {
      selectedBranchId: body.branchId,
      category: body.category,
      selectedTreasuryAccountId: body.treasuryAccountId,
    });
    if (!req.user) {
      return sendPage(res, renderExpenseCashCatchupPage({ ...modelBase, error: 'Sign in first.' }), 401);
    }
    if (!userMayCatchUpExpenseCash(req.user)) {
      return sendPage(
        res,
        renderExpenseCashCatchupPage({
          ...modelBase,
          error: 'Only Finance or an Administrator can post imported expenses onto the cashier book.',
        }),
        403
      );
    }
    if (!csrfTokensEqual(req.csrfToken, body.csrf)) {
      return sendPage(
        res,
        renderExpenseCashCatchupPage({
          ...modelBase,
          error: 'Your session expired. Sign in again, then open this page and retry.',
        }),
        403
      );
    }

    const bid = String(body.branchId || '').trim();
    const category = String(body.category || '').trim();
    const treasuryAccountId = Number(body.treasuryAccountId);
    if (!bid) {
      return sendPage(res, renderExpenseCashCatchupPage({ ...modelBase, error: 'Pick a branch.' }), 400);
    }
    if (!treasuryAccountId) {
      return sendPage(
        res,
        renderExpenseCashCatchupPage({ ...modelBase, error: 'Pick the cashier or bank account these refunds were paid from.' }),
        400
      );
    }

    const rows = listExpensesMissingBankPosting(db, bid, {
      category: category || undefined,
      limit: POST_LIMIT,
    });
    const ids = rows.filter((r) => r.missingTreasury).map((r) => r.expenseID);
    if (!ids.length) {
      return sendPage(
        res,
        renderExpenseCashCatchupPage({
          ...modelBase,
          error:
            'No expenses on this branch are missing a bank/cash line. They may already be on the statement, or you are on the wrong branch.',
        }),
        400
      );
    }

    const r = attachTreasuryToImportedExpenses(
      db,
      ids,
      {
        treasuryAccountId,
        workspaceBranchId: bid,
        workspaceViewAll: false,
      },
      req.user
    );
    if (!r.ok) {
      return sendPage(res, renderExpenseCashCatchupPage({ ...modelBase, error: r.error || 'Could not post.' }), 400);
    }
    const notice = r.message || `Posted ${r.postedCount} expense(s) to the cashier book.`;
    const qs = new URLSearchParams({
      notice,
      branchId: bid,
      category,
    });
    return res.redirect(303, `${EXPENSE_CASH_CATCHUP_PATH}?${qs.toString()}`);
  });
}
