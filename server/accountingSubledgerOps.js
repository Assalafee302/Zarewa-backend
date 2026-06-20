/**
 * Accounting sub-ledgers: Creditors, Debtors, and manual register for inherited balances.
 * @param {import('better-sqlite3').Database} db
 */

import {
  advanceBalanceFromEntries,
  overpayCreditBalanceFromEntries,
  receivableDueOnQuotationFromEntries,
  firstProductionDateISO,
} from '../shared/lib/customerLedgerCore.js';
import { meetsCustomerTradeReceivableRegisterFloor } from '../shared/lib/accountingRegisterConstants.js';
import { quotationPaymentPolicyPhase } from '../shared/lib/accountingPolicyV1.js';
import { effectiveOutstandingNgn } from '../shared/lib/paymentOutstandingTolerance.js';
import { quotationOverpaymentExcessNgn } from '../shared/lib/refundQuotationMoney.js';
import { quotationRefundsBlocked, refundQuotationRefundsBlocked } from '../shared/lib/quotationRefundsBlocked.js';
import { refundOutstandingAmount } from '../shared/lib/refundsStore.js';
import { bankDepositRemainingNgn, bankDepositStatusLabel } from '../shared/lib/bankDeposits.js';
import { isReceiptPendingClearance } from '../shared/lib/receiptClearance.js';
import { buildSupplierAdvanceReport } from './ap2SupplierAdvanceOps.js';
import { listBankDeposits } from './bankDepositOps.js';
import { tableExists } from './ap2ReceivedBasisOps.js';
import { getStaffLoanSchedule } from './hrLoanSchedule.js';
import { buildStaffObligationCreditorItems, OBLIGATION_KIND, OBLIGATION_STATUS, staffObligationTablesReady } from './staffObligationOps.js';
import { hrTablesReady } from './hrOps.js';
import { interBranchLoanBalances, listInterBranchLoans } from './interBranchLoanOps.js';
import { branchPredicate } from './branchSql.js';
import { quotationPaymentCashBreakdown } from './quotationPaymentCash.js';
import {
  branchWhere,
  listAccountsPayable,
  listCustomers,
  listLedgerEntries,
  listProductionJobs,
  listQuotations,
  listRefunds,
  listSalesReceipts,
  listSuppliers,
} from './readModel.js';
import { quotationHasUnclearedReceipts } from './writeOps.js';

const SIGNIFICANT_OVERPAY_NGN = Math.max(
  0,
  Math.round(Number(process.env.ACCOUNTING_SIGNIFICANT_OVERPAY_NGN) || 100_000)
);

function branchScopeFromOpts(opts = {}) {
  const raw = String(opts.branchId || opts.branch || '').trim();
  return raw && raw !== 'ALL' ? raw : 'ALL';
}

function matchesBranch(branchId, scope) {
  if (!scope || scope === 'ALL') return true;
  return String(branchId || '').trim() === scope;
}

function sumSection(items) {
  return items.reduce((s, i) => s + (Math.round(Number(i.amountNgn) || 0) || 0), 0);
}

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

/** Production completed/cancelled or paid void — same closure basis as refund eligibility. */
function quotationProductionClosedForRefund(q, productionJobs) {
  const ref = String(q?.id || '').trim();
  if (!ref) return false;
  const isVoid = String(q?.status || '').trim().toLowerCase() === 'void';
  if (isVoid && roundMoney(q?.paidNgn) > 0) return true;
  return (productionJobs || []).some((j) => {
    if (String(j?.quotationRef || '').trim() !== ref) return false;
    const st = String(j?.status || '').trim().toLowerCase();
    return st === 'completed' || st === 'cancelled';
  });
}

/** Reserved refund amounts on a quote (pending + approved outstanding). */
function sumRefundCommitmentNgnForQuotation(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) return 0;
  const rows = db
    .prepare(
      `SELECT status, amount_ngn, approved_amount_ngn, paid_amount_ngn
       FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled', 'paid')`
    )
    .all(qid);
  let sum = 0;
  for (const row of rows) {
    const st = String(row.status || '').trim();
    if (st === 'Pending') {
      sum += roundMoney(row.amount_ngn);
    } else if (st === 'Approved') {
      const approved = roundMoney(row.approved_amount_ngn || row.amount_ngn);
      const paid = roundMoney(row.paid_amount_ngn);
      sum += effectiveOutstandingNgn(approved, paid);
    }
  }
  return sum;
}

