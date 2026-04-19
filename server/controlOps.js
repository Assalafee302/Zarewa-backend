import { accessoryFulfillmentSummaryForQuotation } from './accessoryFulfillment.js';
import { actorId, actorName, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  nextApprovalActionHumanId,
  nextAuditLogHumanId,
  nextExpenseHumanId,
  nextPaymentRequestHumanId,
  nextRefundHumanId,
} from './humanId.js';
import { isAllowedExpenseCategory } from '../shared/expenseCategories.js';
import {
  normalizeRefundReasonCategoriesForApi,
  REFUND_PREVIEW_VERSION,
} from '../shared/refundConstants.js';
import {
  actorMayApprovePaymentRequestAmount,
  actorMayApproveRefundAmount,
} from '../shared/workspaceGovernance.js';
import { appendPaymentRequestTimelineToOfficeThreads } from './officePaymentRequestTimeline.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { backdateWarningForActedDate } from './backdateSignals.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value || 'null');
  } catch {
    return null;
  }
}

function quotedMetersFromQuotationLines(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    payload = parseJsonValue(payload);
  }
  const rows = payload?.products;
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, line) => sum + (Number(line?.qty) || 0), 0);
}

function quotedAmountPerMeter(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  const rows = payload?.products;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const productRows = rows.filter((line) => Number(line?.qty) > 0 && Number(line?.unitPrice) > 0);
  const totalMeters = productRows.reduce((sum, line) => sum + (Number(line?.qty) || 0), 0);
  if (totalMeters <= 0) return null;
  const totalValue = productRows.reduce(
    (sum, line) => sum + (Number(line?.qty) || 0) * (Number(line?.unitPrice) || 0),
    0
  );
  return totalValue > 0 ? totalValue / totalMeters : null;
}

function quotationHasCompletedDelivery(db, quotationRef) {
  if (!quotationRef) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS x FROM deliveries
         WHERE quotation_ref = ?
           AND (
             TRIM(COALESCE(delivered_date_iso, '')) != ''
             OR LOWER(TRIM(COALESCE(status, ''))) IN ('delivered', 'completed')
             OR COALESCE(fulfillment_posted, 0) = 1
           )
         LIMIT 1`
      )
      .get(quotationRef);
    return Boolean(row);
  } catch {
    return false;
  }
}

function collectQuotationServices(db, quotationRef, quote) {
  let list = [];
  try {
    const raw = quote?.lines_json;
    const j = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    if (Array.isArray(j?.services)) list = j.services.slice();
  } catch {
    list = [];
  }
  if (list.length === 0 && quotationRef) {
    try {
      const rows = db
        .prepare(
          `SELECT name, qty, unit_price_ngn FROM quotation_lines
           WHERE quotation_id = ? AND category = 'services'
           ORDER BY sort_order`
        )
        .all(quotationRef);
      list = rows.map((r) => ({
        id: `ql-${r.name}-${r.unit_price_ngn}`,
        name: r.name,
        qty: r.qty,
        unitPrice: r.unit_price_ngn,
      }));
    } catch {
      /* quotation_lines may be missing in some contexts */
    }
  }
  return list;
}

function serviceNameLower(line) {
  return String(line?.name ?? line?.description ?? '').trim().toLowerCase();
}

function serviceQtyAndUnitPriceNgn(line) {
  const qty = Number(String(line?.qty ?? line?.quantity ?? '').replace(/,/g, '')) || 0;
  let unit = 0;
  if (line?.unitPrice != null) unit = Number(String(line.unitPrice).replace(/,/g, '')) || 0;
  else if (line?.unit_price != null) unit = Number(String(line.unit_price).replace(/,/g, '')) || 0;
  else if (line?.unit_price_ngn != null) unit = Number(line.unit_price_ngn) || 0;
  let unitPrice = roundMoney(unit);
  let amt = roundMoney(qty * unitPrice);
  if (amt <= 0 && qty > 0) {
    const lump = roundMoney(
      Number(String(line?.value ?? line?.lineTotal ?? line?.line_total_ngn ?? '').replace(/,/g, '')) || 0
    );
    if (lump > 0) unitPrice = roundMoney(lump / qty);
  } else if (amt <= 0) {
    const lump = roundMoney(
      Number(String(line?.value ?? line?.lineTotal ?? line?.line_total_ngn ?? '').replace(/,/g, '')) || 0
    );
    if (lump > 0) return { qty: 1, unitPrice: lump };
  }
  return { qty, unitPrice: roundMoney(unitPrice) };
}

function quotationJsonLineAmountNgn(row) {
  const qty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
  const unit = roundMoney(
    Number(String(row?.unitPrice ?? row?.unit_price ?? row?.unit_price_ngn ?? '').replace(/,/g, '')) || 0
  );
  let amt = roundMoney(qty * unit);
  if (amt <= 0) {
    amt = roundMoney(
      Number(String(row?.value ?? row?.lineTotal ?? row?.line_total_ngn ?? '').replace(/,/g, '')) || 0
    );
  }
  return amt;
}

function sumQuotationLinesJsonFlexible(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      return 0;
    }
  }
  if (!payload || typeof payload !== 'object') return 0;
  let s = 0;
  for (const cat of ['products', 'accessories', 'services']) {
    const arr = payload[cat];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (!String(row?.name ?? '').trim()) continue;
      s += quotationJsonLineAmountNgn(row);
    }
  }
  return roundMoney(s);
}

function quotedProductNamesLower(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      return [];
    }
  }
  const prods = payload?.products;
  if (!Array.isArray(prods)) return [];
  return prods
    .map((p) => String(p?.name ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function normKeyPriceList(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Published list ₦/m for gauge + design (same rules as `pricingOps.floorPricePerMeterForGaugeDesign`; inlined to avoid circular imports). */
function listPricePerMeterFromGaugeDesign(db, gaugeRaw, designRaw, branchId) {
  const g = normKeyPriceList(gaugeRaw);
  const d = normKeyPriceList(designRaw);
  if (!g || !d) return null;
  const bid = branchId && String(branchId).trim() ? String(branchId).trim() : null;
  try {
    const row = db
      .prepare(
        `SELECT unit_price_per_meter_ngn FROM price_list_items
         WHERE gauge_key = ? AND design_key = ? AND (branch_id IS NULL OR branch_id = ? OR ? IS NULL)
         ORDER BY CASE WHEN branch_id IS NOT NULL THEN 0 ELSE 1 END,
                  COALESCE(effective_from_iso, '') DESC,
                  sort_order ASC
         LIMIT 1`
      )
      .get(g, d, bid, bid);
    if (!row) return null;
    return Math.round(Number(row.unit_price_per_meter_ngn) || 0) || null;
  } catch {
    return null;
  }
}

/** Resolve list ₦/m for the FG `products` row (gauge + colour / design). */
function listPricePerMeterForProducedProduct(db, productId, branchId) {
  const pid = String(productId ?? '').trim();
  if (!pid) return null;
  let row;
  try {
    row = db
      .prepare(
        `SELECT gauge, colour, material_type, dashboard_attrs_json FROM products WHERE product_id = ? LIMIT 1`
      )
      .get(pid);
  } catch {
    return null;
  }
  if (!row) return null;
  let extra = {};
  try {
    extra = JSON.parse(row.dashboard_attrs_json || '{}');
  } catch {
    extra = {};
  }
  const gauge = String(row.gauge || extra.gauge || '').trim();
  const design = String(
    row.colour || extra.colour || row.material_type || extra.materialType || extra.profile || ''
  ).trim();
  if (!gauge || !design) return null;
  return listPricePerMeterFromGaugeDesign(db, gauge, design, branchId);
}

/**
 * Produced FG differs from quoted roofing but list ₦/m cannot be resolved — fix gauge/colour + price list.
 * @returns {{ code: string; message: string; jobId?: string; productId?: string }[]}
 */
export function refundSubstitutionDataQualityIssues(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return [];
  let quote;
  try {
    quote = db.prepare(`SELECT lines_json, branch_id FROM quotations WHERE id = ?`).get(ref);
  } catch {
    return [];
  }
  if (!quote) return [];
  let productionJobs = [];
  try {
    productionJobs = db
      .prepare(
        `SELECT job_id, product_id, product_name, actual_meters, status FROM production_jobs
         WHERE quotation_ref = ? AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')`
      )
      .all(ref);
  } catch {
    return [];
  }
  const qNames = quotedProductNamesLower(quote?.lines_json ?? '');
  if (!qNames.length || !productionJobs.length) return [];
  const branchId = quote?.branch_id != null ? String(quote.branch_id).trim() || null : null;
  const issues = [];
  for (const j of productionJobs) {
    const pn = String(j.product_name ?? '').trim().toLowerCase();
    if (!pn) continue;
    const match = qNames.some((qn) => pn.includes(qn) || qn.includes(pn));
    if (match) continue;
    const m = Number(j.actual_meters) || 0;
    if (m <= 0) continue;
    const ppm = listPricePerMeterForProducedProduct(db, j.product_id, branchId);
    if (ppm == null || ppm <= 0) {
      const pid = String(j.product_id ?? '').trim();
      issues.push({
        code: 'substitution_list_price',
        jobId: String(j.job_id ?? '').trim() || undefined,
        productId: pid || undefined,
        message: `Substitution credit needs list ₦/m for produced “${String(j.product_name || j.job_id).trim()}”${pid ? ` (FG ${pid})` : ''}. Add gauge and colour (or design) on the FG product and a matching price list row.`,
      });
    }
  }
  const ppmQuote = quotedAmountPerMeter(quote?.lines_json);
  if ((!ppmQuote || ppmQuote <= 0) && productionJobs.some((j) => (Number(j.actual_meters) || 0) > 0)) {
    issues.push({
      code: 'quoted_blend_rate',
      message:
        'Quotation has no product lines with qty × unit price, so blended ₦/m for substitution/unproduced hints may be missing. Add product lines or rely on manual amounts.',
    });
  }
  return issues;
}

