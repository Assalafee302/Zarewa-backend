import crypto from 'node:crypto';
import { appendAuditLog } from './controlOps.js';
import {
  floorNgnForServiceLine,
  lineParticipatesInSheetFloorGate,
  normKey as policyNormKey,
  pricingPolicyNumbersForServiceLine,
} from './pricingPolicyResolve.js';
import { canReadPriceListItems } from './pricingResolve.js';
import {
  listPriceListItemsAsOf,
  floorPricePerMeterForGaugeDesignAsOf,
} from './pricingAsOf.js';

export {
  quotationPricingAsAtIso,
  quotationPricingLockAsAtIso,
  quotationFirstPaymentDateIso,
  listPriceListItemsAsOf,
  normalizePricingAsAtIso,
} from './pricingAsOf.js';
import { canReadMaterialPricingSheetRows, resolveStainSourceMaterialTypeId } from './materialWorkbookQuotationPrice.js';
import { isMeterSheetProductLine } from '../shared/lib/materialWorkbookQuotationPrice.js';
import { isStainMaterialTypeId } from '../shared/lib/stainMaterialPolicy.js';

export { lineParticipatesInSheetFloorGate } from './pricingPolicyResolve.js';
import { quotationTrimWorkbookFloorViolations } from '../shared/lib/materialWorkbookTrimPrice.js';
import { isQuotationTrimProductLine } from '../shared/lib/cuttingListBlankConsumption.js';
import {
  listMaterialPricingRowsForSnapshot,
  materialKeyFromMaterialTypeId,
} from './materialWorkbookQuotationPrice.js';
import { listMaterialPricingRowsAsOf } from './pricingAsOf.js';
import { getPricingPolicyBundle } from './pricingPolicyOps.js';
import { actorName, normalizeRoleKey, userHasPermission } from './auth.js';
import { quotationBelowFloorExceptionApproved } from '../shared/lib/quotationPriceException.js';
import {
  describeQuoteLineFloor,
  pickQuoteLineFloor,
} from '../shared/lib/quoteFloorPolicy.js';
import { resolveQuoteFloorFreeze } from './sales/quoteFloorResolve.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { createHrNotification } from './hrNotifications.js';
import { upsertWorkItemBySource, workRegistryTablesReady } from './workItems.js';

function normKey(s) {
  return policyNormKey(s);
}

