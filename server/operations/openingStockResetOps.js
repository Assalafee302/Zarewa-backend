/**
 * Kaduna (BR-KD) physical-count opening reset — preview then post.
 * Posts dated ADJUSTMENT only — never rewrites prior movements.
 *
 * Excludes the six ACC SKUs already reset today (MV-26-00676…00681).
 * Yola / Maiduguri are not reset (no count).
 */
import { createHash } from 'node:crypto';
import { adjustProductStockForBranch, getProductRowForWorkspace } from '../productBranchInventory.js';
import { insertStockMovementTx } from '../stockMovementOps.js';
import { nextStockMovementHumanId } from '../humanId.js';

export const OPENING_RESET_BRANCH_ID = 'BR-KD';
export const OPENING_RESET_POST_DATE = '2026-10-08';

/** Already posted today — never include in this reset. */
export const ACCESSORY_ALREADY_RESET_PRODUCT_IDS = Object.freeze([
  'ACC-TAPPING-SCREW-PCS',
  'ACC-DRIVE-SCREW-PACK',
  'ACC-RIVET-PACK',
  'ACC-REPAIR-KIT',
  'ACC-FELT-ROLL',
  'ACC-WASHER-PACK',
]);

/** Remaining accessory counts (8 Oct) — base units + unit cost for the ADJUSTMENT. */
export const ACCESSORY_PHYSICAL_COUNTS = [
  {
    productId: 'ACC-SILICON-TUBE',
    count: 20,
    unitCostNgn: 1800,
    reason: 'Physical count 8 Oct 2026',
    note: '',
  },
  {
    productId: 'ACC-STONE-NAIL-PACK',
    count: 20,
    unitCostNgn: 9000,
    reason: 'Physical count 8 Oct 2026',
    note: '',
  },
];

/** Flatsheet in SHEETS (not m²). */
export const FLATSHEET_PHYSICAL_COUNTS = [
  { productId: 'STONE-FS-black-2m', count: 113, note: '2 m black' },
  { productId: 'STONE-FS-red-mix-black-2m', count: 56, note: '2 m red mix black' },
  { productId: 'STONE-FS-red-mix-black-1p4m', count: 5, note: '1.4 m red mix black' },
];

/** All counted stone-metre rolls are 0.20 mm @ ₦4,400/m. */
export const STONE_METRE_UNIT_COST_NGN = 4400;
export const STONE_METRE_COUNTED_0P20 = [
  { productId: 'STONE-milano-black-0.20mm', count: 750, label: 'Milano black 0.20' },
  { productId: 'STONE-bond-black-0.20mm', count: 510, label: 'Bond black 0.20' },
  { productId: 'STONE-milano-red-mix-black-0.20mm', count: 700, label: 'Milano red mix black 0.20' },
  { productId: 'STONE-classic-black-0.20mm', count: 250, label: 'Classic black 0.20' },
  { productId: 'STONE-shingle-red-patch-black-0.20mm', count: 70, label: 'Shingle red patch black 0.20' },
  { productId: 'STONE-shingle-black-patch-white-0.20mm', count: 110, label: 'Shingle black patch white 0.20' },
];

export const OPENING_RESET_REASON_STONE =
  'Physical count 5 Oct 2026 – opening stock reset (0.20 mm rolls)';
export const OPENING_RESET_REASON_FS =
  'Physical count 5 Oct 2026 – opening stock reset (sheets)';