function matchesTransportService(nameLower) {
  if (!nameLower) return false;
  return (
    nameLower.includes('transport') ||
    nameLower.includes('haulage') ||
    nameLower.includes('hauling') ||
    nameLower.includes('delivery') ||
    nameLower.includes('logistic') ||
    nameLower.includes('dispatch') ||
    nameLower.includes('freight') ||
    nameLower.includes('waybill')
  );
}

function matchesInstallationService(nameLower) {
  if (!nameLower) return false;
  return (
    nameLower.includes('install') ||
    nameLower.includes('fitting') ||
    nameLower.includes('erection') ||
    nameLower.includes('mounting')
  );
}

export function periodKeyFromDate(dateISO) {
  const raw = String(dateISO || '').trim();
  const base = raw || nowIso().slice(0, 10);
  const [year, month] = base.split('-');
  return `${year}-${month || '01'}`;
}

export function appendAuditLog(db, payload) {
  const id = nextAuditLogHumanId(db);
  const occurredAtISO = payload.occurredAtISO || nowIso();
  db.prepare(
    `INSERT INTO audit_log (
      id, occurred_at_iso, actor_user_id, actor_name, action, entity_kind, entity_id, status, note, details_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    occurredAtISO,
    actorId(payload.actor),
    actorName(payload.actor),
    payload.action,
    payload.entityKind ?? null,
    payload.entityId ?? null,
    payload.status ?? 'success',
    payload.note ?? '',
    payload.details ? JSON.stringify(payload.details) : null
  );
  return id;
}

export function recordApprovalAction(db, payload) {
  const id = nextApprovalActionHumanId(db);
  const actedAtISO = payload.actedAtISO || nowIso();
  db.prepare(
    `INSERT INTO approval_actions (
      id, entity_kind, entity_id, action, status, note, acted_at_iso, acted_by_user_id, acted_by_name
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    payload.entityKind,
    payload.entityId,
    payload.action,
    payload.status,
    payload.note ?? '',
    actedAtISO,
    actorId(payload.actor),
    actorName(payload.actor)
  );
  return id;
}

export function assertPeriodOpen(db, dateISO, contextLabel = 'Posting date') {
  const periodKey = periodKeyFromDate(dateISO);
  const row = db.prepare(`SELECT * FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
  if (row) {
    const note = row.reason ? ` Reason: ${row.reason}` : '';
    throw new Error(`${contextLabel} falls in locked period ${periodKey}.${note}`);
  }
  return periodKey;
}

export function lockAccountingPeriod(db, payload, actor) {
  const periodKey = periodKeyFromDate(payload.periodKey || payload.dateISO);
  const existing = db.prepare(`SELECT period_key FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
  if (existing) return { ok: false, error: `Period ${periodKey} is already locked.` };
  const lockedAtISO = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO accounting_period_locks (
        period_key, locked_from_iso, locked_at_iso, locked_by_user_id, locked_by_name, reason
      ) VALUES (?,?,?,?,?,?)`
    ).run(
      periodKey,
      `${periodKey}-01`,
      lockedAtISO,
      actorId(actor),
      actorName(actor),
      String(payload.reason ?? '').trim()
    );
    appendAuditLog(db, {
      actor,
      action: 'period.lock',
      entityKind: 'accounting_period',
      entityId: periodKey,
      note: String(payload.reason ?? '').trim() || 'Accounting period locked',
      details: { periodKey },
    });
  })();
  return { ok: true, periodKey };
}

export function unlockAccountingPeriod(db, periodKey, actor, reason = '') {
  const row = db.prepare(`SELECT * FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
  if (!row) return { ok: false, error: 'Period lock not found.' };
  db.transaction(() => {
    db.prepare(`DELETE FROM accounting_period_locks WHERE period_key = ?`).run(periodKey);
    appendAuditLog(db, {
      actor,
      action: 'period.unlock',
      entityKind: 'accounting_period',
      entityId: periodKey,
      note: String(reason || '').trim() || 'Accounting period unlocked',
      details: { previousReason: row.reason ?? '' },
    });
  })();
  return { ok: true };
}


const MAX_PAYREQ_ATTACHMENT_B64_LEN = 4_500_000;

function normalizePaymentRequestLineItems(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.items)) arr = raw.items;
  return arr
    .map((row) => {
      const item = String(row?.item ?? row?.description ?? '').trim();
      const unit = Number.parseFloat(String(row?.unit ?? row?.qty ?? '').replace(/,/g, ''));
      const unitPriceNgn = roundMoney(row?.unitPriceNgn ?? row?.unit_price_ngn ?? 0);
      let lineTotalNgn = roundMoney(row?.lineTotalNgn ?? row?.line_total_ngn ?? 0);
      const u = Number.isFinite(unit) ? unit : 0;
      if (!lineTotalNgn && u > 0 && unitPriceNgn >= 0) {
        lineTotalNgn = roundMoney(u * unitPriceNgn);
      }
      return { item, unit: u, unitPriceNgn, lineTotalNgn };
    })
    .filter((r) => r.item && r.unit > 0 && r.lineTotalNgn > 0);
}

