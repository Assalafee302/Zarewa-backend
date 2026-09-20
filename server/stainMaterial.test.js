import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { floorNgnForServiceLine, applyPricingSnapshotsToServices } from './pricingPolicyResolve.js';
import { quotationPriceViolations } from './pricingOps.js';
import {
  approveMaterialIncident,
  computePoolSummary,
  createCoilDamageMaterialIncident,
  issueOffcutSupplyForProductionTx,
} from './materialIncidentOps.js';
import { insertCuttingList, insertProductionJob } from './writeOps.js';
import { completeProductionJob, saveProductionJobAllocations, startProductionJob } from './productionTraceability.js';
import { STAIN_MATERIAL_TYPE_ID } from '../shared/lib/stainMaterialPolicy.js';
import { quotedAboveFloorCreditNgn } from '../shared/lib/refundQuotedAboveFloor.js';
import { isStainMeterQuotationLinesJson } from './stoneInventory.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

const BM = { userId: 'mgr', displayName: 'Manager', roleKey: 'sales_manager' };
const STORE = { userId: 'u1', displayName: 'Store', roleKey: 'storekeeper' };

describe.skipIf(!mysqlOk)('stain material type', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso
      ) VALUES ('MPS-STAIN', 'aluzinc', '0.45', ?, 'longspan', 5000, 200, '2026-01-01')`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, material_type, branch_id)
       VALUES ('PRD-STAIN-COIL', 'Aluzinc coil', 8000, 'kg', 'Aluzinc', ?)`
    ).run(DEFAULT_BRANCH_ID);
    for (const coilNo of ['C-STAIN-1', 'C-STAIN-2']) {
      db.prepare(
        `INSERT INTO coil_lots (
          coil_no, product_id, branch_id, gauge_label, colour, qty_received, qty_remaining,
          current_weight_kg, supplier_conversion_kg_per_m, current_status, material_type_name
        ) VALUES (?, 'PRD-STAIN-COIL', ?, '0.45mm', 'Charcoal', 4000, 4000, 4000, 2.65, 'available', 'Aluzinc')`
      ).run(coilNo, DEFAULT_BRANCH_ID);
    }
  });

  afterEach(() => {
    db?.close();
  });

  it('seeds MAT-006 Stain as stain_meter', () => {
    const row = db
      .prepare(`SELECT name, inventory_model, active FROM setup_material_types WHERE material_type_id = ?`)
      .get(STAIN_MATERIAL_TYPE_ID);
    expect(row?.name).toBe('Stain');
    expect(row?.inventory_model).toBe('stain_meter');
    expect(Number(row?.active)).toBe(1);
    expect(isStainMeterQuotationLinesJson(db, { materialTypeId: STAIN_MATERIAL_TYPE_ID })).toBe(true);
    expect(isStainMeterQuotationLinesJson(db, { materialTypeId: 'MAT-002' })).toBe(false);
  });

  it('stain floor is parent workbook floor minus 1000; quoting it is not below-floor', () => {
    const headerCtx = {
      materialTypeId: STAIN_MATERIAL_TYPE_ID,
      stainSourceMaterialTypeId: 'MAT-002',
      materialGauge: '0.45mm',
      materialDesign: 'Longspan (Indus6)',
      productName: 'Roofing Sheet',
    };
    const floor = floorNgnForServiceLine(db, { name: 'Roofing Sheet' }, DEFAULT_BRANCH_ID, headerCtx);
    expect(floor).toBe(4000);

    const lines = [{ name: 'Roofing Sheet', meters: 10 }];
    applyPricingSnapshotsToServices(db, lines, DEFAULT_BRANCH_ID, headerCtx);
    expect(lines[0].floorPricePerMeter).toBe(4000);
    expect(lines[0].unitPrice).toBe(4000);

    const okRow = {
      id: 'QT-STAIN-OK',
      branch_id: DEFAULT_BRANCH_ID,
      date_iso: '2026-06-01',
      paid_ngn: 0,
      lines_json: JSON.stringify({
        materialTypeId: STAIN_MATERIAL_TYPE_ID,
        stainSourceMaterialTypeId: 'MAT-002',
        materialGauge: '0.45mm',
        materialDesign: 'Longspan (Indus6)',
        products: [
          {
            name: 'Roofing Sheet',
            meters: 10,
            unitPrice: 4000,
            floorPricePerMeter: 4000,
            gauge: '0.45mm',
            design: 'Longspan (Indus6)',
          },
        ],
        services: [],
      }),
    };
    const ok = quotationPriceViolations(db, okRow, { pricingMode: 'current' });
    expect(ok.violations.filter((v) => v.code === 'below_floor')).toHaveLength(0);

    const lowRow = {
      ...okRow,
      id: 'QT-STAIN-LOW',
      lines_json: JSON.stringify({
        ...JSON.parse(okRow.lines_json),
        products: [
          {
            name: 'Roofing Sheet',
            meters: 10,
            unitPrice: 3999,
            floorPricePerMeter: 4000,
            gauge: '0.45mm',
            design: 'Longspan (Indus6)',
          },
        ],
      }),
    };
    const low = quotationPriceViolations(db, lowRow, { pricingMode: 'current' });
    expect(low.violations.filter((v) => v.code === 'below_floor').length).toBeGreaterThan(0);

    expect(quotedAboveFloorCreditNgn(4000, 4000, 10)).toBe(0);
    expect(quotedAboveFloorCreditNgn(5000, 4000, 10)).toBe(10_000);
  });

  function postIncident(type, meters, coilNo = 'C-STAIN-1') {
    const created = createCoilDamageMaterialIncident(
      db,
      {
        coilNo,
        beforeKg: 3800,
        afterKg: 3500,
        meters,
        incidentType: type,
        note: `${type} section cut for stain tests`,
        submit: true,
      },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: STORE }
    );
    expect(created.ok).toBe(true);
    const approved = approveMaterialIncident(
      db,
      created.id,
      { managerRemark: 'Posted for stain tests' },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: BM }
    );
    expect(approved.ok).toBe(true);
    return created.id;
  }

  it('splits coil_stain into stain pool and blocks cross-issue with generic offcut', () => {
    const stainId = postIncident('coil_stain', 40, 'C-STAIN-1');
    const offcutId = postIncident('yard_offcut', 25, 'C-STAIN-2');

    const pool = computePoolSummary(db, DEFAULT_BRANCH_ID);
    expect(pool.stainMetersAvailable).toBeCloseTo(40, 2);
    expect(pool.productionOffcutMetersAvailable).toBeCloseTo(25, 2);
    expect(pool.bySpec.some((r) => r.poolKind === 'stain' && r.metersAvailable >= 39)).toBe(true);
    expect(pool.stainInventory.totals.lotCount).toBeGreaterThanOrEqual(1);
    expect(pool.stainInventory.lots.some((l) => l.coilNo === 'C-STAIN-1' && l.estMeters >= 39)).toBe(true);

    const stainJob = { job_id: 'JOB-STAIN-X', quotation_ref: 'QT-STAIN-X' };
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-STAIN-X', 'Stain Cust', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id
      ) VALUES ('QT-STAIN-X', 'CUS-STAIN-X', 'Stain Cust', 160000, 160000, 'Paid', 'Approved', ?, '2026-06-01', ?)`
    ).run(
      JSON.stringify({
        materialTypeId: STAIN_MATERIAL_TYPE_ID,
        stainSourceMaterialTypeId: 'MAT-002',
        materialGauge: '0.45mm',
        materialColor: 'Charcoal',
        materialDesign: 'Longspan (Indus6)',
        products: [{ name: 'Roofing Sheet', qty: '40', unitPrice: '4000' }],
      }),
      DEFAULT_BRANCH_ID
    );

    expect(() =>
      issueOffcutSupplyForProductionTx(db, stainJob, [{ materialIncidentId: offcutId, meters: 10 }], BM)
    ).toThrow(/coil stain metres/i);

    const regularJob = { job_id: 'JOB-REG-X', quotation_ref: 'QT-REG-X' };
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id
      ) VALUES ('QT-REG-X', 'CUS-STAIN-X', 'Stain Cust', 200000, 200000, 'Paid', 'Approved', ?, '2026-06-01', ?)`
    ).run(
      JSON.stringify({
        materialTypeId: 'MAT-002',
        materialGauge: '0.45mm',
        materialColor: 'Charcoal',
        materialDesign: 'Longspan (Indus6)',
        products: [{ name: 'Roofing Sheet', qty: '40', unitPrice: '5000' }],
      }),
      DEFAULT_BRANCH_ID
    );
    expect(() =>
      issueOffcutSupplyForProductionTx(db, regularJob, [{ materialIncidentId: stainId, meters: 10 }], BM)
    ).toThrow(/reserved for stain/i);

    const supplied = issueOffcutSupplyForProductionTx(
      db,
      stainJob,
      [{ materialIncidentId: stainId, meters: 10 }],
      BM
    );
    expect(supplied).toHaveLength(1);
    expect(supplied[0].meters).toBe(10);
  });

  it('stain production starts without coils and completes by issuing stain metres', () => {
    const stainId = postIncident('coil_stain', 50, 'C-STAIN-1');
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-STAIN-P', 'Stain Prod', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json,
        date_iso, branch_id, manager_production_approved_at_iso, manager_production_approval_level
      ) VALUES ('QT-STAIN-P', 'CUS-STAIN-P', 'Stain Prod', 160000, 0, 'Unpaid', 'Approved', ?, '2026-06-01', ?, ?, 'admin')`
    ).run(
      JSON.stringify({
        materialTypeId: STAIN_MATERIAL_TYPE_ID,
        stainSourceMaterialTypeId: 'MAT-002',
        materialGauge: '0.45mm',
        materialColor: 'Charcoal',
        materialDesign: 'Longspan (Indus6)',
        products: [{ name: 'Roofing Sheet', qty: '40', unitPrice: '4000', floorPricePerMeter: 4000 }],
      }),
      DEFAULT_BRANCH_ID,
      '2026-06-01T00:00:00.000Z'
    );

    const cl = insertCuttingList(db, {
      quotationRef: 'QT-STAIN-P',
      lines: [{ sheets: 8, lengthM: 5, lineType: 'Roof' }],
    });
    expect(cl.ok).toBe(true);
    const job = insertProductionJob(db, { cuttingListId: cl.id });
    expect(job.ok).toBe(true);

    const started = startProductionJob(db, job.jobID);
    expect(started.ok).toBe(true);

    const empty = completeProductionJob(db, job.jobID, { offcutMetersProduced: 20 });
    expect(empty.ok).toBe(false);
    expect(String(empty.error)).toMatch(/yard|matching coil/i);

    const done = completeProductionJob(db, job.jobID, {
      completeMode: 'offcut',
      offcutMetersProduced: 20,
      offcutInventoryMeters: 20,
      offcutSupply: [{ materialIncidentId: stainId, meters: 20 }],
    });
    expect(done.ok).toBe(true);
    const avail = db.prepare(`SELECT meters_available FROM material_incidents WHERE id = ?`).get(stainId);
    expect(Number(avail.meters_available)).toBeCloseTo(30, 2);
  });

  it('coil_stain on a reserved production coil shrinks the job allocation and fills the stain pool', () => {
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-STAIN-RUN', 'Run Cust', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json,
        date_iso, branch_id, manager_production_approved_at_iso, manager_production_approval_level
      ) VALUES ('QT-STAIN-RUN', 'CUS-STAIN-RUN', 'Run Cust', 200000, 0, 'Unpaid', 'Approved', ?, '2026-06-01', ?, ?, 'admin')`
    ).run(
      JSON.stringify({
        materialTypeId: 'MAT-002',
        materialGauge: '0.45mm',
        materialColor: 'Charcoal',
        materialDesign: 'Longspan (Indus6)',
        products: [{ name: 'Roofing Sheet', qty: '40', unitPrice: '5000', floorPricePerMeter: 5000 }],
      }),
      DEFAULT_BRANCH_ID,
      '2026-06-01T00:00:00.000Z'
    );
    const cl = insertCuttingList(db, {
      quotationRef: 'QT-STAIN-RUN',
      lines: [{ sheets: 8, lengthM: 5, lineType: 'Roof' }],
    });
    expect(cl.ok).toBe(true);
    const job = insertProductionJob(db, { cuttingListId: cl.id });
    expect(job.ok).toBe(true);

    const allocated = saveProductionJobAllocations(
      db,
      job.jobID,
      [{ coilNo: 'C-STAIN-1', openingWeightKg: 4000 }],
      { workspaceBranchId: DEFAULT_BRANCH_ID }
    );
    expect(allocated.ok).toBe(true);
    const reservedBefore = db.prepare(`SELECT qty_reserved, qty_remaining FROM coil_lots WHERE coil_no = 'C-STAIN-1'`).get();
    expect(Number(reservedBefore.qty_reserved)).toBeCloseTo(4000, 2);

    const created = createCoilDamageMaterialIncident(
      db,
      {
        coilNo: 'C-STAIN-1',
        beforeKg: 4000,
        afterKg: 3700,
        meters: 40,
        incidentType: 'coil_stain',
        note: 'Stain band on the running coil cut out',
        submit: true,
      },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: STORE }
    );
    expect(created.ok).toBe(true);
    expect(created.incident?.productionJobId || created.incident?.production_job_id).toBe(job.jobID);

    const approved = approveMaterialIncident(
      db,
      created.id,
      { managerRemark: 'Stain on production coil posted' },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: BM }
    );
    expect(approved.ok).toBe(true);

    const coilAfter = db.prepare(`SELECT qty_reserved, qty_remaining FROM coil_lots WHERE coil_no = 'C-STAIN-1'`).get();
    expect(Number(coilAfter.qty_remaining)).toBeCloseTo(3700, 2);
    expect(Number(coilAfter.qty_reserved)).toBeCloseTo(3700, 2);
    const allocAfter = db
      .prepare(`SELECT opening_weight_kg FROM production_job_coils WHERE job_id = ? AND coil_no = 'C-STAIN-1'`)
      .get(job.jobID);
    expect(Number(allocAfter?.opening_weight_kg)).toBeCloseTo(3700, 2);

    const pool = computePoolSummary(db, DEFAULT_BRANCH_ID);
    expect(pool.stainMetersAvailable).toBeCloseTo(40, 2);
  });

  it('stain jobs may allocate a matching parent-family coil', () => {
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-STAIN-COIL', 'Stain Coil Cust', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json,
        date_iso, branch_id, manager_production_approved_at_iso, manager_production_approval_level
      ) VALUES ('QT-STAIN-COIL', 'CUS-STAIN-COIL', 'Stain Coil Cust', 160000, 0, 'Unpaid', 'Approved', ?, '2026-06-01', ?, ?, 'admin')`
    ).run(
      JSON.stringify({
        materialTypeId: STAIN_MATERIAL_TYPE_ID,
        stainSourceMaterialTypeId: 'MAT-002',
        materialGauge: '0.45mm',
        materialColor: 'Charcoal',
        materialDesign: 'Longspan (Indus6)',
        products: [{ name: 'Roofing Sheet', qty: '40', unitPrice: '4000', floorPricePerMeter: 4000 }],
      }),
      DEFAULT_BRANCH_ID,
      '2026-06-01T00:00:00.000Z'
    );
    const cl = insertCuttingList(db, {
      quotationRef: 'QT-STAIN-COIL',
      lines: [{ sheets: 8, lengthM: 5, lineType: 'Roof' }],
    });
    expect(cl.ok).toBe(true);
    const job = insertProductionJob(db, { cuttingListId: cl.id });
    expect(job.ok).toBe(true);
    const allocated = saveProductionJobAllocations(
      db,
      job.jobID,
      [{ coilNo: 'C-STAIN-2', openingWeightKg: 800 }],
      { workspaceBranchId: DEFAULT_BRANCH_ID }
    );
    expect(allocated.ok).toBe(true);
    const rows = db.prepare(`SELECT coil_no, opening_weight_kg FROM production_job_coils WHERE job_id = ?`).all(job.jobID);
    expect(rows).toHaveLength(1);
    expect(rows[0].coil_no).toBe('C-STAIN-2');
  });
});