/** Default stonePosts map for KD (all 0.20 mm). */
export function defaultKdStonePosts() {
  return STONE_METRE_COUNTED_0P20.map((s) => ({ productId: s.productId, count: s.count }));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function previewHash(lines) {
  const payload = JSON.stringify(
    lines.map((l) => ({
      g: l.group,
      p: l.productId,
      t: l.target,
      a: l.adjustment,
      r: l.role,
      c: l.unitCostNgn || 0,
    }))
  );
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function lineForProduct(
  db,
  branchId,
  group,
  productId,
  target,
  role,
  note,
  {
    ambiguous = false,
    reason = '',
    unitCostNgn = null,
  } = {}
) {
  const row = getProductRowForWorkspace(db, productId, branchId);
  const erp = row ? num(row.stock_level) : null;
  const adjustment = erp == null || target == null ? null : target - erp;
  return {
    group,
    productId,
    name: row?.name || '(missing product)',
    unit: row?.unit || '',
    erpNow: erp,
    target,
    adjustment,
    role,
    note: note || '',
    reason: reason || '',
    unitCostNgn: unitCostNgn != null && unitCostNgn > 0 ? unitCostNgn : null,
    ambiguous: Boolean(ambiguous),
    missing: !row,
  };
}

/**
 * Build preview lines for BR-KD only. Does not write.
 * Applies default 0.20 mm stonePosts unless opts.stonePosts provided.
 */
export function previewOpeningStockReset(db, branchId, opts = {}) {
  const bid = String(branchId || '').trim();
  if (!bid) return { ok: false, error: 'branchId is required.' };
  if (bid !== OPENING_RESET_BRANCH_ID) {
    return {
      ok: false,
      error: `Opening reset is configured for ${OPENING_RESET_BRANCH_ID} only (no count for other branches).`,
    };
  }

  const lines = [];
  const excludedAccessories = ACCESSORY_ALREADY_RESET_PRODUCT_IDS.map((productId) => {
    const row = getProductRowForWorkspace(db, productId, bid);
    return {
      productId,
      name: row?.name || productId,
      erpNow: row ? num(row.stock_level) : null,
      note: 'EXCLUDED — already reset today (MV-26-00676…00681)',
    };
  });

  for (const a of ACCESSORY_PHYSICAL_COUNTS) {
    lines.push(
      lineForProduct(db, bid, 'accessory', a.productId, a.count, 'primary', a.note, {
        reason: a.reason,
        unitCostNgn: a.unitCostNgn,
      })
    );
  }

  // Flatsheet sheets
  const fsRows = db
    .prepare(
      `SELECT product_id FROM products WHERE branch_id = ? AND product_id LIKE 'STONE-FS-%'`
    )
    .all(bid);
  const fsTarget = new Map(FLATSHEET_PHYSICAL_COUNTS.map((f) => [f.productId, f]));
  for (const r of fsRows) {
    const pid = String(r.product_id);
    const hit = fsTarget.get(pid);
    if (hit) {
      lines.push(
        lineForProduct(db, bid, 'stone_flatsheet', pid, hit.count, 'primary', hit.note, {
          reason: OPENING_RESET_REASON_FS,
        })
      );
    } else {
      lines.push(
        lineForProduct(db, bid, 'stone_flatsheet', pid, 0, 'zero_other_fs', 'All other FS → 0 sheets', {
          reason: OPENING_RESET_REASON_FS,
        })
      );
    }
  }
  for (const f of FLATSHEET_PHYSICAL_COUNTS) {
    if (!fsRows.some((r) => String(r.product_id) === f.productId)) {
      lines.push(
        lineForProduct(db, bid, 'stone_flatsheet', f.productId, f.count, 'primary_missing_sku', f.note, {
          reason: OPENING_RESET_REASON_FS,
        })
      );
    }
  }

  // Stone metres: counted 0.20 mm SKUs + every other metre SKU → 0 (incl. Single)
  const stonePosts = new Map(
    (opts.stonePosts?.length ? opts.stonePosts : defaultKdStonePosts()).map((s) => [
      String(s.productId || s.product_id || '').trim(),
      num(s.count),
    ])
  );
  const countedIds = new Set(stonePosts.keys());

  for (const [pid, count] of stonePosts) {
    const meta = STONE_METRE_COUNTED_0P20.find((s) => s.productId === pid);
    lines.push(
      lineForProduct(db, bid, 'stone_metre', pid, count, 'primary', meta?.label || '0.20 mm counted', {
        reason: OPENING_RESET_REASON_STONE,
        unitCostNgn: STONE_METRE_UNIT_COST_NGN,
      })
    );
  }

  const otherMetre = db
    .prepare(
      `SELECT product_id, name, unit, stock_level FROM products
       WHERE branch_id = ?
         AND product_id LIKE 'STONE-%'
         AND product_id NOT LIKE 'STONE-FS-%'
       ORDER BY product_id`
    )
    .all(bid);

  const zeroOtherMetre = [];
  for (const r of otherMetre) {
    const pid = String(r.product_id);
    if (countedIds.has(pid)) continue;
    const line = lineForProduct(
      db,
      bid,
      'stone_metre',
      pid,
      0,
      'zero_other_metre',
      /single/i.test(pid) ? 'Single duplicate / other → 0' : 'Other stone-metre SKU → 0',
      { reason: OPENING_RESET_REASON_STONE, unitCostNgn: STONE_METRE_UNIT_COST_NGN }
    );
    lines.push(line);
    zeroOtherMetre.push({
      productId: pid,
      name: r.name,
      erpNow: num(r.stock_level),
      target: 0,
      adjustment: line.adjustment,
      isSingle: /^STONE-single-/i.test(pid),
    });
  }

  const postable = lines.filter(
    (l) =>
      !l.ambiguous &&
      l.adjustment != null &&
      Math.abs(l.adjustment) > 1e-9 &&
      (l.role === 'primary' ||
        l.role === 'zero_other_fs' ||
        l.role === 'zero_other_metre' ||
        l.role === 'primary_missing_sku')
  );

  const hash = previewHash(lines);
  return {
    ok: true,
    branchId: bid,
    postDate: OPENING_RESET_POST_DATE,
    previewHash: hash,
    lines,
    postableCount: postable.length,
    ambiguousCount: 0,
    excludedAccessories,
    zeroOtherMetre,
    summary: {
      accessories: lines.filter((l) => l.group === 'accessory').length,
      flatsheet: lines.filter((l) => l.group === 'stone_flatsheet').length,
      stoneMetreCounted: countedIds.size,
      stoneMetreZeroed: zeroOtherMetre.length,
      stoneMetreZeroedSingles: zeroOtherMetre.filter((z) => z.isSingle).length,
    },
  };
}

function appendAdjust(db, { productId, delta, branchId, dateISO, detail, unitCostNgn }) {
  const id = nextStockMovementHumanId(db);
  const atISO = `${dateISO}T12:00:00`;
  const cost = Number(unitCostNgn) || 0;
  const valueNgn = cost > 0 ? Math.round(Math.abs(delta) * cost) : null;
  insertStockMovementTx(db, {
    id,
    atISO,
    type: 'ADJUSTMENT',
    productID: productId,
    qty: delta,
    detail: String(detail || '').slice(0, 500),
    dateISO,
    branchId,
    unitPriceNgn: cost > 0 ? Math.round(cost) : null,
    valueNgn,
  });
  adjustProductStockForBranch(db, productId, delta, branchId, { allowNegative: true });
  return id;
}

/**
 * Post preview lines after approval. Requires matching previewHash.
 * @param {{ previewHash: string, stonePosts?: { productId: string, count: number }[], actor?: object, confirm: true }} opts
 */
export function postOpeningStockReset(db, branchId, opts = {}) {
  if (opts.confirm !== true) {
    return { ok: false, error: 'Set confirm: true after reviewing the preview.' };
  }
  const preview = previewOpeningStockReset(db, branchId, { stonePosts: opts.stonePosts });
  if (!preview.ok) return preview;
  if (String(opts.previewHash || '') !== preview.previewHash) {
    return {
      ok: false,
      error: 'Preview hash mismatch — re-run preview and approve the latest lines.',
      previewHash: preview.previewHash,
    };
  }

  const bid = preview.branchId;
  const posted = [];
  const runId = `OSR-${bid}-${Date.now()}`;

  db.transaction(() => {
    for (const line of preview.lines) {
      if (line.adjustment == null || Math.abs(line.adjustment) < 1e-9) continue;
      if (line.missing && line.role !== 'primary_missing_sku') continue;

      if (line.missing) {
        const unit = line.group === 'stone_flatsheet' ? 'sheet' : 'm';
        try {
          db.prepare(
            `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
             VALUES (?,?,0,?,0,0,'','','Stone coated','{}',?)`
          ).run(line.productId, line.name || line.productId, unit, bid);
        } catch {
          /* may exist */
        }
      }

      const row = getProductRowForWorkspace(db, line.productId, bid);
      if (!row) continue;
      const erp = num(row.stock_level);
      const target = num(line.target);
      const delta = target - erp;
      if (Math.abs(delta) < 1e-9) continue;

      const detailReason = line.reason || OPENING_RESET_REASON_STONE;
      const movId = appendAdjust(db, {
        productId: line.productId,
        delta,
        branchId: bid,
        dateISO: OPENING_RESET_POST_DATE,
        detail: `${detailReason}${line.note ? ` — ${line.note}` : ''}`,
        unitCostNgn: line.unitCostNgn,
      });
      posted.push({ productId: line.productId, delta, movementId: movId, target });
    }

    db.prepare(
      `INSERT INTO opening_stock_reset_runs (id, branch_id, preview_json, posted_at_iso, posted_by_user_id, posted_by_name, status, note)
       VALUES (?,?,?,?,?,?, 'posted', ?)`
    ).run(
      runId,
      bid,
      JSON.stringify({
        previewHash: preview.previewHash,
        lines: preview.lines,
        excludedAccessories: preview.excludedAccessories,
        zeroOtherMetre: preview.zeroOtherMetre,
      }),
      new Date().toISOString(),
      opts.actor?.id || null,
      opts.actor?.name || opts.actor?.displayName || null,
      String(opts.note || '').trim() || null
    );
  })();

  return { ok: true, runId, postedCount: posted.length, posted, previewHash: preview.previewHash };
}

export function isOpeningResetPosted(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM opening_stock_reset_runs
         WHERE branch_id = ? AND status = 'posted' LIMIT 1`
      )
      .get(bid);
    return Boolean(row);
  } catch {
    return false;
  }
}

export { isNegativeStockGateActive } from '../productBranchInventory.js';
