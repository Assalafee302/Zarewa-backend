/**
 * Month-end expense memo filing pack — paid (or selected) expenses stacked by
 * category for paper filing. Queries a date window in SQL; does not dump the
 * full expenses table.
 */
import { hasColumn, tableExists } from '../ap2ReceivedBasisOps.js';
import { abbreviateBankName } from '../../shared/lib/bankAbbreviation.js';
import { getExpenseCategoryLane } from '../../shared/expenseCategoryLanes.js';
import { paymentRequestLifecycleStatus } from '../../shared/lib/paymentRequestStatus.js';
import {
  buildExpenseMemoFilingPack,
  mapExpenseFilingMemo,
  memoMatchesFilingStatus,
  normalizeFilingDateBasis,
  normalizeFilingStatus,
  parseExpenseFilingPeriod,
} from '../../shared/lib/expenseMemoFilingPack.js';

const UNBOUNDED_IN = 800;

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function inClause(ids) {
  return ids.map(() => '?').join(',');
}

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function parseLineItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function chunkIds(ids, size = UNBOUNDED_IN) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function bankLabel(row) {
  const isCash = String(row.account_type || '').trim().toLowerCase() === 'cash';
  if (isCash) return 'Cash';
  return abbreviateBankName(row.bank_name) || String(row.account_name || '').trim() || '';
}

function filingNoFromSources(office, workItem) {
  const payload = parseJsonObject(office?.payload_json);
  const fromPayload = String(payload.filingNo || payload.filing_no || '').trim();
  const fromLabel = String(office?.filing_label || '').trim();
  const fromWork = String(workItem?.reference_no || '').trim();
  return fromPayload || fromLabel || fromWork || '';
}

/**
 * Load expense + payment-request rows for a filing window.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   startDate: string;
 *   endDate: string;
 *   branchScope?: string;
 *   status?: string;
 *   dateBasis?: string;
 *   category?: string;
 *   categoryLane?: string;
 *   includeUnlinked?: boolean;
 *   includeOfficeBody?: boolean;
 * }} opts
 */
