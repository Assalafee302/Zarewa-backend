import { appendAuditLog } from './controlOps.js';
import { voidRecentQuotationsAfterMasterPriceChange } from './quotationLifecycleOps.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function trimText(value) {
  return String(value ?? '').trim();
}

function boolFlag(value) {
  return value === false || value === 0 || value === '0' ? 0 : 1;
}

function sortNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.round(next) : fallback;
}

function decimalOrNull(value) {
  if (value == null || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function requireName(value, label) {
  const next = trimText(value);
  if (!next) throw new Error(`${label} is required.`);
  return next;
}

const MASTER_DATA_CONFIG = {
  'quote-items': {
    table: 'setup_quote_items',
    idColumn: 'item_id',
    prefix: 'SQI',
    auditKind: 'setup_quote_item',
    orderBy: 'sort_order ASC, name ASC, item_id ASC',
    defaults: [
      {
        id: 'SQI-001',
        itemType: 'product',
        name: 'Roofing Sheet',
        unit: 'm',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 1,
      },
      {
        id: 'SQI-002',
        itemType: 'product',
        name: 'Capping',
        unit: 'm',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 2,
      },
      {
        id: 'SQI-003',
        itemType: 'product',
        name: 'Ridge Cap',
        unit: 'm',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 3,
      },
      {
        id: 'SQI-004',
        itemType: 'product',
        name: 'Gutter',
        unit: 'm',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 4,
      },
      {
        id: 'SQI-005',
        itemType: 'accessory',
        name: 'Tapping Screw',
        unit: 'pcs',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 10,
        inventoryProductId: 'ACC-TAPPING-SCREW-PCS',
      },
      {
        id: 'SQI-006',
        itemType: 'accessory',
        name: 'Silicon Tube',
        unit: 'tube',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 11,
        inventoryProductId: 'ACC-SILICON-TUBE',
      },
      {
        id: 'SQI-007',
        itemType: 'accessory',
        name: 'Rivets',
        unit: 'pack',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 12,
        inventoryProductId: 'ACC-RIVET-PACK',
      },
      {
        id: 'SQI-008',
        itemType: 'accessory',
        name: 'Bitumen Tape',
        unit: 'roll',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 13,
      },
      {
        id: 'SQI-012',
        itemType: 'accessory',
        name: 'Drive screw nail',
        unit: 'pack',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 14,
        inventoryProductId: 'ACC-DRIVE-SCREW-PACK',
      },
      {
        id: 'SQI-013',
        itemType: 'accessory',
        name: 'Rivet pin',
        unit: 'pack',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 15,
        inventoryProductId: 'ACC-RIVET-PACK',
      },
      {
        id: 'SQI-014',
        itemType: 'accessory',
        name: 'Concrete nail',
        unit: 'pack',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 16,
        inventoryProductId: 'ACC-CONCRETE-NAIL-PACK',
      },
      {
        id: 'SQI-015',
        itemType: 'accessory',
        name: 'Copper nail',
        unit: 'pack',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 17,
        inventoryProductId: 'ACC-COPPER-NAIL-PACK',
      },
      {
        id: 'SQI-016',
        itemType: 'accessory',
        name: 'Hooks',
        unit: 'pcs',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 18,
        inventoryProductId: 'ACC-HOOKS-PCS',
      },
      {
        id: 'SQI-009',
        itemType: 'service',
        name: 'Installation',
        unit: 'job',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 20,
      },
      {
        id: 'SQI-010',
        itemType: 'service',
        name: 'Transportation',
        unit: 'job',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 21,
      },
      {
        id: 'SQI-011',
        itemType: 'service',
        name: 'Labor Charge',
        unit: 'job',
        defaultUnitPriceNgn: 0,
        active: true,
        sortOrder: 22,
      },
    ],
    normalizePayload(payload, fallbackSort = 0) {
      const itemType = trimText(payload.itemType || payload.type || 'product').toLowerCase();
      if (!['product', 'accessory', 'service'].includes(itemType)) {
        throw new Error('Quote item type must be product, accessory, or service.');
      }
      const invPid = trimText(payload.inventoryProductId ?? payload.inventory_product_id ?? '');
      return {
        itemType,
        name: requireName(payload.name, 'Item name'),
        unit: trimText(payload.unit || 'unit') || 'unit',
        defaultUnitPriceNgn: roundMoney(payload.defaultUnitPriceNgn),
        active: boolFlag(payload.active),
        sortOrder: sortNumber(payload.sortOrder, fallbackSort),
        inventoryProductId: invPid || null,
      };
    },
    toClient(row) {
      return {
        id: row.item_id,
        itemType: row.item_type,
        name: row.name,
        unit: row.unit,
        defaultUnitPriceNgn: roundMoney(row.default_unit_price_ngn),
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order) || 0,
        inventoryProductId: row.inventory_product_id ?? '',
      };
    },
  },
  colours: {
    table: 'setup_colours',
    idColumn: 'colour_id',
    prefix: 'COL',
    auditKind: 'setup_colour',
    orderBy: 'sort_order ASC, name ASC, colour_id ASC',
    defaults: [
      { id: 'COL-001', name: 'HM Blue', abbreviation: 'HMB', active: true, sortOrder: 1 },
      { id: 'COL-002', name: 'Traffic Black', abbreviation: 'TB', active: true, sortOrder: 2 },
      { id: 'COL-003', name: 'TC Red', abbreviation: 'TCR', active: true, sortOrder: 3 },
      { id: 'COL-004', name: 'Bush Green', abbreviation: 'BG', active: true, sortOrder: 4 },
      { id: 'COL-005', name: 'Zinc Grey', abbreviation: 'ZG', active: true, sortOrder: 5 },
      { id: 'COL-006', name: 'Ivory', abbreviation: 'IV', active: true, sortOrder: 6 },
      { id: 'COL-007', name: 'Navy Blue', abbreviation: 'NB', active: true, sortOrder: 7 },
      { id: 'COL-008', name: 'Pale Green', abbreviation: 'PG', active: true, sortOrder: 8 },
      { id: 'COL-009', name: 'Plain Red', abbreviation: 'PR', active: true, sortOrder: 9 },
    ],
    normalizePayload(payload, fallbackSort = 0) {
      return {
        name: requireName(payload.name, 'Colour name'),
        abbreviation: requireName(payload.abbreviation, 'Colour abbreviation').toUpperCase(),
        active: boolFlag(payload.active),
        sortOrder: sortNumber(payload.sortOrder, fallbackSort),
      };
    },
    toClient(row) {
      return {
        id: row.colour_id,
        name: row.name,
        abbreviation: row.abbreviation,
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order) || 0,
      };
    },
  },
  gauges: {
    table: 'setup_gauges',
    idColumn: 'gauge_id',
    prefix: 'GAU',
    auditKind: 'setup_gauge',
    orderBy: 'sort_order ASC, gauge_mm ASC, label ASC, gauge_id ASC',
    defaults: [
      { id: 'GAU-001', label: '0.20mm', gaugeMm: 0.2, active: true, sortOrder: 1 },
      { id: 'GAU-002', label: '0.22mm', gaugeMm: 0.22, active: true, sortOrder: 2 },
      { id: 'GAU-003', label: '0.24mm', gaugeMm: 0.24, active: true, sortOrder: 3 },
      { id: 'GAU-004', label: '0.28mm', gaugeMm: 0.28, active: true, sortOrder: 4 },
      { id: 'GAU-005', label: '0.30mm', gaugeMm: 0.3, active: true, sortOrder: 5 },
      { id: 'GAU-006', label: '0.40mm', gaugeMm: 0.4, active: true, sortOrder: 6 },
      { id: 'GAU-007', label: '0.45mm', gaugeMm: 0.45, active: true, sortOrder: 7 },
      { id: 'GAU-008', label: '0.55mm', gaugeMm: 0.55, active: true, sortOrder: 8 },
      { id: 'GAU-009', label: '0.70mm', gaugeMm: 0.7, active: true, sortOrder: 9 },
    ],
    normalizePayload(payload, fallbackSort = 0) {
      const gaugeMm = decimalOrNull(payload.gaugeMm);
      if (gaugeMm == null || gaugeMm <= 0) {
        throw new Error('Gauge thickness must be a positive number.');
      }
      return {
        label: requireName(payload.label, 'Gauge label'),
        gaugeMm,
        active: boolFlag(payload.active),
        sortOrder: sortNumber(payload.sortOrder, fallbackSort),
      };
    },
    toClient(row) {
      return {
        id: row.gauge_id,
        label: row.label,
        gaugeMm: Number(row.gauge_mm) || 0,
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order) || 0,
      };
    },
  },
  'material-types': {
    table: 'setup_material_types',
    idColumn: 'material_type_id',
    prefix: 'MAT',
    auditKind: 'setup_material_type',
    orderBy: 'sort_order ASC, name ASC, material_type_id ASC',
    defaults: [
      {
        id: 'MAT-001',
        name: 'Aluminium',
        densityKgPerM3: 7850,
        widthM: 1.2,
        active: true,
        sortOrder: 1,
        inventoryModel: 'coil_kg',
      },
      {
        id: 'MAT-002',
        name: 'Aluzinc',
        densityKgPerM3: 7850,
        widthM: 1.2,
        active: true,
        sortOrder: 2,
        inventoryModel: 'coil_kg',
      },
      {
        id: 'MAT-003',
        name: 'Longspan (finished)',
        densityKgPerM3: 7850,
        widthM: 1.2,
        active: true,
        sortOrder: 3,
        inventoryModel: 'finished_good',
      },
      {
        id: 'MAT-004',
        name: 'Accessory / non-coil',
        densityKgPerM3: 0,
        widthM: 0,
        active: true,
        sortOrder: 10,
        inventoryModel: 'consumable',
      },
      {
        id: 'MAT-005',
        name: 'Stone coated',
        densityKgPerM3: 0,
        widthM: 0,
        active: true,
        sortOrder: 4,
        inventoryModel: 'stone_meter',
      },
    ],
    normalizePayload(payload, fallbackSort = 0) {
      const inv = trimText(payload.inventoryModel || payload.inventory_model || 'coil_kg') || 'coil_kg';
      return {
        name: requireName(payload.name, 'Material type'),
        densityKgPerM3: Number(decimalOrNull(payload.densityKgPerM3) ?? 0),
        widthM: Number(decimalOrNull(payload.widthM) ?? 0),
        active: boolFlag(payload.active),
        sortOrder: sortNumber(payload.sortOrder, fallbackSort),
        inventoryModel: inv,
      };
    },
    toClient(row) {
      return {
        id: row.material_type_id,
        name: row.name,
        densityKgPerM3: Number(row.density_kg_per_m3) || 0,
        widthM: Number(row.width_m) || 0,
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order) || 0,
        inventoryModel: row.inventory_model != null ? String(row.inventory_model) : 'coil_kg',
      };
    },
  },
  profiles: {
    table: 'setup_profiles',
    idColumn: 'profile_id',
    prefix: 'PROF',
    auditKind: 'setup_profile',
    orderBy: 'sort_order ASC, name ASC, profile_id ASC',
    defaults: [
      { id: 'PROF-001', name: 'Longspan (Indus6)', active: true, sortOrder: 1, materialTypeId: 'MAT-002' },
      { id: 'PROF-002', name: 'Metrotile', active: true, sortOrder: 2, materialTypeId: 'MAT-002' },
      { id: 'PROF-003', name: 'Steptile', active: true, sortOrder: 3, materialTypeId: 'MAT-002' },
      { id: 'PROF-004', name: 'Capping', active: true, sortOrder: 4, materialTypeId: 'MAT-002' },
      { id: 'PROF-005', name: 'Ridge Cap', active: true, sortOrder: 5, materialTypeId: 'MAT-002' },
      { id: 'PROF-006', name: 'Flat Sheet', active: true, sortOrder: 6, materialTypeId: 'MAT-002' },
      { id: 'PROF-007', name: 'Milano', active: true, sortOrder: 7, materialTypeId: 'MAT-005' },
      { id: 'PROF-008', name: 'Bond', active: true, sortOrder: 8, materialTypeId: 'MAT-005' },
      { id: 'PROF-009', name: 'Classic', active: true, sortOrder: 9, materialTypeId: 'MAT-005' },
      { id: 'PROF-010', name: 'Shingle', active: true, sortOrder: 10, materialTypeId: 'MAT-005' },
    ],
    normalizePayload(payload, fallbackSort = 0) {
      return {
        name: requireName(payload.name, 'Profile name'),
        active: boolFlag(payload.active),
        sortOrder: sortNumber(payload.sortOrder, fallbackSort),
        materialTypeId: trimText(payload.materialTypeId ?? payload.material_type_id ?? ''),
      };
    },
    toClient(row) {
      return {
        id: row.profile_id,
        name: row.name,
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order) || 0,
        materialTypeId: row.material_type_id != null ? String(row.material_type_id) : '',
      };
    },
  },
  'price-list': {
    table: 'setup_price_lists',
    idColumn: 'price_id',
    prefix: 'PRI',
    auditKind: 'setup_price_list',
    orderBy: 'sort_order ASC, item_name ASC, price_id ASC',
    defaults: [
      {
        id: 'PRI-001',
        quoteItemId: 'SQI-001',
        itemName: 'Roofing Sheet',
        unit: 'm',
        unitPriceNgn: 2500,
        gaugeId: 'GAU-003',
        colourId: 'COL-001',
        materialTypeId: 'MAT-001',
        profileId: 'PROF-001',
        notes: 'Reference selling price for HM Blue 0.24mm longspan',
        active: true,
        sortOrder: 1,
      },
      {
        id: 'PRI-002',
        quoteItemId: 'SQI-002',
        itemName: 'Capping',
        unit: 'm',
        unitPriceNgn: 1800,
        gaugeId: 'GAU-003',
        colourId: '',
        materialTypeId: 'MAT-001',
        profileId: 'PROF-004',
        notes: 'Reference selling price for capping',
        active: true,
        sortOrder: 2,
      },
      {
        id: 'PRI-003',
        quoteItemId: 'SQI-009',
        itemName: 'Installation',
        unit: 'job',
        unitPriceNgn: 150000,
        gaugeId: '',
        colourId: '',
        materialTypeId: '',
        profileId: '',
        notes: 'Base installation service charge',
        active: true,
        sortOrder: 3,
      },
      {
        id: 'PRI-004',
        quoteItemId: 'SQI-010',
        itemName: 'Transportation',
        unit: 'job',
        unitPriceNgn: 85000,
        gaugeId: '',
        colourId: '',
        materialTypeId: '',
        profileId: '',
        notes: 'Reference haulage charge',
        active: true,
        sortOrder: 4,
      },
    ],
    normalizePayload(payload, fallbackSort = 0) {
      const bookLabel = trimText(payload.bookLabel) || 'Standard';
      const bookVersion = Math.max(1, sortNumber(payload.bookVersion, 1));
      let effectiveFromISO = trimText(payload.effectiveFromISO).slice(0, 10);
      if (!effectiveFromISO) effectiveFromISO = '2020-01-01';
      return {
        quoteItemId: trimText(payload.quoteItemId),
        itemName: requireName(payload.itemName, 'Price-list item name'),
        unit: trimText(payload.unit || 'unit') || 'unit',
        unitPriceNgn: roundMoney(payload.unitPriceNgn),
        gaugeId: trimText(payload.gaugeId),
        colourId: trimText(payload.colourId),
        materialTypeId: trimText(payload.materialTypeId),
        profileId: trimText(payload.profileId),
        notes: trimText(payload.notes),
        active: boolFlag(payload.active),
        sortOrder: sortNumber(payload.sortOrder, fallbackSort),
        bookLabel,
        bookVersion,
        effectiveFromISO,
      };
    },
    toClient(row) {
      return {
        id: row.price_id,
        quoteItemId: row.quote_item_id ?? '',
        itemName: row.item_name,
        unit: row.unit,
        unitPriceNgn: roundMoney(row.unit_price_ngn),
        gaugeId: row.gauge_id ?? '',
        colourId: row.colour_id ?? '',
        materialTypeId: row.material_type_id ?? '',
        profileId: row.profile_id ?? '',
        notes: row.notes ?? '',
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order) || 0,
        bookLabel: row.book_label ?? 'Standard',
        bookVersion: Math.max(1, Number(row.book_version) || 1),
        effectiveFromISO: row.effective_from_iso ?? '2020-01-01',
      };
    },
  },
  'expense-categories': {
    table: 'setup_expense_categories',
    idColumn: 'category_id',
    prefix: 'EXP',
    auditKind: 'setup_expense_category',
    orderBy: 'sort_order ASC, name ASC, category_id ASC',
    defaults: [
      { id: 'EXP-001', name: 'Diesel & fuel', code: 'FUEL', active: true, sortOrder: 1 },
      { id: 'EXP-002', name: 'Vehicle & haulage', code: 'TRANSPORT', active: true, sortOrder: 2 },
      { id: 'EXP-003', name: 'Maintenance & repairs', code: 'MAINT', active: true, sortOrder: 3 },
      { id: 'EXP-004', name: 'Utilities', code: 'UTIL', active: true, sortOrder: 4 },
      { id: 'EXP-005', name: 'Office & admin', code: 'ADMIN', active: true, sortOrder: 5 },
      { id: 'EXP-006', name: 'Staff & payroll costs', code: 'PAYROLL', active: true, sortOrder: 6 },
    ],
    normalizePayload(payload, fallbackSort = 0) {
      return {
        name: requireName(payload.name, 'Category name'),
        code: trimText(payload.code || '').toUpperCase() || null,
        active: boolFlag(payload.active),
        sortOrder: sortNumber(payload.sortOrder, fallbackSort),
      };
    },
    toClient(row) {
      return {
        id: row.category_id,
        name: row.name,
        code: row.code ?? '',
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order) || 0,
      };
    },
  },
};

