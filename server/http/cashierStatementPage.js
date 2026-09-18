/**
 * Full-period cashier statement print. Not capped to recent bootstrap movements.
 */
import { listBranches } from '../branches.js';
import { userHasPermission } from '../auth.js';
import { listTreasuryAccounts } from '../readModel.js';
import { buildTreasuryAccountStatement } from '../finance/treasuryAccountStatementOps.js';

export const CASHIER_STATEMENT_PATH = '/cashier-statement';
export const CASHIER_STATEMENT_VIEW = 'statement';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNgn(n) {
  return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

function dmy(iso) {
  const s = String(iso || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

function userMayView(user) {
  return (
    userHasPermission(user, 'cashier.desk.view') ||
    userHasPermission(user, 'finance.view') ||
    userHasPermission(user, 'finance.post') ||
    userHasPermission(user, 'finance.pay')
  );
}

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function renderCashierStatementPage(model = {}) {
  const user = model.user || null;
  const canView = Boolean(model.canView);
  const branches = Array.isArray(model.branches) ? model.branches : [];
  const accounts = Array.isArray(model.accounts) ? model.accounts : [];
  const selectedBranch = String(model.selectedBranchId || '');
  const selectedAccount = String(model.selectedTreasuryAccountId || '');
  const fromISO = String(model.fromISO || '2026-09-01');
  const toISO = String(model.toISO || todayIso());
  const formAction = String(model.formAction || CASHIER_STATEMENT_PATH);
  const viewField = model.view
    ? `<input type="hidden" name="view" value="${esc(model.view)}" />`
    : '';
  const stmt = model.statement;
  const who = esc(user?.displayName || user?.username || '');

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
      const label = `${a.name || `#${a.id}`}${a.type ? ` (${a.type})` : ''}`;
      return `<option value="${esc(id)}"${id === selectedAccount ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');

  let body = '';
  if (!user) {
    body = `<p class="lead">Sign in first, then open this page again.</p><p><a class="btn" href="/">Go to sign in</a></p>`;
  } else if (!canView) {
    body = `<p class="lead">Signed in as ${who}. Finance or cashier access is required to print a till statement.</p>`;
  } else {
    const lines = stmt?.ok ? stmt.lines : [];
    const table = lines
      .map(
        (r) => `<tr>
          <td>${esc(r.n)}</td>
          <td>${esc(dmy(r.date))}</td>
          <td>${esc(r.source)}</td>
          <td>${esc(r.description)}</td>
          <td class="num">${r.inNgn ? `₦${esc(formatNgn(r.inNgn))}` : '—'}</td>
          <td class="num">${r.outNgn ? `₦${esc(formatNgn(r.outNgn))}` : '—'}</td>
          <td class="num">₦${esc(formatNgn(r.balanceNgn))}</td>
        </tr>`
      )
      .join('');
    body = `
      <p class="lead">Signed in as ${who}. This print includes <strong>every</strong> line in the dates you pick — including 5–11 Sep — not only the recent Cashier desk page.</p>
      ${model.error ? `<p class="err">${esc(model.error)}</p>` : ''}
      <form method="get" action="${esc(formAction)}" class="card noprint">
        ${viewField}
        <label>Branch
          <select name="branchId" onchange="this.form.submit()">${branchOptions}</select>
        </label>
        <label>Account
          <select name="treasuryAccountId">${accountOptions || '<option value="">No account</option>'}</select>
        </label>
        <label>From <input type="date" name="fromISO" value="${esc(fromISO)}" /></label>
        <label>To <input type="date" name="toISO" value="${esc(toISO)}" /></label>
        <div class="row">
          <button type="submit">Show statement</button>
          <button type="button" class="secondary" onclick="window.print()">Print</button>
        </div>
      </form>
      ${
        stmt?.ok
          ? `<article class="sheet">
        <h2>Account Statement</h2>
        <p>Account: <strong>${esc(stmt.account.name)}</strong>${stmt.account.type ? ` (${esc(stmt.account.type)})` : ''}</p>
        <p>Period: ${esc(dmy(stmt.fromISO))} – ${esc(dmy(stmt.toISO))}</p>
        <p>Opening balance: ₦${esc(formatNgn(stmt.openingBalanceNgn))}</p>
        <p>Total inflow: ₦${esc(formatNgn(stmt.inflowNgn))} &nbsp;|&nbsp; Total outflow: ₦${esc(formatNgn(stmt.outflowNgn))}</p>
        <p>Closing balance: ₦${esc(formatNgn(stmt.closingBalanceNgn))}</p>
        <p class="hint">${stmt.lineCount} line(s). Live till balance now: ₦${esc(formatNgn(stmt.account.liveBalanceNgn))}.</p>
        <table>
          <thead><tr><th>#</th><th>Date</th><th>Source</th><th>Description</th><th>In</th><th>Out</th><th>Balance</th></tr></thead>
          <tbody>${table || '<tr><td colspan="7">No movements in this date range.</td></tr>'}</tbody>
        </table>
      </article>`
          : ''
      }
      <p class="noprint"><a href="/expense-cash-catchup?view=duplicates">Remove duplicate expenses</a> · <a href="/expense-cash-catchup">Post imported expenses</a> · <a href="/">Back to Zarewa</a></p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cashier statement — Zarewa</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f4f1ea; color: #1c1917; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
    h2 { font-size: 1.25rem; margin: 0 0 0.6rem; }
    .card { background: #fff; border: 1px solid #d6d3d1; border-radius: 12px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
    label { display: block; font-weight: 600; margin: 0.75rem 0; }
    input, select { display: block; width: 100%; margin-top: 0.35rem; padding: 0.55rem 0.6rem; font-size: 1rem; box-sizing: border-box; }
    .row { display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap; }
    button, .btn { background: #1e3a5f; color: #fff; border: 0; border-radius: 8px; padding: 0.7rem 1rem; font-size: 1rem; cursor: pointer; text-decoration: none; display: inline-block; }
    button.secondary { background: #57534e; }
    .err { background: #fee2e2; color: #7f1d1d; padding: 0.7rem 0.8rem; border-radius: 8px; }
    .hint { color: #57534e; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; padding: 0.3rem 0.35rem; border-bottom: 1px solid #e7e5e4; }
    td.num, th:nth-child(n+5) { text-align: right; font-variant-numeric: tabular-nums; }
    .sheet { background: #fff; padding: 1.2rem; border: 1px solid #d6d3d1; }
    @media print {
      body { background: #fff; }
      .noprint, .card.noprint { display: none !important; }
      main { max-width: none; padding: 0; }
      .sheet { border: 0; }
    }
  </style>
</head>
<body>
  <main>
    <h1 class="noprint">Cashier statement (full dates)</h1>
    ${body}
  </main>
</body>
</html>`;
}

function sendPage(res, html, status = 200) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
}

export function handleCashierStatementGet(db, req, res, opts = {}) {
  const formAction = String(opts.formAction || CASHIER_STATEMENT_PATH);
  const view = String(opts.view || '');
  const branches = listBranches(db);
  const selectedBranchId =
    String(req.query?.branchId || req.workspaceBranchId || '').trim() ||
    branches.find((b) => String(b.id) === 'BR-YL')?.id ||
    branches[0]?.id ||
    '';
  const accounts = selectedBranchId ? listTreasuryAccounts(db, selectedBranchId) : [];
  const selectedTreasuryAccountId =
    String(req.query?.treasuryAccountId || '').trim() ||
    (accounts.find((a) => /pos/i.test(String(a.name || ''))) || accounts[0])?.id ||
    '';
  const fromISO = String(req.query?.fromISO || '2026-09-01').slice(0, 10);
  const toISO = String(req.query?.toISO || todayIso()).slice(0, 10);
  const q = String(req.query?.treasuryAccountId || '').trim();
  let statement = null;
  let error = '';
  if (q) {
    statement = buildTreasuryAccountStatement(db, selectedTreasuryAccountId, fromISO, toISO);
    if (!statement.ok) error = statement.error || 'Could not build statement.';
  }
  return sendPage(
    res,
    renderCashierStatementPage({
      user: req.user || null,
      canView: userMayView(req.user),
      branches,
      selectedBranchId,
      accounts,
      selectedTreasuryAccountId,
      fromISO,
      toISO,
      statement: statement?.ok ? statement : null,
      error,
      formAction,
      view,
    })
  );
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerCashierStatementPage(app, db) {
  app.get(CASHIER_STATEMENT_PATH, (req, res) => handleCashierStatementGet(db, req, res));
}