/** @param {string | null | undefined} s */
export function validatePriceListEffectiveIso(s) {
  const t = String(s ?? '').trim();
  if (!t) return { ok: true, iso: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return { ok: false, error: 'Effective date must be YYYY-MM-DD.' };
  }
  const d = new Date(`${t}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: 'Effective date is not a valid calendar date.' };
  }
  const back = d.toISOString().slice(0, 10);
  if (back !== t) {
    return { ok: false, error: 'Effective date is not a valid calendar date.' };
  }
  return { ok: true, iso: t };
}

/**
 * Default effective date for new/changed rows when omitted (local calendar day).
 * Avoids UTC midnight shifting the business date for WAT/etc.
 */
export function defaultPriceListEffectiveFromIso(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   gaugeKey: string,
 *   designKey: string,
 *   branchId: string | null,
 *   effectiveFromIso: string | null,
 *   materialTypeKey: string,
 *   colourKey: string,
 *   profileKey: string,
 * }} keys
 * @param {string | null} excludeId
 */
export function findDuplicatePriceListItem(db, keys, excludeId) {
  if (!canReadPriceListItems(db)) {
    return null;
  }
  const ex = excludeId && String(excludeId).trim() ? String(excludeId).trim() : null;
  const b = keys.branchId != null && String(keys.branchId).trim() ? String(keys.branchId).trim() : '';
  const e = keys.effectiveFromIso != null && String(keys.effectiveFromIso).trim() ? String(keys.effectiveFromIso).trim() : '';
  const mt = keys.materialTypeKey || '';
  const ck = keys.colourKey || '';
  const pk = keys.profileKey || '';
  const sql = ex
    ? `SELECT id FROM price_list_items
       WHERE gauge_key = ? AND design_key = ?
         AND IFNULL(branch_id, '') = ?
         AND IFNULL(effective_from_iso, '') = ?
         AND IFNULL(material_type_key, '') = ?
         AND IFNULL(colour_key, '') = ?
         AND IFNULL(profile_key, '') = ?
         AND id != ?
       LIMIT 1`
    : `SELECT id FROM price_list_items
       WHERE gauge_key = ? AND design_key = ?
         AND IFNULL(branch_id, '') = ?
         AND IFNULL(effective_from_iso, '') = ?
         AND IFNULL(material_type_key, '') = ?
         AND IFNULL(colour_key, '') = ?
         AND IFNULL(profile_key, '') = ?
       LIMIT 1`;
  const args = [keys.gaugeKey, keys.designKey, b, e, mt, ck, pk];
  if (ex) args.push(ex);
  return db.prepare(sql).get(...args) || null;
}

/**
 * UTF-8 CSV (no BOM here — API may prepend FEFF).
 * @param {ReturnType<typeof listPriceListItems>} items
 */
export function priceListItemsToCsv(items) {
  const headers = [
    'id',
    'gauge_key',
    'design_key',
    'unit_price_per_meter_ngn',
    'sort_order',
    'branch_id',
    'effective_from_iso',
    'material_type_key',
    'colour_key',
    'profile_key',
    'notes',
    'updated_at_iso',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    headers.join(','),
    ...items.map((it) =>
      [
        it.id,
        it.gaugeKey,
        it.designKey,
        it.unitPricePerMeterNgn,
        it.sortOrder,
        it.branchId ?? '',
        it.effectiveFromIso ?? '',
        it.materialTypeKey ?? '',
        it.colourKey ?? '',
        it.profileKey ?? '',
        it.notes ?? '',
        it.updatedAtIso ?? '',
      ]
        .map(esc)
        .join(',')
    ),
  ];
  return lines.join('\n');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} gaugeKey
 * @param {string} designKey
 * @param {string | null} branchId
 * @returns {number | null}
 */
export function floorPricePerMeterForGaugeDesign(db, gaugeKey, designKey, branchId, asAtIso) {
  return floorPricePerMeterForGaugeDesignAsOf(db, gaugeKey, designKey, branchId, asAtIso);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id?: string; lines_json?: string | null; branch_id?: string | null }} quoteRow
 */
function quotationHasPricingFloorData(db) {
  let wb = 0;
  if (canReadMaterialPricingSheetRows(db)) {
    wb =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM material_pricing_sheet_rows WHERE COALESCE(minimum_price_per_m_ngn, 0) > 0`
          )
          .get()?.c
      ) || 0;
  }
  const pl = canReadPriceListItems(db)
    ? Number(db.prepare(`SELECT COUNT(*) AS c FROM price_list_items`).get()?.c) || 0
    : 0;
  return wb > 0 || pl > 0;
}

/**
 * Attach floor-gate fields the sales desk prints on a quotation payload.
 * @param {object | null | undefined} quotation
 * @param {{ violations?: object[]; hasFloorRows?: boolean; floorPolicy?: object | null }} pv
 */
export function withQuotationPricingFields(quotation, pv) {
  if (!quotation) return quotation;
  return {
    ...quotation,
    pricingViolations: pv?.violations ?? [],
    pricingHasFloorRows: Boolean(pv?.hasFloorRows),
    pricingFloor: pv?.floorPolicy ?? null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   id?: string;
 *   lines_json?: string | null;
 *   branch_id?: string | null;
 *   date_iso?: string | null;
 *   paid_ngn?: number | null;
 * }} quoteRow
 * @param {{ pricingMode?: 'current' | 'quotation_date' | 'payment_lock' }} [opts]
 *   Default (`payment_lock`): paid → floors as of **first payment**; unpaid dated quotes →
 *   floors as of **quotation date** (never live — a later publish must not mass-flag MD).
 *   Brand-new drafts without a date use live floors.
 *   `quotation_date` — force quotation date. `current` — always live.
 */
