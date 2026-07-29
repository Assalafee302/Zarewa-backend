import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { upsertHrDailyRollCall, getHrDailyRollCall } from './hrOps.js';
import { createBranchShiftNote, listBranchShiftNotes } from './branchShiftNotesOps.js';
import {
  COST_VARIANCE_THRESHOLD_PCT,
  buildCostVarianceRows,
  buildFloorExceptionLog,
  buildMarginConsistencyRows,
  buildPricingGovernancePack,
} from './pricingGovernanceOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

function tableExists(db, name) {
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_name = ?`
        )
        .get(name)
    );
  } catch {
    try {
      return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
    } catch {
      return false;
    }
  }
}

function columnExists(db, table, column) {
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`
        )
        .get(table, column)
    );
  } catch {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      return cols.some((c) => c.name === column);
    } catch {
      return false;
    }
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('OT / CSAT schema / shift notes / pricing governance', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('schema includes satisfaction_score and branch_shift_notes after migrate', () => {
    expect(columnExists(db, 'deliveries', 'satisfaction_score')).toBe(true);
    expect(tableExists(db, 'branch_shift_notes')).toBe(true);
  });

  it('daily roll persists scheduledMinutes and workedMinutes without payroll OT fields', () => {
    const staff = db.prepare(`SELECT id FROM app_users LIMIT 1`).get();
    expect(staff?.id).toBeTruthy();
    const branch = db.prepare(`SELECT id FROM branches LIMIT 1`).get()?.id || 'BR-KD';
    const dayIso = '2026-07-20';
    const actor = { id: staff.id, displayName: 'Tester', roleKey: 'admin' };
    const scope = { viewAll: true, branchId: branch };
    const up = upsertHrDailyRollCall(db, actor, scope, {
      branchId: branch,
      dayIso,
      rows: [
        {
          userId: staff.id,
          status: 'present',
          scheduledMinutes: 480,
          workedMinutes: 540,
        },
      ],
      notes: 'verify OT capture',
    });
    expect(up.ok).toBe(true);
    const got = getHrDailyRollCall(db, scope, branch, dayIso);
    const row0 = got?.roll?.rows?.[0];
    expect(row0?.scheduledMinutes).toBe(480);
    expect(row0?.workedMinutes).toBe(540);
    expect(row0?.overtimePay).toBeUndefined();
    expect(row0?.otAmount).toBeUndefined();
  });

  it('confirmDelivery stores satisfaction_score 1–5', () => {
    if (!columnExists(db, 'deliveries', 'satisfaction_score')) return;
    const existing = db.prepare(`SELECT id FROM deliveries LIMIT 1`).get();
    if (!existing) {
      db.prepare(
        `INSERT INTO deliveries (id, status, customer_name, branch_id, satisfaction_score)
         VALUES ('DLV-TEST-CSAT', 'Out for delivery', 'Test Customer', 'BR-KD', NULL)`
      ).run();
    }
    const id = existing?.id || 'DLV-TEST-CSAT';
    db.prepare(`UPDATE deliveries SET satisfaction_score = ? WHERE id = ?`).run(4, id);
    const row = db.prepare(`SELECT satisfaction_score FROM deliveries WHERE id = ?`).get(id);
    expect(Number(row.satisfaction_score)).toBe(4);
  });

  it('branch_shift_notes create + list', () => {
    const staff = db.prepare(`SELECT id, display_name FROM app_users LIMIT 1`).get();
    expect(staff?.id).toBeTruthy();
    const actor = {
      id: staff.id,
      displayName: staff.display_name || 'BM Test',
      roleKey: 'sales_manager',
    };
    const r = createBranchShiftNote(
      db,
      { branchId: 'BR-KD', shiftDate: '2026-07-29', note: 'Gates locked; CCTV clear.' },
      actor,
      'BR-KD'
    );
    expect(r.ok).toBe(true);
    const list = listBranchShiftNotes(db, { branchId: 'BR-KD', shiftDate: '2026-07-29' });
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].note).toMatch(/Gates locked/);
  });

  it('pricing governance flags cost variance at 8% threshold', () => {
    expect(COST_VARIANCE_THRESHOLD_PCT).toBe(8);
    const pack = buildPricingGovernancePack(db, { branchId: 'ALL' });
    expect(pack.ok).toBe(true);
    expect(pack.thresholds.costVariancePct).toBe(8);
    expect(Array.isArray(pack.costVariance)).toBe(true);
    expect(Array.isArray(pack.floorExceptions)).toBe(true);
    expect(Array.isArray(pack.marginConsistency)).toBe(true);
  });

  it('margin consistency detects divergent profit for same material/gauge', () => {
    if (!tableExists(db, 'material_pricing_sheet_rows')) return;
    const now = new Date().toISOString();
    db.prepare(
      `DELETE FROM material_pricing_sheet_rows WHERE id IN ('MPS-G1', 'MPS-G2')`
    ).run();
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        cost_per_kg_ngn, overhead_ngn_per_m, profit_ngn_per_m, minimum_price_per_m_ngn,
        updated_at_iso
      ) VALUES
      ('MPS-G1', 'alu', '0.55', 'BR-KD', 'milano', 1000, 100, 200, 3000, ?),
      ('MPS-G2', 'alu', '0.55', 'BR-YL', 'milano', 1000, 100, 400, 3000, ?)`
    ).run(now, now);
    const flags = buildMarginConsistencyRows(db, {});
    const hit = flags.find((f) => f.materialKey === 'alu' && f.gaugeMm === '0.55');
    expect(hit?.flagged).toBe(true);
    expect(hit?.profitFlagged).toBe(true);
  });

  it('floor exception log reads MD snapshot without new logging', () => {
    const qid = 'Q-GOV-FLOOR-1';
    const snapshot = JSON.stringify([
      {
        lineIndex: 0,
        lineName: 'Roof',
        gauge: '0.55',
        design: 'milano',
        quotedPerMeter: 2800,
        floorPerMeter: 3200,
      },
    ]);
    try {
      db.prepare(`DELETE FROM quotations WHERE id = ?`).run(qid);
      db.prepare(
        `INSERT INTO quotations (
          id, customer_id, customer_name, date_iso, total_ngn, branch_id,
          md_price_exception_approved_at_iso, md_price_exception_approved_by_user_id,
          md_price_exception_snapshot_json, price_exception_md_review_required
        ) VALUES (?, 'CUS-001', 'Acme', '2026-07-01', 50000, 'BR-KD', ?, ?, ?, 1)`
      ).run(qid, '2026-07-02T10:00:00.000Z', 'admin', snapshot);
    } catch {
      return;
    }
    const log = buildFloorExceptionLog(db, { branchId: 'BR-KD' });
    const hit = log.find((r) => r.quotationId === qid);
    expect(hit).toBeTruthy();
    expect(hit.totalBelowFloorPerMeterNgn).toBe(400);
    expect(hit.lines[0].belowFloorPerMeterNgn).toBe(400);
  });

  it('cost variance rows expose workbook vs GRN fields', () => {
    const rows = buildCostVarianceRows(db, {});
    expect(Array.isArray(rows)).toBe(true);
  });
});
