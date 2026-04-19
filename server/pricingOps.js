import crypto from 'node:crypto';
import { appendAuditLog } from './controlOps.js';
import { actorName } from './auth.js';

function normKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
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
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_list_items'`).get()) {
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
export function quotationPriceViolations(db, quoteRow) {
  const violations = [];
  if (!quoteRow?.id) return { violations, hasFloorRows: false };
  const floorCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM price_list_items`).get()?.c) || 0;
  if (floorCount === 0) return { violations, hasFloorRows: false };
  let parsed;
  try {
    parsed = JSON.parse(String(quoteRow.lines_json || '{}'));
  } catch {
    return { violations, hasFloorRows: true };
  }
  const services = Array.isArray(parsed?.services) ? parsed.services : [];
  const branchId = quoteRow.branch_id != null ? String(quoteRow.branch_id).trim() || null : null;
  services.forEach((line, idx) => {
    const gauge = normKey(line?.gauge ?? line?.gaugeLabel ?? '');
    const design = normKey(line?.colour ?? line?.color ?? line?.design ?? '');
    if (!gauge || !design) return;
    const floor = floorPricePerMeterForGaugeDesign(db, gauge, design, branchId);
    if (floor == null || floor <= 0) return;
    const meters = Number(line?.meters ?? line?.qtyMeters ?? 0) || 0;
    const unit = Number(line?.unitPrice ?? line?.unitPriceNgn ?? line?.pricePerMeter ?? 0) || 0;
    let effectivePerMeter = unit;
    if (effectivePerMeter <= 0 && meters > 0) {
      const total = Number(line?.lineTotalNgn ?? line?.totalNgn ?? line?.amountNgn ?? 0) || 0;
      if (total > 0) effectivePerMeter = total / meters;
    }
    if (effectivePerMeter > 0 && effectivePerMeter + 0.0001 < floor) {
      violations.push({
        lineIndex: idx,
        gauge,
        design,
        quotedPerMeter: Math.round(effectivePerMeter * 100) / 100,
        floorPerMeter: floor,
      });
    }
  });
  return { violations, hasFloorRows: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listPriceListItems(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_list_items'`).get()) {
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
 * @param {string} quotationId
 * @param {object} actor
 */
export function approveMdPriceExceptionForQuotation(db, quotationId, actor) {
  const qid = String(quotationId || '').trim();
  if (!qid) return { ok: false, error: 'Quotation id required.' };
  const row = db.prepare(`SELECT id, lines_json, branch_id FROM quotations WHERE id = ?`).get(qid);
  if (!row) return { ok: false, error: 'Quotation not found.' };
  const { violations, hasFloorRows } = quotationPriceViolations(db, row);
  if (hasFloorRows && violations.length === 0) {
    return { ok: false, error: 'No below-list price detected for this quotation.' };
  }
  if (!hasFloorRows) {
    return { ok: false, error: 'Price list is empty; no exception needed.' };
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE quotations SET md_price_exception_approved_at_iso = ?, md_price_exception_approved_by_user_id = ? WHERE id = ?`
  ).run(now, actor?.id ?? null, qid);
  appendAuditLog(db, {
    actor,
    action: 'quotation.md_price_exception_approve',
    entityKind: 'quotation',
    entityId: qid,
    note: actorName(actor),
    details: { violations },
  });
  return { ok: true };
}