export function quotationPriceViolations(db, quoteRow, opts = {}) {
  const violations = [];
  const freeze = resolveQuoteFloorFreeze(db, quoteRow, opts);
  const floorPolicy = quoteRow?.id
    ? {
        freezeEvent: freeze.freezeEvent,
        freezeDateIso: freeze.freezeDateIso,
        pricingAsAtIso: freeze.asAtIso || null,
        freezeWhy: freeze.why,
      }
    : null;
  if (!quoteRow?.id) return { violations, hasFloorRows: false, floorPolicy };
  if (!quotationHasPricingFloorData(db)) return { violations, hasFloorRows: false, floorPolicy };
  let parsed;
  try {
    parsed = JSON.parse(String(quoteRow.lines_json || '{}'));
  } catch {
    return { violations, hasFloorRows: true, floorPolicy };
  }
  const headerGauge = String(parsed?.materialGauge ?? '').trim();
  const headerColour = String(parsed?.materialColor ?? '').trim();
  const headerDesign = String(parsed?.materialDesign ?? '').trim();
  const headerMaterialTypeId = String(parsed?.materialTypeId ?? '').trim();
  const stainSourceMaterialTypeId = isStainMaterialTypeId(headerMaterialTypeId)
    ? resolveStainSourceMaterialTypeId(db, parsed)
    : '';
  const products = Array.isArray(parsed?.products) ? parsed.products : [];
  const services = Array.isArray(parsed?.services) ? parsed.services : [];
  const branchId = quoteRow.branch_id != null ? String(quoteRow.branch_id).trim() || null : null;
  const pricingAsAtIso = freeze.asAtIso;
  const headerCtx = {
    materialTypeId: headerMaterialTypeId,
    stainSourceMaterialTypeId,
    materialGauge: headerGauge,
    // Product names wrongly stored as profile must not drive workbook design matching.
    materialDesign: isMeterSheetProductLine(headerDesign) ? '' : headerDesign,
    ...(pricingAsAtIso ? { asAtIso: pricingAsAtIso } : {}),
  };

  const withHeader = (line, cat, idx) => ({
    ...line,
    _pricingCat: cat,
    _pricingIdx: idx,
    gauge: line?.gauge ?? line?.gaugeLabel ?? headerGauge,
    colour: line?.colour ?? line?.color ?? headerColour,
    color: line?.color ?? line?.colour ?? headerColour,
    design: line?.design ?? headerDesign,
    profile: line?.profile ?? line?.profileName ?? line?.profileKey ?? headerDesign,
  });

  const linesToCheck = [
    ...products.map((line, idx) => withHeader(line, 'products', idx)),
    ...services.map((line, idx) => withHeader(line, 'services', idx)),
  ];

  linesToCheck.forEach((line) => {
    const idx = line._pricingIdx;
    const cat = line._pricingCat;
    if (!lineParticipatesInSheetFloorGate(line, cat)) return;
    const isProductMeterSheet = cat === 'products' && isMeterSheetProductLine(line?.name);

    const gauge = normKey(line?.gauge ?? line?.gaugeLabel ?? '');
    if (!gauge) return;
    const lineKind = String(line?.lineKind ?? (isProductMeterSheet ? 'roofing' : ''))
      .trim()
      .toLowerCase()
      .replace(/-/g, '_');
    const designRaw = normKey(line?.colour ?? line?.color ?? line?.design ?? '');
    const profileRaw = normKey(line?.profile ?? line?.profileName ?? line?.profileKey ?? '');
    if (!isProductMeterSheet && lineKind !== 'stone_coated' && !designRaw && !profileRaw) return;

    const lineHeaderCtx = { ...headerCtx, productName: line?.name };
    const resolvedFloor = floorNgnForServiceLine(db, line, branchId, lineHeaderCtx);
    const pick = pickQuoteLineFloor({
      workbookFloorNgn: resolvedFloor,
      stampedFloorNgn: line?.floorPricePerMeter ?? line?.floor_price_per_meter,
      listBadgeNgn: line?.recommendedPricePerMeter ?? line?.recommended_price_per_meter,
      meterSheet: isProductMeterSheet,
    });
    const stampedFloor = pick.stampedFloorNgnPerM;
    const floor = pick.floorNgnPerM;
    const floorSource = pick.source;
    if (floor == null || floor <= 0) return;
    const floorWhy = describeQuoteLineFloor(pick, freeze);
    const nums = pricingPolicyNumbersForServiceLine(db, line, branchId, lineHeaderCtx);
    const meters = Number(line?.meters ?? line?.qtyMeters ?? line?.qty ?? 0) || 0;
    const unit = Number(line?.unitPrice ?? line?.unitPriceNgn ?? line?.pricePerMeter ?? 0) || 0;
    let effectivePerMeter = unit;
    if (effectivePerMeter <= 0 && meters > 0) {
      const total = Number(line?.lineTotalNgn ?? line?.totalNgn ?? line?.amountNgn ?? 0) || 0;
      if (total > 0) effectivePerMeter = total / meters;
    }
    if (effectivePerMeter <= 0) return;

    const design = nums.designKey || designRaw || profileRaw || gauge;
    // Meter-sheet MD gate is workbook floor only (not trading band / list).
    const minAllowed = isProductMeterSheet
      ? floor
      : stampedFloor > 0 && pick.workbookFloorNgnPerM != null
        ? Math.min(stampedFloor, nums.minAllowed ?? floor)
        : stampedFloor > 0
          ? stampedFloor
          : nums.minAllowed;

    if (effectivePerMeter + 0.0001 < floor) {
      violations.push({
        code: 'below_floor',
        lineCategory: cat,
        lineIndex: idx,
        lineName: String(line?.name ?? '').trim(),
        gauge,
        design,
        quotedPerMeter: Math.round(effectivePerMeter * 100) / 100,
        floorPerMeter: floor,
        recommendedPerMeter: nums.recommended ?? floor,
        bandNgn: nums.band,
        minAllowedPerMeter: minAllowed,
        floorSource,
        ignoredListStamp: pick.ignoredListStamp,
        freezeEvent: freeze.freezeEvent,
        freezeDateIso: freeze.freezeDateIso,
        pricingAsAtIso: freeze.asAtIso || null,
        floorWhy,
      });
      return;
    }
    if (isProductMeterSheet) return;
    if (minAllowed != null && effectivePerMeter + 0.0001 < minAllowed) {
      violations.push({
        code: 'below_trading_band',
        lineCategory: cat,
        lineIndex: idx,
        lineName: String(line?.name ?? '').trim(),
        gauge,
        design,
        quotedPerMeter: Math.round(effectivePerMeter * 100) / 100,
        floorPerMeter: floor,
        recommendedPerMeter: nums.recommended ?? floor,
        bandNgn: nums.band,
        minAllowedPerMeter: minAllowed,
        freezeEvent: freeze.freezeEvent,
        freezeDateIso: freeze.freezeDateIso,
        pricingAsAtIso: freeze.asAtIso || null,
        floorWhy,
      });
    }
  });
  const hasTrimLines = products.some((line) => isQuotationTrimProductLine(line?.name));
  if (hasTrimLines && canReadMaterialPricingSheetRows(db)) {
    const materialKey = materialKeyFromMaterialTypeId(db, headerMaterialTypeId);
    if (materialKey && headerGauge && branchId) {
      const pricingRows = pricingAsAtIso
        ? listMaterialPricingRowsAsOf(db, branchId, pricingAsAtIso)
        : listMaterialPricingRowsForSnapshot(db, branchId);
      const ridgeAddOns = getPricingPolicyBundle(db).ridgeAddOns || [];
      violations.push(
        ...quotationTrimWorkbookFloorViolations({
          products,
          materialKey,
          gaugeLabel: headerGauge,
          branchId,
          designLabel: headerDesign,
          materialPricingRows: pricingRows,
          ridgeAddOns,
        })
      );
    }
  }
  return { violations, hasFloorRows: true, floorPolicy };
}