function parsePaymentRequestAttachment(payload) {
  const att = payload?.attachment;
  if (!att || typeof att !== 'object') {
    return { name: '', mime: '', b64: '' };
  }
  const name = String(att.name ?? '').trim().slice(0, 240);
  const mime = String(att.mime ?? att.mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
    .slice(0, 120);
  const b64 = String(att.dataBase64 ?? '').replace(/\s/g, '');
  return { name, mime, b64 };
}


export function insertPaymentRequest(db, payload, actor) {
  const providedRequestId = String(payload.requestID ?? '').trim();
  const requestDate = String(payload.requestDate ?? '').trim() || nowIso().slice(0, 10);
  const description = String(payload.description ?? '').trim() || '—';
  const requestReference = String(payload.requestReference ?? payload.reference ?? '').trim();
  const branchId = String(payload.workspaceBranchId ?? '').trim() || DEFAULT_BRANCH_ID;

  const lineItems = normalizePaymentRequestLineItems(payload.lineItems ?? payload.items);
  const expenseCategory = String(payload.expenseCategory ?? payload.category ?? '').trim();
  const { name: attName, mime: attMime, b64: attB64Raw } = parsePaymentRequestAttachment(payload);
  let attB64 = attB64Raw;
  if (attB64) {
    const allowed = attMime.startsWith('image/') || attMime === 'application/pdf';
    if (!allowed) {
      return { ok: false, error: 'Attachment must be a PDF or image file.' };
    }
    if (attB64.length > MAX_PAYREQ_ATTACHMENT_B64_LEN) {
      return { ok: false, error: 'Attachment is too large (max about 2.5 MB).' };
    }
  } else {
    attB64 = '';
  }

  const lineItemsJson = lineItems.length ? JSON.stringify(lineItems) : '';

  let legacyExpenseID = String(payload.expenseID ?? '').trim();
  let amountRequestedNgn = roundMoney(payload.amountRequestedNgn);

  if (lineItems.length > 0) {
    if (!expenseCategory) {
      return { ok: false, error: 'Expense category is required.' };
    }
    if (!isAllowedExpenseCategory(expenseCategory)) {
      return { ok: false, error: 'Expense category must be chosen from the standard list.' };
    }
    amountRequestedNgn = lineItems.reduce((s, x) => s + x.lineTotalNgn, 0);
    if (amountRequestedNgn <= 0) {
      return { ok: false, error: 'Line items must total a positive amount.' };
    }
  } else {
    if (!legacyExpenseID) {
      return {
        ok: false,
        error:
          'Add at least one line with description, quantity, and unit price (or link an existing posted expense and amount).',
      };
    }
    if (amountRequestedNgn <= 0) {
      return { ok: false, error: 'Amount requested must be positive.' };
    }
    const expense = db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(legacyExpenseID);
    if (!expense) return { ok: false, error: 'Linked expense was not found.' };
  }

  const maxAttempts = providedRequestId ? 1 : 3;
  let lastErr = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const requestID =
      providedRequestId ||
      (i === 0
        ? nextPaymentRequestHumanId(db, branchId)
        : `${nextPaymentRequestHumanId(db, branchId)}-${Math.random().toString(36).slice(2, 7)}`);
    try {
      assertPeriodOpen(db, requestDate, 'Payment request date');
      db.transaction(() => {
        let expenseIdForRow = legacyExpenseID;
        if (lineItems.length > 0) {
          let newExpId = nextExpenseHumanId(db, branchId);
          for (let k = 0; k < 8 && db.prepare(`SELECT 1 FROM expenses WHERE expense_id = ?`).get(newExpId); k += 1) {
            newExpId = nextExpenseHumanId(db, branchId);
          }
          db.prepare(
            `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
             VALUES (?,?,?,?,?,?,?,?)`
          ).run(
            newExpId,
            'Payment request (pending payout)',
            amountRequestedNgn,
            requestDate,
            expenseCategory,
            'Pending',
            requestReference || requestID,
            branchId
          );
          expenseIdForRow = newExpId;
        }
        db.prepare(
          `INSERT INTO payment_requests (
            request_id, expense_id, amount_requested_ngn, request_date, approval_status, description,
            approved_by, approved_at_iso, approval_note,
            request_reference, line_items_json, attachment_name, attachment_mime, attachment_data_b64
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          requestID,
          expenseIdForRow,
          amountRequestedNgn,
          requestDate,
          'Pending',
          description,
          '',
          '',
          '',
          requestReference || '',
          lineItemsJson || null,
          attName || '',
          attMime || '',
          attB64 || ''
        );
        appendAuditLog(db, {
          actor,
          action: 'payment_request.create',
          entityKind: 'payment_request',
          entityId: requestID,
          note: `Payment request ${requestID} submitted`,
          details: {
            expenseID: expenseIdForRow,
            amountRequestedNgn,
            lineItemCount: lineItems.length,
            hasAttachment: Boolean(attB64),
          },
        });
      })();
      return { ok: true, requestID };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (providedRequestId || !msg.includes('UNIQUE constraint failed: payment_requests.request_id')) {
        return { ok: false, error: msg };
      }
    }
  }
  return { ok: false, error: String(lastErr?.message || lastErr || 'Could not create payment request.') };
}

export function decidePaymentRequest(db, requestID, payload, actor) {
  const row = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(requestID);
  if (!row) return { ok: false, error: 'Payment request not found.' };
  if (!['Pending', 'Submitted', 'Awaiting approval', ''].includes(String(row.approval_status || 'Pending'))) {
    return { ok: false, error: 'Only pending requests can be reviewed.' };
  }
  const status = String(payload.status ?? '').trim();
  if (!['Approved', 'Rejected'].includes(status)) {
    return { ok: false, error: 'Decision status must be Approved or Rejected.' };
  }
  const expenseRow = row.expense_id
    ? db.prepare(`SELECT category FROM expenses WHERE expense_id = ?`).get(row.expense_id)
    : null;
  const expenseCategory = String(expenseRow?.category ?? '');
  const amountRequestedNgn = roundMoney(row.amount_requested_ngn ?? 0);
  const govLimits = getOrgGovernanceLimits(db);
  if (
    status === 'Approved' &&
    !actorMayApprovePaymentRequestAmount(
      actor,
      (p) => userHasPermission(actor, p),
      amountRequestedNgn,
      expenseCategory,
      govLimits
    )
  ) {
    const hi = govLimits.expenseExecutiveThresholdNgn;
    return {
      ok: false,
      error: `Non-refund expenses above ₦${hi.toLocaleString('en-NG')} require MD/CEO-level approval (branch manager may approve at or below this threshold).`,
    };
  }
  const note = String(payload.note ?? '').trim();
  const actedAtISO = String(payload.actedAtISO ?? '').trim() || nowIso().slice(0, 10);
  const warnings = [];
  const bd = backdateWarningForActedDate(actedAtISO, 'Approval date');
  if (bd) warnings.push(bd);
  try {
    assertPeriodOpen(db, actedAtISO, 'Approval date');
    db.transaction(() => {
      db.prepare(
        `UPDATE payment_requests
         SET approval_status = ?, approved_by = ?, approved_at_iso = ?, approval_note = ?
         WHERE request_id = ?`
      ).run(status, actorName(actor), actedAtISO, note, requestID);
      recordApprovalAction(db, {
        actor,
        entityKind: 'payment_request',
        entityId: requestID,
        action: 'review',
        status: status.toLowerCase(),
        note,
        actedAtISO,
      });
      appendAuditLog(db, {
        actor,
        action: 'payment_request.review',
        entityKind: 'payment_request',
        entityId: requestID,
        note: note || `Payment request ${status.toLowerCase()}`,
        details: { status },
      });
    })();
    const actorLabel = actorName(actor);
    const notePart = note ? ` Note: ${note}` : '';
    appendPaymentRequestTimelineToOfficeThreads(
      db,
      requestID,
      status === 'Approved'
        ? `Accounts: payment request ${requestID} was approved by ${actorLabel}.${notePart}`
        : `Accounts: payment request ${requestID} was rejected by ${actorLabel}.${notePart}`
    );
    return { ok: true, warnings };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function insertRefundRequest(db, payload, actor, branchId = DEFAULT_BRANCH_ID) {
  const customerID = String(payload.customerID ?? '').trim();
  const amountNgn = roundMoney(payload.amountNgn);
  if (!customerID) return { ok: false, error: 'Customer is required.' };
  if (amountNgn <= 0) return { ok: false, error: 'Refund amount must be positive.' };
  const refundID =
    String(payload.refundID ?? '').trim() ||
    nextRefundHumanId(db, String(branchId || DEFAULT_BRANCH_ID).trim());
  const requestedAtISO = String(payload.requestedAtISO ?? '').trim() || nowIso();
  try {
    assertPeriodOpen(db, requestedAtISO, 'Refund request date');
    const quotationRef = String(payload.quotationRef ?? '').trim();
    const product = String(payload.product ?? '').trim() || '—';
    const requestedCats = normalizeRefundReasonCategoriesForApi(payload.reasonCategory);
    if (requestedCats.length === 0) {
      return { ok: false, error: 'Select at least one refund reason category.' };
    }

    if (quotationRef) {
      const existingRefunds = db.prepare(
        `SELECT reason_category FROM customer_refunds
         WHERE quotation_ref = ? AND status IN ('Pending', 'Approved')`
      ).all(quotationRef);

      for (const row of existingRefunds) {
        try {
          const cats = JSON.parse(row.reason_category || '[]');
          const alreadyRefunded = Array.isArray(cats) ? cats : [row.reason_category];
          const intersection = requestedCats.filter(c => alreadyRefunded.includes(c));
          if (intersection.length > 0) {
            return { ok: false, error: `A refund request for category "${intersection[0]}" already exists for this quotation.` };
          }
        } catch {
          if (requestedCats.includes(row.reason_category)) {
            return { ok: false, error: `A refund request for category "${row.reason_category}" already exists for this quotation.` };
          }
        }
      }

      if (requestedCats.includes('Order cancellation') && quotationHasCompletedDelivery(db, quotationRef)) {
        return {
          ok: false,
          error: 'Order cancellation is not allowed after material has been delivered for this quotation.',
        };
      }

      const elig = quotationMeetsRefundEligibility(db, quotationRef);
      if (!elig.ok) return elig;
      if (amountNgn > elig.remainingNgn) {
        return {
          ok: false,
          error: `Refund amount (₦${amountNgn.toLocaleString('en-NG')}) exceeds remaining refundable balance (₦${elig.remainingNgn.toLocaleString('en-NG')}).`,
        };
      }
    }

    let quotationCustomerName = '';
    if (quotationRef) {
      const qRow = db.prepare(`SELECT customer_name FROM quotations WHERE id = ?`).get(quotationRef);
      quotationCustomerName = String(qRow?.customer_name ?? '').trim();
    }

    const reasonCategory = JSON.stringify(requestedCats);

    let previewSnapshotJson = null;
    if (payload.previewSnapshot != null && typeof payload.previewSnapshot === 'object') {
      try {
        const snap = {
          ...payload.previewSnapshot,
          engineVersion: REFUND_PREVIEW_VERSION,
        };
        previewSnapshotJson = JSON.stringify(snap).slice(0, 120_000);
      } catch {
        previewSnapshotJson = null;
      }
    }

    db.transaction(() => {
      db.prepare(
        `INSERT INTO customer_refunds (
          refund_id, customer_id, customer_name, quotation_ref, cutting_list_ref, product, reason_category, reason,
          amount_ngn, calculation_lines_json, suggested_lines_json, preview_snapshot_json, calculation_notes, status, requested_by, requested_by_user_id, requested_at_iso,
          approval_date, approved_by, approved_amount_ngn, manager_comments, paid_amount_ngn, paid_at_iso, paid_by, payment_note, branch_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        refundID,
        customerID,
        String(payload.customer ?? payload.customerName ?? quotationCustomerName ?? '').trim(),
        quotationRef,
        String(payload.cuttingListRef ?? '').trim(),
        product,
        reasonCategory,
        String(payload.reason ?? '').trim(),
        amountNgn,
        JSON.stringify(payload.calculationLines || []),
        JSON.stringify(payload.suggestedLines || payload.calculationLines || []),
        previewSnapshotJson,
        String(payload.calculationNotes ?? '').trim(),
        'Pending',
        actorName(actor),
        actorId(actor),
        requestedAtISO,
        '',
        '',
        0,
        '',
        0,
        '',
        '',
        '',
        String(branchId || DEFAULT_BRANCH_ID).trim()
      );
      appendAuditLog(db, {
        actor,
        action: 'refund.create',
        entityKind: 'refund',
        entityId: refundID,
        note: `Refund request ${refundID} submitted`,
        details: { amountNgn, customerID },
      });
    })();
    return { ok: true, refundID };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function decideRefundRequest(db, refundID, payload, actor) {
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundID);
  if (!row) return { ok: false, error: 'Refund request not found.' };
  if (String(row.status || 'Pending') !== 'Pending') {
    return { ok: false, error: 'Only pending refunds can be reviewed.' };
  }
  if (row.requested_by_user_id === actorId(actor)) {
    // Allow the requester to approve their own refund when they are an approver (manager/finance).
    const canSelfApprove =
      userHasPermission(actor, 'refunds.approve') || userHasPermission(actor, 'finance.approve');
    if (!canSelfApprove) {
      return {
        ok: false,
        error: 'Self-approval is prohibited unless you have refunds.approve or finance.approve permissions.',
      };
    }
  }
  const status = String(payload.status ?? '').trim();
  if (!['Approved', 'Rejected'].includes(status)) {
    return { ok: false, error: 'Decision status must be Approved or Rejected.' };
  }
  const actedAtISO = String(payload.approvalDate ?? '').trim() || nowIso().slice(0, 10);
  const comment = String(payload.managerComments ?? payload.note ?? '').trim();
  const approvedAmountNgn =
    status === 'Approved'
      ? roundMoney(payload.approvedAmountNgn ?? row.amount_ngn)
      : 0;
  if (status === 'Approved' && approvedAmountNgn <= 0) {
    return { ok: false, error: 'Approved refund amount must be positive.' };
  }
  const requestedAmountNgn = roundMoney(row.amount_ngn);
  if (status === 'Approved' && approvedAmountNgn > requestedAmountNgn) {
    return {
      ok: false,
      error: `Approved amount (₦${approvedAmountNgn.toLocaleString('en-NG')}) cannot exceed the requested amount (₦${requestedAmountNgn.toLocaleString('en-NG')}).`,
    };
  }
  const govLimitsR = getOrgGovernanceLimits(db);
  if (
    status === 'Approved' &&
    !actorMayApproveRefundAmount(actor, (p) => userHasPermission(actor, p), approvedAmountNgn, govLimitsR)
  ) {
    const hi = govLimitsR.refundExecutiveThresholdNgn;
    return {
      ok: false,
      error: `Refunds above ₦${hi.toLocaleString('en-NG')} require MD/CEO-level approval (or administrator).`,
    };
  }
  const refundWarnings = [];
  const bdR = backdateWarningForActedDate(actedAtISO, 'Refund approval date');
  if (bdR) refundWarnings.push(bdR);
  const qref = String(row.quotation_ref ?? '').trim();
  if (status === 'Approved' && qref) {
    const qRow = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(qref);
    const paidNgn = roundMoney(qRow?.paid_ngn ?? 0);
    const sumRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM customer_refunds
         WHERE quotation_ref = ? AND TRIM(COALESCE(LOWER(status), '')) != 'rejected' AND refund_id != ?`
      )
      .get(qref, refundID);
    const sumOthersNgn = roundMoney(sumRow?.s ?? 0);
    const maxApprovableNgn = roundMoney(paidNgn - sumOthersNgn);
    if (approvedAmountNgn > maxApprovableNgn) {
      return {
        ok: false,
        error: `Approved amount exceeds quotation refundable headroom (max ₦${maxApprovableNgn.toLocaleString('en-NG')} for this request given other open refunds on the same quotation).`,
      };
    }
  }
  try {
    assertPeriodOpen(db, actedAtISO, 'Refund approval date');
    db.transaction(() => {
      const calcLinesRaw = payload.calculationLines;
      let calculationLinesJson = null;
      if (status === 'Approved' && Array.isArray(calcLinesRaw) && calcLinesRaw.length > 0) {
        const normalized = calcLinesRaw
          .map((line) => ({
            label: String(line?.label ?? '').trim(),
            amountNgn: roundMoney(line?.amountNgn),
          }))
          .filter((line) => line.label && line.amountNgn > 0);
        if (normalized.length) calculationLinesJson = JSON.stringify(normalized);
      }
      const calcNotes =
        status === 'Approved' && payload.calculationNotes !== undefined && payload.calculationNotes !== null
          ? String(payload.calculationNotes).trim()
          : null;
      const suggestedRaw = payload.suggestedLines;
      let suggestedLinesJson = null;
      if (status === 'Approved' && Array.isArray(suggestedRaw) && suggestedRaw.length > 0) {
        const normalized = suggestedRaw
          .map((line) => ({
            label: String(line?.label ?? '').trim(),
            amountNgn: roundMoney(line?.amountNgn),
          }))
          .filter((line) => line.label && line.amountNgn > 0);
        if (normalized.length) suggestedLinesJson = JSON.stringify(normalized);
      }
      if (calculationLinesJson != null || calcNotes != null || suggestedLinesJson != null) {
        db.prepare(
          `UPDATE customer_refunds
           SET status = ?, approval_date = ?, approved_by = ?, approved_amount_ngn = ?, manager_comments = ?,
               calculation_lines_json = COALESCE(?, calculation_lines_json),
               calculation_notes = COALESCE(?, calculation_notes),
               suggested_lines_json = COALESCE(?, suggested_lines_json)
           WHERE refund_id = ?`
        ).run(
          status,
          actedAtISO,
          actorName(actor),
          approvedAmountNgn,
          comment,
          calculationLinesJson,
          calcNotes,
          suggestedLinesJson,
          refundID
        );
      } else {
        db.prepare(
          `UPDATE customer_refunds
           SET status = ?, approval_date = ?, approved_by = ?, approved_amount_ngn = ?, manager_comments = ?
           WHERE refund_id = ?`
        ).run(status, actedAtISO, actorName(actor), approvedAmountNgn, comment, refundID);
      }
      recordApprovalAction(db, {
        actor,
        entityKind: 'refund',
        entityId: refundID,
        action: 'review',
        status: status.toLowerCase(),
        note: comment,
        actedAtISO,
      });
      appendAuditLog(db, {
        actor,
        action: 'refund.review',
        entityKind: 'refund',
        entityId: refundID,
        note: comment || `Refund ${status.toLowerCase()}`,
        details: { status, approvedAmountNgn },
      });
    })();
    return { ok: true, warnings: refundWarnings };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function previewRefundRequest(db, payload) {
  const quotationRef = String(payload.quotationRef ?? '').trim();
  const quote = quotationRef
    ? db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quotationRef)
    : null;

  const customerID = String(payload.customerID ?? quote?.customer_id ?? '').trim();
  if (!customerID && !quotationRef) return { ok: false, error: 'Customer or Quotation is required.' };

  const receipts = quotationRef
    ? db
        .prepare(
          `SELECT * FROM sales_receipts WHERE quotation_ref = ?
           AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`
        )
        .all(quotationRef)
    : [];

  const overpayRow =
    quotationRef &&
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries
         WHERE type = 'OVERPAY_ADVANCE' AND quotation_ref = ?`
      )
      .get(quotationRef);
  const overpayAdvanceNgn = roundMoney(overpayRow?.s ?? 0);

  const productionJobs = quotationRef
    ? db
        .prepare(`SELECT * FROM production_jobs WHERE quotation_ref = ? AND status IN ('Completed', 'Cancelled')`)
        .all(quotationRef)
    : [];

  const existingRefunds = quotationRef
    ? db.prepare(`SELECT * FROM customer_refunds WHERE quotation_ref = ? AND status != 'Rejected'`).all(quotationRef)
    : [];

  const refundedCategories = new Set();
  existingRefunds.forEach(r => {
    try {
      const cats = JSON.parse(r.reason_category || '[]');
      if (Array.isArray(cats)) cats.forEach(c => refundedCategories.add(c));
      else refundedCategories.add(r.reason_category);
    } catch {
      refundedCategories.add(r.reason_category);
    }
  });

  const paidOnQuoteNgn = receipts.reduce((sum, row) => sum + roundMoney(row.amount_ngn), 0);
  const quotationCashInNgn = roundMoney(paidOnQuoteNgn + overpayAdvanceNgn);
  const quoteTotalNgn = roundMoney(quote?.total_ngn);

  // Quoted vs Actual Produced (optional payload overrides for tools/tests)
  const quotedMetersFromQuote = quotedMetersFromQuotationLines(quote?.lines_json ?? '');
  const actualMetersFromJobs = productionJobs.reduce((sum, j) => sum + (Number(j.actual_meters) || 0), 0);
  const quotedMetersOverride = positiveNumber(payload.quotedMeters);
  const actualMetersOverride = positiveNumber(payload.actualMeters);
  const quotedMeters =
    quotedMetersOverride != null ? Math.max(0, roundMoney(quotedMetersOverride)) : quotedMetersFromQuote;
  const actualMeters =
    actualMetersOverride != null ? Math.max(0, roundMoney(actualMetersOverride)) : actualMetersFromJobs;

  const derivedPricePerMeter = quotedAmountPerMeter(quote?.lines_json);
  const pricePerMeter = positiveNumber(payload.pricePerMeterNgn) || derivedPricePerMeter;

  const suggestedLines = [];
  const warnings = [];
  const materialDelivered = quotationRef ? quotationHasCompletedDelivery(db, quotationRef) : false;
  const blockedRefundCategories = [];
  if (materialDelivered) {
    blockedRefundCategories.push('Order cancellation');
    warnings.push(
      'Material has been marked delivered for this quotation; order cancellation refunds are not allowed.'
    );
  }

  const requestedPpm = positiveNumber(payload.pricePerMeterNgn);
  if (derivedPricePerMeter && requestedPpm && derivedPricePerMeter > 0) {
    const diffPct = (Math.abs(requestedPpm - derivedPricePerMeter) / derivedPricePerMeter) * 100;
    if (diffPct > 5) {
      warnings.push(
        `Provided price/meter deviates by more than 5% from quotation-implied rate (≈₦${Math.round(derivedPricePerMeter).toLocaleString('en-NG')}).`
      );
    }
  }

  // 1. Overpayment Auto-detection (RECEIPT total + OVERPAY_ADVANCE from split-till posting)
  if (
    !refundedCategories.has('Overpayment') &&
    quotationCashInNgn > quoteTotalNgn &&
    quoteTotalNgn > 0
  ) {
    suggestedLines.push({
      label: `Overpayment on ${quotationRef || 'quotation'}`,
      amountNgn: quotationCashInNgn - quoteTotalNgn,
      category: 'Overpayment'
    });
  }

  // 2. Unproduced / Substituted Meterage (blocked after customer delivery is recorded)
  if (quotedMeters > 0 && pricePerMeter) {
    const unproducedPotential = Math.max(0, quotedMeters - actualMeters);
    if (
      unproducedPotential > 0 &&
      !refundedCategories.has('Order cancellation') &&
      !materialDelivered
    ) {
      suggestedLines.push({
        label: `Unproduced metres (${unproducedPotential.toFixed(2)}m @ ₦${Math.round(pricePerMeter).toLocaleString()})`,
        amountNgn: Math.round(unproducedPotential * pricePerMeter),
        category: 'Order cancellation',
      });
    }
  }

  // 3. Service refunds — transport / installation (JSON lines_json + quotation_lines fallback; broad name matching)
  const quoteLines = collectQuotationServices(db, quotationRef, quote);
  for (const s of quoteLines) {
    const nl = serviceNameLower(s);
    const { qty, unitPrice } = serviceQtyAndUnitPriceNgn(s);
    const amt = roundMoney(qty * unitPrice);
    if (amt <= 0) continue;

    const isTransport = matchesTransportService(nl);
    const isInstall = matchesInstallationService(nl);

    if (isTransport && isInstall) {
      const needTransport = !refundedCategories.has('Transport issue');
      const needInstall = !refundedCategories.has('Installation issue');
      const appliesToCategories = [];
      if (needTransport) appliesToCategories.push('Transport issue');
      if (needInstall) appliesToCategories.push('Installation issue');
      if (appliesToCategories.length > 0) {
        suggestedLines.push({
          label: `Transport & installation service: ${String(s?.name ?? 'Service').trim() || 'Service'}`,
          amountNgn: amt,
          category: 'Transport issue',
          appliesToCategories,
        });
        warnings.push(
          'This quotation bundles transport and installation on one line; adjust amounts or add manual lines if refunding only part of the bundle.'
        );
      }
      continue;
    }
    if (isTransport && !refundedCategories.has('Transport issue')) {
      suggestedLines.push({
        label: `Unclaimed transport: ${String(s?.name ?? 'Service').trim() || 'Service'}`,
        amountNgn: amt,
        category: 'Transport issue',
      });
    }
    if (isInstall && !refundedCategories.has('Installation issue')) {
      suggestedLines.push({
        label: `Unclaimed installation: ${String(s?.name ?? 'Service').trim() || 'Service'}`,
        amountNgn: amt,
        category: 'Installation issue',
      });
    }
  }

  if (quotationRef && !refundedCategories.has('Accessory shortfall')) {
    const accSummary = accessoryFulfillmentSummaryForQuotation(db, quotationRef);
    for (const a of accSummary) {
      const sf = Math.max(0, Number(a.shortfall) || 0);
      if (sf <= 0) continue;
      const up = Math.round(Number(a.unitPriceNgn) || 0);
      const amountNgn = roundMoney(sf * up);
      if (amountNgn <= 0) continue;
      suggestedLines.push({
        label: `Accessory shortfall: ${a.name} (${sf} × ₦${up.toLocaleString('en-NG')})`,
        amountNgn,
        category: 'Accessory shortfall',
      });
    }
  }

  if (quote && quotationRef && !refundedCategories.has('Calculation error')) {
    const lineSum = sumQuotationLinesJsonFlexible(quote.lines_json);
    if (lineSum > 0) {
      const diff = roundMoney(quoteTotalNgn - lineSum);
      if (Math.abs(diff) >= 1) {
        suggestedLines.push({
          label: `Quotation total vs line-item sum (${diff > 0 ? 'header higher' : 'lines higher'} by ₦${Math.abs(diff).toLocaleString('en-NG')})`,
          amountNgn: Math.abs(diff),
          category: 'Calculation error',
        });
      }
    }
  }

  /** Substitution: credit = max(0, quoted ₦/m − produced list ₦/m) × produced metres (per completed job whose FG name ≠ quoted product names). */
  const substitutionPerMeterBreakdown = [];
  if (quotationRef && !refundedCategories.has('Substitution Difference')) {
    const qNames = quotedProductNamesLower(quote?.lines_json);
    if (qNames.length && productionJobs.length) {
      const branchId = quote?.branch_id != null ? String(quote.branch_id).trim() || null : null;
      const overrideSubPpm = positiveNumber(payload.substitutePricePerMeterNgn);
      let totalCredit = 0;
      let anyMismatch = false;
      const missingListPriceLabels = [];
      let noPositiveDelta = false;

      for (const j of productionJobs) {
        const pn = String(j.product_name ?? '').trim().toLowerCase();
        if (!pn) continue;
        const match = qNames.some((qn) => pn.includes(qn) || qn.includes(pn));
        if (match) continue;
        anyMismatch = true;
        const m = Number(j.actual_meters) || 0;
        const jobLabel = String(j.product_name || j.job_id || 'Production job').trim();

        if (!pricePerMeter) {
          continue;
        }
        if (m <= 0) continue;

        const producedPpm = overrideSubPpm ?? listPricePerMeterForProducedProduct(db, j.product_id, branchId);
        if (producedPpm == null || producedPpm <= 0) {
          missingListPriceLabels.push(jobLabel);
          continue;
        }

        const deltaPpm = pricePerMeter - producedPpm;
        if (deltaPpm <= 0) {
          noPositiveDelta = true;
          continue;
        }

        const credit = roundMoney(deltaPpm * m);
        totalCredit += credit;
        substitutionPerMeterBreakdown.push({
          jobId: j.job_id,
          productName: String(j.product_name || '').trim(),
          meters: m,
          quotedPricePerMeterNgn: Math.round(pricePerMeter),
          producedListPricePerMeterNgn: producedPpm,
          deltaPerMeterNgn: Math.round(deltaPpm),
          creditNgn: credit,
        });
      }

      if (anyMismatch) {
        const fmtN = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;
        let label;
        if (substitutionPerMeterBreakdown.length > 0) {
          const parts = substitutionPerMeterBreakdown.map(
            (b) => `${b.meters.toFixed(2)}m × ${fmtN(b.deltaPerMeterNgn)}/m (${String(b.productName || 'FG').trim()})`
          );
          label = `Substitution credit (quoted ${fmtN(pricePerMeter)}/m minus produced list rate × metres): ${parts.join('; ')}`;
        } else if (!pricePerMeter) {
          label =
            'Produced FG may differ from quoted roofing lines — add product lines with qty and unitPrice to derive quoted ₦/m, or enter credit manually';
        } else {
          label =
            'Produced FG may differ from quoted roofing lines — no automatic credit (set substitutePricePerMeterNgn, add price list + gauge/colour on FG product, or enter amount manually)';
        }
        suggestedLines.push({
          label,
          amountNgn: totalCredit,
          category: 'Substitution Difference',
        });
        if (!pricePerMeter) {
          warnings.push(
            'Substitution: cannot compute per-metre delta without a quotation blended ₦/m (product lines with qty and unitPrice), or pass pricePerMeterNgn in preview.'
          );
        } else if (missingListPriceLabels.length > 0 && !overrideSubPpm) {
          const uniq = [...new Set(missingListPriceLabels)];
          warnings.push(
            `Substitution: could not resolve list ₦/m for ${uniq.join(', ')}. Add gauge/colour on the FG product and a matching price list row, or pass substitutePricePerMeterNgn when calling preview.`
          );
        }
        if (noPositiveDelta && substitutionPerMeterBreakdown.length === 0 && pricePerMeter && !missingListPriceLabels.length) {
          warnings.push(
            'Substitution: produced list rate is not below the quotation blended ₦/m — per-metre delta credit is zero.'
          );
        }
      }
    }
  }

  if (existingRefunds.length > 0) {
    const totalExisting = existingRefunds.reduce((sum, r) => sum + r.amount_ngn, 0);
    warnings.push(`There are ${existingRefunds.length} existing refund(s) for this quotation totaling ₦${totalExisting.toLocaleString()}.`);
  }

  const manualAdj = roundMoney(payload.manualAdjustmentNgn);
  if (manualAdj > 0) {
    suggestedLines.push({
      label: 'Manual adjustment',
      amountNgn: manualAdj,
      category: 'Adjustment',
    });
  }

  const suggestedAmountNgn = suggestedLines.reduce((sum, line) => sum + roundMoney(line.amountNgn), 0);
  let remainingRefundableNgn = null;
  if (quotationRef) {
    const el = quotationMeetsRefundEligibility(db, quotationRef);
    if (el.ok) remainingRefundableNgn = el.remainingNgn;
  }
  return {
    ok: true,
    preview: {
      customerID,
      customerName: quote?.customer_name ?? '',
      quotationRef,
      quoteTotalNgn,
      paidOnQuoteNgn,
      overpayAdvanceNgn,
      quotationCashInNgn,
      remainingRefundableNgn,
      quotedMeters,
      actualMeters,
      pricePerMeterNgn: pricePerMeter ? Math.round(pricePerMeter) : null,
      substitutePricePerMeterNgn: positiveNumber(payload.substitutePricePerMeterNgn),
      substitutionPerMeterBreakdown,
      suggestedAmountNgn,
      suggestedLines,
      warnings,
      alreadyRefundedCategories: Array.from(refundedCategories),
      blockedRefundCategories,
    },
  };
}

function parseRefundReasonCategoryList(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* stored as plain text */
  }
  const s = String(raw).trim();
  return s ? [s] : [];
}

function refundReasonCategoriesIncludeOrderCancellation(reasonCategoryField) {
  return parseRefundReasonCategoryList(reasonCategoryField).some(
    (c) => String(c).trim().toLowerCase() === 'order cancellation'
  );
}

/**
 * Any non-rejected refund whose categories include “Order cancellation”.
 * Production must not proceed while this is on file (prevents produce-after-cancel).
 */
export function quotationHasNonRejectedOrderCancellationRefund(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return false;
  const rows = db
    .prepare(
      `SELECT reason_category FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) != 'rejected'`
    )
    .all(ref);
  return rows.some((r) => refundReasonCategoriesIncludeOrderCancellation(r.reason_category));
}

/** True when any production row for the quote is not in a terminal state (Completed / Cancelled). */
function quotationHasOpenProductionJob(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return null;
  return db
    .prepare(
      `SELECT job_id,
              CASE WHEN TRIM(COALESCE(status, '')) = '' THEN 'Planned' ELSE TRIM(status) END AS st
       FROM production_jobs
       WHERE quotation_ref = ?
         AND LOWER(
           CASE WHEN TRIM(COALESCE(status, '')) = '' THEN 'planned' ELSE TRIM(LOWER(status)) END
         ) NOT IN ('completed', 'cancelled')
       LIMIT 1`
    )
    .get(ref);
}

/**
 * Single-quotation checks aligned with {@link getEligibleRefundQuotations} listing rules, plus
 * remaining headroom: paid_ngn minus non-rejected refund totals.
 */
export function quotationMeetsRefundEligibility(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return { ok: false, error: 'Quotation reference is required.' };
  const q = db.prepare(`SELECT id, paid_ngn, status FROM quotations WHERE id = ?`).get(ref);
  if (!q) return { ok: false, error: 'Quotation not found.' };
  const paidNgn = roundMoney(q.paid_ngn);
  if (paidNgn <= 0) {
    return { ok: false, error: 'This quotation has no recorded payment toward a refund.' };
  }
  const sumRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM customer_refunds
       WHERE quotation_ref = ? AND status != 'Rejected'`
    )
    .get(ref);
  const totalRefundedNgn = roundMoney(sumRow?.s ?? 0);
  const remainingNgn = roundMoney(paidNgn - totalRefundedNgn);
  if (remainingNgn <= 0) {
    return {
      ok: false,
      error: 'Refundable balance on this quotation is fully covered by existing refund requests.',
    };
  }
  const isVoid = String(q.status || '').trim().toLowerCase() === 'void';
  const openJob = quotationHasOpenProductionJob(db, ref);
  if (openJob) {
    return {
      ok: false,
      error: `Finish or cancel production job ${openJob.job_id} (${openJob.st}) before requesting a refund.`,
    };
  }
  const hadClosedProduction = db
    .prepare(
      `SELECT 1 FROM production_jobs
       WHERE quotation_ref = ? AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')
       LIMIT 1`
    )
    .get(ref);
  if (!hadClosedProduction && !isVoid) {
    return {
      ok: false,
      error:
        'Refund requests are only allowed after production is completed or cancelled, or for a paid void quotation.',
    };
  }
  return { ok: true, paidNgn, totalRefundedNgn, remainingNgn };
}

/**
 * Returns quotations with money at risk (paid in), room left to refund, and production closed out:
 * at least one job in `Completed` or `Cancelled`, or a paid `Void` quotation (sales-side cancellation).
 * Logic mirrors {@link quotationMeetsRefundEligibility} per row.
 */
export function getEligibleRefundQuotations(db) {
  const sql = `
    SELECT q.*,
      COALESCE((
        SELECT SUM(amount_ngn) FROM customer_refunds
        WHERE quotation_ref = q.id AND status != 'Rejected'
      ), 0) AS total_refunded
    FROM quotations q
    WHERE q.paid_ngn > 0
      AND COALESCE((
        SELECT SUM(amount_ngn) FROM customer_refunds
        WHERE quotation_ref = q.id AND status != 'Rejected'
      ), 0) < q.paid_ngn
      AND NOT EXISTS (
        SELECT 1 FROM production_jobs j2
        WHERE j2.quotation_ref = q.id
          AND LOWER(
            CASE WHEN TRIM(COALESCE(j2.status, '')) = '' THEN 'planned' ELSE TRIM(LOWER(j2.status)) END
          ) NOT IN ('completed', 'cancelled')
      )
      AND (
        EXISTS (
          SELECT 1 FROM production_jobs j
          WHERE j.quotation_ref = q.id
            AND LOWER(TRIM(COALESCE(j.status, ''))) IN ('completed', 'cancelled')
        )
        OR TRIM(COALESCE(q.status, '')) = 'Void'
      )
    ORDER BY q.date_iso DESC
  `;
  return db.prepare(sql).all();
}

function positiveNumber(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

export function upsertTreasuryAccount(db, payload, actor) {
  const name = String(payload.name ?? '').trim();
  if (!name) return { ok: false, error: 'Account name is required.' };
  const balance = roundMoney(payload.balance);
  let savedId = null;
  try {
    db.transaction(() => {
      if (payload.id) {
        db.prepare(
          `UPDATE treasury_accounts
           SET name = ?, bank_name = ?, balance = ?, type = ?, acc_no = ?
           WHERE id = ?`
        ).run(
          name,
          String(payload.bankName ?? '').trim(),
          balance,
          String(payload.type ?? 'Bank').trim() || 'Bank',
          String(payload.accNo ?? '').trim() || 'N/A',
          Number(payload.id)
        );
      } else {
        db.prepare(
          `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no)
           VALUES (?,?,?,?,?)`
        ).run(
          name,
          String(payload.bankName ?? '').trim(),
          balance,
          String(payload.type ?? 'Bank').trim() || 'Bank',
          String(payload.accNo ?? '').trim() || 'N/A'
        );
      }
      const row = payload.id
        ? db.prepare(`SELECT * FROM treasury_accounts WHERE id = ?`).get(Number(payload.id))
        : db.prepare(`SELECT * FROM treasury_accounts ORDER BY id DESC LIMIT 1`).get();
      savedId = row?.id ?? null;
      appendAuditLog(db, {
        actor,
        action: payload.id ? 'treasury_account.update' : 'treasury_account.create',
        entityKind: 'treasury_account',
        entityId: String(row?.id ?? payload.id ?? ''),
        note: `${name} saved in treasury controls`,
        details: { balance },
      });
    })();
    return { ok: true, id: savedId };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function reviewQuotation(db, quoteId, payload, actor) {
  const row = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quoteId);
  if (!row) return { ok: false, error: 'Quotation not found.' };

  const decision = String(payload.decision ?? '').trim(); // 'clear', 'flag', 'approve_production'
  const note = String(payload.note ?? '').trim();
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      if (decision === 'clear') {
        db.prepare(
          `UPDATE quotations 
           SET manager_cleared_at_iso = ?, manager_flagged_at_iso = NULL, manager_flag_reason = NULL 
           WHERE id = ?`
        ).run(now, quoteId);
      } else if (decision === 'flag') {
        db.prepare(
          `UPDATE quotations 
           SET manager_flagged_at_iso = ?, manager_flag_reason = ?, manager_cleared_at_iso = NULL 
           WHERE id = ?`
        ).run(now, note, quoteId);
      } else if (decision === 'approve_production') {
        db.prepare(
          `UPDATE quotations 
           SET manager_production_approved_at_iso = ? 
           WHERE id = ?`
        ).run(now, quoteId);
      } else {
        throw new Error('Invalid manager decision.');
      }

      appendAuditLog(db, {
        actor,
        action: `quotation.${decision}`,
        entityKind: 'quotation',
        entityId: quoteId,
        note: `Manager ${decision} action on ${quoteId}`,
        details: { note, decision },
      });
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

