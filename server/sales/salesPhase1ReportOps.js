/**
 * Loads the books for the Phase 1 sales pack.
 * As-at advances and debtors need the whole history, so these reads are not desk-list capped.
 * The Management report endpoints are unchanged.
 */
import { branchWhere } from '../readModel.js';
import { hasColumn, tableExists } from '../ap2ReceivedBasisOps.js';
import { buildSalesPhase1Report } from '../../shared/lib/salesPhase1Recognition.js';

function isoDate(value) {
  const m = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * September-style month: opening is the last day of the previous month, closing is the last day of the month.
 * @param {{ month?: string, startDate?: string, endDate?: string, openingAsAt?: string, closingAsAt?: string }} opts
 */
export function resolveSalesPhase1Period(opts = {}) {
  const month = String(opts.month || '').trim();
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const startDate = `${month}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const endDate = `${month}-${String(last).padStart(2, '0')}`;
    const opening = new Date(Date.UTC(y, m - 1, 0));
    const openingAsAt = opening.toISOString().slice(0, 10);
    return { ok: true, startDate, endDate, openingAsAt, closingAsAt: endDate };
  }
  const startDate = isoDate(opts.startDate);
  const endDate = isoDate(opts.endDate);
  const openingAsAt = isoDate(opts.openingAsAt);
  const closingAsAt = isoDate(opts.closingAsAt || endDate);
  if (!startDate || !endDate || !openingAsAt || !closingAsAt) {
    return { ok: false, error: 'Provide month=YYYY-MM, or startDate, endDate, openingAsAt, and closingAsAt.' };
  }
  if (startDate > endDate) return { ok: false, error: 'startDate must be on or before endDate.' };
  return { ok: true, startDate, endDate, openingAsAt, closingAsAt };
}

function parseLines(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      products: Array.isArray(parsed.products) ? parsed.products : [],
      accessories: Array.isArray(parsed.accessories) ? parsed.accessories : [],
      services: Array.isArray(parsed.services) ? parsed.services : [],
    };
  } catch {
    return null;
  }
}

function mapTieMovement(row) {
  return {
    id: row.id,
    sourceKind: row.source_kind || 'LEDGER_RECEIPT',
    sourceId: row.source_id,
    type: row.type,
    amountNgn: row.amount_ngn,
    postedAtISO: row.posted_at_iso,
    reversesMovementId: row.reverses_movement_id,
    treasuryAccountId: row.treasury_account_id,
    accountName: row.account_name || '',
    accountBankName: row.account_bank_name || '',
    accountBranchId: row.account_branch_id || '',
    counterpartyName: row.counterparty_name || '',
    note: row.note || '',
    customerId: row.customer_id || row.counterparty_id || '',
    customerName: row.customer_name || row.counterparty_name || '',
    quotationRef: row.quotation_ref || '',
  };
}

/** Statement inflows named for this check. They are not posted as customer receipts. */
const NON_SALES_PASS_THROUGH = [
  {
    name: 'AFNICE',
    dateISO: '2026-09-09',
    amountNgn: 20_000_000,
    detail: 'Bank inflow on 9 Sep. Not a customer receipt and not in sales cash.',
  },
  {
    name: 'Ramatu Jallo',
    dateISO: '2026-09-04',
    amountNgn: 6_075_400,
    detail: 'Bank inflow on 4 Sep, returned the same day. Not customer cash.',
  },
];

const PASS_THROUGH_REFUNDS = [];

/** Owner confirmed Crock was an overpayment. Cash and the refund stay; the service revenue does not. */
const ADVANCE_RETURN_REFUNDS = [
  {
    refundId: 'RF-KD-26-9655',
    receiptId: 'LE-KD-26-1836',
    detail: 'Crock ₦5,380,867 on 9 Sep was an overpayment, refunded on 24 Sep via RF-KD-26-9655. Payee per customer instruction.',
  },
];

function obligationIdFromNote(note) {
  const match = String(note || '').match(/OBL-[A-Z0-9-]+/i);
  return match ? match[0] : '';
}

function mixFromLineType(lineType, metres, mix) {
  const metresN = Number(metres) || 0;
  if (!(metresN > 0)) return;
  const t = String(lineType || '').toLowerCase();
  if (t.includes('flat')) mix.flat += metresN;
  else if (t.includes('clad')) mix.clad += metresN;
  else if (t.includes('stone')) mix.stone += metresN;
  else mix.roof += metresN;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ month?: string, startDate?: string, endDate?: string, openingAsAt?: string, closingAsAt?: string, branchScope?: string }} opts
 */
export function buildSalesPhase1ReportFromDb(db, opts = {}) {
  const period = resolveSalesPhase1Period(opts);
  if (!period.ok) return period;
  const branchScope = opts.branchScope || 'ALL';

  const qBranch = branchWhere(db, 'quotations', branchScope);
  const quotations = db
    .prepare(
      `SELECT id, customer_id, customer_name, status, branch_id, lines_json
       FROM quotations WHERE 1=1${qBranch.sql}`
    )
    .all(...qBranch.args)
    .map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      status: row.status,
      branchId: row.branch_id || '',
      lines: parseLines(row.lines_json),
    }));

  const missingLines = quotations.filter((q) => !q.lines).map((q) => q.id);
  if (missingLines.length && tableExists(db, 'quotation_lines')) {
    const byId = new Map();
    const chunk = 400;
    for (let i = 0; i < missingLines.length; i += chunk) {
      const ids = missingLines.slice(i, i + chunk);
      const ph = ids.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT quotation_id, category, name, qty, unit_price_ngn
           FROM quotation_lines WHERE quotation_id IN (${ph}) ORDER BY quotation_id, sort_order`
        )
        .all(...ids);
      for (const row of rows) {
        const id = String(row.quotation_id || '');
        if (!byId.has(id)) byId.set(id, { products: [], accessories: [], services: [] });
        const bucket = byId.get(id);
        const cat = bucket[row.category] ? row.category : 'products';
        bucket[cat].push({ name: row.name, qty: row.qty, unitPrice: row.unit_price_ngn });
      }
    }
    for (const q of quotations) {
      if (!q.lines && byId.has(q.id)) q.lines = byId.get(q.id);
      if (!q.lines) q.lines = { products: [], accessories: [], services: [] };
    }
  }

  const jobBranch = branchWhere(db, 'production_jobs', branchScope);
  const jobCols = ['job_id', 'quotation_ref', 'customer_id', 'customer_name', 'status', 'completed_at_iso', 'end_date_iso', 'actual_meters', 'cutting_list_id'];
  for (const col of ['actual_roof_m', 'actual_flatsheet_m', 'actual_cladding_m']) {
    if (hasColumn(db, 'production_jobs', col)) jobCols.push(col);
  }
  const jobs = db
    .prepare(
      `SELECT ${jobCols.join(', ')} FROM production_jobs
       WHERE 1=1${jobBranch.sql}`
    )
    .all(...jobBranch.args)
    .map((row) => ({
      jobId: row.job_id,
      quotationRef: row.quotation_ref,
      customerId: row.customer_id,
      customerName: row.customer_name,
      status: row.status,
      completedAtISO: row.completed_at_iso,
      endDateISO: row.end_date_iso,
      actualMeters: row.actual_meters,
      actualRoofM: row.actual_roof_m,
      actualFlatsheetM: row.actual_flatsheet_m,
      actualCladdingM: row.actual_cladding_m,
      cuttingListId: row.cutting_list_id,
      cuttingMix: null,
    }));

  const mixByList = new Map();
  if (tableExists(db, 'cutting_list_lines')) {
    const lineRows = db.prepare(`SELECT cutting_list_id, line_type, total_m FROM cutting_list_lines`).all();
    for (const row of lineRows) {
      const id = String(row.cutting_list_id || '');
      if (!id) continue;
      if (!mixByList.has(id)) mixByList.set(id, { roof: 0, flat: 0, clad: 0, stone: 0 });
      mixFromLineType(row.line_type, row.total_m, mixByList.get(id));
    }
  }
  for (const job of jobs) {
    if (job.cuttingListId && mixByList.has(String(job.cuttingListId))) {
      job.cuttingMix = mixByList.get(String(job.cuttingListId));
    }
  }

  const clBranch = branchWhere(db, 'cutting_lists', branchScope);
  const cuttingLists = tableExists(db, 'cutting_lists')
    ? db
        .prepare(`SELECT id, quotation_ref, status, date_iso FROM cutting_lists WHERE 1=1${clBranch.sql}`)
        .all(...clBranch.args)
        .map((row) => ({
          id: row.id,
          quotationRef: row.quotation_ref,
          status: row.status,
          dateISO: row.date_iso,
        }))
    : [];

  const delBranch = branchWhere(db, 'deliveries', branchScope);
  const deliveries = tableExists(db, 'deliveries')
    ? db
        .prepare(
          `SELECT quotation_ref, status, delivered_date_iso, ship_date FROM deliveries WHERE 1=1${delBranch.sql}`
        )
        .all(...delBranch.args)
        .map((row) => ({
          quotationRef: row.quotation_ref,
          status: row.status,
          deliveredDateISO: row.delivered_date_iso,
          shipDate: row.ship_date,
        }))
    : [];

  const rcBranch = branchWhere(db, 'sales_receipts', branchScope);
  const bankCol = hasColumn(db, 'sales_receipts', 'bank_confirmed_at_iso') ? 'bank_confirmed_at_iso' : 'NULL AS bank_confirmed_at_iso';
  const bankAmt = hasColumn(db, 'sales_receipts', 'bank_received_amount_ngn')
    ? 'bank_received_amount_ngn'
    : 'NULL AS bank_received_amount_ngn';
  const finCol = hasColumn(db, 'sales_receipts', 'finance_reconciliation_saved_at_iso')
    ? 'finance_reconciliation_saved_at_iso'
    : 'NULL AS finance_reconciliation_saved_at_iso';
  const receiptBranchCol = hasColumn(db, 'sales_receipts', 'branch_id') ? 'branch_id' : "'' AS branch_id";
  const receipts = db
    .prepare(
      `SELECT id, ledger_entry_id, customer_id, customer_name, quotation_ref, ${receiptBranchCol}, date_iso, amount_ngn, status,
              ${bankCol}, ${bankAmt}, ${finCol}
       FROM sales_receipts WHERE 1=1${rcBranch.sql}`
    )
    .all(...rcBranch.args)
    .map((row) => ({
      id: row.id,
      ledgerEntryId: row.ledger_entry_id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      quotationRef: row.quotation_ref,
      branchId: row.branch_id || '',
      dateISO: row.date_iso,
      amountNgn: row.amount_ngn,
      status: row.status,
      bankConfirmedAtISO: row.bank_confirmed_at_iso,
      bankReceivedAmountNgn: row.bank_received_amount_ngn,
      financeReconciliationSavedAtISO: row.finance_reconciliation_saved_at_iso,
    }));

  const accountJoin = tableExists(db, 'treasury_accounts')
    ? 'LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id'
    : '';
  const accountCols = tableExists(db, 'treasury_accounts')
    ? 'tm.treasury_account_id, ta.name AS account_name, ta.bank_name AS account_bank_name, ta.branch_id AS account_branch_id'
    : 'tm.treasury_account_id, NULL AS account_name, NULL AS account_bank_name, NULL AS account_branch_id';
  const treasuryMovements = tableExists(db, 'treasury_movements')
    ? db
        .prepare(
          `SELECT tm.id, tm.source_id, tm.type, tm.amount_ngn, tm.posted_at_iso, tm.reverses_movement_id,
                  ${accountCols}
           FROM treasury_movements tm
           ${accountJoin}
           WHERE tm.source_kind = 'LEDGER_RECEIPT'
             AND tm.type IN ('RECEIPT_IN', 'RECEIPT_REVERSAL_OUT')`
        )
        .all()
        .map(mapTieMovement)
    : [];

  function loadTieLines(type) {
    if (!tableExists(db, 'treasury_movements') || !tableExists(db, 'treasury_accounts')) return [];
    return db
      .prepare(
        `SELECT tm.id, tm.source_kind, tm.source_id, tm.type, tm.amount_ngn, tm.posted_at_iso, tm.reverses_movement_id,
                tm.treasury_account_id, tm.counterparty_name, tm.note,
                ta.name AS account_name, ta.bank_name AS account_bank_name, ta.branch_id AS account_branch_id
         FROM treasury_movements tm
         JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
         WHERE tm.type = ?
           AND ta.branch_id = 'BR-KD'
           AND SUBSTR(tm.posted_at_iso, 1, 10) >= ?
           AND SUBSTR(tm.posted_at_iso, 1, 10) <= ?`
      )
      .all(type, period.startDate, period.endDate)
      .map(mapTieMovement);
  }
  const tieOutReceiptIns = loadTieLines('RECEIPT_IN');
  const tieOutReversals = loadTieLines('RECEIPT_REVERSAL_OUT');

  const rfBranch = branchWhere(db, 'customer_refunds', branchScope);
  const refundMovements =
    tableExists(db, 'treasury_movements') && tableExists(db, 'customer_refunds')
      ? db
          .prepare(
            `SELECT tm.id, tm.source_id, tm.type, tm.amount_ngn, tm.posted_at_iso, tm.reverses_movement_id,
                    rf.customer_id, rf.customer_name, rf.quotation_ref, rf.refund_id, rf.branch_id
             FROM treasury_movements tm
             LEFT JOIN customer_refunds rf ON rf.refund_id = tm.source_id
             WHERE tm.source_kind = 'REFUND'
               AND tm.type IN ('REFUND_PAYOUT', 'REFUND_PAYOUT_REVERSAL_IN')${rfBranch.sql.replaceAll('branch_id', 'rf.branch_id')}`
          )
          .all(...rfBranch.args)
          .map((row) => ({
            id: row.id,
            sourceId: row.source_id,
            refundId: row.refund_id || row.source_id,
            type: row.type,
            amountNgn: row.amount_ngn,
            postedAtISO: row.posted_at_iso,
            reversesMovementId: row.reverses_movement_id,
            customerId: row.customer_id,
            customerName: row.customer_name,
            quotationRef: row.quotation_ref,
            branchId: row.branch_id || '',
          }))
      : [];

  const creditBranch = tableExists(db, 'refund_credit_applications')
    ? branchWhere(db, 'refund_credit_applications', branchScope)
    : { sql: '', args: [] };
  const creditApplications = tableExists(db, 'refund_credit_applications')
    ? db
        .prepare(
          `SELECT application_id, customer_id, source_quotation_ref, target_quotation_ref, amount_ngn,
                  status, created_at_iso, reversed_at_iso
           FROM refund_credit_applications WHERE 1=1${creditBranch.sql}`
        )
        .all(...creditBranch.args)
        .map((row) => ({
          id: row.application_id,
          customerId: row.customer_id,
          sourceQuotationRef: row.source_quotation_ref,
          targetQuotationRef: row.target_quotation_ref,
          amountNgn: row.amount_ngn,
          status: row.status,
          createdAtISO: row.created_at_iso,
          reversedAtISO: row.reversed_at_iso,
        }))
    : [];

  const refunds = tableExists(db, 'customer_refunds')
    ? db
        .prepare(
          `SELECT refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
                  calculation_lines_json, split_distributions_json, payee_name, payee_bank_name, payee_account_no
           FROM customer_refunds WHERE 1=1${rfBranch.sql}`
        )
        .all(...rfBranch.args)
        .map((row) => ({
          refundId: row.refund_id,
          customerId: row.customer_id,
          customerName: row.customer_name,
          quotationRef: row.quotation_ref,
          reasonCategory: row.reason_category,
          reason: row.reason,
          calculationText: row.calculation_lines_json,
          splits: row.split_distributions_json,
          payeeName: row.payee_name,
          payeeBankName: row.payee_bank_name,
          payeeAccountNo: row.payee_account_no,
        }))
    : [];

  const advanceMovements = tableExists(db, 'treasury_movements')
    ? db
        .prepare(
          `SELECT tm.id, tm.source_id, tm.type, tm.amount_ngn, tm.posted_at_iso, tm.reverses_movement_id,
                  tm.treasury_account_id, tm.counterparty_id, tm.counterparty_name, ta.branch_id AS account_branch_id,
                  le.customer_id, le.customer_name, le.quotation_ref
           FROM treasury_movements tm
           LEFT JOIN ledger_entries le ON le.id = tm.source_id
           LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
           WHERE tm.type = 'ADVANCE_IN'
              OR tm.reverses_movement_id IN (SELECT id FROM treasury_movements WHERE type = 'ADVANCE_IN')`
        )
        .all()
        .map((row) => ({
          id: row.id,
          sourceId: row.source_id,
          type: row.type,
          amountNgn: row.amount_ngn,
          postedAtISO: row.posted_at_iso,
          reversesMovementId: row.reverses_movement_id,
          treasuryAccountId: row.treasury_account_id,
          accountBranchId: row.account_branch_id || '',
          counterpartyId: row.counterparty_id,
          counterpartyName: row.counterparty_name,
          customerId: row.customer_id || row.counterparty_id || '',
          customerName: row.customer_name || row.counterparty_name || '',
          quotationRef: row.quotation_ref || '',
        }))
    : [];

  const advanceApplications = tableExists(db, 'ledger_entries')
    ? db
        .prepare(
          `SELECT id, at_iso, customer_id, customer_name, quotation_ref, amount_ngn, note
           FROM ledger_entries WHERE type = 'ADVANCE_APPLIED'`
        )
        .all()
        .map((row) => ({
          id: row.id,
          dateISO: row.at_iso,
          customerId: row.customer_id,
          customerName: row.customer_name,
          quotationRef: row.quotation_ref,
          amountNgn: row.amount_ngn,
          note: row.note || '',
        }))
    : [];

  const staffPurchaseCredits = tableExists(db, 'ledger_entries')
    ? db
        .prepare(
          `SELECT id, at_iso, customer_id, customer_name, quotation_ref, amount_ngn, note
           FROM ledger_entries WHERE type = 'STAFF_PURCHASE_CREDIT'`
        )
        .all()
        .map((row) => ({
          id: row.id,
          dateISO: row.at_iso,
          customerId: row.customer_id,
          customerName: row.customer_name,
          quotationRef: row.quotation_ref,
          amountNgn: row.amount_ngn,
          obligationId: obligationIdFromNote(row.note),
          note: row.note || '',
        }))
    : [];

  const depositAllocations =
    tableExists(db, 'bank_deposit_allocations') && tableExists(db, 'bank_deposits')
      ? db
          .prepare(
            `SELECT a.id, a.bank_deposit_id, a.allocated_to_id, a.amount_ngn, d.amount_ngn AS deposit_amount_ngn, d.bank_date_iso, d.status, d.reversed_at_iso
             FROM bank_deposit_allocations a
             JOIN bank_deposits d ON d.id = a.bank_deposit_id
             WHERE a.allocated_to_kind = 'receipt'`
          )
          .all()
          .map((row) => ({
            allocationId: row.id,
            depositId: row.bank_deposit_id,
            receiptId: row.allocated_to_id,
            amountNgn: row.amount_ngn,
            depositAmountNgn: row.deposit_amount_ngn,
            bankDateISO: row.bank_date_iso,
            depositStatus: row.status,
            reversedAtISO: row.reversed_at_iso,
          }))
      : [];

  const postedAdjustments = tableExists(db, 'sales_phase1_adjustments')
    ? db
        .prepare(
          `SELECT id, month, kind, entity_id, customer_id, customer_name, quotation_ref, amount_ngn, branch_id, date_iso, note
           FROM sales_phase1_adjustments
           WHERE date_iso <= ? OR month = ?`
        )
        .all(period.endDate, String(period.startDate || '').slice(0, 7))
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          entityId: row.entity_id,
          customerId: row.customer_id || '',
          customerName: row.customer_name || '',
          quotationRef: row.quotation_ref || '',
          amountNgn: row.amount_ngn,
          branchId: row.branch_id || '',
          dateISO: row.date_iso || '',
          note: row.note || '',
        }))
    : [];

  const staffPayees = [];
  try {
    const staffCustomers = db.prepare(
      `SELECT customer_id, name, bank_account_no, bank_name
       FROM customers
       WHERE name LIKE '%(Staff)%' OR name LIKE '%(staff)%'`
    ).all();
    for (const row of staffCustomers || []) {
      staffPayees.push({
        id: row.customer_id,
        name: row.name,
        accountNo: row.bank_account_no || '',
        bankName: row.bank_name || '',
      });
    }
  } catch {
    /* staff names are optional for the recovery split */
  }
  if (tableExists(db, 'associated_staff')) {
    try {
      const associated = db.prepare(
        `SELECT id, name, bank_account_no, bank_name FROM associated_staff`
      ).all();
      for (const row of associated || []) {
        staffPayees.push({
          id: row.id,
          name: row.name,
          accountNo: row.bank_account_no || '',
          bankName: row.bank_name || '',
        });
      }
    } catch {
      /* associated staff bank columns are optional */
    }
  }
  const periodKey = String(period.startDate || '').slice(0, 7);
  let periodLocked = false;
  if (periodKey && tableExists(db, 'accounting_period_locks')) {
    try {
      periodLocked = Boolean(
        db.prepare(`SELECT period_key FROM accounting_period_locks WHERE period_key = ?`).get(periodKey)
      );
    } catch {
      periodLocked = false;
    }
  }

  return buildSalesPhase1Report({
    ...period,
    periodLocked,
    branchScope,
    postedAdjustments,
    quotations,
    jobs,
    cuttingLists,
    deliveries,
    receipts,
    treasuryMovements,
    advanceMovements,
    advanceApplications,
    staffPurchaseCredits,
    depositAllocations,
    refundMovements,
    refunds,
    creditApplications,
    tieOutReceiptIns,
    tieOutReversals,
    staffPayees,
    statementBeneficiaries: opts.statementBeneficiaries || [],
    passThroughRefunds: PASS_THROUGH_REFUNDS,
    advanceReturnRefunds: ADVANCE_RETURN_REFUNDS,
    nonSalesPassThrough: NON_SALES_PASS_THROUGH,
  });
}
