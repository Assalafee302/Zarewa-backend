import crypto from 'node:crypto';
import { appendAuditLog } from './controlOps.js';
import { actorName } from './auth.js';
import {
  floorNgnForServiceLine,
  normKey as policyNormKey,
  pricingPolicyNumbersForServiceLine,
} from './pricingPolicyResolve.js';
import { canReadPriceListItems } from './pricingResolve.js';
import { listPriceListItemsAsOf, floorPricePerMeterForGaugeDesignAsOf } from './pricingAsOf.js';

export { quotationPricingAsAtIso, listPriceListItemsAsOf, normalizePricingAsAtIso } from './pricingAsOf.js';
import { canReadMaterialPricingSheetRows } from './materialWorkbookQuotationPrice.js';
import { isMeterSheetProductLine } from '../shared/lib/materialWorkbookQuotationPrice.js';
import { quotationTrimWorkbookFloorViolations } from '../shared/lib/materialWorkbookTrimPrice.js';
import { isQuotationTrimProductLine } from '../shared/lib/cuttingListBlankConsumption.js';
import {
  listMaterialPricingRowsForSnapshot,
  materialKeyFromMaterialTypeId,
} from './materialWorkbookQuotationPrice.js';
import { listMaterialPricingRowsAsOf } from './pricingAsOf.js';
import { getPricingPolicyBundle } from './pricingPolicyOps.js';
import { userHasPermission } from './auth.js';
import { quotationBelowFloorExceptionApproved } from '../shared/lib/quotationPriceException.js';

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
 * @param {import('better-sqlite3').Database} db
 * @param {{ id?: string; lines_json?: string | null; branch_id?: string | null; date_iso?: string | null }} quoteRow
 * @param {{ pricingMode?: 'current' | 'quotation_date' }} [opts]
 *   `current` (default) — live workbook / price list for cutting list & production gates.
 *   `quotation_date` — historical floors (refunds / substitution only).
 */
