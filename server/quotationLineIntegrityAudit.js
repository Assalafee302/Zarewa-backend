/**
 * Scan quotations for line-integrity issues (empty product names, stone flatsheet without length).
 */
import { validateQuotationLineIntegrity } from '../shared/lib/stoneCoatedQuotationPolicy.js';
import { listQuotationIds } from './readModel.js';

function parseLinesJson(raw) {
  try {
    const j = JSON.parse(String(raw || '{}'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 */
export function auditSingleQuotationLineIntegrity(db, quotationId) {
  const id = String(quotationId || '').trim();
  if (!id) return { ok: false, error: 'quotationId required' };
  const row = db
    .prepare(`SELECT id, customer_name, date_iso, total_ngn, paid_ngn, status, lines_json FROM quotations WHERE id = ?`)
    .get(id);
  if (!row) return { ok: false, error: 'Quotation not found' };
  const linesJson = parseLinesJson(row.lines_json);
  if (!linesJson) {
    return {
      ok: true,
      quotationId: id,
      customerName: row.customer_name,
      invalid: true,
      issues: [{ code: 'PARSE_ERROR', message: 'Could not parse lines_json' }],
    };
  }
  const check = validateQuotationLineIntegrity(linesJson);
  if (check.ok) {
    return {
      ok: true,
      quotationId: id,
      customerName: row.customer_name,
      dateIso: row.date_iso,
      totalNgn: Math.round(Number(row.total_ngn) || 0),
      paidNgn: Math.round(Number(row.paid_ngn) || 0),
      status: row.status,
      invalid: false,
      issues: [],
    };
  }
  return {
    ok: true,
    quotationId: id,
    customerName: row.customer_name,
    dateIso: row.date_iso,
    totalNgn: Math.round(Number(row.total_ngn) || 0),
    paidNgn: Math.round(Number(row.paid_ngn) || 0),
    status: row.status,
    invalid: true,
    issues: [
      {
        code: check.code || 'QUOTATION_LINE_INTEGRITY',
        message: check.error,
        details: check.details || {},
      },
    ],
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {{ limit?: number, onlyInvalid?: boolean }} [opts]
 */
export function auditQuotationLineIntegrity(db, branchScope = 'ALL', opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 5000);
  const ids = listQuotationIds(db, branchScope);
  const scanned = [];
  const invalidRows = [];
  let scannedCount = 0;

  for (const id of ids) {
    if (scannedCount >= limit) break;
    scannedCount += 1;
    const row = auditSingleQuotationLineIntegrity(db, id);
    if (!row.ok) continue;
    if (row.invalid) {
      invalidRows.push(row);
      if (!opts.onlyInvalid) scanned.push(row);
    } else if (!opts.onlyInvalid) {
      scanned.push(row);
    }
  }

  return {
    ok: true,
    branchScope,
    quotationCount: ids.length,
    scannedCount,
    invalidCount: invalidRows.length,
    truncated: ids.length > limit,
    rows: opts.onlyInvalid !== false ? invalidRows : scanned.filter((r) => r.invalid),
  };
}
