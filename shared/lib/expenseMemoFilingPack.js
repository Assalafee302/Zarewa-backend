/**
 * Monthly expense-memo filing pack — compact stacked print, grouped by category.
 *
 * One memo per page wastes paper (letterhead + whitespace). Month-end filing
 * prints a cover index plus dense blocks, several memos per A4 sheet, with
 * page breaks only between categories so each folder tab can start clean.
 */

import { displayDocNumber, displayTxnDateShort } from './reportDisplayFormat.js';
import { getExpenseCategoryLane, getExpenseCategoryLaneMeta } from '../expenseCategoryLanes.js';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** ~5 compact memo blocks fit on A4 at 10pt with a category header. */
export const FILING_MEMOS_PER_A4 = 5;
/** Helvetica 10pt usable width on A4 with 12mm margins. */
export const FILING_PRINT_LINE_WIDTH = 86;
export const FILING_PDF_LINES_PER_PAGE = 50;

const PAID_STATUSES = new Set(['paid']);
const APPROVED_STATUSES = new Set(['paid', 'approved']);

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function lastDayOfMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate();
}

/**
 * @param {{ month?: string; startDate?: string; endDate?: string; now?: Date }} opts
 * @returns {{ ok: true; monthKey: string; startDate: string; endDate: string; label: string } | { ok: false; error: string; code: string }}
 */
