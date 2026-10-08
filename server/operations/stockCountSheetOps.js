/**
 * Physical stock count sheets for Operations → Stock.
 * Store copy hides ERP quantities; manager copy includes them.
 * Tails and zero-stock accessories/stone are excluded.
 */
import XLSX from 'xlsx';
import { STONE_FLATSHEET_WIDTH_M } from '../../shared/lib/poLineTypes.js';
import { DEFAULT_BRANCH_ID, getBranch } from '../branches.js';

export const COUNT_SHEET_BRANCH_IDS = Object.freeze(['BR-KD', 'BR-YL', 'BR-MDG']);
export const COUNT_FOOTER = 'Counted by ____  Checked by ____  Date/time ____';
export const MANAGER_FOOTER = 'Do not give this sheet to the store';
const TAIL_HOLD = 'Tail – not prime stock';
const EXCLUDED_COIL_STATUSES = new Set(['consumed', 'finished', 'written off', 'written_off', 'scrap']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round3(n) {
  return Math.round(num(n) * 1000) / 1000;
}

/** @param {string | null | undefined} stockHold */
export function isTailStockHold(stockHold) {
  const h = String(stockHold || '').trim();
  if (!h) return false;
  if (h === TAIL_HOLD) return true;
  return /tail/i.test(h) && /not prime/i.test(h);
}

function gaugeKey(g) {
  const s = String(g || '').trim();
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 999;
}

function sortCoils(rows) {
  return rows.slice().sort((a, b) => {
    const ga = gaugeKey(a.gaugeLabel);
    const gb = gaugeKey(b.gaugeLabel);
    if (ga !== gb) return ga - gb;
    const ca = String(a.colour || '').localeCompare(String(b.colour || ''), undefined, { sensitivity: 'base' });
    if (ca) return ca;
    return String(a.coilNo).localeCompare(String(b.coilNo));
  });
}

function parseAttrs(p) {
  try {
    return p.dashboard_attrs_json ? JSON.parse(p.dashboard_attrs_json) : {};
  } catch {
    return {};
  }
}

function flatsheetLengthM(p) {
  const attrs = parseAttrs(p);
  const fromAttr = Number(attrs.stoneFlatsheetLengthM ?? attrs.flatsheetLengthM);
  if (fromAttr === 1.4 || fromAttr === 2) return fromAttr;
  const hay = `${p.product_id} ${p.name}`.toLowerCase();
  if (/1\.4|1p4|1_4/.test(hay)) return 1.4;
  if (/\b2m\b|2\.0|[^0-9]2m/.test(hay) || /-2m\b/.test(hay)) return 2;
  if (hay.includes('2m')) return 2;
  return 2;
}

function erpSheets(p) {
  const m2 = num(p.stock_level);
  const len = flatsheetLengthM(p);
  const per = len * STONE_FLATSHEET_WIDTH_M;
  if (!(per > 0)) return null;
  return round3(m2 / per);
}

/** @param {{ product_id?: string, unit?: string, name?: string, dashboard_attrs_json?: string }} p */
export function countUnitForProduct(p) {
  const pid = String(p.product_id || '');
  const unit = String(p.unit || '').toLowerCase().trim();
  const name = String(p.name || '').toLowerCase();
  if (/^STONE-FS-/i.test(pid)) {
    return `sheet (${flatsheetLengthM(p)} m)`;
  }
  if (/^STONE-/i.test(pid)) return 'metre';
  if (/carton|ctn/.test(unit) || /carton|ctn/.test(name)) return 'carton';
  if (/tube/.test(unit) || /tube|silicon|silicone|repair.?kit/.test(name)) return 'tube';
  if (/pack|pkt|kit|roll/.test(unit) || /\bpack\b|\broll\b/.test(name)) return 'pack';
  if (/metre|meter|^m$/.test(unit)) return 'metre';
  if (/sheet/.test(unit)) return 'sheet';
  if (/pcs|pc|piece/.test(unit) || /pcs|piece/.test(name)) return 'pcs';
  if (unit) return unit;
  return 'pcs';
}

function walkGroup(pid) {
  if (/^STONE-FS-/i.test(pid)) return 3;
  if (/^STONE-/i.test(pid)) return 2;
  return 1;
}

function stoneDesign(p) {
  const name = String(p.name || '');
  const m = name.match(/Stone coated\s+([^/]+)\s*\//i);
  if (m) return m[1].trim();
  const pid = String(p.product_id || '');
  const idm = pid.match(/^STONE-([a-z0-9]+)-/i);
  if (idm) return idm[1].charAt(0).toUpperCase() + idm[1].slice(1);
  return '';
}

function itemLabel(p) {
  const pid = String(p.product_id || '');
  const name = String(p.name || pid).trim();
  if (/^STONE-FS-/i.test(pid)) {
    const len = flatsheetLengthM(p);
    const col = String(p.colour || '').trim();
    return col ? `Stone flatsheet ${col} (${len} m)` : `${name} (${len} m)`;
  }
  if (/^STONE-/i.test(pid)) {
    const design = stoneDesign(p);
    const col = String(p.colour || '').trim();
    const g = String(p.gauge || '').trim();
    const parts = [design, col, g].filter(Boolean);
    return parts.length ? parts.join(' / ') : name.replace(/^Stone coated\s+/i, '');
  }
  return name;
}

/**
 * @param {string | null | undefined} branchId
 * @returns {{ ok: true, branchId: string } | { ok: false, error: string }}
 */
export function assertCountSheetBranchId(branchId) {
  const bid = String(branchId || '').trim();
  if (!bid || bid === 'ALL') {
    return { ok: false, error: 'Select a branch workspace (KD, YL, or MDG — not HQ roll-up).' };
  }
  if (!COUNT_SHEET_BRANCH_IDS.includes(bid)) {
    return { ok: false, error: `Branch must be one of ${COUNT_SHEET_BRANCH_IDS.join(', ')}.` };
  }
  return { ok: true, branchId: bid };
}

/**
 * Build walk-order count pack for one branch.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @returns {{ ok: true, pack: object } | { ok: false, error: string }}
 */
export function buildStockCountSheet(db, branchId) {
  const gate = assertCountSheetBranchId(branchId);
  if (!gate.ok) return gate;
  const bid = gate.branchId;
  const branch = getBranch(db, bid);
  const branchCode = branch?.code || bid.replace(/^BR-/, '');
  const branchName = branch?.name || bid;
  const asAtIso = new Date().toISOString();

  const coilRows = db
    .prepare(
      `SELECT coil_no, colour, gauge_label, qty_remaining, current_weight_kg, current_status,
              IFNULL(stock_hold,'') AS stock_hold, IFNULL(location,'') AS location,
              IFNULL(material_type_name,'') AS material_type_name
       FROM coil_lots
       WHERE branch_id = ?
         AND qty_remaining > 0.0001
         AND LOWER(IFNULL(current_status,'')) NOT IN ('consumed','finished','written off','written_off','scrap')`
    )
    .all(bid);

  const primeRaw = coilRows
    .filter((r) => !isTailStockHold(r.stock_hold))
    .filter((r) => !EXCLUDED_COIL_STATUSES.has(String(r.current_status || '').toLowerCase().trim()))
    .map((r) => ({
      coilNo: r.coil_no,
      colour: r.colour || '',
      gaugeLabel: r.gauge_label || '',
      erpKg: round3(r.qty_remaining ?? r.current_weight_kg),
      location: r.location || '',
      materialTypeName: r.material_type_name || '',
    }));
  const coils = sortCoils(primeRaw).map((row, i) => ({ ...row, no: i + 1 }));

  const products = db
    .prepare(
      `SELECT product_id, name, unit, stock_level, colour, gauge, material_type, dashboard_attrs_json
       FROM products
       WHERE branch_id = ?
         AND (product_id LIKE 'ACC-%' OR product_id LIKE 'STONE-%')
       ORDER BY product_id`
    )
    .all(bid);

  const accessoriesStone = products
    .filter((p) => num(p.stock_level) > 0.0001)
    .map((p) => {
      const isFs = /^STONE-FS-/i.test(p.product_id);
      const isStone = /^STONE-/i.test(p.product_id) && !isFs;
      const lengthM = isFs ? flatsheetLengthM(p) : null;
      return {
        productId: p.product_id,
        item: itemLabel(p),
        countUnit: countUnitForProduct(p),
        erpQty: isFs ? erpSheets(p) : round3(p.stock_level),
        colour: String(p.colour || ''),
        gauge: String(p.gauge || ''),
        design: isStone ? stoneDesign(p) : '',
        lengthM,
        isFs,
        isStone,
        walkGroup: walkGroup(p.product_id),
        nameSort: String(p.name || p.product_id),
      };
    })
    .sort((a, b) => {
      if (a.walkGroup !== b.walkGroup) return a.walkGroup - b.walkGroup;
      if (a.walkGroup === 3) {
        if (a.lengthM !== b.lengthM) return (a.lengthM || 0) - (b.lengthM || 0);
        return a.colour.localeCompare(b.colour) || a.nameSort.localeCompare(b.nameSort);
      }
      if (a.walkGroup === 2) {
        const d = a.design.localeCompare(b.design, undefined, { sensitivity: 'base' });
        if (d) return d;
        const c = a.colour.localeCompare(b.colour, undefined, { sensitivity: 'base' });
        if (c) return c;
        return a.gauge.localeCompare(b.gauge) || a.nameSort.localeCompare(b.nameSort);
      }
      return a.nameSort.localeCompare(b.nameSort);
    })
    .map((row, i) => ({
      no: i + 1,
      productId: row.productId,
      item: row.item,
      countUnit: row.countUnit,
      erpQty: row.erpQty,
      colour: row.colour,
      gauge: row.gauge,
      lengthM: row.lengthM,
      isFs: row.isFs,
      isStone: row.isStone,
      section: row.isFs ? 'Flatsheet' : row.isStone ? 'Stone' : 'Accessory',
    }));

  const managerRows = [
    ...coils.map((c) => ({
      section: 'Coil',
      no: c.no,
      item: c.coilNo,
      colour: c.colour,
      unit: c.gaugeLabel,
      erp: c.erpKg,
      remarks: '',
    })),
    ...accessoriesStone.map((a) => ({
      section: a.section,
      no: a.no,
      item: a.item,
      colour: a.colour,
      unit: a.countUnit,
      erp: a.erpQty,
      remarks: a.isFs
        ? `ERP shown in sheets (${a.lengthM} m × ${STONE_FLATSHEET_WIDTH_M} m wide)`
        : '',
    })),
  ];

  return {
    ok: true,
    pack: {
      branchId: bid,
      branchCode,
      branchName,
      asAtIso,
      footer: COUNT_FOOTER,
      managerFooter: MANAGER_FOOTER,
      coils,
      accessoriesStone,
      managerRows,
      counts: {
        coils: coils.length,
        accessoriesStone: accessoriesStone.length,
        manager: managerRows.length,
      },
    },
  };
}

/**
 * @param {object} pack — from buildStockCountSheet().pack
 * @returns {Buffer}
 */
export function buildStockCountSheetWorkbook(pack) {
  const wb = XLSX.utils.book_new();
  const stamp = String(pack.asAtIso || new Date().toISOString()).slice(0, 16).replace('T', ' ');
  const label = `${pack.branchName || pack.branchId} (${pack.branchId})`;

  const coilAoA = [
    ['No', 'Coil no. (ERP)', 'Colour', 'Gauge', 'Present? (✓/✗)', 'Kg on tag', 'Remarks'],
    ...(pack.coils || []).map((r) => [r.no, r.coilNo, r.colour, r.gaugeLabel, '', '', '']),
  ];
  const coilSheet = XLSX.utils.aoa_to_sheet(coilAoA);
  coilSheet['!cols'] = [{ wch: 5 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, coilSheet, 'Count – Coils');

  const accAoA = [
    ['No', 'Item', 'Count unit (carton/pack/tube/pcs/metre/sheet)', 'Counted qty', 'Remarks'],
    ...(pack.accessoriesStone || []).map((r) => [r.no, r.item, r.countUnit, '', '']),
  ];
  const accSheet = XLSX.utils.aoa_to_sheet(accAoA);
  accSheet['!cols'] = [{ wch: 5 }, { wch: 36 }, { wch: 18 }, { wch: 12 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, accSheet, 'Count – Accessories & Stone');

  const mgrAoA = [
    [
      'Section',
      'No',
      'Coil no. / Item',
      'Colour',
      'Gauge / Count unit',
      'Present? (✓/✗)',
      'Kg on tag / Counted qty',
      'ERP (kg / qty)',
      'Remarks',
    ],
    ...(pack.managerRows || []).map((r) => [
      r.section,
      r.no,
      r.item,
      r.colour,
      r.unit,
      '',
      '',
      r.erp,
      r.remarks || '',
    ]),
  ];
  const mgrSheet = XLSX.utils.aoa_to_sheet(mgrAoA);
  mgrSheet['!cols'] = [
    { wch: 12 },
    { wch: 5 },
    { wch: 34 },
    { wch: 14 },
    { wch: 16 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, mgrSheet, 'Manager copy');

  // Title notes as a tiny meta sheet so print headers are discoverable in Excel.
  const meta = XLSX.utils.aoa_to_sheet([
    ['Zarewa physical stock count'],
    ['Branch', label],
    ['As at', stamp],
    ['Store footer', pack.footer || COUNT_FOOTER],
    ['Manager footer', pack.managerFooter || MANAGER_FOOTER],
    ['Coils', pack.counts?.coils ?? (pack.coils || []).length],
    ['Accessories & stone', pack.counts?.accessoriesStone ?? (pack.accessoriesStone || []).length],
  ]);
  XLSX.utils.book_append_sheet(wb, meta, 'Meta');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/**
 * @param {object} pack
 * @returns {string}
 */
export function stockCountSheetFilename(pack) {
  const code = String(pack.branchCode || pack.branchId || DEFAULT_BRANCH_ID).replace(/[^\w-]+/g, '');
  const stamp = String(pack.asAtIso || new Date().toISOString())
    .slice(0, 16)
    .replace(/[:T]/g, '-');
  return `${code}-stock-count-${stamp}.xlsx`;
}
