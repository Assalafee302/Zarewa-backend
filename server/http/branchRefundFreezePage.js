/**
 * Admin HTML form to lock refunds on quotations/receipts in a date window.
 * Full-page GET/POST /refund-lock — date pickers, no console.
 */
import crypto from 'node:crypto';
import express from 'express';
import { listBranches } from '../branches.js';
import { userMayBlockBranchRefunds } from '../../shared/workspaceGovernance.js';
import { calendarDayFromIso } from '../../shared/lib/branchRefundFreeze.js';
import { loadAllBranchRefundLocks } from '../sales/branchRefundFreeze.js';
import { setBranchRefundsBlocked } from '../sales/branchRefundFreezeOps.js';

export const REFUND_LOCK_PATH = '/refund-lock';

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

/**
 * @param {{
 *   user?: { displayName?: string; username?: string; roleKey?: string } | null;
 *   csrf?: string;
 *   branches?: Array<{ id: string; name?: string; code?: string }>;
 *   locks?: Map<string, { refundsBlockedFromISO?: string | null; refundsBlockedToISO?: string | null; refundsBlockedReason?: string }>;
 *   selectedBranchId?: string;
 *   fromDay?: string;
 *   toDay?: string;
 *   reason?: string;
 *   notice?: string;
 *   error?: string;
 *   canLock?: boolean;
 * }} model
 */