function buildPreProductionCustomerDepositItems(db, branchScope) {
  const quotations = listQuotations(db, branchScope);
  const productionJobs = listProductionJobs(db, branchScope);
  const customers = new Map(listCustomers(db, branchScope).map((c) => [c.customerID, c]));
  const items = [];
  for (const q of quotations) {
    if (quotationRefundsBlocked(q)) continue;
    if (quotationPaymentPolicyPhase(q.id, productionJobs) !== 'pre_production') continue;
    if (quotationHasUnclearedReceipts(db, q.id)) continue;
    const cash = quotationPaymentCashBreakdown(db, q.id);
    if (cash.cashInNgn <= 0) continue;
    const quoteTotal = roundMoney(q.totalNgn);
    const depositBase = quoteTotal > 0 ? Math.min(cash.cashInNgn, quoteTotal) : cash.cashInNgn;
    const reserved = sumRefundCommitmentNgnForQuotation(db, q.id);
    const amountNgn = Math.max(0, depositBase - reserved);
    if (amountNgn <= 0) continue;
    const cid = String(q.customerID || '').trim();
    items.push(
      withEntity(
        {
          id: `${q.id}-preprod-deposit`,
          partyName: customers.get(cid)?.name || q.customer || cid || 'Customer',
          partyRef: cid,
          branchId: q.branchId || '',
          amountNgn,
          reference: q.id,
          quotationRef: q.id,
          asAtDateIso: String(q.dateISO || '').slice(0, 10) || null,
          detail: 'Customer deposit — paid quotation before production completes (Policy v1)',
          policyPhase: 'pre_production',
        },
        'customer',
        cid
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

function buildCustomerRefundCommitmentItems(db, branchScope) {
  const refunds = listRefunds(db, branchScope);
  const productionJobs = listProductionJobs(db, branchScope);
  const quotations = new Map(listQuotations(db, branchScope).map((q) => [q.id, q]));
  const items = [];
  for (const r of refunds) {
    if (refundQuotationRefundsBlocked(r)) continue;
    const qref = String(r.quotationRef || '').trim();
    if (!qref) continue;
    const q = quotations.get(qref);
    if (!q || quotationRefundsBlocked(q)) continue;
    if (!quotationProductionClosedForRefund(q, productionJobs)) continue;
    const st = String(r.status || '').trim();
    if (st === 'Pending') {
      const amountNgn = roundMoney(r.amountNgn);
      if (amountNgn <= 0) continue;
      items.push(
        withEntity(
          {
            id: r.refundID,
            partyName: r.customer || q.customer || r.customerID || 'Customer',
            partyRef: r.customerID || q.customerID || '',
            branchId: r.branchId || q.branchId || '',
            amountNgn,
            reference: r.refundID,
            quotationRef: qref,
            asAtDateIso: String(r.requestedAtISO || '').slice(0, 10) || null,
            detail: 'Refund requested — awaiting approval (not yet paid from treasury)',
            refundStatus: 'Pending',
          },
          'customer',
          r.customerID || q.customerID
        )
      );
      continue;
    }
    if (st === 'Approved') {
      const amountNgn = refundOutstandingAmount(r);
      if (amountNgn <= 0) continue;
      items.push(
        withEntity(
          {
            id: r.refundID,
            partyName: r.customer || q.customer || r.customerID || 'Customer',
            partyRef: r.customerID || q.customerID || '',
            branchId: r.branchId || q.branchId || '',
            amountNgn,
            reference: r.refundID,
            quotationRef: qref,
            asAtDateIso: String(r.approvalDate || r.requestedAtISO || '').slice(0, 10) || null,
            detail: 'Refund approved — committed liability, not yet paid from treasury',
            refundStatus: 'Approved',
          },
          'customer',
          r.customerID || q.customerID
        )
      );
    }
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

/** @param {object} item @param {string} entityType @param {string} [entityId] */
function withEntity(item, entityType, entityId) {
  const id = String(entityId || item.partyRef || '').trim();
  return {
    ...item,
    entityType: entityType || item.entityType || '',
    entityId: id || item.entityId || '',
  };
}

/** @param {import('better-sqlite3').Database} db */
function poSupplierIdMap(db) {
  const map = new Map();
  try {
    for (const row of db.prepare(`SELECT po_id, supplier_id FROM purchase_orders`).all()) {
      if (row.po_id && row.supplier_id) map.set(row.po_id, row.supplier_id);
    }
  } catch {
    /* optional in tests */
  }
  return map;
}

function section(id, title, description, items) {
  const subtotalNgn = sumSection(items);
  return {
    id,
    title,
    description,
    count: items.length,
    subtotalNgn,
    items: items.slice(0, 200),
  };
}

/** Run a section builder without failing the whole register. */
function safeRegisterItems(sectionKey, buildFn) {
  try {
    return buildFn();
  } catch (err) {
    console.error(`[accounting-register] ${sectionKey} section failed:`, err);
    return [];
  }
}

/** @param {import('better-sqlite3').Database} db */
export function ensureAccountingRegisterSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounting_register_lines (
      id TEXT PRIMARY KEY,
      register_side TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'legacy',
      party_name TEXT NOT NULL,
      party_ref TEXT,
      branch_id TEXT,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      as_at_date_iso TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'legacy',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      reference TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      cleared_at_iso TEXT,
      cleared_by_user_id TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_acct_reg_side_status ON accounting_register_lines(register_side, status);
    CREATE INDEX IF NOT EXISTS idx_acct_reg_branch ON accounting_register_lines(branch_id);
  `);
}

function mapRegisterRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    registerSide: row.register_side,
    category: row.category,
    partyName: row.party_name,
    partyRef: row.party_ref ?? '',
    branchId: row.branch_id ?? '',
    amountNgn: Math.round(Number(row.amount_ngn) || 0),
    asAtDateIso: row.as_at_date_iso,
    source: row.source,
    description: row.description ?? '',
    status: row.status,
    reference: row.reference ?? '',
    createdAtIso: row.created_at_iso,
    createdByUserId: row.created_by_user_id ?? '',
    clearedAtIso: row.cleared_at_iso ?? '',
    notes: row.notes ?? '',
  };
}

/** @param {import('better-sqlite3').Database} db @param {{ registerSide?: string; branchId?: string; status?: string }} [opts] */
export function listAccountingRegisterLines(db, opts = {}) {
  ensureAccountingRegisterSchema(db);
  const side = String(opts.registerSide || '').trim();
  const status = String(opts.status || 'open').trim();
  const branchId = branchScopeFromOpts(opts);
  let sql = `SELECT * FROM accounting_register_lines WHERE 1=1`;
  const args = [];
  if (side) {
    sql += ` AND register_side = ?`;
    args.push(side);
  }
  if (status && status !== 'ALL') {
    sql += ` AND status = ?`;
    args.push(status);
  }
  const branchFilter = branchPredicate(db, 'accounting_register_lines', branchId);
  sql += branchFilter.sql;
  args.push(...branchFilter.args);
  sql += ` ORDER BY as_at_date_iso DESC, party_name COLLATE NOCASE`;
  const rows = db.prepare(sql).all(...args).map(mapRegisterRow);
  return { ok: true, lines: rows };
}

/** @param {import('better-sqlite3').Database} db @param {string} lineId */
export function getAccountingRegisterLine(db, lineId) {
  ensureAccountingRegisterSchema(db);
  const id = String(lineId || '').trim();
  const row = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Register line not found.' };
  return { ok: true, line: mapRegisterRow(row) };
}

function nextRegisterId() {
  return `REG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function registerPartyKindForCategory(category) {
  const cat = String(category || '').trim();
  if (cat === 'staff_loan') return 'staff';
  if (['customer_ar', 'customer_deposit', 'project_overpayment'].includes(cat)) return 'customer';
  if (['supplier_ap', 'supplier_prepay'].includes(cat)) return 'supplier';
  if (cat === 'inter_branch') return 'branch';
  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} category
 * @param {string} partyRef
 * @param {string} partyName
 * @param {string} [ownBranchId]
 */
function resolveRegisterLineParty(db, category, partyRef, partyName, ownBranchId = '') {
  const kind = registerPartyKindForCategory(category);
  const ref = String(partyRef || '').trim();
  const ownBranch = String(ownBranchId || '').trim();

  if (!kind) {
    const name = String(partyName || '').trim();
    if (!name) return { ok: false, error: 'Party name is required.' };
    return { ok: true, partyName: name, partyRef: ref || null };
  }

  if (!ref) {
    if (kind === 'staff') return { ok: false, error: 'Select an employee from the staff list.' };
    if (kind === 'customer') return { ok: false, error: 'Select a customer from the customer list.' };
    if (kind === 'supplier') return { ok: false, error: 'Select a supplier from the supplier list.' };
    return { ok: false, error: 'Select a branch from the branch list.' };
  }

  if (kind === 'branch' && ownBranch && ref === ownBranch) {
    return { ok: false, error: 'Counterparty branch must differ from this branch.' };
  }

  if (kind === 'staff') {
    if (!hrTablesReady(db)) return { ok: false, error: 'HR module is not available.' };
    const row = db
      .prepare(
        `SELECT u.id, u.display_name
         FROM hr_staff_profiles sp
         JOIN app_users u ON u.id = sp.user_id
         WHERE u.id = ?`
      )
      .get(ref);
    if (!row) return { ok: false, error: 'Employee not found — pick from the staff list.' };
    return { ok: true, partyName: row.display_name || row.id, partyRef: row.id };
  }

  if (kind === 'customer') {
    const row = db.prepare(`SELECT customer_id, name FROM customers WHERE customer_id = ?`).get(ref);
    if (!row) return { ok: false, error: 'Customer not found — pick from the customer list.' };
    return { ok: true, partyName: row.name, partyRef: row.customer_id };
  }

  if (kind === 'supplier') {
    const row = db.prepare(`SELECT supplier_id, name FROM suppliers WHERE supplier_id = ?`).get(ref);
    if (!row) return { ok: false, error: 'Supplier not found — pick from the supplier list.' };
    return { ok: true, partyName: row.name, partyRef: row.supplier_id };
  }

  const branchRow = db.prepare(`SELECT id, name FROM branches WHERE id = ?`).get(ref);
  if (!branchRow) return { ok: false, error: 'Branch not found — pick from the branch list.' };
  return { ok: true, partyName: branchRow.name || branchRow.id, partyRef: branchRow.id };
}

function partyLinkWarningForKind(kind) {
  if (kind === 'staff') return 'Not linked to an employee — edit and pick from the staff list.';
  if (kind === 'customer') return 'Not linked to a customer — edit and pick from the customer list.';
  if (kind === 'supplier') return 'Not linked to a supplier — edit and pick from the supplier list.';
  return 'Not linked to a branch — edit and pick the counterparty branch.';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ category?: string; partyRef?: string; partyName?: string; branchId?: string }} line
 */
export function assessRegisterLinePartyLink(db, line) {
  const category = String(line?.category || '').trim();
  const kind = registerPartyKindForCategory(category);
  if (!kind) {
    return { partyLinkStatus: 'not_required', partyLinkWarning: '' };
  }
  const ref = String(line?.partyRef || '').trim();
  const branchId = String(line?.branchId || '').trim();
  if (!ref) {
    return { partyLinkStatus: 'unlinked', partyLinkWarning: partyLinkWarningForKind(kind) };
  }
  const resolved = resolveRegisterLineParty(db, category, ref, line?.partyName, branchId);
  if (!resolved.ok) {
    return {
      partyLinkStatus: 'unlinked',
      partyLinkWarning: resolved.error || partyLinkWarningForKind(kind),
    };
  }
  return { partyLinkStatus: 'linked', partyLinkWarning: '' };
}

/** @param {import('better-sqlite3').Database} db */
export function createAccountingRegisterLine(db, body, user) {
  ensureAccountingRegisterSchema(db);
  const registerSide = String(body?.registerSide || '').trim().toLowerCase();
  if (!['creditor', 'debtor'].includes(registerSide)) {
    return { ok: false, error: 'registerSide must be creditor or debtor.' };
  }
  const category = String(body?.category || 'legacy').trim() || 'legacy';
  const branchId = String(body?.branchId || '').trim();
  if (!branchId) return { ok: false, error: 'Branch is required.' };
  const partyResolved = resolveRegisterLineParty(
    db,
    category,
    body?.partyRef,
    body?.partyName,
    branchId || ''
  );
  if (!partyResolved.ok) return partyResolved;
  const partyName = partyResolved.partyName;
  const partyRef = partyResolved.partyRef;
  const amountNgn = Math.round(Number(body?.amountNgn) || 0);
  if (amountNgn <= 0) return { ok: false, error: 'Amount must be greater than zero.' };

  const catLower = category.toLowerCase();
  if (
    staffObligationTablesReady(db) &&
    registerSide === 'creditor' &&
    (catLower === 'staff_loan' || catLower === 'staff')
  ) {
    const staffRef = String(body?.partyRef || partyRef || '').trim();
    if (staffRef) {
      const existing = db
        .prepare(
          `SELECT id FROM hr_staff_obligation_accounts
           WHERE user_id = ? AND kind = ? AND principal_outstanding_ngn > 0
             AND status IN (?, ?, ?) LIMIT 1`
        )
        .get(
          staffRef,
          OBLIGATION_KIND.LOAN,
          OBLIGATION_STATUS.ACTIVE,
          OBLIGATION_STATUS.PENDING_DISBURSEMENT,
          OBLIGATION_STATUS.PENDING_APPROVAL
        );
      if (existing?.id) {
        return {
          ok: false,
          error:
            'This staff member already has an HR obligation loan account. Use HR → Loans (obligation ledger) instead of a manual creditors register line.',
        };
      }
    }
  }

  const asAtDateIso = String(body?.asAtDateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAtDateIso)) {
    return { ok: false, error: 'Valid as-at date (YYYY-MM-DD) is required.' };
  }
  const now = new Date().toISOString();
  const id = nextRegisterId();
  const uid = user?.id ? String(user.id) : null;
  db.prepare(
    `INSERT INTO accounting_register_lines (
      id, register_side, category, party_name, party_ref, branch_id, amount_ngn,
      as_at_date_iso, source, description, status, reference, created_at_iso, created_by_user_id, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    registerSide,
    category,
    partyName,
    partyRef,
    branchId,
    amountNgn,
    asAtDateIso,
    String(body?.source || 'manual').trim() || 'manual',
    String(body?.description || '').trim() || null,
    'open',
    String(body?.reference || '').trim() || null,
    now,
    uid,
    String(body?.notes || '').trim() || null
  );
  const row = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(id);
  return { ok: true, line: mapRegisterRow(row) };
}

/** @param {import('better-sqlite3').Database} db */
export function updateAccountingRegisterLine(db, lineId, body, user) {
  ensureAccountingRegisterSchema(db);
  const id = String(lineId || '').trim();
  const cur = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(id);
  if (!cur) return { ok: false, error: 'Register line not found.' };
  if (cur.status !== 'open') {
    return { ok: false, error: 'Only open register lines can be edited.' };
  }

  const category = String(body?.category ?? cur.category ?? 'legacy').trim() || 'legacy';
  const branchId = String(body?.branchId ?? cur.branch_id ?? '').trim();
  if (!branchId) return { ok: false, error: 'Branch is required.' };
  const partyResolved = resolveRegisterLineParty(
    db,
    category,
    body?.partyRef ?? cur.party_ref,
    body?.partyName ?? cur.party_name,
    branchId || ''
  );
  if (!partyResolved.ok) return partyResolved;
  const partyName = partyResolved.partyName;
  const partyRef = partyResolved.partyRef;
  const amountNgn = Math.round(Number(body?.amountNgn ?? cur.amount_ngn) || 0);
  if (amountNgn <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
  const asAtDateIso = String(body?.asAtDateIso ?? cur.as_at_date_iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAtDateIso)) {
    return { ok: false, error: 'Valid as-at date (YYYY-MM-DD) is required.' };
  }

  db.prepare(
    `UPDATE accounting_register_lines SET
      category = ?,
      party_name = ?,
      party_ref = ?,
      branch_id = ?,
      amount_ngn = ?,
      as_at_date_iso = ?,
      description = ?,
      reference = ?,
      notes = ?
    WHERE id = ?`
  ).run(
    category,
    partyName,
    partyRef,
    branchId,
    amountNgn,
    asAtDateIso,
    String(body?.description ?? cur.description ?? '').trim() || null,
    String(body?.reference ?? cur.reference ?? '').trim() || null,
    String(body?.notes ?? cur.notes ?? '').trim() || null,
    id
  );

  void user;
  const row = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(id);
  return { ok: true, line: mapRegisterRow(row) };
}

/** @param {import('better-sqlite3').Database} db */
export function clearAccountingRegisterLine(db, lineId, user) {
  ensureAccountingRegisterSchema(db);
  const id = String(lineId || '').trim();
  const cur = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(id);
  if (!cur) return { ok: false, error: 'Register line not found.' };
  if (cur.status === 'cleared') return { ok: false, error: 'Line is already cleared.' };
  const now = new Date().toISOString();
  const uid = user?.id ? String(user.id) : null;
  db.prepare(
    `UPDATE accounting_register_lines SET status = 'cleared', cleared_at_iso = ?, cleared_by_user_id = ? WHERE id = ?`
  ).run(now, uid, id);
  const row = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(id);
  return { ok: true, line: mapRegisterRow(row) };
}

function buildStaffLoanItems(db, branchScope) {
  if (staffObligationTablesReady(db)) {
    return buildStaffObligationCreditorItems(db, branchScope);
  }
  if (!hrTablesReady(db)) return [];
  if (!tableExists(db, 'hr_staff_profiles') || !tableExists(db, 'app_users')) return [];
  let staffRows = [];
  try {
    staffRows = db
      .prepare(
        `SELECT sp.user_id, sp.branch_id, u.display_name
         FROM hr_staff_profiles sp
         JOIN app_users u ON u.id = sp.user_id`
      )
      .all();
  } catch (err) {
    console.error('[accounting-register] staff loan staff query failed:', err);
    return [];
  }
  const items = [];
  for (const staff of staffRows) {
    if (!matchesBranch(staff.branch_id, branchScope)) continue;
    for (const loan of getStaffLoanSchedule(db, staff.user_id)) {
      if (loan.outstandingNgn <= 0) continue;
      items.push({
        id: loan.requestId,
        partyName: staff.display_name || staff.user_id,
        partyRef: staff.user_id,
        branchId: staff.branch_id || '',
        amountNgn: loan.outstandingNgn,
        reference: loan.title,
        asAtDateIso: String(loan.disbursedAtIso || '').slice(0, 10) || null,
        detail: `${loan.monthsPaid}/${loan.repaymentMonths} months paid · ₦${loan.monthlyDeductionNgn.toLocaleString()}/mo`,
        status: loan.status,
        entityType: 'staff',
        entityId: staff.user_id,
      });
    }
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

function buildStaffRecoveryReceivableItems(db, branchScope) {
  if (!staffObligationTablesReady(db)) return [];
  return buildStaffObligationCreditorItems(db, branchScope, OBLIGATION_KIND.RECOVERY);
}

function buildStaffPurchaseReceivableItems(db, branchScope) {
  if (!staffObligationTablesReady(db)) return [];
  return buildStaffObligationCreditorItems(db, branchScope, OBLIGATION_KIND.PURCHASE);
}

function quotationHasActiveStaffPurchaseCredit(db, quotationRef) {
  if (!staffObligationTablesReady(db)) return false;
  try {
    const cols = new Set(db.prepare(`PRAGMA table_info(quotations)`).all().map((c) => c.name));
    if (!cols.has('is_staff_purchase')) return false;
  } catch {
    return false;
  }
  const q = db.prepare(`SELECT is_staff_purchase, staff_purchase_credit_id FROM quotations WHERE id = ?`).get(quotationRef);
  if (!q || !Number(q.is_staff_purchase)) return false;
  const acctId = String(q.staff_purchase_credit_id || '').trim();
  if (!acctId) return false;
  const acct = db.prepare(`SELECT status FROM hr_staff_obligation_accounts WHERE id = ?`).get(acctId);
  return acct && ['active', 'pending_approval'].includes(String(acct.status));
}

function buildCustomerReceivableItems(db, branchScope) {
  const quotations = listQuotations(db, branchScope);
  const productionJobs = listProductionJobs(db, branchScope);
  const customers = new Map(listCustomers(db, branchScope).map((c) => [c.customerID, c]));
  const byCustomer = new Map();

  for (const q of quotations) {
    if (quotationHasActiveStaffPurchaseCredit(db, q.id)) continue;
    const due = receivableDueOnQuotationFromEntries([], q, productionJobs);
    if (due <= 0) continue;
    const cid = String(q.customerID || q.customerId || '').trim();
    const cust = customers.get(cid);
    const key = cid || q.customer || q.id;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        id: key,
        partyName: cust?.name || q.customer || cid || 'Unknown customer',
        partyRef: cid,
        branchId: q.branchId || cust?.branchId || '',
        amountNgn: 0,
        quotations: [],
        oldestDueIso: '',
      });
    }
    const row = byCustomer.get(key);
    row.amountNgn += due;
    row.quotations.push({ quotationRef: q.id, amountNgn: due });
    const prodDate = firstProductionDateISO(q.id, productionJobs);
    if (prodDate && (!row.oldestDueIso || prodDate < row.oldestDueIso)) row.oldestDueIso = prodDate;
  }

  return [...byCustomer.values()]
    .filter((r) => meetsCustomerTradeReceivableRegisterFloor(r.amountNgn))
    .map((r) =>
      withEntity(
        {
          id: r.id,
          partyName: r.partyName,
          partyRef: r.partyRef,
          branchId: r.branchId,
          amountNgn: r.amountNgn,
          reference: r.quotations.map((x) => x.quotationRef).slice(0, 3).join(', '),
          quotationRefs: r.quotations.map((x) => x.quotationRef),
          asAtDateIso: r.oldestDueIso || null,
          detail: `${r.quotations.length} quotation(s) with outstanding balance`,
          quotationCount: r.quotations.length,
        },
        'customer',
        r.partyRef
      )
    )
    .sort((a, b) => b.amountNgn - a.amountNgn);
}

function buildSupplierPrepaymentItems(db, branchScope) {
  let report;
  try {
    report = buildSupplierAdvanceReport(db, {
      branchId: branchScope === 'ALL' ? null : branchScope,
      includeGlCapability: false,
    });
  } catch (err) {
    console.error('[accounting-register] supplier prepayment report failed:', err);
    return [];
  }
  const items = [];
  for (const row of report.paidNotReceived || []) {
    if ((row.supplierPaidNgn || 0) <= 0) continue;
    items.push(
      withEntity(
        {
          id: row.poId,
          partyName: row.supplierName || row.supplierId || 'Supplier',
          partyRef: row.supplierId || row.poId,
          branchId: row.branchId || '',
          amountNgn: row.supplierPaidNgn,
          reference: row.poId,
          asAtDateIso: row.lastPaymentDateISO,
          detail: 'Paid — goods/services not yet received (GRN pending)',
          ageDays: row.ageDays,
        },
        row.supplierId ? 'supplier' : 'purchase_order',
        row.supplierId || row.poId
      )
    );
  }
  for (const row of report.supplierAdvanceSummary || []) {
    if ((row.supplierAdvanceNgn || 0) <= 0) continue;
    if (items.some((i) => i.reference === row.poId)) continue;
    items.push(
      withEntity(
        {
          id: `${row.poId}-adv`,
          partyName: row.supplierName || row.supplierId || 'Supplier',
          partyRef: row.supplierId || row.poId,
          branchId: row.branchId || '',
          amountNgn: row.supplierAdvanceNgn,
          reference: row.poId,
          asAtDateIso: row.lastPaymentDateISO,
          detail: 'Supplier advance / prepayment balance',
          ageDays: row.ageDays,
        },
        row.supplierId ? 'supplier' : 'purchase_order',
        row.supplierId || row.poId
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

function buildInterBranchReceivableItems(db, branchScope, branchLabel) {
  if (!tableExists(db, 'inter_branch_loans')) return [];
  const balances = interBranchLoanBalances(db, branchScope);
  const loans = listInterBranchLoans(db, branchScope).filter((l) => l.status === 'active');
  const items = [];
  if (branchScope === 'ALL') {
    for (const b of balances) {
      items.push(
        withEntity(
          {
            id: `${b.lenderBranchId}|${b.borrowerBranchId}`,
            partyName: branchLabel(b.borrowerBranchId),
            partyRef: b.borrowerBranchId,
            branchId: b.lenderBranchId,
            amountNgn: b.outstandingNgn,
            reference: `${b.lenderBranchId} ← ${b.borrowerBranchId}`,
            detail: `${branchLabel(b.lenderBranchId)} is owed by ${branchLabel(b.borrowerBranchId)}`,
          },
          'inter_branch',
          b.borrowerBranchId
        )
      );
    }
  } else {
    for (const l of loans) {
      if (l.outstandingNgn <= 0) continue;
      if (l.lenderBranchId === branchScope) {
        items.push(
          withEntity(
            {
              id: l.loanId,
              partyName: branchLabel(l.borrowerBranchId),
              partyRef: l.borrowerBranchId,
              branchId: l.lenderBranchId,
              amountNgn: l.outstandingNgn,
              reference: l.loanId,
              asAtDateIso: l.dateISO,
              detail: `Inter-branch loan — ${branchLabel(l.borrowerBranchId)} owes this branch`,
            },
            'inter_branch_loan',
            l.loanId
          )
        );
      }
    }
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

function registerToItems(db, lines) {
  return lines.map((l) => {
    const cat = String(l.category || '').trim();
    const ref = String(l.partyRef || '').trim();
    const kind = registerPartyKindForCategory(cat);
    let entityType = '';
    if (kind === 'staff' || cat === 'staff_loan' || ref.startsWith('USR-')) entityType = 'staff';
    else if (kind === 'customer' || ref.startsWith('CUS-')) entityType = 'customer';
    else if (kind === 'supplier' || ref.startsWith('SUP-')) entityType = 'supplier';
    else if (kind === 'branch' || cat === 'inter_branch') entityType = 'inter_branch';

    const linkMeta = assessRegisterLinePartyLink(db, l);

    return withEntity(
      {
        id: l.id,
        partyName: l.partyName,
        partyRef: l.partyRef,
        branchId: l.branchId,
        amountNgn: l.amountNgn,
        reference: l.reference,
        asAtDateIso: l.asAtDateIso,
        detail: l.description || `Inherited balance (${l.category})`,
        description: l.description ?? '',
        notes: l.notes ?? '',
        source: l.source,
        category: l.category,
        isLegacy: true,
        partyLinkStatus: linkMeta.partyLinkStatus,
        partyLinkWarning: linkMeta.partyLinkWarning,
      },
      entityType,
      ref
    );
  });
}

function buildLegacyInheritedSection(db, lines, title, description) {
  const items = registerToItems(db, lines);
  const sec = section('legacy_inherited', title, description, items);
  return {
    ...sec,
    unlinkedLegacyCount: items.filter((i) => i.partyLinkStatus === 'unlinked').length,
  };
}

function branchLabelMap(db) {
  const map = new Map();
  try {
    for (const b of db.prepare(`SELECT id, name FROM branches`).all()) {
      map.set(b.id, b.name || b.id);
    }
  } catch {
    /* branches table may not exist in tests */
  }
  return (id) => map.get(id) || id || '—';
}

/**
 * Creditors — amounts owed TO Zarewa (credit extended by the company).
 * Staff loans, customer receivables, supplier prepayments, inter-branch receivables, legacy inherited.
 */
export function buildCreditorsRegister(db, opts = {}) {
  ensureAccountingRegisterSchema(db);
  const branchScope = branchScopeFromOpts(opts);
  const branchLabel = branchLabelMap(db);
  let legacy = [];
  try {
    legacy = listAccountingRegisterLines(db, {
      registerSide: 'creditor',
      branchId: branchScope,
      status: 'open',
    }).lines;
  } catch (err) {
    console.error('[accounting-register] creditor legacy lines failed:', err);
  }

  const sections = [
    section(
      'staff_loans',
      'Staff loan receivables',
      'Outstanding staff loans — payroll deductions and manual recovery.',
      safeRegisterItems('creditors.staff_loans', () => buildStaffLoanItems(db, branchScope))
    ),
    section(
      'staff_purchase_receivables',
      'Staff purchase credit',
      'Roofing and materials sold to staff on credit — recovered via payroll.',
      safeRegisterItems('creditors.staff_purchase', () => buildStaffPurchaseReceivableItems(db, branchScope))
    ),
    section(
      'staff_recovery_receivables',
      'Staff discipline recovery',
      'Incident-related amounts recovered from staff via payroll or direct payment.',
      safeRegisterItems('creditors.staff_recovery', () => buildStaffRecoveryReceivableItems(db, branchScope))
    ),
    section(
      'customer_receivables',
      'Customer trade receivables',
      'Outstanding balances on completed production (not yet fully paid).',
      safeRegisterItems('creditors.customer_receivables', () =>
        buildCustomerReceivableItems(db, branchScope)
      )
    ),
    section(
      'supplier_prepayments',
      'Supplier prepayments & paid-not-received',
      'Payments to suppliers before goods/services are received (GRN pending).',
      safeRegisterItems('creditors.supplier_prepayments', () =>
        buildSupplierPrepaymentItems(db, branchScope)
      )
    ),
    section(
      'inter_branch_receivable',
      'Inter-branch receivables',
      'Amounts other branches owe this branch (or company-wide net positions).',
      safeRegisterItems('creditors.inter_branch_receivable', () =>
        buildInterBranchReceivableItems(db, branchScope, branchLabel)
      )
    ),
    buildLegacyInheritedSection(
      db,
      legacy,
      'Inherited & manual receivables',
      'Opening balances and credits carried forward from before this system.'
    ),
  ];

  const legacySection = sections.find((s) => s.id === 'legacy_inherited');
  const totalNgn = sections.reduce((s, sec) => s + sec.subtotalNgn, 0);
  return {
    ok: true,
    label: 'Creditors register',
    description:
      'Amounts owed to Zarewa — staff loans, customer balances, supplier prepayments, inter-branch, and inherited credits.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    generatedAtISO: new Date().toISOString(),
    summary: {
      totalNgn,
      staffLoansNgn: sections[0].subtotalNgn,
      customerReceivablesNgn: sections[1].subtotalNgn,
      supplierPrepaymentsNgn: sections[2].subtotalNgn,
      interBranchReceivableNgn: sections[3].subtotalNgn,
      legacyInheritedNgn: sections[4].subtotalNgn,
      unlinkedLegacyCount: legacySection?.unlinkedLegacyCount ?? 0,
    },
    sections,
    notes: [
      'Customer receivables include only quotations with completed production.',
      'Customer trade receivable rows below ₦1,000 are omitted from this register (small-balance materiality).',
      'Use “Add legacy line” for balances from before go-live that are not in live transactions.',
      'Staff loan outstanding uses HR loan schedule; verify against payroll deductions.',
    ],
  };
}

function buildSupplierPayableItems(db, branchScope) {
  const suppliers = new Map(listSuppliers(db).map((s) => [s.supplierID, s.name]));
  const poSuppliers = poSupplierIdMap(db);
  const items = [];
  for (const ap of listAccountsPayable(db, branchScope)) {
    const outstanding = effectiveOutstandingNgn(Number(ap.amountNgn) || 0, Number(ap.paidNgn) || 0);
    if (outstanding <= 0) continue;
    const supplierId = poSuppliers.get(ap.poRef) || '';
    items.push(
      withEntity(
        {
          id: ap.apID,
          partyName: ap.supplierName || suppliers.get(supplierId) || 'Supplier',
          partyRef: supplierId || ap.poRef,
          branchId: ap.branchId || '',
          amountNgn: outstanding,
          reference: ap.poRef || ap.invoiceRef || ap.apID,
          asAtDateIso: ap.dueDateISO,
          detail: `PO ${ap.poRef} · AP outstanding`,
        },
        supplierId ? 'supplier' : 'purchase_order',
        supplierId || ap.poRef
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

function buildCustomerDepositItems(db, branchScope) {
  const ledger = listLedgerEntries(db, branchScope);
  const customers = listCustomers(db, branchScope);
  const items = [];
  for (const c of customers) {
    const advance = advanceBalanceFromEntries(ledger, c.customerID);
    if (advance <= 0) continue;
    items.push(
      withEntity(
        {
          id: c.customerID,
          partyName: c.name,
          partyRef: c.customerID,
          branchId: c.branchId || '',
          amountNgn: advance,
          detail: 'Voluntary customer deposit (ADVANCE_IN balance)',
        },
        'customer',
        c.customerID
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

/**
 * Sum per-quotation economic overpayment (cash in minus quote total) — same basis as refund preview.
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerID
 * @param {'ALL' | string} branchScope
 */
function economicOverpayExcessSumForCustomer(db, customerID, branchScope) {
  const cid = String(customerID || '').trim();
  if (!cid) return 0;
  const b = branchWhere(db, 'quotations', branchScope);
  const quotes = db
    .prepare(`SELECT id, total_ngn FROM quotations WHERE customer_id = ?${b.sql}`)
    .all(cid, ...b.args);
  let sum = 0;
  for (const q of quotes) {
    const cash = quotationPaymentCashBreakdown(db, q.id);
    sum += quotationOverpaymentExcessNgn({
      cashInNgn: cash.cashInNgn,
      quoteTotalNgn: q.total_ngn,
    });
  }
  return Math.round(sum);
}

/**
 * Refundable overpayment for debtors register: ledger OVERPAY_ADVANCE pool capped by economic excess.
 * Display-only — does not mutate ledger rows.
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{ customerID: string, type: string, amountNgn?: number }>} ledger
 * @param {string} customerID
 * @param {'ALL' | string} branchScope
 */
export function refundableOverpayCreditNgnForCustomer(db, ledger, customerID, branchScope) {
  const ledgerPoolNgn = overpayCreditBalanceFromEntries(ledger, customerID);
  const economicExcessNgn = economicOverpayExcessSumForCustomer(db, customerID, branchScope);
  const amountNgn = Math.min(Math.max(0, ledgerPoolNgn), Math.max(0, economicExcessNgn));
  return { amountNgn, ledgerPoolNgn, economicExcessNgn };
}

function buildOverpaymentCreditItems(db, branchScope) {
  const ledger = listLedgerEntries(db, branchScope);
  const customers = listCustomers(db, branchScope);
  const items = [];
  for (const c of customers) {
    const { amountNgn, ledgerPoolNgn, economicExcessNgn } = refundableOverpayCreditNgnForCustomer(
      db,
      ledger,
      c.customerID,
      branchScope
    );
    if (amountNgn <= 0) continue;
    const detail =
      ledgerPoolNgn > amountNgn
        ? `Refundable overpayment credit (₦${amountNgn.toLocaleString()} economic excess; ledger pool ₦${ledgerPoolNgn.toLocaleString()})`
        : 'Refundable overpayment credit — cash received above quote total';
    items.push(
      withEntity(
        {
          id: `${c.customerID}-overpay`,
          partyName: c.name,
          partyRef: c.customerID,
          branchId: c.branchId || '',
          amountNgn,
          ledgerPoolNgn,
          economicExcessNgn,
          detail,
          isSignificant: amountNgn >= SIGNIFICANT_OVERPAY_NGN,
        },
        'customer',
        c.customerID
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

/** Sales receipts with no quotation — suspense until matched (not uncleared workflow items). */
function buildUnallocatedReceiptItems(db, branchScope) {
  const receipts = listSalesReceipts(db, branchScope);
  const items = [];
  for (const r of receipts) {
    if (String(r.status || '').toUpperCase() === 'REVERSED') continue;
    const quoteRef = String(r.quotationRef || '').trim();
    if (quoteRef) continue;
    const amount = Math.round(Number(r.amountNgn) || 0);
    if (amount <= 0) continue;
    items.push(
      withEntity(
        {
          id: r.id,
          partyName: r.customer || r.customerID || 'Unknown',
          partyRef: r.customerID || '',
          branchId: r.branchId || '',
          amountNgn: amount,
          reference: r.id,
          asAtDateIso: r.dateISO,
          detail: 'Sales receipt not linked to a quotation — match in Sales or Finance',
          unlinked: true,
        },
        r.customerID ? 'customer' : 'receipt',
        r.customerID || r.id
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

/** Open bank-deposit pool (GL 2150 suspense) registered by Finance, not yet linked to Sales. */
function buildBankDepositSuspenseItems(db, branchScope) {
  if (!tableExists(db, 'bank_deposits')) return [];
  const deposits = listBankDeposits(db, branchScope, { openOnly: true });
  const items = [];
  for (const d of deposits) {
    const remaining = bankDepositRemainingNgn(d);
    if (remaining <= 0) continue;
    const label = String(d.description || d.bankReference || '').trim() || 'Unidentified bank inflow';
    items.push(
      withEntity(
        {
          id: d.id,
          partyName: label,
          partyRef: d.id,
          branchId: d.branchId || '',
          amountNgn: remaining,
          reference: d.bankReference || d.id,
          asAtDateIso: d.bankDateISO,
          detail: `Unlinked bank deposit (GL 2150 suspense) · ${bankDepositStatusLabel(d.status)}`,
          bankDepositId: d.id,
        },
        'bank_deposit',
        d.id
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

/** Linked receipts awaiting finance clearance — control exceptions, not payables. */
function buildPendingFinanceClearanceExceptions(db, branchScope) {
  const receipts = listSalesReceipts(db, branchScope);
  const items = [];
  for (const r of receipts) {
    if (!isReceiptPendingClearance(r)) continue;
    const quoteRef = String(r.quotationRef || '').trim();
    if (!quoteRef) continue;
    const amount = Math.round(Number(r.amountNgn) || 0);
    if (amount <= 0) continue;
    items.push({
      id: r.id,
      partyName: r.customer || r.customerID || 'Unknown',
      partyRef: r.customerID || '',
      branchId: r.branchId || '',
      amountNgn: amount,
      reference: r.id,
      quotationRef: quoteRef,
      asAtDateIso: r.dateISO,
      detail: 'Awaiting finance bank/cash confirmation — not a payable',
    });
  }
  items.sort((a, b) => b.amountNgn - a.amountNgn);
  return {
    count: items.length,
    totalNgn: sumSection(items),
    description:
      'Customer receipts linked to quotations but not yet cleared in Finance. These are workflow exceptions, not amounts owed by the company.',
    items: items.slice(0, 50),
  };
}

function buildInterBranchPayableItems(db, branchScope, branchLabel) {
  if (!tableExists(db, 'inter_branch_loans')) return [];
  const loans = listInterBranchLoans(db, branchScope).filter((l) => l.status === 'active');
  const items = [];
  if (branchScope === 'ALL') {
    const balances = interBranchLoanBalances(db, branchScope);
    for (const b of balances) {
      items.push(
        withEntity(
          {
            id: `pay-${b.lenderBranchId}|${b.borrowerBranchId}`,
            partyName: branchLabel(b.lenderBranchId),
            partyRef: b.lenderBranchId,
            branchId: b.borrowerBranchId,
            amountNgn: b.outstandingNgn,
            reference: `${b.borrowerBranchId} → ${b.lenderBranchId}`,
            detail: `${branchLabel(b.borrowerBranchId)} owes ${branchLabel(b.lenderBranchId)}`,
          },
          'inter_branch',
          b.lenderBranchId
        )
      );
    }
  } else {
    for (const l of loans) {
      if (l.outstandingNgn <= 0) continue;
      if (l.borrowerBranchId === branchScope) {
        items.push(
          withEntity(
            {
              id: l.loanId,
              partyName: branchLabel(l.lenderBranchId),
              partyRef: l.lenderBranchId,
              branchId: l.borrowerBranchId,
              amountNgn: l.outstandingNgn,
              reference: l.loanId,
              asAtDateIso: l.dateISO,
              detail: `Inter-branch loan — this branch owes ${branchLabel(l.lenderBranchId)}`,
            },
            'inter_branch_loan',
            l.loanId
          )
        );
      }
    }
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

/**
 * Debtors — amounts Zarewa OWES (payables, deposits held, refundable credits).
 */
export function buildDebtorsRegister(db, opts = {}) {
  ensureAccountingRegisterSchema(db);
  const branchScope = branchScopeFromOpts(opts);
  const branchLabel = branchLabelMap(db);
  let legacy = [];
  try {
    legacy = listAccountingRegisterLines(db, {
      registerSide: 'debtor',
      branchId: branchScope,
      status: 'open',
    }).lines;
  } catch (err) {
    console.error('[accounting-register] debtor legacy lines failed:', err);
  }

  const overpayItems = safeRegisterItems('debtors.overpayment_credits', () =>
    buildOverpaymentCreditItems(db, branchScope)
  );
  const significantOverpay = overpayItems.filter((i) => i.isSignificant);

  const sections = [
    section(
      'supplier_payables',
      'Supplier trade payables',
      'Approved supplier invoices not yet fully paid.',
      safeRegisterItems('debtors.supplier_payables', () => buildSupplierPayableItems(db, branchScope))
    ),
    section(
      'customer_deposits',
      'Customer deposits & advances',
      'Voluntary deposits held on customer ledger (ADVANCE_IN).',
      safeRegisterItems('debtors.customer_deposits', () => buildCustomerDepositItems(db, branchScope))
    ),
    section(
      'pre_production_deposits',
      'Pre-production customer deposits',
      'Cleared payments on quotations before production completes — customer deposit liability (Policy v1). Excludes permanently blocked quotations.',
      safeRegisterItems('debtors.pre_production_deposits', () =>
        buildPreProductionCustomerDepositItems(db, branchScope)
      )
    ),
    section(
      'customer_refund_commitments',
      'Customer refund commitments',
      'Pending or approved refunds on closed production — treasury payout may still be outstanding. Excludes permanently blocked quotations.',
      safeRegisterItems('debtors.customer_refund_commitments', () =>
        buildCustomerRefundCommitmentItems(db, branchScope)
      )
    ),
    section(
      'overpayment_credits',
      'Overpayment & refundable credits',
      `Economic overpayment (cash in minus quote total), capped by ledger pool — significant ≥ ₦${SIGNIFICANT_OVERPAY_NGN.toLocaleString()}.`,
      overpayItems
    ),
    section(
      'unallocated_receipts',
      'Unallocated sales receipts',
      'Sales receipts not linked to a quotation — suspense until matched to a customer job.',
      safeRegisterItems('debtors.unallocated_receipts', () => buildUnallocatedReceiptItems(db, branchScope))
    ),
    section(
      'bank_deposit_suspense',
      'Unlinked bank deposits (suspense)',
      'Finance-registered bank inflows on GL 2150 not yet linked to Sales receipts or advances.',
      safeRegisterItems('debtors.bank_deposit_suspense', () => buildBankDepositSuspenseItems(db, branchScope))
    ),
    section(
      'inter_branch_payable',
      'Inter-branch payables',
      'Amounts this branch (or company) owes to other branches.',
      safeRegisterItems('debtors.inter_branch_payable', () =>
        buildInterBranchPayableItems(db, branchScope, branchLabel)
      )
    ),
    buildLegacyInheritedSection(
      db,
      legacy,
      'Inherited & manual payables',
      'Opening balances and overpayments carried forward (e.g. April project overpayment).'
    ),
  ];

  const legacySection = sections.find((s) => s.id === 'legacy_inherited');
  const sectionSubtotal = (id) => sections.find((s) => s.id === id)?.subtotalNgn ?? 0;
  const totalNgn = sections.reduce((s, sec) => s + sec.subtotalNgn, 0);
  const pendingFinanceClearance = (() => {
    try {
      return buildPendingFinanceClearanceExceptions(db, branchScope);
    } catch (err) {
      console.error('[accounting-register] pending clearance exceptions failed:', err);
      return { count: 0, totalNgn: 0, description: '', items: [] };
    }
  })();
  return {
    ok: true,
    label: 'Debtors register',
    description:
      'Amounts Zarewa owes or must refund — supplier AP, customer deposits, overpayments, unallocated receipts, bank suspense, inter-branch, and inherited balances.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    generatedAtISO: new Date().toISOString(),
    significantOverpayThresholdNgn: SIGNIFICANT_OVERPAY_NGN,
    summary: {
      totalNgn,
      supplierPayablesNgn: sectionSubtotal('supplier_payables'),
      customerDepositsNgn: sectionSubtotal('customer_deposits'),
      preProductionDepositsNgn: sectionSubtotal('pre_production_deposits'),
      customerRefundCommitmentsNgn: sectionSubtotal('customer_refund_commitments'),
      overpaymentCreditsNgn: sectionSubtotal('overpayment_credits'),
      significantOverpaymentCount: significantOverpay.length,
      significantOverpaymentNgn: sumSection(significantOverpay),
      unallocatedReceiptsNgn: sectionSubtotal('unallocated_receipts'),
      bankDepositSuspenseNgn: sectionSubtotal('bank_deposit_suspense'),
      interBranchPayableNgn: sectionSubtotal('inter_branch_payable'),
      legacyInheritedNgn: sectionSubtotal('legacy_inherited'),
      unlinkedLegacyCount: legacySection?.unlinkedLegacyCount ?? 0,
      pendingFinanceClearanceCount: pendingFinanceClearance.count ?? 0,
      pendingFinanceClearanceNgn: pendingFinanceClearance.totalNgn ?? 0,
    },
    sections,
    exceptions: {
      pendingFinanceClearance,
    },
    notes: [
      'Record pre-system overpayments (e.g. April project ₦8M) under “Add legacy line” on this tab.',
      'Pre-production deposits are cleared quote payments before production completes — not the same as treasury “Record pay” (use that for approved refund payout).',
      'Refund commitments include pending and approved unpaid refunds on closed jobs; permanently blocked quotations are excluded from this register.',
      'Overpayment credits use economic excess (cash in minus quote total), capped by the ledger pool — same basis as refund preview.',
      'When detail shows a higher ledger pool than the amount, finance may reverse stale OVERPAY_ADVANCE rows.',
      'Unallocated receipts and unlinked bank deposits are suspense items until matched — not trade payables.',
      'Receipts pending finance clearance are listed separately; they are not part of this register total.',
    ],
  };
}
