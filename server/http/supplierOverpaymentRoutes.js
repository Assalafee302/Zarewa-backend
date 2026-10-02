/**
 * Supplier Double Payment & Overpayment Reversal — Desk & REST API.
 *
 * Provides a dedicated, high-clarity interface for recording:
 * 1. Second / duplicate disbursements or payments exceeding purchase order obligations.
 * 2. Overpayment reversals when a supplier refunds the excess cash or a bank recalls the transfer.
 */
import crypto from 'node:crypto';
import express from 'express';
import { requirePermission, userHasPermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { listBranches } from '../branches.js';
import { branchWhere, getPurchaseOrder, listTreasuryAccounts } from '../readModel.js';
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

function normalizeStatus(st) {
  return String(st || '').trim().toLowerCase();
}

function statusBadgeClass(status) {
  const s = normalizeStatus(status);
  if (s === 'received' || s === 'completed' || s === 'delivered') return 'badge-success';
  if (s === 'in transit' || s === 'on loading' || s === 'approved') return 'badge-info';
  if (s === 'ordered' || s === 'pending') return 'badge-warning';
  if (s === 'rejected' || s === 'cancelled') return 'badge-danger';
  return 'badge-neutral';
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
  const recentOrders = Array.isArray(model.recentOrders) ? model.recentOrders : [];
  const overpaidOrders = Array.isArray(model.overpaidOrders) ? model.overpaidOrders : [];
  const who = esc(user?.displayName || user?.username || 'Guest');

  const accountOptions = accounts
    .map((a) => {
      const id = String(a.id);
      const label = `${a.name || 'Account ' + id}${a.type ? ` (${a.type})` : ''} · ₦${formatNgn(a.balance)}`;
      return `<option value="${esc(id)}"${id === selectedAccount ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');

  const poSuggestions = recentOrders
    .map((po) => `<option value="${esc(po.po_id)}">${esc(po.supplier_name || 'Supplier')} (${esc(po.status || 'open')})</option>`)
    .join('');

  const overpaidPills = overpaidOrders.length
    ? `<div class="quick-pills-row">
        <span class="quick-pills-label">Recent Overpayments:</span>
        ${overpaidOrders
          .map(
            (o) =>
              `<a class="pill-link ${o.po_id === poId ? 'active' : ''}" href="${SUPPLIER_OVERPAYMENT_PATH}?poId=${encodeURIComponent(o.po_id)}">
                <strong>${esc(o.po_id)}</strong> · ${esc(o.supplier_name || 'Supplier')}
              </a>`
          )
          .join('')}
       </div>`
    : '';

  const recentPills = recentOrders.length && !overpaidOrders.length
    ? `<div class="quick-pills-row">
        <span class="quick-pills-label">Recent POs:</span>
        ${recentOrders.slice(0, 6)
          .map(
            (o) =>
              `<a class="pill-link ${o.po_id === poId ? 'active' : ''}" href="${SUPPLIER_OVERPAYMENT_PATH}?poId=${encodeURIComponent(o.po_id)}">
                ${esc(o.po_id)} (${esc(o.supplier_name || '')})
              </a>`
          )
          .join('')}
       </div>`
    : '';

  let positionHtml = '';
  if (position?.ok) {
    const obligation = Number(position.obligationNgn) || 0;
    const paid = Number(position.supplierPaidNgn) || 0;
    const owed = Number(position.stillOwedNgn) || 0;
    const excess = Number(position.excessNgn) || 0;

    const settledPct = obligation > 0 ? Math.min(100, Math.round((Math.min(paid, obligation) / obligation) * 100)) : (paid > 0 ? 100 : 0);
    const excessPct = obligation > 0 ? Math.max(0, Math.round((excess / obligation) * 100)) : 0;

    const movementRows = movements.length
      ? movements
          .map((row) => {
            const inbound = Number(row.amountNgn) > 0;
            const badgeClass = inbound ? 'pill-inbound' : 'pill-outbound';
            const badgeLabel = inbound ? '📥 Reversal (Cash In)' : '📤 Extra Pay (Cash Out)';
            const acctLabel = row.accountName ? `${row.accountName}${row.accountType ? ` (${row.accountType})` : ''}` : `Account #${row.treasuryAccountId}`;
            return `<tr>
              <td><span class="cell-date">${esc(String(row.postedAtISO || '').slice(0, 10))}</span></td>
              <td><span class="tx-badge ${badgeClass}">${badgeLabel}</span></td>
              <td><span class="cell-account">${esc(acctLabel)}</span></td>
              <td><code class="cell-ref">${esc(row.reference || '—')}</code></td>
              <td><span class="cell-note">${esc(row.note || '—')}</span></td>
              <td class="num ${inbound ? 'amt-in' : 'amt-out'}">${inbound ? '+' : '−'}₦${formatNgn(Math.abs(row.amountNgn))}</td>
            </tr>`;
          })
          .join('')
      : '';

    positionHtml = `
      <section class="po-dashboard-card card">
        <div class="po-header">
          <div class="po-title-block">
            <span class="po-badge-id">#${esc(position.poId)}</span>
            <h2 class="po-supplier-name">${esc(position.supplierName || 'Supplier')}</h2>
          </div>
          <div class="po-meta-tags">
            <span class="meta-tag badge ${statusBadgeClass(position.status)}">${esc(position.status || 'Active')}</span>
            <span class="meta-tag tag-branch">📍 Factory: ${esc(position.branchId || 'Kaduna')}</span>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-card kpi-obligation">
            <span class="kpi-label">Order Obligation</span>
            <span class="kpi-value">₦${formatNgn(obligation)}</span>
            <span class="kpi-sub">Landed coil cost / agreed line total</span>
          </div>
          <div class="kpi-card kpi-paid">
            <span class="kpi-label">Total Disbursed</span>
            <span class="kpi-value">₦${formatNgn(paid)}</span>
            <span class="kpi-sub">All posted treasury payments to date</span>
          </div>
          <div class="kpi-card ${owed > 0 ? 'kpi-owed-active' : 'kpi-owed-settled'}">
            <span class="kpi-label">Still Owed on Order</span>
            <span class="kpi-value">₦${formatNgn(owed)}</span>
            <span class="kpi-sub">${owed === 0 ? 'Paid in full ✓' : 'Outstanding on order'}</span>
          </div>
          <div class="kpi-card ${excess > 0 ? 'kpi-excess-active' : 'kpi-excess-zero'}">
            <span class="kpi-label">Excess (Supplier Owes Back)</span>
            <span class="kpi-value">₦${formatNgn(excess)}</span>
            <span class="kpi-sub">${excess > 0 ? '⚡ Available for refund / reversal' : 'No excess holding'}</span>
          </div>
        </div>

        <div class="progress-container">
          <div class="progress-bar-track">
            <div class="progress-bar-settled" style="width: ${settledPct}%;" title="Settled: ${settledPct}%"></div>
            ${excessPct > 0 ? `<div class="progress-bar-excess" style="width: ${Math.min(excessPct, 60)}%;" title="Excess: ${excessPct}%"></div>` : ''}
          </div>
          <div class="progress-legend">
            <span class="legend-item"><span class="legend-dot dot-settled"></span> Order Settled: ${settledPct}%</span>
            ${excess > 0 ? `<span class="legend-item"><span class="legend-dot dot-excess"></span> Unapplied Advance: ₦${formatNgn(excess)}</span>` : ''}
          </div>
        </div>
      </section>

      <section class="action-tabs-wrapper card">
        <div class="tabs-nav" role="tablist">
          <button type="button" class="tab-btn active" id="tab-btn-pay" onclick="switchActionTab('pay')" role="tab" aria-selected="true">
            <span class="tab-icon">📤</span>
            <div class="tab-text-group">
              <span class="tab-title">1. Record Second / Extra Payment</span>
              <span class="tab-sub">Disburse duplicate or overpaid funds</span>
            </div>
          </button>
          <button type="button" class="tab-btn ${excess > 0 ? 'tab-btn-highlight' : ''}" id="tab-btn-rev" onclick="switchActionTab('rev')" role="tab" aria-selected="false">
            <span class="tab-icon">📥</span>
            <div class="tab-text-group">
              <span class="tab-title">2. Record Overpayment Reversal</span>
              <span class="tab-sub">${excess > 0 ? `₦${formatNgn(excess)} refundable` : 'Supplier refund / bank recall'}</span>
            </div>
            ${excess > 0 ? `<span class="tab-badge-pill">Ready</span>` : ''}
          </button>
        </div>

        <div class="tab-content" id="tab-panel-pay" role="tabpanel">
          <form method="post" action="${SUPPLIER_OVERPAYMENT_PATH}" class="workflow-form" id="form-excess" onsubmit="handleFormSubmit(this, 'Recording payment...')">
            <input type="hidden" name="csrf" value="${esc(model.csrf)}" />
            <input type="hidden" name="action" value="excess" />
            <input type="hidden" name="poId" value="${esc(position.poId)}" />

            <div class="form-banner banner-info">
              <span class="banner-icon">ℹ️</span>
              <div class="banner-body">
                <strong>When to use this form:</strong>
                Money has already left your bank a second time, or a transfer was executed above the order value.
                ${owed > 0 ? `The first <strong>₦${formatNgn(owed)}</strong> will clear the open balance on the PO invoice. ` : 'Since the PO is already paid in full, '}
                all additional funds are credited to <strong>GL 1400 (Supplier Prepayments)</strong> and sit ready for reversal when refunded.
              </div>
            </div>

            <div class="form-row-grid">
              <div class="form-group span-2">
                <label for="pay-reason">Disbursement Scenario</label>
                <select id="pay-reason" name="reason" required class="input-control">
                  <option value="duplicate_payment">We paid this supplier twice (Duplicate payment)</option>
                  <option value="overpayment">Single transfer exceeded order value (Overpayment)</option>
                </select>
              </div>

              <div class="form-group span-2">
                <div class="label-with-actions">
                  <label for="pay-amount">Amount That Left The Bank (₦)</label>
                  <div class="quick-fill-buttons">
                    ${owed > 0 ? `<button type="button" class="chip-btn" onclick="fillPayAmount(${owed + 100000})">Fill Balance + ₦100k</button>` : ''}
                    <button type="button" class="chip-btn" onclick="fillPayAmount(${obligation > 0 ? obligation : 1000000})">Fill Full PO Value (${formatNgn(obligation)})</button>
                  </div>
                </div>
                <div class="input-prefix-wrapper">
                  <span class="input-prefix">₦</span>
                  <input type="text" id="pay-amount" name="amountNgn" required inputmode="numeric" placeholder="e.g. 1,500,000" class="input-control has-prefix" oninput="updatePaySimulator(${owed})" />
                </div>
                <div id="pay-simulator-box" class="simulator-callout" style="display:none;"></div>
              </div>

              <div class="form-group">
                <label for="pay-account">Disbursing Treasury Account</label>
                <select id="pay-account" name="treasuryAccountId" required class="input-control">
                  ${accountOptions}
                </select>
                <span class="form-hint">The bank account that sent the money.</span>
              </div>

              <div class="form-group">
                <div class="label-with-actions">
                  <label for="pay-date">Payment Date</label>
                  <div class="quick-fill-buttons">
                    <button type="button" class="chip-btn" onclick="setPayDate('today')">Today</button>
                    <button type="button" class="chip-btn" onclick="setPayDate('yesterday')">Yesterday</button>
                  </div>
                </div>
                <input type="date" id="pay-date" name="dateISO" value="${esc(model.dateISO || todayISO())}" required class="input-control" />
              </div>

              <div class="form-group">
                <label for="pay-ref">Bank Reference / NIP Session ID</label>
                <input type="text" id="pay-ref" name="reference" required minlength="3" placeholder="e.g. NIP/20261002/983719" class="input-control" />
                <span class="form-hint">Must be at least 3 chars; prevents duplicate submissions.</span>
              </div>

              <div class="form-group">
                <label for="pay-note">Audit Explanation Note</label>
                <input type="text" id="pay-note" name="note" required minlength="8" placeholder="e.g. Duplicate transfer authorized during weekend shift" class="input-control" />
                <span class="form-hint">Recorded on the treasury movement and audit log.</span>
              </div>
            </div>

            <div class="form-actions-footer">
              <button type="submit" class="btn btn-primary" ${allowed ? '' : 'disabled'}>
                <span class="btn-icon">✓</span> Post Extra Supplier Payment
              </button>
              <span class="action-subtext">Will debit Prepayments/AP, credit Treasury, and update Cashier Acks.</span>
            </div>
          </form>
        </div>

        <div class="tab-content" id="tab-panel-rev" role="tabpanel" style="display:none;">
          ${
            excess <= 0
              ? `<div class="empty-reversal-box">
                  <div class="empty-icon">ℹ️</div>
                  <h3>No Excess Available to Reverse</h3>
                  <p>This purchase order does not currently have any funds paid above its obligation (Agreed: ₦${formatNgn(obligation)} vs Paid: ₦${formatNgn(paid)}).</p>
                  <p class="empty-sub">If an extra payment was already sent from your bank, record it using the <strong>Record Second / Extra Payment</strong> tab first. Once recorded, the excess will appear here ready for reversal.</p>
                </div>`
              : `<form method="post" action="${SUPPLIER_OVERPAYMENT_PATH}" class="workflow-form" id="form-reversal" onsubmit="handleFormSubmit(this, 'Recording reversal...')">
                  <input type="hidden" name="csrf" value="${esc(model.csrf)}" />
                  <input type="hidden" name="action" value="reversal" />
                  <input type="hidden" name="poId" value="${esc(position.poId)}" />

                  <div class="form-banner banner-warning">
                    <span class="banner-icon">⚡</span>
                    <div class="banner-body">
                      The supplier holds <strong>₦${formatNgn(excess)}</strong> in unapplied excess funds on this order.
                      When the supplier returns this cash (or your bank recalls the transfer), book it here to return cash into your accounts and reduce the PO paid total.
                      <strong>Maximum reversal allowed: ₦${formatNgn(excess)}</strong>.
                    </div>
                  </div>

                  <div class="form-row-grid">
                    <div class="form-group span-2">
                      <label for="rev-reason">Reversal Scenario</label>
                      <select id="rev-reason" name="reason" required class="input-control">
                        <option value="supplier_refund">Supplier refunded the overpayment to our account</option>
                        <option value="bank_reversal">Bank reversed / recalled the duplicate transfer</option>
                      </select>
                    </div>

                    <div class="form-group span-2">
                      <div class="label-with-actions">
                        <label for="rev-amount">Refunded Amount Entering Bank (₦)</label>
                        <div class="quick-fill-buttons">
                          <button type="button" class="chip-btn chip-btn-fill" onclick="fillRevAmount(${excess})">Fill Full Excess (₦${formatNgn(excess)})</button>
                        </div>
                      </div>
                      <div class="input-prefix-wrapper">
                        <span class="input-prefix">₦</span>
                        <input type="text" id="rev-amount" name="amountNgn" required inputmode="numeric" placeholder="e.g. ${formatNgn(excess)}" class="input-control has-prefix" oninput="updateRevSimulator(${excess}, ${paid})" />
                      </div>
                      <div id="rev-simulator-box" class="simulator-callout" style="display:none;"></div>
                    </div>

                    <div class="form-group">
                      <label for="rev-account">Receiving Treasury Account</label>
                      <select id="rev-account" name="treasuryAccountId" required class="input-control">
                        ${accountOptions}
                      </select>
                      <span class="form-hint">The bank account the refund was deposited into.</span>
                    </div>

                    <div class="form-group">
                      <div class="label-with-actions">
                        <label for="rev-date">Date Received</label>
                        <div class="quick-fill-buttons">
                          <button type="button" class="chip-btn" onclick="setRevDate('today')">Today</button>
                          <button type="button" class="chip-btn" onclick="setRevDate('yesterday')">Yesterday</button>
                        </div>
                      </div>
                      <input type="date" id="rev-date" name="dateISO" value="${esc(model.dateISO || todayISO())}" required class="input-control" />
                    </div>

                    <div class="form-group">
                      <label for="rev-ref">Bank Reference / Alert Session ID</label>
                      <input type="text" id="rev-ref" name="reference" required minlength="3" placeholder="e.g. RET/20261002/819234" class="input-control" />
                      <span class="form-hint">Credit alert session or bank reference from the supplier refund.</span>
                    </div>

                    <div class="form-group">
                      <label for="rev-note">Audit Explanation Note</label>
                      <input type="text" id="rev-note" name="note" required minlength="8" placeholder="e.g. Supplier refund for overpayment received via wire" class="input-control" />
                      <span class="form-hint">Recorded on the treasury movement and audit trail.</span>
                    </div>
                  </div>

                  <div class="form-actions-footer">
                    <button type="submit" class="btn btn-secondary" ${allowed ? '' : 'disabled'}>
                      <span class="btn-icon">↺</span> Post Overpayment Reversal
                    </button>
                    <span class="action-subtext">Will credit Prepayments (GL 1400), debit Treasury, and drop cumulative PO paid.</span>
                  </div>
                </form>`
          }
        </div>
      </section>

      <section class="movements-history-card card">
        <div class="section-header-row">
          <div>
            <h3 class="section-title">Overpayment & Reversal Audit Trail</h3>
            <p class="section-sub">History of all excess disbursements and supplier refunds posted against #${esc(position.poId)}.</p>
          </div>
          <span class="badge-count">${movements.length} record(s)</span>
        </div>

        ${
          movements.length
            ? `<div class="table-responsive">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Movement Kind</th>
                      <th>Treasury Account</th>
                      <th>Reference</th>
                      <th>Reason & Note</th>
                      <th class="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>${movementRows}</tbody>
                </table>
              </div>`
            : `<div class="empty-table-state">
                <span class="empty-table-icon">📋</span>
                <p>No overpayment disbursements or refunds have been recorded on this screen for <strong>#${esc(position.poId)}</strong> yet.</p>
              </div>`
        }
      </section>
    `;
  } else if (poId && model.lookupError) {
    positionHtml = `
      <div class="alert alert-error">
        <span class="alert-icon">⚠️</span>
        <div class="alert-content">
          <strong>Purchase order not found:</strong>
          ${esc(model.lookupError)}
        </div>
      </div>
    `;
  }

  const noticeHtml = model.notice
    ? `<div class="alert alert-success">
        <span class="alert-icon">✓</span>
        <div class="alert-content">
          <strong>Transaction Confirmed:</strong>
          ${esc(model.notice)}
        </div>
      </div>`
    : '';

  const errorHtml = model.error
    ? `<div class="alert alert-error">
        <span class="alert-icon">⚠️</span>
        <div class="alert-content">
          <strong>Transaction Blocked:</strong>
          ${esc(model.error)}
        </div>
      </div>`
    : '';

  const permissionNotice = !signedIn
    ? `<div class="alert alert-warning"><span class="alert-icon">🔒</span><div class="alert-content">Sign in to Zarewa first to record supplier payments.</div></div>`
    : !allowed
      ? `<div class="alert alert-warning"><span class="alert-icon">🔒</span><div class="alert-content">Signed in as <strong>${who}</strong>. Your role has read-only access here; <code>finance.pay</code> permission is required to post disbursements or reversals.</div></div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Supplier Overpayments & Reversals — Zarewa</title>
  <style>
    :root {
      --bg-page: #f8fafc;
      --card-bg: #ffffff;
      --text-main: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --border-subtle: #e2e8f0;
      --border-strong: #cbd5e1;
      --primary: #1e3a5f;
      --primary-hover: #162c46;
      --secondary: #0f766e;
      --secondary-hover: #115e59;
      --success-bg: #ecfdf5;
      --success-border: #a7f3d0;
      --success-text: #065f46;
      --danger-bg: #fef2f2;
      --danger-border: #fecaca;
      --danger-text: #991b1b;
      --warning-bg: #fffbeb;
      --warning-border: #fde68a;
      --warning-text: #92400e;
      --info-bg: #eff6ff;
      --info-border: #bfdbfe;
      --info-text: #1e40af;
      --highlight-bg: #f5f3ff;
      --highlight-border: #ddd6fe;
      --highlight-text: #6b21a8;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.06), 0 2px 4px -2px rgba(0, 0, 0, 0.06);
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      background: var(--bg-page);
      color: var(--text-main);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .top-nav {
      background: #ffffff;
      border-bottom: 1px solid var(--border-subtle);
      padding: 0.75rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.88rem;
    }
    .top-nav-left {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }
    .brand-badge {
      background: #0f172a;
      color: #ffffff;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      padding: 0.25rem 0.55rem;
      border-radius: var(--radius-sm);
      text-transform: uppercase;
    }
    .nav-breadcrumb {
      color: var(--text-muted);
      font-weight: 500;
    }
    .nav-breadcrumb strong {
      color: var(--text-main);
    }
    .top-nav-right {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .user-pill {
      background: #f1f5f9;
      padding: 0.35rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.82rem;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .back-link {
      color: var(--primary);
      text-decoration: none;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
    .back-link:hover { text-decoration: underline; }
    main {
      max-width: 62rem;
      margin: 0 auto;
      padding: 2rem 1.25rem 4rem;
    }
    .page-header {
      margin-bottom: 1.5rem;
    }
    .page-title {
      font-size: 1.75rem;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 0.4rem;
      letter-spacing: -0.02em;
    }
    .page-desc {
      color: var(--text-secondary);
      font-size: 0.98rem;
      margin: 0;
      max-width: 48rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 1.35rem 1.5rem;
      margin-bottom: 1.35rem;
      box-shadow: var(--shadow-sm);
    }
    .alert {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.9rem 1.1rem;
      border-radius: var(--radius-md);
      margin-bottom: 1.25rem;
      font-size: 0.94rem;
      line-height: 1.45;
    }
    .alert-icon { font-size: 1.15rem; flex-shrink: 0; }
    .alert-success { background: var(--success-bg); border: 1px solid var(--success-border); color: var(--success-text); }
    .alert-error { background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger-text); }
    .alert-warning { background: var(--warning-bg); border: 1px solid var(--warning-border); color: var(--warning-text); }
    .search-card {
      background: linear-gradient(to bottom, #ffffff, #fcfdfe);
    }
    .search-form-row {
      display: flex;
      gap: 0.6rem;
      margin-top: 0.5rem;
    }
    .search-input-wrapper {
      flex: 1;
      position: relative;
    }
    .search-input {
      width: 100%;
      padding: 0.65rem 0.85rem;
      font-size: 1rem;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      color: var(--text-main);
      background: #ffffff;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .search-input:focus {
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      font-size: 0.95rem;
      font-weight: 600;
      padding: 0.65rem 1.25rem;
      border-radius: var(--radius-md);
      border: 0;
      cursor: pointer;
      text-decoration: none;
      transition: background-color 0.15s, transform 0.05s;
    }
    .btn:active { transform: translateY(1px); }
    .btn-primary { background: var(--primary); color: #ffffff; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: var(--secondary); color: #ffffff; }
    .btn-secondary:hover { background: var(--secondary-hover); }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .quick-pills-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem;
      margin-top: 0.85rem;
      font-size: 0.82rem;
    }
    .quick-pills-label { color: var(--text-muted); font-weight: 600; }
    .pill-link {
      background: #f1f5f9;
      color: var(--text-secondary);
      padding: 0.25rem 0.65rem;
      border-radius: 9999px;
      text-decoration: none;
      border: 1px solid var(--border-subtle);
      transition: background-color 0.15s, border-color 0.15s;
    }
    .pill-link:hover { background: #e2e8f0; color: var(--text-main); }
    .pill-link.active { background: #dbeafe; border-color: #93c5fd; color: #1e40af; font-weight: 600; }
    .po-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 1.25rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border-subtle);
    }
    .po-badge-id {
      display: inline-block;
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 0.15rem;
    }
    .po-supplier-name {
      font-size: 1.45rem;
      font-weight: 700;
      margin: 0;
      color: #0f172a;
    }
    .po-meta-tags {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .badge {
      font-size: 0.78rem;
      font-weight: 600;
      padding: 0.25rem 0.6rem;
      border-radius: var(--radius-sm);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge-success { background: var(--success-bg); color: var(--success-text); border: 1px solid var(--success-border); }
    .badge-info { background: var(--info-bg); color: var(--info-text); border: 1px solid var(--info-border); }
    .badge-warning { background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .badge-danger { background: var(--danger-bg); color: var(--danger-text); border: 1px solid var(--danger-border); }
    .badge-neutral { background: #f1f5f9; color: var(--text-secondary); border: 1px solid var(--border-subtle); }
    .tag-branch {
      background: #f8fafc;
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      font-size: 0.82rem;
      font-weight: 500;
      padding: 0.25rem 0.65rem;
      border-radius: var(--radius-sm);
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
      gap: 0.85rem;
      margin-bottom: 1.25rem;
    }
    .kpi-card {
      background: #f8fafc;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 1rem 1.15rem;
      display: flex;
      flex-direction: column;
    }
    .kpi-label {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      margin-bottom: 0.3rem;
    }
    .kpi-value {
      font-size: 1.45rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: #0f172a;
      line-height: 1.2;
    }
    .kpi-sub {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-top: 0.3rem;
    }
    .kpi-owed-settled .kpi-value { color: var(--success-text); }
    .kpi-owed-active .kpi-value { color: var(--warning-text); }
    .kpi-excess-active {
      background: var(--highlight-bg);
      border-color: var(--highlight-border);
    }
    .kpi-excess-active .kpi-label { color: var(--highlight-text); }
    .kpi-excess-active .kpi-value { color: var(--highlight-text); }
    .kpi-excess-active .kpi-sub { color: #7e22ce; font-weight: 600; }
    .progress-container {
      margin-top: 0.5rem;
    }
    .progress-bar-track {
      height: 10px;
      background: #e2e8f0;
      border-radius: 9999px;
      overflow: hidden;
      display: flex;
    }
    .progress-bar-settled {
      background: #2563eb;
      height: 100%;
      transition: width 0.3s ease;
    }
    .progress-bar-excess {
      background: #9333ea;
      height: 100%;
      transition: width 0.3s ease;
    }
    .progress-legend {
      display: flex;
      gap: 1.25rem;
      margin-top: 0.45rem;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }
    .legend-item { display: inline-flex; align-items: center; gap: 0.4rem; }
    .legend-dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot-settled { background: #2563eb; }
    .dot-excess { background: #9333ea; }
    .tabs-nav {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.65rem;
      margin-bottom: 1.35rem;
    }
    .tab-btn {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.9rem 1.15rem;
      background: #f8fafc;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      cursor: pointer;
      text-align: left;
      transition: background-color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover {
      background: #f1f5f9;
      border-color: var(--border-strong);
    }
    .tab-btn.active {
      background: #ffffff;
      border-color: #2563eb;
      box-shadow: 0 0 0 1px #2563eb;
    }
    .tab-icon { font-size: 1.4rem; flex-shrink: 0; }
    .tab-text-group { display: flex; flex-direction: column; flex: 1; }
    .tab-title { font-size: 0.95rem; font-weight: 700; color: #0f172a; }
    .tab-sub { font-size: 0.78rem; color: var(--text-muted); }
    .tab-badge-pill {
      background: #fae8ff;
      color: #86198f;
      font-size: 0.75rem;
      font-weight: 700;
      padding: 0.2rem 0.5rem;
      border-radius: 9999px;
      border: 1px solid #f0abfc;
    }
    .workflow-form {
      display: flex;
      flex-direction: column;
      gap: 1.15rem;
    }
    .form-banner {
      display: flex;
      gap: 0.75rem;
      padding: 0.85rem 1rem;
      border-radius: var(--radius-md);
      font-size: 0.88rem;
      line-height: 1.45;
    }
    .banner-info { background: var(--info-bg); border: 1px solid var(--info-border); color: var(--info-text); }
    .banner-warning { background: var(--warning-bg); border: 1px solid var(--warning-border); color: var(--warning-text); }
    .form-row-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .span-2 { grid-column: span 2; }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .form-group label {
      font-size: 0.88rem;
      font-weight: 600;
      color: #1e293b;
    }
    .label-with-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .quick-fill-buttons {
      display: flex;
      gap: 0.35rem;
    }
    .chip-btn {
      background: #f1f5f9;
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      font-size: 0.76rem;
      font-weight: 600;
      padding: 0.2rem 0.55rem;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background 0.15s;
    }
    .chip-btn:hover { background: #e2e8f0; color: #0f172a; }
    .chip-btn-fill { background: #fdf4ff; border-color: #f0abfc; color: #a21caf; }
    .chip-btn-fill:hover { background: #fae8ff; color: #86198f; }
    .input-control {
      width: 100%;
      padding: 0.6rem 0.75rem;
      font-size: 0.95rem;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: #ffffff;
      color: var(--text-main);
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .input-control:focus {
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
    }
    .input-prefix-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }
    .input-prefix {
      position: absolute;
      left: 0.75rem;
      color: var(--text-muted);
      font-weight: 600;
      pointer-events: none;
    }
    .has-prefix { padding-left: 1.85rem; }
    .form-hint {
      font-size: 0.76rem;
      color: var(--text-muted);
    }
    .simulator-callout {
      background: #f8fafc;
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius-sm);
      padding: 0.65rem 0.85rem;
      margin-top: 0.45rem;
      font-size: 0.84rem;
      color: var(--text-secondary);
      line-height: 1.4;
    }
    .form-actions-footer {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-top: 0.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle);
    }
    .action-subtext {
      font-size: 0.82rem;
      color: var(--text-muted);
    }
    .empty-reversal-box {
      text-align: center;
      padding: 2rem 1rem;
      background: #f8fafc;
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius-md);
    }
    .empty-icon { font-size: 2rem; margin-bottom: 0.5rem; }
    .empty-reversal-box h3 { margin: 0 0 0.4rem; font-size: 1.1rem; color: #0f172a; }
    .empty-reversal-box p { margin: 0 0 0.5rem; color: var(--text-secondary); font-size: 0.92rem; }
    .empty-sub { color: var(--text-muted) !important; font-size: 0.82rem !important; }
    .section-header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-bottom: 1rem;
    }
    .section-title { font-size: 1.15rem; font-weight: 700; color: #0f172a; margin: 0 0 0.2rem; }
    .section-sub { font-size: 0.82rem; color: var(--text-muted); margin: 0; }
    .badge-count {
      background: #f1f5f9;
      color: var(--text-secondary);
      font-size: 0.78rem;
      font-weight: 600;
      padding: 0.2rem 0.55rem;
      border-radius: var(--radius-sm);
    }
    .table-responsive { overflow-x: auto; }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }
    .data-table th, .data-table td {
      text-align: left;
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--border-subtle);
    }
    .data-table th {
      background: #f8fafc;
      font-weight: 600;
      color: var(--text-secondary);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .data-table td.num, .data-table th.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .tx-badge {
      display: inline-block;
      font-size: 0.76rem;
      font-weight: 600;
      padding: 0.2rem 0.55rem;
      border-radius: var(--radius-sm);
      white-space: nowrap;
    }
    .pill-outbound { background: #fee2e2; color: #991b1b; }
    .pill-inbound { background: #dcfce7; color: #166534; }
    .amt-out { color: #991b1b; font-weight: 700; }
    .amt-in { color: #166534; font-weight: 700; }
    .cell-date { color: var(--text-muted); font-size: 0.82rem; }
    .cell-ref { background: #f1f5f9; padding: 0.15rem 0.35rem; border-radius: 4px; font-size: 0.82rem; }
    .empty-table-state {
      text-align: center;
      padding: 2.2rem 1rem;
      color: var(--text-muted);
      font-size: 0.92rem;
    }
    .empty-table-icon { font-size: 1.8rem; display: block; margin-bottom: 0.4rem; }
    @media (max-width: 680px) {
      .form-row-grid { grid-template-columns: 1fr; }
      .span-2 { grid-column: span 1; }
      .tabs-nav { grid-template-columns: 1fr; }
      .po-header { flex-direction: column; gap: 0.75rem; }
      .kpi-grid { grid-template-columns: 1fr 1fr; }
      .top-nav { flex-direction: column; gap: 0.5rem; align-items: flex-start; }
    }
    @media print {
      body { background: #fff; }
      .top-nav, .search-card, .action-tabs-wrapper { display: none !important; }
      .card { box-shadow: none; border: 1px solid #ccc; }
    }
  </style>
</head>
<body>
  <header class="top-nav">
    <div class="top-nav-left">
      <span class="brand-badge">ZAREWA ERP</span>
      <span class="nav-breadcrumb">Finance &rsaquo; Payables &rsaquo; <strong>Supplier Overpayments</strong></span>
    </div>
    <div class="top-nav-right">
      <span class="user-pill">👤 ${who} ${allowed ? '· <strong style="color:#059669;">Pay Authorized</strong>' : ''}</span>
      <a class="back-link" href="/">← Back to Desk</a>
    </div>
  </header>

  <main>
    <div class="page-header">
      <h1 class="page-title">Supplier Double Payments & Overpayments</h1>
      <p class="page-desc">
        Record duplicate disbursements and excess payments above purchase order commitments without distorting normal payables.
        When the supplier refunds the cash or the bank recalls the wire, post the reversal to return cash to company accounts.
      </p>
    </div>

    ${noticeHtml}
    ${errorHtml}
    ${permissionNotice}

    <section class="search-card card">
      <form method="get" action="${SUPPLIER_OVERPAYMENT_PATH}">
        <label for="search-po-input" style="font-size: 0.88rem; font-weight: 600; color: #1e293b;">
          Select Purchase Order
        </label>
        <div class="search-form-row">
          <div class="search-input-wrapper">
            <input
              type="text"
              id="search-po-input"
              name="poId"
              value="${esc(poId)}"
              list="po-datalist"
              placeholder="Enter or select PO Number (e.g. PO-ACK-1)"
              required
              class="search-input"
              autocomplete="off"
            />
            <datalist id="po-datalist">
              ${poSuggestions}
            </datalist>
          </div>
          <button type="submit" class="btn btn-primary">
            Inspect Balances &rsaquo;
          </button>
        </div>
      </form>
      ${overpaidPills}
      ${recentPills}
    </section>

    ${positionHtml}
  </main>

  <script>
    function switchActionTab(tabKey) {
      var payBtn = document.getElementById('tab-btn-pay');
      var revBtn = document.getElementById('tab-btn-rev');
      var payPanel = document.getElementById('tab-panel-pay');
      var revPanel = document.getElementById('tab-panel-rev');
      if (!payBtn || !revBtn || !payPanel || !revPanel) return;

      if (tabKey === 'pay') {
        payBtn.classList.add('active');
        payBtn.setAttribute('aria-selected', 'true');
        revBtn.classList.remove('active');
        revBtn.setAttribute('aria-selected', 'false');
        payPanel.style.display = 'block';
        revPanel.style.display = 'none';
      } else {
        revBtn.classList.add('active');
        revBtn.setAttribute('aria-selected', 'true');
        payBtn.classList.remove('active');
        payBtn.setAttribute('aria-selected', 'false');
        revPanel.style.display = 'block';
        payPanel.style.display = 'none';
      }
    }

    function formatNumberNgn(n) {
      return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
    }

    function parseNumericInput(val) {
      if (typeof val === 'number') return Math.round(val);
      var cleaned = String(val || '').replace(/[^0-9]/g, '');
      return Number(cleaned) || 0;
    }

    function fillPayAmount(amt) {
      var inp = document.getElementById('pay-amount');
      if (!inp) return;
      inp.value = formatNumberNgn(amt);
      inp.dispatchEvent(new Event('input'));
      inp.focus();
    }

    function fillRevAmount(amt) {
      var inp = document.getElementById('rev-amount');
      if (!inp) return;
      inp.value = formatNumberNgn(amt);
      inp.dispatchEvent(new Event('input'));
      inp.focus();
    }

    function setPayDate(mode) {
      var inp = document.getElementById('pay-date');
      if (!inp) return;
      var d = new Date();
      if (mode === 'yesterday') d.setDate(d.getDate() - 1);
      inp.value = d.toISOString().slice(0, 10);
    }

    function setRevDate(mode) {
      var inp = document.getElementById('rev-date');
      if (!inp) return;
      var d = new Date();
      if (mode === 'yesterday') d.setDate(d.getDate() - 1);
      inp.value = d.toISOString().slice(0, 10);
    }

    function updatePaySimulator(stillOwed) {
      var inp = document.getElementById('pay-amount');
      var box = document.getElementById('pay-simulator-box');
      if (!inp || !box) return;
      var raw = parseNumericInput(inp.value);
      if (raw <= 0) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      if (stillOwed > 0 && raw <= stillOwed) {
        box.innerHTML = '<strong>⚠️ Regular Settlement:</strong> ₦' + formatNumberNgn(raw) + ' is within what this order still owes (₦' + formatNumberNgn(stillOwed) + '). A normal payment from the Procurement or Finance desk handles this. Use this screen for payments that exceed the order balance.';
        box.style.borderColor = '#f59e0b';
        box.style.background = '#fffbeb';
      } else {
        var settlement = Math.min(raw, stillOwed);
        var advance = Math.max(0, raw - settlement);
        box.innerHTML = '<strong>📊 Financial Allocation:</strong> ₦' + formatNumberNgn(settlement) + ' will clear the remaining order balance, and <strong style=\"color:#7e22ce;\">₦' + formatNumberNgn(advance) + '</strong> will be booked as an excess supplier advance (GL 1400) ready for reversal.';
        box.style.borderColor = '#93c5fd';
        box.style.background = '#eff6ff';
      }
    }

    function updateRevSimulator(maxExcess, currentPaid) {
      var inp = document.getElementById('rev-amount');
      var box = document.getElementById('rev-simulator-box');
      if (!inp || !box) return;
      var raw = parseNumericInput(inp.value);
      if (raw <= 0) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      if (raw > maxExcess) {
        box.innerHTML = '<strong>⚠️ Amount Exceeds Excess:</strong> You cannot reverse more than ₦' + formatNumberNgn(maxExcess) + '. Only funds paid above the order obligation can be reversed here.';
        box.style.borderColor = '#ef4444';
        box.style.background = '#fef2f2';
      } else {
        var remainingExcess = Math.max(0, maxExcess - raw);
        var nextPaid = Math.max(0, currentPaid - raw);
        box.innerHTML = '<strong>↺ Reversal Impact:</strong> Cumulative PO paid will drop from ₦' + formatNumberNgn(currentPaid) + ' to <strong style=\"color:#047857;\">₦' + formatNumberNgn(nextPaid) + '</strong>. Remaining excess held: ₦' + formatNumberNgn(remainingExcess) + '.';
        box.style.borderColor = '#86efac';
        box.style.background = '#f0fdf4';
      }
    }

    function handleFormSubmit(form, loadingText) {
      var btn = form.querySelector('button[type=\"submit\"]');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class=\"btn-icon\">⏳</span> ' + (loadingText || 'Processing...');
      }
      return true;
    }
  </script>
</body>
</html>`;
}