export function quotationPriceViolations(db, quoteRow, opts = {}) {
  const violations = [];
  if (!quoteRow?.id) return { violations, hasFloorRows: false };
  if (!quotationHasPricingFloorData(db)) return { violations, hasFloorRows: false };
  let parsed;
  try {
    parsed = JSON.parse(String(quoteRow.lines_json || '{}'));
  } catch {
    return { violations, hasFloorRows: true };
  }
  const headerGauge = String(parsed?.materialGauge ?? '').trim();
  const headerColour = String(parsed?.materialColor ?? '').trim();
  const headerDesign = String(parsed?.materialDesign ?? '').trim();
  const headerMaterialTypeId = String(parsed?.materialTypeId ?? '').trim();
  const products = Array.isArray(parsed?.products) ? parsed.products : [];
  const services = Array.isArray(parsed?.services) ? parsed.services : [];
  const branchId = quoteRow.branch_id != null ? String(quoteRow.branch_id).trim() || null : null;
  const useQuoteDate = opts.pricingMode === 'quotation_date';
  const pricingAsAtIso =
    useQuoteDate &&
    String(quoteRow?.date_iso ?? '').trim().slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/)
      ? String(quoteRow.date_iso).trim().slice(0, 10)
      : undefined;
  const headerCtx = {
    materialTypeId: headerMaterialTypeId,
    materialGauge: headerGauge,
    materialDesign: headerDesign,
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
    const isProductMeterSheet = cat === 'products' && isMeterSheetProductLine(line?.name);
    if (cat === 'products' && !isProductMeterSheet) return;

    const gauge = normKey(line?.gauge ?? line?.gaugeLabel ?? '');
    if (!gauge) return;
    const lineKind = String(line?.lineKind ?? 'roofing')
      .trim()
      .toLowerCase()
      .replace(/-/g, '_');
    const designRaw = normKey(line?.colour ?? line?.color ?? line?.design ?? '');
    const profileRaw = normKey(line?.profile ?? line?.profileName ?? line?.profileKey ?? '');
    if (!isProductMeterSheet && lineKind !== 'stone_coated' && !designRaw && !profileRaw) return;

    const lineHeaderCtx = { ...headerCtx, productName: line?.name };
    const floor = floorNgnForServiceLine(db, line, branchId, lineHeaderCtx);
    if (floor == null || floor <= 0) return;
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
    const minAllowed = nums.minAllowed;

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
  return { violations, hasFloorRows: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listPriceListItems(db, asAtIso) {
  if (!canReadPriceListItems(db)) {
    return [];
  }
  return listPriceListItemsAsOf(db, asAtIso);
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

/**
 * @param {object | null | undefined} actor
 * @returns {boolean}
 */
export function actorMayApproveMdPriceException(actor) {
  if (!actor) return false;
  if (userHasPermission(actor, '*')) return true;
  if (userHasPermission(actor, 'md.price_exception.approve')) return true;
  const rk = String(actor?.roleKey ?? actor?.role_key ?? actor?.role ?? '')
    .trim()
    .toLowerCase();
  return rk === 'md';
}

/**
 * MD or administrator approves below-floor pricing — required before cutting list and production.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 * @param {object} actor
 */
export function approveMdPriceExceptionForQuotation(db, quotationId, actor) {
  const qid = String(quotationId || '').trim();
  if (!qid) return { ok: false, error: 'Quotation id required.' };
  if (!actorMayApproveMdPriceException(actor)) {
    return {
      ok: false,
      error: 'Only the Managing Director or an administrator may approve a below-floor price exception.',
    };
  }
  const row = db
    .prepare(
      `SELECT id, lines_json, branch_id, date_iso,
              md_price_exception_approved_at_iso, price_exception_md_confirmed_at_iso
       FROM quotations WHERE id = ?`
    )
    .get(qid);
  if (!row) return { ok: false, error: 'Quotation not found.' };
  const mapped = {
    mdPriceExceptionApprovedAtISO: row.md_price_exception_approved_at_iso,
    priceExceptionMdConfirmedAtISO: row.price_exception_md_confirmed_at_iso,
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
  const now = new Date().toISOString();
  const snapshotJson = JSON.stringify(violations);
  const violationSummary = violations
    .map(
      (v) =>
        `${v.lineCategory || 'line'}#${Number(v.lineIndex) + 1} quoted ${v.quotedPerMeter}/m < floor ${v.floorPerMeter}/m`
    )
    .join('; ');
  try {
    db.prepare(
      `UPDATE quotations SET
        md_price_exception_approved_at_iso = ?,
        md_price_exception_approved_by_user_id = ?,
        md_price_exception_snapshot_json = ?,
        price_exception_md_review_required = 1
       WHERE id = ?`
    ).run(now, actor?.id ?? null, snapshotJson, qid);
  } catch {
    db.prepare(
      `UPDATE quotations SET
        md_price_exception_approved_at_iso = ?,
        md_price_exception_approved_by_user_id = ?,
        price_exception_md_review_required = 1
       WHERE id = ?`
    ).run(now, actor?.id ?? null, qid);
  }
  appendAuditLog(db, {
    actor,
    action: 'quotation.md_price_exception_approve',
    entityKind: 'quotation',
    entityId: qid,
    note: `${actorName(actor)} — ${violations.length} below-floor line(s): ${violationSummary}`.slice(0, 500),
    details: { violations, snapshotJson },
  });
  return { ok: true };
}

/**
 * @deprecated Branch managers may no longer approve below-floor pricing. Use {@link approveMdPriceExceptionForQuotation}.
 */
export function approveBranchManagerPriceExceptionForQuotation(db, quotationId, actor) {
  void actor;
  void db;
  void quotationId;
  return {
    ok: false,
    error:
      'Below-floor price exceptions require Managing Director or administrator approval. Branch managers cannot approve discounted floor prices.',
  };
}

/** @deprecated Use {@link approveMdPriceExceptionForQuotation} */
export function confirmMdPriceExceptionReviewForQuotation(db, quotationId, actor) {
  return approveMdPriceExceptionForQuotation(db, quotationId, actor);
}