export function parseExpenseFilingPeriod(opts = {}) {
  const monthRaw = String(opts.month || '').trim();
  const startRaw = toIsoDate(opts.startDate);
  const endRaw = toIsoDate(opts.endDate);
  if (monthRaw) {
    const m = /^(\d{4})-(\d{2})$/.exec(monthRaw);
    if (!m) {
      return { ok: false, error: 'month must be YYYY-MM.', code: 'VALIDATION_ERROR' };
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (!Number.isFinite(year) || month < 1 || month > 12) {
      return { ok: false, error: 'month must be YYYY-MM.', code: 'VALIDATION_ERROR' };
    }
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
    return {
      ok: true,
      monthKey: `${year}-${String(month).padStart(2, '0')}`,
      startDate,
      endDate,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
    };
  }
  if (startRaw || endRaw) {
    const startDate = startRaw || endRaw;
    const endDate = endRaw || startRaw;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return { ok: false, error: 'startDate and endDate must be YYYY-MM-DD.', code: 'VALIDATION_ERROR' };
    }
    if (startDate > endDate) {
      return { ok: false, error: 'startDate must be on or before endDate.', code: 'VALIDATION_ERROR' };
    }
    const monthKey = startDate.slice(0, 7);
    const month = Number(monthKey.slice(5, 7));
    const year = Number(monthKey.slice(0, 4));
    const sameMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
    const label = sameMonth
      ? `${MONTH_NAMES[month - 1] || monthKey} ${year}`
      : `${startDate} to ${endDate}`;
    return { ok: true, monthKey, startDate, endDate, label };
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return parseExpenseFilingPeriod({ month: `${year}-${String(month).padStart(2, '0')}` });
}

/**
 * @param {string} raw
 * @returns {'paid'|'approved'|'all'}
 */
export function normalizeFilingStatus(raw) {
  const s = String(raw || 'paid').trim().toLowerCase();
  if (s === 'all' || s === '*') return 'all';
  if (s === 'approved' || s === 'approve') return 'approved';
  return 'paid';
}

/**
 * @param {string} raw
 * @returns {'paid'|'expense'}
 */
export function normalizeFilingDateBasis(raw) {
  const s = String(raw || 'paid').trim().toLowerCase();
  if (s === 'expense' || s === 'recognised' || s === 'recognized' || s === 'date') return 'expense';
  return 'paid';
}

export function formatFilingNgn(n) {
  return `NGN ${roundMoney(n).toLocaleString('en-NG')}`;
}

/**
 * @param {unknown} lineItems
 * @returns {string}
 */
export function compactLineItemsSummary(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return '';
  const parts = [];
  for (const item of lineItems) {
    const desc = String(item?.description ?? item?.name ?? item?.item ?? '').trim();
    const qty = Number(item?.quantity ?? item?.qty);
    const unit = roundMoney(item?.unitPriceNgn ?? item?.unit_price_ngn ?? item?.unitPrice);
    const lineTotal = roundMoney(
      item?.lineTotalNgn ?? item?.amountNgn ?? item?.amount_ngn ?? (Number.isFinite(qty) && qty > 0 ? qty * unit : 0)
    );
    if (!desc && lineTotal <= 0) continue;
    const qtyBit = Number.isFinite(qty) && qty > 0 && qty !== 1 ? ` x${qty}` : '';
    const amtBit = lineTotal > 0 ? ` ${formatFilingNgn(lineTotal)}` : '';
    parts.push(`${desc || 'Line'}${qtyBit}${amtBit}`.trim());
    if (parts.length >= 4) break;
  }
  if (lineItems.length > 4) parts.push(`+${lineItems.length - 4} more`);
  return parts.join('; ');
}

function dash(value) {
  const s = String(value ?? '').trim();
  return s || '—';
}

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trim()}…`;
}

/**
 * @param {object} row
 * @returns {object}
 */
export function mapExpenseFilingMemo(row = {}) {
  const expenseId = String(row.expenseId ?? row.expenseID ?? row.expense_id ?? '').trim();
  const requestId = String(row.requestId ?? row.requestID ?? row.request_id ?? '').trim();
  const category = String(row.category ?? row.expenseCategory ?? '').trim() || '—';
  const lane = String(row.categoryLane ?? row.expenseCategoryLane ?? '').trim() || getExpenseCategoryLane(category);
  const laneMeta = getExpenseCategoryLaneMeta(lane);
  const amountNgn = roundMoney(row.amountNgn ?? row.amount_ngn ?? row.paidAmountNgn);
  const paidAmountNgn = roundMoney(row.paidAmountNgn ?? row.paid_amount_ngn ?? amountNgn);
  const description =
    String(row.description ?? '').trim() ||
    String(row.expenseType ?? row.expense_type ?? '').trim() ||
    category;
  const lineItems = Array.isArray(row.lineItems) ? row.lineItems : [];
  const bankAccount = String(row.bankAccount ?? '').trim() || '—';
  const filingNo = String(row.filingNo ?? '').trim();
  const dateISO = toIsoDate(row.dateISO ?? row.date ?? row.paidAtISO);
  const approvalStatus = String(row.approvalStatus ?? '').trim() || '—';
  const printLines = buildMemoPrintLines({
    expenseId,
    requestId,
    dateISO,
    amountNgn: paidAmountNgn || amountNgn,
    approvalStatus,
    bankAccount,
    description,
    lineItems,
    payeeName: row.payeeName,
    requestReference: row.requestReference,
    filingNo,
    officeSubject: row.officeSubject,
    approvedBy: row.approvedBy,
    paidBy: row.paidBy,
    paidAtISO: row.paidAtISO,
    paymentMethod: row.paymentMethod,
    categoryJustification: row.categoryJustification,
  });
  return {
    expenseId,
    expenseIdDisplay: displayDocNumber(expenseId) || expenseId || '—',
    requestId,
    requestIdDisplay: displayDocNumber(requestId) || requestId || '—',
    requestReference: String(row.requestReference ?? '').trim(),
    filingNo,
    dateISO,
    amountNgn,
    paidAmountNgn: paidAmountNgn || amountNgn,
    approvalStatus,
    description: clip(description, 240),
    lineItems,
    lineItemsSummary: compactLineItemsSummary(lineItems),
    paymentMethod: String(row.paymentMethod ?? row.payment_method ?? '').trim(),
    bankAccount,
    payeeName: String(row.payeeName ?? '').trim(),
    payeeAccountNo: String(row.payeeAccountNo ?? '').trim(),
    payeeBankName: String(row.payeeBankName ?? '').trim(),
    category,
    categoryLane: lane,
    categoryLaneLabel: laneMeta.label,
    categoryJustification: String(row.categoryJustification ?? '').trim(),
    officeThreadId: String(row.officeThreadId ?? '').trim(),
    officeSubject: clip(row.officeSubject, 160),
    officeBody: clip(row.officeBody, 400),
    approvedBy: String(row.approvedBy ?? '').trim(),
    paidBy: String(row.paidBy ?? '').trim(),
    paidAtISO: String(row.paidAtISO ?? '').trim(),
    attachmentPresent: Boolean(row.attachmentPresent),
    source: requestId ? 'payment_request' : 'direct_expense',
    printLines,
  };
}

function buildMemoPrintLines(input) {
  const amount = formatFilingNgn(input.amountNgn);
  const date = displayTxnDateShort(input.dateISO);
  const ids = [input.expenseId, input.requestId].filter(Boolean).join('  ');
  const head = `${dash(ids)}   ${date}   ${amount}   ${dash(input.approvalStatus)}   ${dash(input.bankAccount)}`;
  const desc = clip(input.description, 160);
  const linesSummary = compactLineItemsSummary(input.lineItems);
  const refs = [
    input.payeeName ? `Payee: ${input.payeeName}` : '',
    input.requestReference ? `Ref: ${input.requestReference}` : '',
    input.filingNo ? `File: ${input.filingNo}` : '',
    input.paymentMethod && input.paymentMethod !== '—' ? input.paymentMethod : '',
  ]
    .filter(Boolean)
    .join('  |  ');
  const audit = [
    input.approvedBy ? `Approved ${input.approvedBy}` : '',
    input.paidBy ? `Paid ${input.paidBy}` : '',
    input.paidAtISO ? displayTxnDateShort(input.paidAtISO) : '',
  ]
    .filter(Boolean)
    .join('  |  ');
  const extra = [];
  if (input.officeSubject && input.officeSubject !== desc) extra.push(clip(input.officeSubject, 140));
  if (input.categoryJustification) extra.push(`Why: ${clip(input.categoryJustification, 140)}`);
  return [head, desc, linesSummary, refs, audit, ...extra].map((s) => String(s || '').trim()).filter(Boolean);
}

/**
 * @param {object[]} memos
 * @returns {object[]}
 */
export function groupExpenseMemosByCategory(memos = []) {
  const byCategory = new Map();
  for (const raw of memos || []) {
    const memo = raw?.printLines ? raw : mapExpenseFilingMemo(raw);
    const key = memo.category || '—';
    if (!byCategory.has(key)) {
      byCategory.set(key, {
        category: key,
        categoryLane: memo.categoryLane,
        categoryLaneLabel: memo.categoryLaneLabel,
        memos: [],
        subtotalNgn: 0,
        rowCount: 0,
      });
    }
    const group = byCategory.get(key);
    group.memos.push(memo);
    group.subtotalNgn += roundMoney(memo.paidAmountNgn || memo.amountNgn);
    group.rowCount += 1;
  }
  const groups = [...byCategory.values()];
  for (const group of groups) {
    group.memos.sort(
      (a, b) =>
        String(a.dateISO || '').localeCompare(String(b.dateISO || '')) ||
        String(a.expenseId || '').localeCompare(String(b.expenseId || ''))
    );
    group.subtotalNgn = roundMoney(group.subtotalNgn);
    group.printTitle = `${group.category}  ·  ${group.rowCount} memo${group.rowCount === 1 ? '' : 's'}  ·  ${formatFilingNgn(group.subtotalNgn)}`;
  }
  groups.sort((a, b) => {
    const laneA = getExpenseCategoryLaneMeta(a.categoryLane).sortOrder;
    const laneB = getExpenseCategoryLaneMeta(b.categoryLane).sortOrder;
    if (laneA !== laneB) return laneA - laneB;
    return String(a.category).localeCompare(String(b.category));
  });
  return groups;
}

export function estimateFilingPackPages(memoCount, categoryCount, pageBreakBeforeCategory = true) {
  const memos = Math.max(0, Number(memoCount) || 0);
  const cats = Math.max(0, Number(categoryCount) || 0);
  const cover = 1;
  if (memos === 0) return cover;
  if (!pageBreakBeforeCategory) {
    return cover + Math.ceil(memos / FILING_MEMOS_PER_A4);
  }
  const body = Math.max(cats, Math.ceil(memos / FILING_MEMOS_PER_A4));
  return cover + body;
}

function boolFlag(value, fallback) {
  if (value == null || value === '') return fallback;
  const s = String(value).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no') return false;
  if (s === '1' || s === 'true' || s === 'yes') return true;
  return fallback;
}

/**
 * @param {{ period: object; branchScope?: string; memos?: object[]; categoryFilter?: string; status?: string; dateBasis?: string; pageBreakBeforeCategory?: boolean }} input
 */
export function buildExpenseMemoFilingPack(input = {}) {
  const period = input.period;
  const memos = (input.memos || []).map((row) => (row?.printLines ? row : mapExpenseFilingMemo(row)));
  const groups = groupExpenseMemosByCategory(memos);
  const count = memos.length;
  const amountNgn = roundMoney(memos.reduce((s, m) => s + roundMoney(m.paidAmountNgn || m.amountNgn), 0));
  const categoryCount = groups.length;
  const filteredCategory = String(input.categoryFilter || '').trim();
  const pageBreakBeforeCategory = boolFlag(input.pageBreakBeforeCategory, !filteredCategory);
  const estimatedPagesA4 = estimateFilingPackPages(count, categoryCount, pageBreakBeforeCategory);
  const vsSinglePageMemos = Math.max(0, count - estimatedPagesA4);
  const monthKey = period?.monthKey || '';
  const filingFolder = filteredCategory
    ? `Accounts / Expenses / ${monthKey || 'YYYY-MM'} / ${filteredCategory}`
    : `Accounts / Expenses / ${monthKey || 'YYYY-MM'} / <category>`;
  return {
    ok: true,
    title: `Expense filing pack — ${period?.label || monthKey}`.trim(),
    period: {
      startDate: period?.startDate || '',
      endDate: period?.endDate || '',
      monthKey,
      label: period?.label || monthKey,
    },
    branchScope: String(input.branchScope || 'ALL').trim() || 'ALL',
    status: normalizeFilingStatus(input.status),
    dateBasis: normalizeFilingDateBasis(input.dateBasis),
    totals: { count, amountNgn, categoryCount },
    index: groups.map((g) => ({
      category: g.category,
      categoryLane: g.categoryLane,
      categoryLaneLabel: g.categoryLaneLabel,
      rowCount: g.rowCount,
      subtotalNgn: g.subtotalNgn,
    })),
    groups,
    printHints: {
      paper: 'A4',
      orientation: 'portrait',
      density: 'compact',
      coverSheet: true,
      pageBreakBeforeMemo: false,
      pageBreakBeforeCategory,
      avoidPageBreakInsideMemo: true,
      estimatedPagesA4,
      pagesSavedVsOneMemoPerPage: vsSinglePageMemos,
      filingInstruction: `Print this pack once at month-end. File under ${filingFolder}. Do not print each memo on its own page.`,
    },
  };
}

export function wrapFilingPrintLine(text, width = FILING_PRINT_LINE_WIDTH) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  if (s.length <= width) return [s];
  const out = [];
  let rest = s;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < Math.floor(width * 0.5)) cut = width;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function pushWrapped(lines, text) {
  for (const part of wrapFilingPrintLine(text)) lines.push(part);
}

function flushPdfPage(pages, lines) {
  if (!lines.length) return;
  pages.push({ lines: lines.slice() });
  lines.length = 0;
}

function ensurePdfRoom(pages, lines, needed) {
  if (lines.length + needed > FILING_PDF_LINES_PER_PAGE) flushPdfPage(pages, lines);
}

/**
 * Compact printable pages for archive PDF. Never starts a new page per memo.
 * @param {ReturnType<typeof buildExpenseMemoFilingPack>} pack
 * @returns {{ lines: string[] }[]}
 */
export function filingPackToPdfPages(pack) {
  const pages = [];
  const cover = [];
  const periodLabel = pack?.period?.label || pack?.period?.monthKey || '';
  const branch = pack?.branchScope && pack.branchScope !== 'ALL' ? pack.branchScope : 'All branches';
  pushWrapped(cover, 'ZAREWA ALUMINIUM AND PLASTICS LTD');
  cover.push('');
  pushWrapped(cover, 'MONTHLY EXPENSE FILING PACK');
  pushWrapped(cover, `${periodLabel}  |  ${branch}`);
  pushWrapped(
    cover,
    `Status: ${pack?.status || 'paid'}  |  Date basis: ${pack?.dateBasis === 'expense' ? 'expense date' : 'payout date'}`
  );
  cover.push('');
  pushWrapped(cover, 'Stacked register — several memos per page. Do not print one memo per sheet.');
  const saved = Number(pack?.printHints?.pagesSavedVsOneMemoPerPage) || 0;
  const est = Number(pack?.printHints?.estimatedPagesA4) || 0;
  if (pack?.totals?.count) {
    pushWrapped(
      cover,
      `About ${est} page(s) vs ${pack.totals.count} if each memo were printed alone (saves ~${saved} sheet(s)).`
    );
  }
  cover.push('');
  pushWrapped(cover, 'INDEX');
  const index = pack?.index || [];
  if (!index.length) {
    cover.push('(No paid expenses in this period.)');
  } else {
    for (const row of index) {
      const name = String(row.category || '—').slice(0, 28).padEnd(28, ' ');
      pushWrapped(
        cover,
        `${name}  ${String(row.rowCount).padStart(4, ' ')}   ${formatFilingNgn(row.subtotalNgn)}`
      );
    }
    cover.push('----------------------------------------');
    pushWrapped(
      cover,
      `TOTAL${''.padEnd(23, ' ')}  ${String(pack.totals.count).padStart(4, ' ')}   ${formatFilingNgn(pack.totals.amountNgn)}`
    );
  }
  cover.push('');
  pushWrapped(cover, 'File: Accounts / Expenses / ' + (pack?.period?.monthKey || 'YYYY-MM') + ' / <category>.');
  pushWrapped(cover, 'Keep original attachments digitally; this pack is the month paper register.');
  pages.push({ lines: cover });

  const bodyLines = [];
  const groups = pack?.groups || [];
  const breakBeforeCategory = pack?.printHints?.pageBreakBeforeCategory !== false && groups.length > 1;
  for (const group of groups) {
    if (breakBeforeCategory && bodyLines.length) flushPdfPage(pages, bodyLines);
    ensurePdfRoom(pages, bodyLines, 4);
    bodyLines.push('========================================');
    pushWrapped(bodyLines, group.printTitle || group.category);
    pushWrapped(bodyLines, group.categoryLaneLabel || '');
    bodyLines.push('========================================');
    for (const memo of group.memos || []) {
      const block = memo.printLines || [];
      ensurePdfRoom(pages, bodyLines, block.length + 1);
      for (const line of block) pushWrapped(bodyLines, line);
      bodyLines.push('----------------------------------------');
    }
  }
  flushPdfPage(pages, bodyLines);
  return pages.length ? pages : [{ lines: ['(empty document)'] }];
}

/**
 * @param {ReturnType<typeof buildExpenseMemoFilingPack>} pack
 * @returns {string}
 */
export function filingPackToCsv(pack) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = [
    'category',
    'lane',
    'date',
    'expenseId',
    'requestId',
    'filingNo',
    'amountNgn',
    'status',
    'payee',
    'bankAccount',
    'description',
  ];
  const rows = [header.join(',')];
  for (const group of pack?.groups || []) {
    for (const memo of group.memos || []) {
      rows.push(
        [
          group.category,
          group.categoryLane,
          memo.dateISO,
          memo.expenseId,
          memo.requestId,
          memo.filingNo,
          memo.paidAmountNgn || memo.amountNgn,
          memo.approvalStatus,
          memo.payeeName,
          memo.bankAccount,
          memo.description,
        ]
          .map(esc)
          .join(',')
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

export function filingPackFilename(pack, ext = 'json') {
  const month = String(pack?.period?.monthKey || 'period').replace(/[^\d-]/g, '');
  const branch = String(pack?.branchScope || 'ALL')
    .trim()
    .replace(/[^\w-]+/g, '-')
    .slice(0, 24) || 'ALL';
  const cat = String(pack?.groups?.length === 1 ? pack.groups[0].category : '')
    .trim()
    .replace(/[^\w]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);
  const bits = ['expense-filing', branch, month, cat].filter(Boolean);
  return `${bits.join('-').replace(/-+$/g, '')}.${ext}`;
}

export function memoMatchesFilingStatus(status, approvalStatus, paymentMethod) {
  const gate = normalizeFilingStatus(status);
  if (gate === 'all') return true;
  const st = String(approvalStatus || '').trim().toLowerCase();
  if (st) {
    if (gate === 'paid') return PAID_STATUSES.has(st);
    return APPROVED_STATUSES.has(st);
  }
  const method = String(paymentMethod || '').trim().toLowerCase();
  if (gate === 'paid') return method && method !== 'pending';
  return true;
}