/**
 * Clear a false-positive MD below-floor review flag when the quote is OK under
 * payment/quote-date floors (and stamped line floors). Idempotent.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id?: string; lines_json?: string; branch_id?: string; date_iso?: string; paid_ngn?: number } | null} quoteRow
 * @returns {{ cleared: boolean; violations: object[]; hasFloorRows: boolean }}
 */
export function clearStaleMdBelowFloorReviewFlag(db, quoteRow) {
  const pv = quotationPriceViolations(db, quoteRow);
  const qid = String(quoteRow?.id || '').trim();
  if (!qid || !pv.hasFloorRows || pv.violations.length > 0) {
    return { cleared: false, ...pv };
  }
  try {
    const r = db
      .prepare(
        `UPDATE quotations SET price_exception_md_review_required = 0
         WHERE id = ? AND price_exception_md_review_required = 1`
      )
      .run(qid);
    return { cleared: Number(r?.changes || 0) > 0, ...pv };
  } catch {
    return { cleared: false, ...pv };
  }
}

/**
 * Sweep MD queue candidates and drop flags that a later workbook raise wrongly set.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; limit?: number }} [opts]
 * @returns {{ scanned: number; cleared: number }}
 */
export function reconcileStaleMdBelowFloorFlags(db, opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
  const branchId = String(opts.branchId || '').trim();
  let sql = `SELECT id, lines_json, branch_id, date_iso, paid_ngn
             FROM quotations
             WHERE price_exception_md_review_required = 1
               AND (md_price_exception_approved_at_iso IS NULL OR TRIM(IFNULL(md_price_exception_approved_at_iso,'')) = '')
               AND (price_exception_md_confirmed_at_iso IS NULL OR TRIM(IFNULL(price_exception_md_confirmed_at_iso,'')) = '')
               AND (bm_price_exception_approved_at_iso IS NULL OR TRIM(IFNULL(bm_price_exception_approved_at_iso,'')) = '')`;
  const args = [];
  if (branchId && branchId !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(branchId);
  }
  sql += ` ORDER BY date_iso DESC LIMIT ?`;
  args.push(limit);
  let rows = [];
  try {
    rows = db.prepare(sql).all(...args);
  } catch {
    return { scanned: 0, cleared: 0 };
  }
  let cleared = 0;
  for (const row of rows) {
    if (clearStaleMdBelowFloorReviewFlag(db, row).cleared) cleared += 1;
  }
  return { scanned: rows.length, cleared };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} [asAtIso]
 * @param {{ branchId?: string | null }} [opts]
 */