export function renderRefundLockPage(model = {}) {
  const user = model.user || null;
  const canLock = Boolean(model.canLock);
  const branches = Array.isArray(model.branches) ? model.branches : [];
  const locks = model.locks instanceof Map ? model.locks : new Map();
  const selected =
    String(model.selectedBranchId || '').trim() ||
    branches.find((b) => String(b.id) === 'BR-YL')?.id ||
    branches[0]?.id ||
    '';
  const fromDay = String(model.fromDay || '2026-09-01').slice(0, 10);
  const toDay = String(model.toDay || '2026-09-16').slice(0, 10);
  const reason =
    String(model.reason || '').trim() || 'Yola historical refunds treated as already paid';
  const who = esc(user?.displayName || user?.username || '');

  const lockRows = branches
    .map((b) => {
      const lock = locks.get(String(b.id));
      if (!lock?.refundsBlockedFromISO) return '';
      const from = calendarDayFromIso(lock.refundsBlockedFromISO) || '—';
      const to = calendarDayFromIso(lock.refundsBlockedToISO) || 'onward';
      return `<li><strong>${esc(b.name || b.id)}</strong> — ${esc(from)} to ${esc(to)}${
        lock.refundsBlockedReason ? ` · ${esc(lock.refundsBlockedReason)}` : ''
      }</li>`;
    })
    .filter(Boolean)
    .join('');

  const branchOptions = branches
    .map((b) => {
      const id = String(b.id);
      const label = `${b.name || id}${b.code ? ` (${b.code})` : ''}`;
      return `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');

  let body = '';
  if (!user) {
    body = `
      <p class="lead">Sign in to Zarewa as <strong>Administrator</strong> first, then open this page again.</p>
      <p><a class="btn" href="/">Go to sign in</a></p>`;
  } else if (!canLock) {
    body = `
      <p class="lead">Signed in as ${who}. Only an <strong>Administrator</strong> can lock or unlock refunds for a branch.</p>
      <p><a href="/">Back to Zarewa</a></p>`;
  } else {
    body = `
      <p class="lead">Signed in as ${who}. Pick the branch and dates. Quotations and receipts in that range cannot be refunded — they are treated as already paid.</p>
      ${lockRows ? `<div class="card"><h2>Current locks</h2><ul>${lockRows}</ul></div>` : ''}
      ${model.error ? `<p class="err">${esc(model.error)}</p>` : ''}
      ${model.notice ? `<p class="ok">${esc(model.notice)}</p>` : ''}
      <form method="post" action="${REFUND_LOCK_PATH}" class="card">
        <input type="hidden" name="csrf" value="${esc(model.csrf || '')}" />
        <label>Branch
          <select name="branchId" required>${branchOptions}</select>
        </label>
        <label>From date
          <input type="date" name="fromISO" value="${esc(fromDay)}" required />
        </label>
        <label>To date
          <input type="date" name="toISO" value="${esc(toDay)}" required />
        </label>
        <label>Reason
          <input type="text" name="reason" minlength="10" maxlength="240" value="${esc(reason)}" required />
        </label>
        <div class="row">
          <button type="submit" name="action" value="lock">Lock these dates</button>
          <button type="submit" name="action" value="unlock" class="secondary">Remove lock</button>
        </div>
      </form>
      <p class="hint">Example for Yola catch-up: 1 September 2026 to 16 September 2026.</p>
      <p><a href="/">Back to Zarewa</a></p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lock refunds — Zarewa</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f4f1ea; color: #1c1917; }
    main { max-width: 36rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
    .lead { line-height: 1.45; }
    .card { background: #fff; border: 1px solid #d6d3d1; border-radius: 12px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
    label { display: block; font-weight: 600; margin: 0.75rem 0; }
    input, select { display: block; width: 100%; margin-top: 0.35rem; padding: 0.55rem 0.6rem; font-size: 1rem; box-sizing: border-box; }
    .row { display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap; }
    button, .btn { background: #1e3a5f; color: #fff; border: 0; border-radius: 8px; padding: 0.7rem 1rem; font-size: 1rem; cursor: pointer; text-decoration: none; display: inline-block; }
    button.secondary { background: #57534e; }
    .ok { background: #dcfce7; color: #14532d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .err { background: #fee2e2; color: #7f1d1d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .hint { color: #57534e; }
    ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
  </style>
</head>
<body>
  <main>
    <h1>Lock refunds on a branch</h1>
    ${body}
  </main>
</body>
</html>`;
}

function pageModel(db, req, extra = {}) {
  const branches = listBranches(db);
  return {
    user: req.user || null,
    csrf: req.csrfToken || '',
    canLock: userMayBlockBranchRefunds(req.user),
    branches,
    locks: loadAllBranchRefundLocks(db),
    selectedBranchId: extra.selectedBranchId || req.query?.branchId || req.body?.branchId || '',
    fromDay: extra.fromDay || req.body?.fromISO || '',
    toDay: extra.toDay || req.body?.toISO || '',
    reason: extra.reason || req.body?.reason || '',
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
export function registerBranchRefundFreezePage(app, db) {
  app.get(REFUND_LOCK_PATH, (req, res) => {
    return sendPage(res, renderRefundLockPage(pageModel(db, req)));
  });

  app.post(REFUND_LOCK_PATH, express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body || {};
    const modelBase = pageModel(db, req, {
      selectedBranchId: body.branchId,
      fromDay: body.fromISO,
      toDay: body.toISO,
      reason: body.reason,
    });
    if (!req.user) {
      return sendPage(res, renderRefundLockPage({ ...modelBase, error: 'Sign in first.' }), 401);
    }
    if (!userMayBlockBranchRefunds(req.user)) {
      return sendPage(
        res,
        renderRefundLockPage({ ...modelBase, error: 'Only an Administrator can lock refunds.' }),
        403
      );
    }
    if (!csrfTokensEqual(req.csrfToken, body.csrf)) {
      return sendPage(
        res,
        renderRefundLockPage({
          ...modelBase,
          error: 'Your session expired. Sign in again, then open this page and retry.',
        }),
        403
      );
    }

    const action = String(body.action || 'lock').trim().toLowerCase();
    const r =
      action === 'unlock'
        ? setBranchRefundsBlocked(db, body.branchId, { blocked: false }, req.user)
        : setBranchRefundsBlocked(
            db,
            body.branchId,
            {
              fromISO: body.fromISO,
              toISO: body.toISO,
              reason: body.reason,
            },
            req.user
          );
    if (!r.ok) {
      return sendPage(res, renderRefundLockPage({ ...modelBase, error: r.error || 'Could not save.' }), 400);
    }
    const notice =
      action === 'unlock'
        ? `Lock removed for ${r.branchName || body.branchId}.`
        : `Locked ${r.branchName || body.branchId} from ${calendarDayFromIso(r.refundsBlockedFromISO)} to ${
            calendarDayFromIso(r.refundsBlockedToISO) || 'onward'
          }.`;
    return res.redirect(303, `${REFUND_LOCK_PATH}?notice=${encodeURIComponent(notice)}`);
  });
}