export function loadExpenseMemoFilingRows(db, opts = {}) {
  const startDate = toIsoDate(opts.startDate);
  const endDate = toIsoDate(opts.endDate);
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';
  const status = normalizeFilingStatus(opts.status);
  const dateBasis = normalizeFilingDateBasis(opts.dateBasis);
  const category = String(opts.category || '').trim();
  const categoryLane = String(opts.categoryLane || opts.lane || '').trim();
  const includeUnlinked = opts.includeUnlinked !== false;
  const includeOfficeBody = Boolean(opts.includeOfficeBody);

  const hasBranch = hasColumn(db, 'expenses', 'branch_id');
  const hasLane = hasColumn(db, 'expenses', 'category_lane');
  const hasPayee = hasColumn(db, 'payment_requests', 'payee_name');
  const hasJustification = hasColumn(db, 'payment_requests', 'category_justification');
  const hasAttachmentName = hasColumn(db, 'payment_requests', 'attachment_name');

  const where = [];
  const args = [];

  if (hasBranch && branchScope !== 'ALL') {
    where.push('e.branch_id = ?');
    args.push(branchScope);
  }
  if (category) {
    where.push('e.category = ?');
    args.push(category);
  }
  if (hasLane && categoryLane) {
    where.push('e.category_lane = ?');
    args.push(categoryLane);
  }
  if (!includeUnlinked) {
    where.push('pr.request_id IS NOT NULL');
  }

  const dateExpr =
    dateBasis === 'expense'
      ? 'e.date'
      : `CASE WHEN pr.paid_at_iso IS NOT NULL AND TRIM(pr.paid_at_iso) != '' THEN SUBSTR(pr.paid_at_iso, 1, 10) ELSE e.date END`;
  where.push(`${dateExpr} >= ?`);
  args.push(startDate);
  where.push(`${dateExpr} <= ?`);
  args.push(endDate);

  if (status === 'paid') {
    where.push(
      `(pr.approval_status = 'Paid'
        OR (pr.request_id IS NOT NULL AND COALESCE(pr.amount_requested_ngn,0) > 0
            AND COALESCE(pr.paid_amount_ngn,0) >= COALESCE(pr.amount_requested_ngn,0))
        OR (pr.request_id IS NULL AND TRIM(COALESCE(e.payment_method, '')) != '' AND LOWER(e.payment_method) != 'pending'))`
    );
  } else if (status === 'approved') {
    where.push(
      `(pr.approval_status IN ('Paid', 'Approved')
        OR (pr.request_id IS NOT NULL AND COALESCE(pr.paid_amount_ngn,0) > 0)
        OR (pr.request_id IS NULL AND TRIM(COALESCE(e.payment_method, '')) != '' AND LOWER(e.payment_method) != 'pending'))`
    );
  }

  const prSelect = [
    'pr.request_id',
    'pr.amount_requested_ngn',
    'pr.request_date',
    'pr.approval_status',
    'pr.description',
    'pr.approved_by',
    'pr.approved_at_iso',
    'pr.paid_amount_ngn',
    'pr.paid_at_iso',
    'pr.paid_by',
    'pr.payment_note',
    'pr.request_reference',
    'pr.line_items_json',
  ];
  if (hasJustification) prSelect.push('pr.category_justification');
  if (hasPayee) prSelect.push('pr.payee_name', 'pr.payee_account_no', 'pr.payee_bank_name');
  if (hasAttachmentName) prSelect.push('pr.attachment_name', 'pr.attachment_mime');

  const sql = `SELECT e.expense_id, e.expense_type, e.amount_ngn, e.date, e.category,
              e.payment_method, e.reference${hasBranch ? ', e.branch_id' : ''}${hasLane ? ', e.category_lane' : ''},
              ${prSelect.join(', ')}
       FROM expenses e
       LEFT JOIN payment_requests pr ON pr.expense_id = e.expense_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.date ASC, e.expense_id ASC`;

  const joined = db.prepare(sql).all(...args);
  const byExpense = new Map();
  for (const row of joined) {
    const id = String(row.expense_id || '').trim();
    if (!id) continue;
    const current = byExpense.get(id);
    if (!current) {
      byExpense.set(id, row);
      continue;
    }
    const rowPaid =
      paymentRequestLifecycleStatus({
        approvalStatus: row.approval_status,
        amountRequestedNgn: row.amount_requested_ngn,
        paidAmountNgn: row.paid_amount_ngn,
      }) === 'Paid';
    const curPaid =
      paymentRequestLifecycleStatus({
        approvalStatus: current.approval_status,
        amountRequestedNgn: current.amount_requested_ngn,
        paidAmountNgn: current.paid_amount_ngn,
      }) === 'Paid';
    if (rowPaid && !curPaid) byExpense.set(id, row);
    else if (rowPaid === curPaid) {
      const rowPay = toIsoDate(row.paid_at_iso);
      const curPay = toIsoDate(current.paid_at_iso);
      if (rowPay > curPay) byExpense.set(id, row);
    }
  }

  let rows = [...byExpense.values()];
  if (categoryLane && !hasLane) {
    rows = rows.filter((row) => getExpenseCategoryLane(row.category) === categoryLane);
  }
  rows = rows.filter((row) =>
    memoMatchesFilingStatus(
      status,
      paymentRequestLifecycleStatus({
        approvalStatus: row.approval_status,
        amountRequestedNgn: row.amount_requested_ngn,
        paidAmountNgn: row.paid_amount_ngn,
      }),
      row.payment_method
    )
  );

  const expenseIds = rows.map((r) => String(r.expense_id)).filter(Boolean);
  const requestIds = rows.map((r) => String(r.request_id || '').trim()).filter(Boolean);

  const bankByExpenseId = new Map();
  if (expenseIds.length && tableExists(db, 'treasury_movements')) {
    for (const chunk of chunkIds(expenseIds)) {
      const bankRows = db
        .prepare(
          `SELECT tm.source_id, ta.type AS account_type, ta.name AS account_name, ta.bank_name AS bank_name
           FROM treasury_movements tm
           LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
           WHERE tm.source_kind = 'EXPENSE'
             AND tm.source_id IN (${inClause(chunk)})
             AND COALESCE(tm.reverses_movement_id, '') = ''
           ORDER BY tm.posted_at_iso ASC, tm.id ASC`
        )
        .all(...chunk);
      for (const b of bankRows) {
        const id = String(b.source_id || '').trim();
        const label = bankLabel(b);
        if (!id || !label) continue;
        const prev = bankByExpenseId.get(id);
        if (!prev) bankByExpenseId.set(id, label);
        else if (!prev.split(' + ').includes(label)) bankByExpenseId.set(id, `${prev} + ${label}`);
      }
    }
  }

  const officeByRequestId = new Map();
  if (requestIds.length && tableExists(db, 'office_threads')) {
    const hasFilingTable = tableExists(db, 'office_thread_filing');
    for (const chunk of chunkIds(requestIds)) {
      const officeSql = hasFilingTable
        ? `SELECT ot.id, ot.subject, ot.body, ot.related_payment_request_id, ot.payload_json,
                  f.category_label AS filing_label
           FROM office_threads ot
           LEFT JOIN office_thread_filing f ON f.thread_id = ot.id
           WHERE ot.related_payment_request_id IN (${inClause(chunk)})`
        : `SELECT ot.id, ot.subject, ot.body, ot.related_payment_request_id, ot.payload_json, NULL AS filing_label
           FROM office_threads ot
           WHERE ot.related_payment_request_id IN (${inClause(chunk)})`;
      const officeRows = db.prepare(officeSql).all(...chunk);
      for (const ot of officeRows) {
        const rid = String(ot.related_payment_request_id || '').trim();
        if (!rid) continue;
        const prev = officeByRequestId.get(rid);
        const hasFile = Boolean(filingNoFromSources(ot, null));
        if (!prev || (hasFile && !filingNoFromSources(prev, null))) officeByRequestId.set(rid, ot);
      }
    }
  }

  const workByRequestId = new Map();
  if (requestIds.length && tableExists(db, 'work_items') && hasColumn(db, 'work_items', 'source_kind')) {
    for (const chunk of chunkIds(requestIds)) {
      const wiRows = db
        .prepare(
          `SELECT source_id, reference_no
           FROM work_items
           WHERE source_kind = 'payment_request' AND source_id IN (${inClause(chunk)})`
        )
        .all(...chunk);
      for (const wi of wiRows) {
        const rid = String(wi.source_id || '').trim();
        if (rid && !workByRequestId.has(rid)) workByRequestId.set(rid, wi);
      }
    }
  }

  return rows.map((row) => {
    const expenseId = String(row.expense_id || '').trim();
    const requestId = String(row.request_id || '').trim();
    const office = requestId ? officeByRequestId.get(requestId) : null;
    const workItem = requestId ? workByRequestId.get(requestId) : null;
    const category = String(row.category || '').trim();
    const paidAmount = roundMoney(row.paid_amount_ngn || row.amount_ngn);
    return mapExpenseFilingMemo({
      expenseId,
      requestId,
      requestReference: row.request_reference || row.reference || '',
      filingNo: filingNoFromSources(office, workItem),
      dateISO: dateBasis === 'paid' ? toIsoDate(row.paid_at_iso) || toIsoDate(row.date) : toIsoDate(row.date),
      amountNgn: roundMoney(row.amount_ngn),
      paidAmountNgn: paidAmount,
      approvalStatus: row.approval_status || (row.payment_method && String(row.payment_method) !== 'Pending' ? 'Paid' : ''),
      description: row.description || row.expense_type || '',
      expenseType: row.expense_type,
      lineItems: parseLineItems(row.line_items_json),
      paymentMethod: row.payment_method,
      bankAccount: bankByExpenseId.get(expenseId) || '',
      payeeName: row.payee_name,
      payeeAccountNo: row.payee_account_no,
      payeeBankName: row.payee_bank_name,
      category,
      categoryLane: row.category_lane || getExpenseCategoryLane(category),
      categoryJustification: row.category_justification,
      officeThreadId: office?.id,
      officeSubject: office?.subject,
      officeBody: includeOfficeBody ? office?.body : '',
      approvedBy: row.approved_by,
      paidBy: row.paid_by,
      paidAtISO: row.paid_at_iso,
      attachmentPresent: Boolean(String(row.attachment_name || '').trim()),
    });
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} query
 */
export function buildExpenseMemoFilingPackFromDb(db, query = {}) {
  const period = parseExpenseFilingPeriod({
    month: query.month,
    startDate: query.startDate || query.fromDate || query.from,
    endDate: query.endDate || query.toDate || query.to,
  });
  if (!period.ok) return period;
  const memos = loadExpenseMemoFilingRows(db, {
    startDate: period.startDate,
    endDate: period.endDate,
    branchScope: query.branchScope,
    status: query.status,
    dateBasis: query.dateBasis,
    category: query.category,
    categoryLane: query.categoryLane || query.lane,
    includeUnlinked: query.includeUnlinked !== false && query.includeUnlinked !== '0',
    includeOfficeBody: query.includeOfficeBody === true || query.includeOfficeBody === '1',
  });
  return buildExpenseMemoFilingPack({
    period,
    branchScope: query.branchScope,
    status: query.status,
    dateBasis: query.dateBasis,
    categoryFilter: query.category,
    pageBreakBeforeCategory: query.pageBreakBeforeCategory,
    memos,
  });
}
