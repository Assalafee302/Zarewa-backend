import crypto from 'node:crypto';
import { appendAuditLog } from './controlOps.js';
import { actorName } from './auth.js';
import {
  floorNgnForServiceLine,
  normKey as policyNormKey,
  pricingPolicyNumbersForServiceLine,
} from './pricingPolicyResolve.js';
import { canReadPriceListItems } from './pricingResolve.js';
import { canReadMaterialPricingSheetRows } from './materialWorkbookQuotationPrice.js';
import { isMeterSheetProductLine } from '../shared/lib/materialWorkbookQuotationPrice.js';
import { isBranchManagerApprovalAuthority } from '../shared/workspaceGovernance.js';
import {
  quotationFlaggedForMdPriceReview,
  quotationMdPriceReviewConfirmed,
} from '../shared/lib/quotationPriceException.js';

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
 * Default effective date for new/changed rows when omitted (today UTC date label).
 */
export function defaultPriceListEffectiveFromIso() {
  return new Date().toISOString().slice(0, 10);
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
export function floorPricePerMeterForGaugeDesign(db, gaugeKey, designKey, branchId) {
  const g = normKey(gaugeKey);
  const d = normKey(designKey);
  if (!g || !d) return null;
  const bid = branchId && String(branchId).trim() ? String(branchId).trim() : null;
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

export function quotationPriceViolations(db, quoteRow) {
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
  const headerCtx = {
    materialTypeId: headerMaterialTypeId,
    materialGauge: headerGauge,
    materialDesign: headerDesign,
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
  return { violations, hasFloorRows: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listPriceListItems(db) {
  if (!canReadPriceListItems(db)) {
    return [];
  }
  return db
    .prepare(
      `SELECT * FROM price_list_items ORDER BY gauge_key ASC, design_key ASC, sort_order ASC, id ASC`
    )
    .all()
    .map((row) => ({
      id: row.id,
      gaugeKey: row.gauge_key,
      designKey: row.design_key,
      unitPricePerMeterNgn: Math.round(Number(row.unit_price_per_meter_ngn) || 0),
      sortOrder: Number(row.sort_order) || 0,
      notes: row.notes ?? '',
      branchId: row.branch_id ?? null,
      effectiveFromIso: row.effective_from_iso ?? null,
      updatedAtIso: row.updated_at_iso ?? null,
      updatedByUserId: row.updated_by_user_id ?? null,
      materialTypeKey: row.material_type_key ?? '',
      colourKey: row.colour_key ?? '',
      profileKey: row.profile_key ?? '',
    }));
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
 * Branch manager approves below-floor pricing so production may start; flags MD review before refund.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 * @param {object} actor
 */
export function approveBranchManagerPriceExceptionForQuotation(db, quotationId, actor) {
  const qid = String(quotationId || '').trim();
  if (!qid) return { ok: false, error: 'Quotation id required.' };
  const roleKey = actor?.roleKey ?? actor?.role_key ?? actor?.role;
  const rk = String(roleKey || '').trim().toLowerCase();
  if (!isBranchManagerApprovalAuthority(roleKey) && rk !== 'admin') {
    return {
      ok: false,
      error: 'Only a branch manager or administrator may approve a below-floor price exception.',
    };
  }
  const row = db.prepare(`SELECT id, lines_json, branch_id FROM quotations WHERE id = ?`).get(qid);
  if (!row) return { ok: false, error: 'Quotation not found.' };
  const { violations, hasFloorRows } = quotationPriceViolations(db, row);
  if (hasFloorRows && violations.length === 0) {
    return { ok: false, error: 'No below-floor price detected for this quotation.' };
  }
  if (!hasFloorRows) {
    return { ok: false, error: 'Pricing workbook / list is empty; no exception needed.' };
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE quotations SET
      bm_price_exception_approved_at_iso = ?,
      bm_price_exception_approved_by_user_id = ?,
      price_exception_md_review_required = 1
     WHERE id = ?`
  ).run(now, actor?.id ?? null, qid);
  appendAuditLog(db, {
    actor,
    action: 'quotation.bm_price_exception_approve',
    entityKind: 'quotation',
    entityId: qid,
    note: actorName(actor),
    details: { violations, mdReviewRequired: true },
  });
  return { ok: true, mdReviewRequired: true };
}

/**
 * MD confirms below-floor exception after production — required before customer refund.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 * @param {object} actor
 */
export function confirmMdPriceExceptionReviewForQuotation(db, quotationId, actor) {
  const qid = String(quotationId || '').trim();
  if (!qid) return { ok: false, error: 'Quotation id required.' };
  const row = db
    .prepare(
      `SELECT id, lines_json, branch_id, bm_price_exception_approved_at_iso,
              price_exception_md_review_required, price_exception_md_confirmed_at_iso,
              md_price_exception_approved_at_iso
       FROM quotations WHERE id = ?`
    )
    .get(qid);
  if (!row) return { ok: false, error: 'Quotation not found.' };

  const mapped = {
    bmPriceExceptionApprovedAtISO: row.bm_price_exception_approved_at_iso,
    priceExceptionMdReviewRequired: row.price_exception_md_review_required,
    priceExceptionMdConfirmedAtISO: row.price_exception_md_confirmed_at_iso,
    mdPriceExceptionApprovedAtISO: row.md_price_exception_approved_at_iso,
  };
  if (quotationMdPriceReviewConfirmed(mapped)) {
    return { ok: false, error: 'MD review is already confirmed for this quotation.' };
  }
  if (!quotationFlaggedForMdPriceReview(mapped) && !String(row.bm_price_exception_approved_at_iso || '').trim()) {
    return {
      ok: false,
      error: 'No branch-manager below-floor approval on file. Branch manager must approve before MD confirmation.',
    };
  }
  if (!quotationHadClosedProduction(db, qid)) {
    return {
      ok: false,
      error:
        'MD confirmation is recorded after production is completed or cancelled. Finish production on this quotation first.',
    };
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE quotations SET
      price_exception_md_confirmed_at_iso = ?,
      price_exception_md_confirmed_by_user_id = ?
     WHERE id = ?`
  ).run(now, actor?.id ?? null, qid);
  appendAuditLog(db, {
    actor,
    action: 'quotation.md_price_exception_confirm',
    entityKind: 'quotation',
    entityId: qid,
    note: actorName(actor),
  });
  return { ok: true };
}

/** @deprecated Use {@link approveBranchManagerPriceExceptionForQuotation} */
export function approveMdPriceExceptionForQuotation(db, quotationId, actor) {
  return approveBranchManagerPriceExceptionForQuotation(db, quotationId, actor);
}