export function listPriceListItems(db, asAtIso, opts = {}) {
  if (!canReadPriceListItems(db)) {
    return [];
  }
  return listPriceListItemsAsOf(db, asAtIso, opts);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object} actor
 */
export function upsertPriceListItem(db, body, actor) {
  const id = String(body?.id || '').trim() || `PL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const gaugeKey = normKey(body?.gaugeKey ?? body?.gauge);
  const designKey = normKey(body?.designKey ?? body?.design ?? body?.colour);
  const unitPricePerMeterNgn = Math.max(0, Math.round(Number(body?.unitPricePerMeterNgn) || 0));
  if (!gaugeKey || !designKey) return { ok: false, error: 'Gauge and design are required.' };
  if (unitPricePerMeterNgn <= 0) return { ok: false, error: 'Unit price per metre must be positive.' };
  if (gaugeKey.length > 120 || designKey.length > 120) {
    return { ok: false, error: 'Gauge and design keys must be at most 120 characters.' };
  }
  const sortOrder = Math.round(Number(body?.sortOrder) || 0);
  const notes = body?.notes != null ? String(body.notes).trim() || null : null;
  if (notes && notes.length > 2000) {
    return { ok: false, error: 'Notes must be at most 2000 characters.' };
  }
  const materialTypeKey = normKey(body?.materialTypeKey ?? body?.material_type_key ?? '');
  const colourKey = normKey(body?.colourKey ?? body?.colour_key ?? '');
  const profileKey = normKey(body?.profileKey ?? body?.profile_key ?? '');
  if (materialTypeKey.length > 120 || colourKey.length > 120 || profileKey.length > 120) {
    return { ok: false, error: 'Material, colour, and profile keys must be at most 120 characters each.' };
  }
  const branchId =
    body?.branchId != null && String(body.branchId).trim() ? String(body.branchId).trim() : null;
  if (branchId && branchId.length > 64) {
    return { ok: false, error: 'Branch id is too long.' };
  }

  const now = new Date().toISOString();
  const existingRow = db.prepare(`SELECT effective_from_iso FROM price_list_items WHERE id = ?`).get(id);
  const effInput = String(body?.effectiveFromIso ?? '').trim();
  let effectiveFromIso;
  if (effInput) {
    const v = validatePriceListEffectiveIso(effInput);
    if (!v.ok) return { ok: false, error: v.error };
    effectiveFromIso = v.iso;
  } else if (existingRow) {
    effectiveFromIso =
      existingRow.effective_from_iso != null && String(existingRow.effective_from_iso).trim()
        ? String(existingRow.effective_from_iso).trim().slice(0, 10)
        : defaultPriceListEffectiveFromIso();
  } else {
    effectiveFromIso = defaultPriceListEffectiveFromIso();
  }

  const dup = findDuplicatePriceListItem(
    db,
    {
      gaugeKey,
      designKey,
      branchId,
      effectiveFromIso,
      materialTypeKey,
      colourKey,
      profileKey,
    },
    existingRow ? id : null
  );
  if (dup?.id) {
    return {
      ok: false,
      code: 'DUPLICATE',
      error: `Duplicate row: same gauge, design, branch, effective date, and scope keys already exist (id ${dup.id}).`,
    };
  }

  const exists = Boolean(existingRow);
  if (exists) {
    db.prepare(
      `UPDATE price_list_items SET
        gauge_key = ?, design_key = ?, unit_price_per_meter_ngn = ?, sort_order = ?, notes = ?,
        branch_id = ?, effective_from_iso = ?, updated_at_iso = ?, updated_by_user_id = ?,
        material_type_key = ?, colour_key = ?, profile_key = ?
       WHERE id = ?`
    ).run(
      gaugeKey,
      designKey,
      unitPricePerMeterNgn,
      sortOrder,
      notes,
      branchId,
      effectiveFromIso,
      now,
      actor?.id ?? null,
      materialTypeKey,
      colourKey,
      profileKey,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO price_list_items (
        id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, notes, branch_id, effective_from_iso, updated_at_iso, updated_by_user_id,
        material_type_key, colour_key, profile_key
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      gaugeKey,
      designKey,
      unitPricePerMeterNgn,
      sortOrder,
      notes,
      branchId,
      effectiveFromIso,
      now,
      actor?.id ?? null,
      materialTypeKey,
      colourKey,
      profileKey
    );
  }
  appendAuditLog(db, {
    actor,
    action: 'pricing.list_upsert',
    entityKind: 'price_list_item',
    entityId: id,
    note: `${gaugeKey} / ${designKey} @ ${unitPricePerMeterNgn}/m`,
  });
  return { ok: true, id };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} actor
 */
export function deletePriceListItem(db, id, actor) {
  const rid = String(id || '').trim();
  if (!rid) return { ok: false, error: 'id required.' };
  const r = db.prepare(`DELETE FROM price_list_items WHERE id = ?`).run(rid);
  if (r.changes < 1) return { ok: false, error: 'Not found.' };
  appendAuditLog(db, {
    actor,
    action: 'pricing.list_delete',
    entityKind: 'price_list_item',
    entityId: rid,
  });
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function quotationHadClosedProduction(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return false;
  const q = db.prepare(`SELECT status FROM quotations WHERE id = ?`).get(ref);
  if (String(q?.status || '').trim().toLowerCase() === 'void') return true;
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS ok FROM production_jobs
         WHERE quotation_ref = ? AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')
         LIMIT 1`
      )
      .get(ref)?.ok
  );
}

