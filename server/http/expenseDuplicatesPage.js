/**
 * Remove extra imported expense copies and restore till/bank cash.
 */
import crypto from 'node:crypto';
import express from 'express';
import { listBranches } from '../branches.js';
import { userHasPermission } from '../auth.js';
import {
  deleteDuplicateImportedExpenses,
  listDuplicateImportedExpenseGroups,
} from '../finance/expenseTreasuryCatchUpOps.js';

export const EXPENSE_DUPLICATES_PATH = '/expense-duplicates';

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

function userMayDelete(user) {
  return userHasPermission(user, 'finance.post') || userHasPermission(user, 'expenses.create');
}

export function renderExpenseDuplicatesPage(model = {}) {
  const user = model.user || null;
  const canPost = Boolean(model.canPost);
  const branches = Array.isArray(model.branches) ? model.branches : [];
  const groups = Array.isArray(model.groups) ? model.groups : [];
  const selectedBranch = String(model.selectedBranchId || '');
  const who = esc(user?.displayName || user?.username || '');
  const extraCount = Number(model.extraCount) || 0;
  const restoreCashNgn = Number(model.restoreCashNgn) || 0;

  const branchOptions = branches
    .map((b) => {
      const id = String(b.id);
      const label = `${b.name || id}${b.code ? ` (${b.code})` : ''}`;
      return `<option value="${esc(id)}"${id === selectedBranch ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');

  const rows = groups
    .map((g) => {
      const extras = (g.extraExpenseIDs || [])
        .map(
          (id) =>
            `<label class="chk"><input type="checkbox" name="expenseIds" value="${esc(id)}" checked /> ${esc(id)}</label>`
        )
        .join('');
      return `<tr>
        <td>${esc(g.date || '')}</td>
        <td>${esc(g.category || '')}</td>
        <td>${esc(g.reference || '—')}</td>
        <td class="num">₦${esc(formatNgn(g.amountNgn))}</td>
        <td><strong>Keep ${esc(g.keepExpenseID)}</strong></td>
        <td>${extras}</td>
      </tr>`;
    })
    .join('');

  let body = '';
  if (!user) {
    body = `<p class="lead">Sign in as Finance or Administrator first.</p><p><a class="btn" href="/">Go to sign in</a></p>`;
  } else if (!canPost) {
    body = `<p class="lead">Signed in as ${who}. Only Finance or an Administrator can delete duplicate expenses.</p>`;
  } else {
    body = `
      <p class="lead">Signed in as ${who}. Keep one row for each refund. Extra copies (same date, category, amount, and reference) are listed below. Deleting them <strong>puts the money back</strong> on Cash or POS.</p>
      ${model.error ? `<p class="err">${esc(model.error)}</p>` : ''}
      ${model.notice ? `<p class="ok">${esc(model.notice)}</p>` : ''}
      <form method="get" action="${EXPENSE_DUPLICATES_PATH}" class="card">
        <label>Branch
          <select name="branchId" onchange="this.form.submit()">${branchOptions}</select>
        </label>
        <button type="submit" class="secondary">Show duplicates</button>
      </form>
      <div class="card">
        <h2>${groups.length} duplicate group(s) · ${extraCount} extra row(s) · ₦${esc(formatNgn(restoreCashNgn))} to put back</h2>
        ${
          groups.length
            ? `<form method="post" action="${EXPENSE_DUPLICATES_PATH}">
          <input type="hidden" name="csrf" value="${esc(model.csrf || '')}" />
          <input type="hidden" name="branchId" value="${esc(selectedBranch)}" />
          <table>
            <thead><tr><th>Date</th><th>Category</th><th>Reference</th><th>Amount</th><th>Keep</th><th>Delete extras</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="row">
            <button type="submit">Delete selected extras and restore cash</button>
          </div>
        </form>`
            : `<p>No duplicate extra copies on this branch (same date + category + amount + reference).</p>`
        }
      </div>
      <p><a href="/cashier-statement">Open full cashier statement</a> · <a href="/">Back to Zarewa</a></p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Delete duplicate expenses — Zarewa</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f4f1ea; color: #1c1917; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
    h2 { font-size: 1.1rem; margin: 0 0 0.6rem; }
    .card { background: #fff; border: 1px solid #d6d3d1; border-radius: 12px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
    label { display: block; font-weight: 600; margin: 0.75rem 0; }
    .chk { font-weight: 400; margin: 0.2rem 0; }
    select { display: block; width: 100%; margin-top: 0.35rem; padding: 0.55rem 0.6rem; font-size: 1rem; box-sizing: border-box; }
    .row { display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap; }
    button, .btn { background: #1e3a5f; color: #fff; border: 0; border-radius: 8px; padding: 0.7rem 1rem; font-size: 1rem; cursor: pointer; text-decoration: none; display: inline-block; }
    button.secondary { background: #57534e; }
    .ok { background: #dcfce7; color: #14532d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .err { background: #fee2e2; color: #7f1d1d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <main>
    <h1>Delete duplicate expenses</h1>
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
  const preview = selectedBranchId
    ? listDuplicateImportedExpenseGroups(db, selectedBranchId)
    : { ok: true, groups: [], extraCount: 0, restoreCashNgn: 0 };
  return {
    user: req.user || null,
    csrf: req.csrfToken || '',
    canPost: userMayDelete(req.user),
    branches,
    selectedBranchId,
    groups: preview.groups || [],
    extraCount: preview.extraCount || 0,
    restoreCashNgn: preview.restoreCashNgn || 0,
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
export function registerExpenseDuplicatesPage(app, db) {
  app.get(EXPENSE_DUPLICATES_PATH, (req, res) => {
    return sendPage(res, renderExpenseDuplicatesPage(pageModel(db, req)));
  });

  app.post(EXPENSE_DUPLICATES_PATH, express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body || {};
    const rawIds = body.expenseIds;
    const expenseIds = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [];
    const modelBase = pageModel(db, req, { selectedBranchId: body.branchId });
    if (!req.user) {
      return sendPage(res, renderExpenseDuplicatesPage({ ...modelBase, error: 'Sign in first.' }), 401);
    }
    if (!userMayDelete(req.user)) {
      return sendPage(
        res,
        renderExpenseDuplicatesPage({ ...modelBase, error: 'Only Finance or an Administrator can delete duplicates.' }),
        403
      );
    }
    if (!csrfTokensEqual(req.csrfToken, body.csrf)) {
      return sendPage(
        res,
        renderExpenseDuplicatesPage({
          ...modelBase,
          error: 'Your session expired. Sign in again, then open this page and retry.',
        }),
        403
      );
    }
    const r = deleteDuplicateImportedExpenses(db, req.user, {
      workspaceBranchId: String(body.branchId || '').trim(),
      workspaceViewAll: false,
      expenseIds,
    });
    if (!r.ok) {
      return sendPage(res, renderExpenseDuplicatesPage({ ...modelBase, error: r.error || 'Could not delete.' }), 400);
    }
    const qs = new URLSearchParams({
      notice: r.message || `Removed ${r.deletedCount} duplicate(s).`,
      branchId: String(body.branchId || ''),
    });
    return res.redirect(303, `${EXPENSE_DUPLICATES_PATH}?${qs.toString()}`);
  });
}