const MASTER_DATA_ALIASES = {
  quoteitems: 'quote-items',
  'quote-items': 'quote-items',
  colours: 'colours',
  colors: 'colours',
  gauges: 'gauges',
  materialtypes: 'material-types',
  'material-types': 'material-types',
  profiles: 'profiles',
  pricelist: 'price-list',
  'price-list': 'price-list',
  expensecategories: 'expense-categories',
  'expense-categories': 'expense-categories',
  procurementcatalog: 'procurement-catalog',
  'procurement-catalog': 'procurement-catalog',
};

export const MASTER_DATA_KINDS = Object.keys(MASTER_DATA_CONFIG);

function resolveKind(kind) {
  const key = MASTER_DATA_ALIASES[String(kind ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-')];
  if (!key || !MASTER_DATA_CONFIG[key]) {
    throw new Error('Unknown master-data collection.');
  }
  return key;
}

function nextMasterId(db, cfg) {
  const rows = db.prepare(`SELECT ${cfg.idColumn} AS id FROM ${cfg.table}`).all();
  let max = 0;
  for (const row of rows) {
    const match = String(row.id ?? '').match(/(\d+)\s*$/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return `${cfg.prefix}-${String(max + 1).padStart(3, '0')}`;
}

function listRows(db, kind) {
  const cfg = MASTER_DATA_CONFIG[kind];
  return db
    .prepare(`SELECT * FROM ${cfg.table} ORDER BY ${cfg.orderBy}`)
    .all()
    .map((row) => cfg.toClient(row));
}

export function listMasterData(db) {
  return {
    quoteItems: listRows(db, 'quote-items'),
    colours: listRows(db, 'colours'),
    gauges: listRows(db, 'gauges'),
    materialTypes: listRows(db, 'material-types'),
    profiles: listRows(db, 'profiles'),
    priceList: listRows(db, 'price-list'),
    expenseCategories: listRows(db, 'expense-categories'),
  };
}

function getStatements(kind, row) {
  switch (kind) {
    case 'quote-items':
      return {
        values: [
          row.itemType,
          row.name,
          row.unit,
          row.defaultUnitPriceNgn,
          row.active,
          row.sortOrder,
          row.inventoryProductId || null,
        ],
        insertSql: `INSERT INTO setup_quote_items (item_id, item_type, name, unit, default_unit_price_ngn, active, sort_order, inventory_product_id) VALUES (?,?,?,?,?,?,?,?)`,
        updateSql: `UPDATE setup_quote_items SET item_type = ?, name = ?, unit = ?, default_unit_price_ngn = ?, active = ?, sort_order = ?, inventory_product_id = ? WHERE item_id = ?`,
      };
    case 'colours':
      return {
        values: [row.name, row.abbreviation, row.active, row.sortOrder],
        insertSql: `INSERT INTO setup_colours (colour_id, name, abbreviation, active, sort_order) VALUES (?,?,?,?,?)`,
        updateSql: `UPDATE setup_colours SET name = ?, abbreviation = ?, active = ?, sort_order = ? WHERE colour_id = ?`,
      };
    case 'gauges':
      return {
        values: [row.label, row.gaugeMm, row.active, row.sortOrder],
        insertSql: `INSERT INTO setup_gauges (gauge_id, label, gauge_mm, active, sort_order) VALUES (?,?,?,?,?)`,
        updateSql: `UPDATE setup_gauges SET label = ?, gauge_mm = ?, active = ?, sort_order = ? WHERE gauge_id = ?`,
      };
    case 'material-types':
      return {
        values: [row.name, row.densityKgPerM3, row.widthM, row.active, row.sortOrder, row.inventoryModel || 'coil_kg'],
        insertSql: `INSERT INTO setup_material_types (material_type_id, name, density_kg_per_m3, width_m, active, sort_order, inventory_model) VALUES (?,?,?,?,?,?,?)`,
        updateSql: `UPDATE setup_material_types SET name = ?, density_kg_per_m3 = ?, width_m = ?, active = ?, sort_order = ?, inventory_model = ? WHERE material_type_id = ?`,
      };
    case 'profiles':
      return {
        values: [row.name, row.active, row.sortOrder, row.materialTypeId || null],
        insertSql: `INSERT INTO setup_profiles (profile_id, name, active, sort_order, material_type_id) VALUES (?,?,?,?,?)`,
        updateSql: `UPDATE setup_profiles SET name = ?, active = ?, sort_order = ?, material_type_id = ? WHERE profile_id = ?`,
      };
    case 'price-list':
      return {
        values: [
          row.quoteItemId,
          row.itemName,
          row.unit,
          row.unitPriceNgn,
          row.gaugeId,
          row.colourId,
          row.materialTypeId,
          row.profileId,
          row.notes,
          row.active,
          row.sortOrder,
          row.bookLabel,
          row.bookVersion,
          row.effectiveFromISO,
        ],
        insertSql: `INSERT INTO setup_price_lists (price_id, quote_item_id, item_name, unit, unit_price_ngn, gauge_id, colour_id, material_type_id, profile_id, notes, active, sort_order, book_label, book_version, effective_from_iso) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        updateSql: `UPDATE setup_price_lists SET quote_item_id = ?, item_name = ?, unit = ?, unit_price_ngn = ?, gauge_id = ?, colour_id = ?, material_type_id = ?, profile_id = ?, notes = ?, active = ?, sort_order = ?, book_label = ?, book_version = ?, effective_from_iso = ? WHERE price_id = ?`,
      };
    case 'expense-categories':
      return {
        values: [row.name, row.code, row.active, row.sortOrder],
        insertSql: `INSERT INTO setup_expense_categories (category_id, name, code, active, sort_order) VALUES (?,?,?,?,?)`,
        updateSql: `UPDATE setup_expense_categories SET name = ?, code = ?, active = ?, sort_order = ? WHERE category_id = ?`,
      };
    case 'procurement-catalog':
      return {
        values: [
          row.color,
          row.gauge,
          row.productID,
          row.offerKg,
          row.offerMeters,
          row.conversionKgPerM,
          row.label,
        ],
        insertSql: `INSERT INTO procurement_catalog (id, color, gauge, product_id, offer_kg, offer_meters, conversion_kg_per_m, label) VALUES (?,?,?,?,?,?,?,?)`,
        updateSql: `UPDATE procurement_catalog SET color = ?, gauge = ?, product_id = ?, offer_kg = ?, offer_meters = ?, conversion_kg_per_m = ?, label = ? WHERE id = ?`,
      };
    default:
      throw new Error('Unsupported master-data collection.');
  }
}

export function upsertMasterDataRecord(db, kind, payload, actor) {
  const resolved = resolveKind(kind);
  const cfg = MASTER_DATA_CONFIG[resolved];
  const currentRows = listRows(db, resolved);
  const fallbackSort = currentRows.length + 1;
  const row = cfg.normalizePayload(payload || {}, fallbackSort);
  const requestedId = trimText(payload?.id);
  const id = requestedId || nextMasterId(db, cfg);
  const existing = requestedId
    ? db.prepare(`SELECT ${cfg.idColumn} AS id FROM ${cfg.table} WHERE ${cfg.idColumn} = ?`).get(requestedId)
    : null;
  const stmt = getStatements(resolved, row);
  db.transaction(() => {
    if (existing) {
      db.prepare(stmt.updateSql).run(...stmt.values, id);
    } else {
      try {
        db.prepare(stmt.insertSql).run(id, ...stmt.values);
      } catch (e) {
        // Windows / WAL edge cases: row may exist though pre-insert SELECT missed it.
        if (e && (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE')) {
          db.prepare(stmt.updateSql).run(...stmt.values, id);
        } else {
          throw e;
        }
      }
    }
    if (actor) {
      appendAuditLog(db, {
        actor,
        action: existing ? `${cfg.auditKind}.update` : `${cfg.auditKind}.create`,
        entityKind: cfg.auditKind,
        entityId: id,
        note: `${row.label || row.name || row.itemName || id} saved in setup`,
        details: { collection: resolved },
      });
    }
  })();
  if (resolved === 'quote-items' || resolved === 'price-list') {
    try {
      voidRecentQuotationsAfterMasterPriceChange(db, 'ALL');
    } catch (e) {
      console.error('[zarewa] void quotations after master price change failed', e);
    }
  }
  return { ok: true, id };
}

export function deleteMasterDataRecord(db, kind, recordId, actor) {
  const resolved = resolveKind(kind);
  const cfg = MASTER_DATA_CONFIG[resolved];
  const id = trimText(recordId);
  if (!id) return { ok: false, error: 'Record id is required.' };
  const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE ${cfg.idColumn} = ?`).get(id);
  if (!row) return { ok: false, error: 'Setup record not found.' };
  db.transaction(() => {
    db.prepare(`DELETE FROM ${cfg.table} WHERE ${cfg.idColumn} = ?`).run(id);
    appendAuditLog(db, {
      actor,
      action: `${cfg.auditKind}.delete`,
      entityKind: cfg.auditKind,
      entityId: id,
      note: `${row.label || row.name || row.item_name || id} removed from setup`,
      details: { collection: resolved },
    });
  })();
  if (resolved === 'quote-items' || resolved === 'price-list') {
    try {
      voidRecentQuotationsAfterMasterPriceChange(db, 'ALL');
    } catch (e) {
      console.error('[zarewa] void quotations after master price delete failed', e);
    }
  }
  return { ok: true };
}

function seedCollection(db, kind) {
  const cfg = MASTER_DATA_CONFIG[kind];
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${cfg.table}`).get().c;
  if (count > 0) return;
  const seeded = cfg.defaults || [];
  for (const row of seeded) {
    upsertMasterDataRecord(db, kind, row, null);
  }
}

export function seedMasterData(db) {
  for (const kind of MASTER_DATA_KINDS) {
    seedCollection(db, kind);
  }
}