function actorRoleKey(actor) {
  return normalizeRoleKey(actor?.roleKey ?? actor?.role_key ?? actor?.role ?? '');
}

function isBranchManagerRole(actor) {
  const rk = actorRoleKey(actor);
  return rk === 'sales_manager' || rk === 'branch_manager';
}

/**
 * @param {object | null | undefined} actor
 * @returns {boolean}
 */
export function actorMayApproveMdPriceException(actor) {
  if (!actor) return false;
  if (userHasPermission(actor, '*')) return true;
  if (userHasPermission(actor, 'md.price_exception.approve')) return true;
  return actorRoleKey(actor) === 'md';
}

/**
 * Branch manager (role key `sales_manager` / `branch_manager`) may approve below-floor quotes.
 * MD is notified after the fact and does not need to re-approve.
 * @param {object | null | undefined} actor
 * @returns {boolean}
 */
export function actorMayApproveBranchManagerPriceException(actor) {
  if (!actor) return false;
  if (userHasPermission(actor, '*')) return true;
  if (userHasPermission(actor, 'bm.price_exception.approve')) return true;
  if (isBranchManagerRole(actor)) return true;
  return false;
}

function belowFloorViolationSummary(violations) {
  return (violations || [])
    .map(
      (v) =>
        `${v.lineCategory || 'line'}#${Number(v.lineIndex) + 1} quoted ${v.quotedPerMeter}/m < floor ${v.floorPerMeter}/m`
    )
    .join('; ');
}

/**
 * Shared pre-check for BM / MD below-floor approval.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 */
