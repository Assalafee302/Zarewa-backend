import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { insertCuttingList, insertProductionJob } from './writeOps.js';
import { startProductionJob } from './productionTraceability.js';

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

describe.skipIf(!mysqlOk)('production below-floor price is warn-only', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-PF-1', 'Price Filter Customer', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso
      ) VALUES ('MPS-PF', 'alu', '0.24', ?, 'iv', 4000, 400, '2026-01-01')`
    ).run(DEFAULT_BRANCH_ID);
  });

  afterEach(() => {
    db?.close();
  });

  function linesJson(unitPrice) {
    return JSON.stringify({
      materialGauge: '0.24mm',
      materialDesign: 'IV',
      materialTypeId: '',
      products: [
        {
          name: 'Roofing Sheet',
          qty: '10',
          meters: 10,
          unitPrice,
          floorPricePerMeter: 4000,
          gauge: '0.24mm',
          design: 'IV',
          materialType: 'alu',
        },
      ],
      accessories: [],
      services: [],
    });
  }

  function insertQuote(id, unitPrice, totalNgn) {
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json,
        date_iso, branch_id, manager_production_approved_at_iso, manager_production_approval_level
      ) VALUES (?, 'CUS-PF-1', 'Price Filter Customer', ?, 0, 'Unpaid', 'Approved', ?, '2026-03-15', ?, ?, 'admin')`
    ).run(id, totalNgn, linesJson(unitPrice), DEFAULT_BRANCH_ID, '2026-03-15T00:00:00.000Z');
  }

  it('still blocks a new cutting list when the quote is below floor', () => {
    insertQuote('QT-PF-CL', 500, 5000);
    const cl = insertCuttingList(db, {
      quotationRef: 'QT-PF-CL',
      lines: [{ sheets: 2, lengthM: 5, totalM: 10, lineType: 'Roof' }],
    });
    expect(cl.ok).toBe(false);
    expect(cl.code).toBe('BELOW_FLOOR_MD_APPROVAL_REQUIRED');
    expect(String(cl.error || '')).toMatch(/cutting list/i);
  });

  it('registers and starts production with a warning after the quote already passed earlier price stages', () => {
    insertQuote('QT-PF-PROD', 4000, 40000);
    const cl = insertCuttingList(db, {
      quotationRef: 'QT-PF-PROD',
      lines: [{ sheets: 2, lengthM: 5, totalM: 10, lineType: 'Roof' }],
    });
    expect(cl.ok).toBe(true);

    db.prepare(
      `UPDATE quotations SET lines_json = ?, price_exception_md_review_required = 1 WHERE id = ?`
    ).run(linesJson(500), 'QT-PF-PROD');

    const job = insertProductionJob(db, { cuttingListId: cl.id });
    expect(job.ok).toBe(true);
    expect(job.jobID).toBeTruthy();
    expect(String(job.warning || '')).toMatch(/workbook floor/i);
    expect(job.warnings?.some((v) => v.code === 'below_floor')).toBe(true);

    const started = startProductionJob(db, job.jobID, { startMode: 'offcut' });
    expect(started.ok).toBe(true);
    expect(started.error).toBeUndefined();
    expect(String(started.warning || '')).toMatch(/Production can proceed/i);
    expect(started.warnings?.some((v) => v.code === 'below_floor')).toBe(true);

    const row = db.prepare(`SELECT status FROM production_jobs WHERE job_id = ?`).get(job.jobID);
    expect(row.status).toBe('Running');
  });
});