function listRecentPurchaseOrders(db, branchScope = 'ALL', limit = 12) {
  try {
    const b = branchWhere(db, 'purchase_orders', branchScope);
    const sql = `
      SELECT po.po_id, po.supplier_name, po.status, po.supplier_paid_ngn, po.branch_id
      FROM purchase_orders po
      WHERE LOWER(TRIM(COALESCE(po.status, ''))) != 'rejected'
      ${b.sql}
      ORDER BY po.order_date_iso DESC, po.po_id DESC
      LIMIT ?
    `;
    return db.prepare(sql).all(...b.args, limit);
  } catch {
    return [];
  }
}

function listOverpaidPurchaseOrders(db, branchScope = 'ALL', limit = 8) {
  try {
    const b = branchWhere(db, 'purchase_orders', branchScope);
    const sql = `
      SELECT DISTINCT po.po_id, po.supplier_name, po.status, po.supplier_paid_ngn, po.branch_id
      FROM purchase_orders po
      WHERE po.po_id IN (
        SELECT DISTINCT source_id FROM treasury_movements
        WHERE source_kind IN ('SUPPLIER_OVERPAYMENT', 'SUPPLIER_OVERPAYMENT_REVERSAL')
      )
      ${b.sql}
      ORDER BY po.po_id DESC
      LIMIT ?
    `;
    return db.prepare(sql).all(...b.args, limit);
  } catch {
    return [];
  }
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
    recentOrders: listRecentPurchaseOrders(db, branchId),
    overpaidOrders: listOverpaidPurchaseOrders(db, branchId),
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
        ? `Recorded ₦${formatNgn(result.amountNgn)} leaving the bank. ₦${formatNgn(result.advanceNgn)} is held as an excess advance.`
        : `Recorded ₦${formatNgn(result.amountNgn)} coming back. Total paid on this order is now ₦${formatNgn(result.position?.supplierPaidNgn)}.`;
    const qs = new URLSearchParams({ poId, notice });
    return res.redirect(303, `${SUPPLIER_OVERPAYMENT_PATH}?${qs.toString()}`);
  });
}