function quotationBelowFloorApprovalContext(db, quotationId) {
  const qid = String(quotationId || '').trim();
  if (!qid) return { ok: false, error: 'Quotation id required.' };
  let row;
  try {
    row = db
      .prepare(
        `SELECT id, lines_json, branch_id, date_iso, customer_name,
                md_price_exception_approved_at_iso, price_exception_md_confirmed_at_iso,
                bm_price_exception_approved_at_iso
         FROM quotations WHERE id = ?`
      )
      .get(qid);
  } catch {
    row = db
      .prepare(
        `SELECT id, lines_json, branch_id, date_iso, customer_name,
                md_price_exception_approved_at_iso, price_exception_md_confirmed_at_iso
         FROM quotations WHERE id = ?`
      )
      .get(qid);
  }
  if (!row) return { ok: false, error: 'Quotation not found.' };
  const mapped = {
    mdPriceExceptionApprovedAtISO: row.md_price_exception_approved_at_iso,
    priceExceptionMdConfirmedAtISO: row.price_exception_md_confirmed_at_iso,
    bmPriceExceptionApprovedAtISO: row.bm_price_exception_approved_at_iso,
  };
  if (quotationBelowFloorExceptionApproved(mapped)) {
    return { ok: false, error: 'Below-floor price exception is already approved for this quotation.' };
  }
  const { violations, hasFloorRows } = quotationPriceViolations(db, row);
  if (hasFloorRows && violations.length === 0) {
    return { ok: false, error: 'No below-floor price detected for this quotation.' };
  }
  if (!hasFloorRows) {
    return { ok: false, error: 'Pricing workbook / list is empty; no exception needed.' };
  }
  return {
    ok: true,
    qid,
    row,
    violations,
    snapshotJson: JSON.stringify(violations),
    violationSummary: belowFloorViolationSummary(violations),
  };
}

function listMdNotifyUsers(db) {
  try {
    return db
      .prepare(`SELECT id FROM app_users WHERE status = 'active' AND role_key IN ('md', 'admin') LIMIT 25`)
      .all();
  } catch {
    return [];
  }
}

/**
 * Informational notice to MD/admin after a branch manager approves below-floor pricing.
 * Does not require MD to re-approve — cutting list and refunds may proceed.
 * @param {import('better-sqlite3').Database} db
 */
