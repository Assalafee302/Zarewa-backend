import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMaterialCostingPanel } from './execCostingOps.js';
import { buildReservePolicyReadiness, RESERVE_POLICY_KEYS } from './execReservePolicyOps.js';
import { buildStaffActivitySummary } from './execStaffActivityOps.js';
import { buildExecTargetsPanel } from './execTargetsOps.js';
import { buildWorkingCapitalSnapshot } from './execWorkingCapitalOps.js';
import { createDatabase } from './db.js';
import { setJsonBlob } from './readModel.js';

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
const staffOpsSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'execStaffActivityOps.js'),
  'utf8'
);

describe('exec Phase 3B ops', () => {
  it.skipIf(!mysqlOk)('buildWorkingCapitalSnapshot exposes components and missing-data flags', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const wc = buildWorkingCapitalSnapshot(db, 'ALL', {
        cashNgn: 1_000_000,
        receivablesNgn: 500_000,
        inventoryValueNgn: 200_000,
        purchaseOrders: [],
        pendingOutflowsNgn: 0,
      });
      expect(wc.label).toBe('Estimated working capital snapshot');
      expect(wc.notStatutoryAccounts).toBe(true);
      expect(wc.notWithdrawableCash).toBe(true);
      expect(Array.isArray(wc.currentAssets)).toBe(true);
      expect(Array.isArray(wc.currentLiabilities)).toBe(true);
      expect(wc.currentAssets.some((l) => l.id === 'cash')).toBe(true);
      expect(wc.currentLiabilities.some((l) => l.id === 'payroll_liability')).toBe(true);
      const payroll = wc.currentLiabilities.find((l) => l.id === 'payroll_liability');
      expect(payroll).toBeTruthy();
      if (!payroll.available) {
        expect(payroll.amountNgn == null || payroll.estimated).toBeTruthy();
      }
      expect(wc.notes.some((n) => /not the same as free cash/i.test(n))).toBe(true);
      expect(typeof wc.estimatedWorkingCapitalNgn).toBe('number');
    } finally {
      db.close();
    }
  });

  it('buildMaterialCostingPanel labels estimated material-only cost', () => {
    const db = { prepare: () => ({ get: () => null, all: () => [] }) };
    const panel = buildMaterialCostingPanel(db, 'ALL', {
      startISO: '2026-06-01',
      endISO: '2026-06-04',
    });
    expect(panel.label).toMatch(/Estimated material cost per metre/i);
    expect(panel.estimated).toBe(true);
    expect(panel.excludes).toEqual(
      expect.arrayContaining(['labour', 'diesel', 'machine overhead', 'transport', 'factory allocation'])
    );
    expect(panel.notes.some((n) => /Not true total production cost/i.test(n))).toBe(true);
  });

  it.skipIf(!mysqlOk)('buildExecTargetsPanel reports configured vs missing targets', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const missing = buildExecTargetsPanel(
        db,
        'ALL',
        { startISO: '2026-06-01', endISO: '2026-06-04', monthKey: '2026-06' },
        { producedRevenueNgn: 0 }
      );
      expect(missing.basis).toBe('company');
      expect(missing.configured).toBe(false);
      expect(missing.rows.every((r) => r.status === 'No Target Set')).toBe(true);

      setJsonBlob(db, 'org.manager_targets.v1', {
        nairaTargetPerMonth: 10_000_000,
        meterTargetPerMonth: 5000,
      });
      const configured = buildExecTargetsPanel(
        db,
        'ALL',
        { startISO: '2026-06-01', endISO: '2026-06-04', monthKey: '2026-06' },
        { producedRevenueNgn: 12_000_000 }
      );
      expect(configured.configured).toBe(true);
      const naira = configured.rows.find((r) => r.metricKey === 'naira_sales');
      expect(naira?.target).toBe(10_000_000);
      expect(['Ahead', 'On Track', 'Behind', 'No Target Set']).toContain(naira?.status);
    } finally {
      db.close();
    }
  });

  it('buildStaffActivitySummary is not a performance ranking and ignores handled_by', () => {
    const sqlBlocks = [...staffOpsSource.matchAll(/prepare\(\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(sqlBlocks.length).toBeGreaterThan(0);
    expect(sqlBlocks.every((sql) => !/handled_by/i.test(sql))).toBe(true);
    const panel = buildStaffActivitySummary(
      { prepare: () => ({ get: () => null, all: () => [] }) },
      'ALL',
      { startISO: '2026-06-01', endISO: '2026-06-04' }
    );
    expect(panel.notPerformanceRanking).toBe(true);
    expect(panel.legacyNote).toMatch(/handled_by/i);
    expect(panel.notes.some((n) => /not performance ranking/i.test(n))).toBe(true);
    expect(panel.rows).toEqual([]);
  });

  it.skipIf(!mysqlOk)('buildReservePolicyReadiness lists missing reserve keys when unset', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const readiness = buildReservePolicyReadiness(db);
      expect(readiness.headroomHidden).toBe(true);
      expect(readiness.configured).toBe(false);
      expect(readiness.missingKeys.length).toBe(RESERVE_POLICY_KEYS.length);
      expect(readiness.note).toMatch(/Reserve policy is not configured/i);
    } finally {
      db.close();
    }
  });
});
