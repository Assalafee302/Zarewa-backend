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
import { effectiveOutstandingNgn } from '../shared/lib/paymentOutstandingTolerance.js';
import { buildSupplierAdvanceReport } from './ap2SupplierAdvanceOps.js';
import { tableExists } from './ap2ReceivedBasisOps.js';
import { getStaffLoanSchedule } from './hrLoanSchedule.js';
import { hrTablesReady } from './hrOps.js';
import { interBranchLoanBalances, listInterBranchLoans } from './interBranchLoanOps.js';
import {
  listAccountsPayable,
  listCustomers,
  listLedgerEntries,
  listProductionJobs,
  listQuotations,
  listSalesReceipts,
  listSuppliers,
} from './readModel.js';

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
  if (branchId !== 'ALL') {
    sql += ` AND (branch_id = ? OR branch_id IS NULL OR TRIM(branch_id) = '')`;
    args.push(branchId);
  }
  sql += ` ORDER BY as_at_date_iso DESC, party_name COLLATE NOCASE`;
  const rows = db.prepare(sql).all(...args).map(mapRegisterRow);
  return { ok: true, lines: rows };
}

function nextRegisterId() {
  return `REG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {import('better-sqlite3').Database} db */
export function createAccountingRegisterLine(db, body, user) {
  ensureAccountingRegisterSchema(db);
  const registerSide = String(body?.registerSide || '').trim().toLowerCase();
  if (!['creditor', 'debtor'].includes(registerSide)) {
    return { ok: false, error: 'registerSide must be creditor or debtor.' };
  }
  const partyName = String(body?.partyName || '').trim();
  if (!partyName) return { ok: false, error: 'Party name is required.' };
  const amountNgn = Math.round(Number(body?.amountNgn) || 0);
  if (amountNgn <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
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
    String(body?.category || 'legacy').trim() || 'legacy',
    partyName,
    String(body?.partyRef || '').trim() || null,
    String(body?.branchId || '').trim() || null,
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

  const partyName = String(body?.partyName ?? cur.party_name ?? '').trim();
  if (!partyName) return { ok: false, error: 'Party name is required.' };
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
    String(body?.category ?? cur.category ?? 'legacy').trim() || 'legacy',
    partyName,
    String(body?.partyRef ?? cur.party_ref ?? '').trim() || null,
    String(body?.branchId ?? cur.branch_id ?? '').trim() || null,
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

function buildCustomerReceivableItems(db, branchScope) {
  const quotations = listQuotations(db, branchScope);
  const productionJobs = listProductionJobs(db, branchScope);
  const customers = new Map(listCustomers(db, branchScope).map((c) => [c.customerID, c]));
  const byCustomer = new Map();

  for (const q of quotations) {
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

function registerToItems(lines) {
  return lines.map((l) => {
    let entityType = '';
    const cat = String(l.category || '').trim();
    const ref = String(l.partyRef || '').trim();
    if (cat === 'staff_loan' || ref.startsWith('USR-')) entityType = 'staff';
    else if (
      cat === 'customer_deposit' ||
      cat === 'customer_ar' ||
      cat === 'project_overpayment' ||
      ref.startsWith('CUS-')
    ) {
      entityType = 'customer';
    } else if (cat === 'supplier_ap' || cat === 'supplier_prepay' || ref.startsWith('SUP-')) {
      entityType = 'supplier';
    } else if (cat === 'inter_branch') entityType = 'inter_branch';

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
      },
      entityType,
      ref
    );
  });
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
    section(
      'legacy_inherited',
      'Inherited & manual receivables',
      'Opening balances and credits carried forward from before this system.',
      registerToItems(legacy)
    ),
  ];

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
    },
    sections,
    notes: [
      'Customer receivables include only quotations with completed production.',
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

function buildOverpaymentCreditItems(db, branchScope) {
  const ledger = listLedgerEntries(db, branchScope);
  const customers = listCustomers(db, branchScope);
  const items = [];
  for (const c of customers) {
    const overpay = overpayCreditBalanceFromEntries(ledger, c.customerID);
    if (overpay <= 0) continue;
    items.push(
      withEntity(
        {
          id: `${c.customerID}-overpay`,
          partyName: c.name,
          partyRef: c.customerID,
          branchId: c.branchId || '',
          amountNgn: overpay,
          detail: 'Split-till overpayment credit — refundable to customer',
          isSignificant: overpay >= SIGNIFICANT_OVERPAY_NGN,
        },
        'customer',
        c.customerID
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
}

function buildUnlinkedPaymentItems(db, branchScope) {
  const receipts = listSalesReceipts(db, branchScope);
  const items = [];
  for (const r of receipts) {
    if (String(r.status || '').toUpperCase() === 'REVERSED') continue;
    const amount = Math.round(Number(r.amountNgn) || 0);
    if (amount <= 0) continue;
    const quoteRef = String(r.quotationRef || '').trim();
    const cleared = String(r.financeReconciliationSavedAtISO || '').trim() !== '';
    const noQuote = !quoteRef;
    const uncleared = !cleared;
    if (!noQuote && !uncleared) continue;
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
          detail: noQuote
            ? 'Receipt not linked to a quotation'
            : 'Receipt not cleared in finance reconciliation',
          quotationRef: quoteRef || null,
          uncleared,
          unlinked: noQuote,
        },
        r.customerID ? 'customer' : 'receipt',
        r.customerID || r.id
      )
    );
  }
  return items.sort((a, b) => b.amountNgn - a.amountNgn);
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
      'overpayment_credits',
      'Overpayment & refundable credits',
      `Customer overpayments available for refund or re-application (significant ≥ ₦${SIGNIFICANT_OVERPAY_NGN.toLocaleString()}).`,
      overpayItems
    ),
    section(
      'unlinked_payments',
      'Unlinked & uncleared receipts',
      'Bank receipts not tied to a quotation or not cleared in finance reconciliation.',
      safeRegisterItems('debtors.unlinked_payments', () => buildUnlinkedPaymentItems(db, branchScope))
    ),
    section(
      'inter_branch_payable',
      'Inter-branch payables',
      'Amounts this branch (or company) owes to other branches.',
      safeRegisterItems('debtors.inter_branch_payable', () =>
        buildInterBranchPayableItems(db, branchScope, branchLabel)
      )
    ),
    section(
      'legacy_inherited',
      'Inherited & manual payables',
      'Opening balances and overpayments carried forward (e.g. April project overpayment).',
      registerToItems(legacy)
    ),
  ];

  const totalNgn = sections.reduce((s, sec) => s + sec.subtotalNgn, 0);
  return {
    ok: true,
    label: 'Debtors register',
    description:
      'Amounts Zarewa owes or must refund — supplier AP, customer deposits, overpayments, unlinked payments, inter-branch, and inherited balances.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    generatedAtISO: new Date().toISOString(),
    significantOverpayThresholdNgn: SIGNIFICANT_OVERPAY_NGN,
    summary: {
      totalNgn,
      supplierPayablesNgn: sections[0].subtotalNgn,
      customerDepositsNgn: sections[1].subtotalNgn,
      overpaymentCreditsNgn: sections[2].subtotalNgn,
      significantOverpaymentCount: significantOverpay.length,
      significantOverpaymentNgn: sumSection(significantOverpay),
      unlinkedPaymentsNgn: sections[3].subtotalNgn,
      interBranchPayableNgn: sections[4].subtotalNgn,
      legacyInheritedNgn: sections[5].subtotalNgn,
    },
    sections,
    notes: [
      'Record pre-system overpayments (e.g. April project ₦8M) under “Add legacy line” on this tab.',
      'Significant overpayments should be reviewed for refund or re-application to the correct quotation.',
      'Unlinked receipts may need manual matching in Finance → Receipts.',
    ],
  };
}