export function notifyMdOfBranchManagerBelowFloorApproval(db, { quotationId, actor, branchId, customerName, violationSummary }) {
  const qid = String(quotationId || '').trim();
  if (!qid) return { ok: true, noop: true };
  const actorLabel = actorName(actor) || 'Branch manager';
  const customer = String(customerName || '').trim();
  const body = [
    `${actorLabel} approved below-floor pricing on ${qid}`,
    customer,
    String(violationSummary || '').trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  const title = `Below-floor quote ${qid} approved by branch manager`;
  let notified = 0;
  try {
    for (const u of listMdNotifyUsers(db)) {
      const r = createHrNotification(db, {
        userId: u.id,
        kind: 'bm_below_floor_price_exception',
        title,
        body,
        routePath: '/exec',
        entityKind: 'quotation',
        entityId: qid,
      });
      if (r?.ok) notified += 1;
    }
  } catch {
    /* notifications are best-effort */
  }
  try {
    if (workRegistryTablesReady(db)) {
      const bid = String(branchId || '').trim() || DEFAULT_BRANCH_ID;
      upsertWorkItemBySource(db, {
        actor,
        sourceKind: 'bm_below_floor_price_exception',
        sourceId: qid,
        branchId: bid,
        officeKey: 'executive',
        responsibleOfficeKey: 'executive',
        documentClass: 'report',
        documentType: 'bm_below_floor_price_exception',
        status: 'open',
        priority: 'high',
        title: `Below-floor price approved by branch manager · ${qid}`,
        summary: body,
        body: 'Notification only. The branch manager already approved this below-floor price. Cutting list and refunds may proceed; the Managing Director does not need to re-approve.',
        requiresResponse: false,
        requiresApproval: false,
        senderUserId: actor?.id || null,
        senderDisplayName: actorLabel,
        senderRoleKey: actorRoleKey(actor) || 'sales_manager',
        senderOfficeKey: 'sales',
        senderBranchId: bid,
        visibilityEntries: [
          { visibilityKind: 'role_key', visibilityValue: 'md' },
          { visibilityKind: 'role_key', visibilityValue: 'admin' },
          { visibilityKind: 'role_key', visibilityValue: 'ceo' },
        ],
        data: {
          routePath: '/exec',
          quotationId: qid,
          approvedByUserId: actor?.id || null,
          notificationOnly: true,
        },
        links: [{ entityKind: 'quotation', entityId: qid }],
      });
    }
  } catch {
    /* work items are best-effort */
  }
  return { ok: true, notified };
}

/**
 * MD or administrator approves below-floor pricing — unblocks cutting list and refunds.
 * Production does not wait on this approval (warn-only).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 * @param {object} actor
 */
export function approveMdPriceExceptionForQuotation(db, quotationId, actor) {
  if (!actorMayApproveMdPriceException(actor)) {
    return {
      ok: false,
      error: 'Only the Managing Director or an administrator may approve a below-floor price exception.',
    };
  }
  const ctx = quotationBelowFloorApprovalContext(db, quotationId);
  if (!ctx.ok) return ctx;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE quotations SET
        md_price_exception_approved_at_iso = ?,
        md_price_exception_approved_by_user_id = ?,
        md_price_exception_snapshot_json = ?,
        price_exception_md_review_required = 1
       WHERE id = ?`
    ).run(now, actor?.id ?? null, ctx.snapshotJson, ctx.qid);
  } catch {
    db.prepare(
      `UPDATE quotations SET
        md_price_exception_approved_at_iso = ?,
        md_price_exception_approved_by_user_id = ?,
        price_exception_md_review_required = 1
       WHERE id = ?`
    ).run(now, actor?.id ?? null, ctx.qid);
  }
  appendAuditLog(db, {
    actor,
    action: 'quotation.md_price_exception_approve',
    entityKind: 'quotation',
    entityId: ctx.qid,
    note: `${actorName(actor)} — ${ctx.violations.length} below-floor line(s): ${ctx.violationSummary}`.slice(0, 500),
    details: { violations: ctx.violations, snapshotJson: ctx.snapshotJson },
  });
  return { ok: true };
}

/**
 * Branch manager approves below-floor pricing (same gate as MD). MD is notified that this happened.
 * MD/admin callers are routed to {@link approveMdPriceExceptionForQuotation}.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 * @param {object} actor
 */
export function approveBranchManagerPriceExceptionForQuotation(db, quotationId, actor) {
  if (actorMayApproveMdPriceException(actor) && !isBranchManagerRole(actor)) {
    return approveMdPriceExceptionForQuotation(db, quotationId, actor);
  }
  if (!actorMayApproveBranchManagerPriceException(actor)) {
    return {
      ok: false,
      error:
        'Only a branch manager (or the Managing Director / administrator) may approve a below-floor price exception.',
    };
  }
  const ctx = quotationBelowFloorApprovalContext(db, quotationId);
  if (!ctx.ok) return ctx;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE quotations SET
        bm_price_exception_approved_at_iso = ?,
        bm_price_exception_approved_by_user_id = ?,
        md_price_exception_snapshot_json = ?,
        price_exception_md_review_required = 1
       WHERE id = ?`
    ).run(now, actor?.id ?? null, ctx.snapshotJson, ctx.qid);
  } catch {
    db.prepare(
      `UPDATE quotations SET
        bm_price_exception_approved_at_iso = ?,
        bm_price_exception_approved_by_user_id = ?,
        price_exception_md_review_required = 1
       WHERE id = ?`
    ).run(now, actor?.id ?? null, ctx.qid);
  }
  appendAuditLog(db, {
    actor,
    action: 'quotation.bm_price_exception_approve',
    entityKind: 'quotation',
    entityId: ctx.qid,
    note: `${actorName(actor)} — ${ctx.violations.length} below-floor line(s): ${ctx.violationSummary}`.slice(0, 500),
    details: { violations: ctx.violations, snapshotJson: ctx.snapshotJson, mdNotified: true },
  });
  const notify = notifyMdOfBranchManagerBelowFloorApproval(db, {
    quotationId: ctx.qid,
    actor,
    branchId: ctx.row.branch_id,
    customerName: ctx.row.customer_name,
    violationSummary: ctx.violationSummary,
  });
  return { ok: true, mdNotified: Number(notify?.notified || 0) > 0 };
}

/** @deprecated Use {@link approveMdPriceExceptionForQuotation} */
export function confirmMdPriceExceptionReviewForQuotation(db, quotationId, actor) {
  return approveMdPriceExceptionForQuotation(db, quotationId, actor);
}
