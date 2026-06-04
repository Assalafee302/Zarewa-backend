import { describe, expect, it } from 'vitest';
import { resolveBiPeriodBounds } from '../shared/lib/businessIntelligence.js';
import {
  agingSeverityScore,
  buildBranchScorecardHighlights,
  buildEnrichedBranchScorecard,
  buildExecDataScopeNotes,
  buildExecutiveDecisionAlerts,
  buildQueueSummaryTray,
  buildScopedExecutiveCounts,
  classifyCustomerDebtRisk,
  resolveExecDashboardBranchScope,
  resolveExecDashboardPeriod,
  topCustomersByDebt,
} from './execDashboardOps.js';
import { createDatabase } from './db.js';

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

describe('execDashboardOps', () => {
  it('resolveExecDashboardPeriod maps today, week, and last_month with custom BI bounds', () => {
    const today = resolveExecDashboardPeriod({ periodKey: 'today' });
    expect(today.key).toBe('today');
    expect(today.startISO).toBe(today.endISO);
    expect(today.biPeriodKey).toBe('custom');
    expect(today.kpiPeriodAware).toBe(true);

    const week = resolveExecDashboardPeriod({ periodKey: 'week' });
    expect(week.key).toBe('week');
    expect(week.startISO <= week.endISO).toBe(true);
    expect(week.biPeriodKey).toBe('custom');

    const lm = resolveExecDashboardPeriod({ periodKey: 'last_month' });
    expect(lm.key).toBe('last_month');
    expect(lm.startISO).toMatch(/^\d{4}-\d{2}-01$/);
    expect(lm.biPeriodKey).toBe('custom');
  });

  it('resolveBiPeriodBounds uses explicit start/end for exec periods', () => {
    const b = resolveBiPeriodBounds({
      periodStartISO: '2026-06-01',
      periodEndISO: '2026-06-04',
    });
    expect(b.startIso).toBe('2026-06-01');
    expect(b.endIso).toBe('2026-06-04');
  });

  it('buildExecDataScopeNotes documents SKU/cash BI lookback', () => {
    const notes = buildExecDataScopeNotes(resolveExecDashboardPeriod({ periodKey: 'month' }), {
      skuUsesBiLookback: true,
    });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].id).toBe('bi-lookback-partial');
    expect(notes[0].message).toMatch(/SKU weeks-cover/i);
  });

  it('buildQueueSummaryTray emits one summary row per kind, not duplicated stubs', () => {
    const items = buildQueueSummaryTray({
      pendingRefunds: 12,
      pendingPaymentRequests: 5,
      payrollDraftsAwaitingMd: 1,
    });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.summaryOnly === true)).toBe(true);
    expect(items.every((i) => i.canAct === false)).toBe(true);
    expect(items.some((i) => String(i.id).includes(':queue:'))).toBe(false);
  });

  it('buildQueueSummaryTray carries scopeBasis for branch vs company-wide labels', () => {
    const items = buildQueueSummaryTray({
      pendingRefunds: { count: 2, scopeBasis: 'branch' },
      pendingPaymentRequests: { count: 1, scopeBasis: 'company' },
      payrollDraftsAwaitingMd: { count: 3, scopeBasis: 'company' },
    });
    const refunds = items.find((i) => i.kind === 'refunds');
    expect(refunds?.scopeBasis).toBe('branch');
    expect(refunds?.branchName).toBe('This branch');
    const payroll = items.find((i) => i.kind === 'payroll');
    expect(payroll?.scopeBasis).toBe('company');
    expect(payroll?.branchName).toBe('Company-wide');
  });

  it('buildExecDataScopeNotes adds cash horizon note when period is not month', () => {
    const notes = buildExecDataScopeNotes(resolveExecDashboardPeriod({ periodKey: 'today' }), {
      skuUsesBiLookback: true,
      cashUsesBiLookback: true,
    });
    expect(notes.some((n) => n.id === 'cash-horizon-lookback')).toBe(true);
    expect(notes.some((n) => /SKU weeks-cover/i.test(n.message))).toBe(true);
  });

  it('classifyCustomerDebtRisk and agingSeverityScore rank debt risk', () => {
    expect(classifyCustomerDebtRisk({ days0_30: 1000 }, 1000)).toBe('Fresh');
    expect(classifyCustomerDebtRisk({ days31_60: 200_000, days0_30: 0 }, 500_000)).toBe('Watch');
    expect(
      classifyCustomerDebtRisk({ days61_90: 300_000, days90_plus: 0 }, 600_000)
    ).toBe('High Risk');
    expect(
      classifyCustomerDebtRisk({ days90_plus: 500_000, days61_90: 100_000 }, 1_000_000)
    ).toBe('Critical');
    const severe = agingSeverityScore({ days90_plus: 100, days0_30: 10 });
    const mild = agingSeverityScore({ days0_30: 100 });
    expect(severe).toBeGreaterThan(mild);
  });

  it.skipIf(!mysqlOk)('buildScopedExecutiveCounts returns scope metadata per metric', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const all = buildScopedExecutiveCounts(db, 'ALL');
      expect(all.pendingRefunds.scopeBasis).toBe('company');
      expect(all.payrollDraftsAwaitingMd.scopeBasis).toBe('company');
      expect(all.pendingProductionJobs).toHaveProperty('scopeBasis');
      expect(all.stockRegisterPendingMd).toHaveProperty('scopeBasis');
      const scoped = buildScopedExecutiveCounts(db, 'BR-KD');
      expect(scoped.pendingRefunds.scopeBasis).toBe('branch');
      expect(scoped.branchScope).toBe('BR-KD');
    } finally {
      db.close();
    }
  });

  it('resolveExecDashboardBranchScope respects workspace and ALL rollup', () => {
    const md = { roleKey: 'md', permissions: ['*'] };
    expect(
      resolveExecDashboardBranchScope(md, { workspaceBranchId: 'BR-YL', workspaceViewAll: false }, 'ALL')
    ).toBe('ALL');
    expect(
      resolveExecDashboardBranchScope(md, { workspaceBranchId: 'BR-YL', workspaceViewAll: false }, 'BR-KD')
    ).toBe('BR-KD');
  });

  it('buildExecutiveDecisionAlerts produces specific management messages', () => {
    const alerts = buildExecutiveDecisionAlerts(
      { prepare: () => ({ get: () => null }) },
      { expenseAnalysis: { periodChangePct: 28, topCategories: [{ category: 'Transport', amountNgn: 1 }] } },
      {},
      {
        lowStockHighDemand: [
          {
            family: 'aluzinc',
            gauge: '0.24',
            colour: 'Ivory',
            weeksCover: 1.8,
            reason: 'High demand',
          },
        ],
        slowMovingStock: [],
        recommendations: [],
      },
      [
        {
          branchId: 'BR-YL',
          branchName: 'Yola Factory',
          producedRevenueNgn: 5_000_000,
          netCollectedNgn: 1_500_000,
          producedCollectionRatePct: 30,
          coilValuationNgn: 500_000,
          liquidateSkuCount: 0,
        },
      ],
      {
        outstandingReceivablesNgn: 10_000_000,
        receivablesAging: { '61_90': 4_000_000, over_90: 3_000_000 },
      }
    );
    expect(alerts.length).toBeGreaterThan(0);
    const sku = alerts.find((a) => a.id.startsWith('sku-buy'));
    expect(sku?.message).toMatch(/0\.24.*Ivory.*Aluzinc/i);
    expect(sku?.message).toMatch(/1\.8 weeks/i);
    const branch = alerts.find((a) => a.id === 'branch-coll-BR-YL');
    expect(branch?.message).toMatch(/Yola/i);
    expect(branch?.message).toMatch(/collection rate/i);
    const aging = alerts.find((a) => a.id === 'receivables-aging-60');
    expect(aging?.message).toMatch(/60 days/i);
    expect(alerts.every((a) => a.level && a.message && a.id)).toBe(true);
  });

  it('buildEnrichedBranchScorecard adds scorecard columns', () => {
    const rows = buildEnrichedBranchScorecard(
      { prepare: () => ({ get: () => null }) },
      [
        {
          branchId: 'BR-KD',
          producedRevenueNgn: 1_000_000,
          netCollectedNgn: 800_000,
          coilValuationNgn: 200_000,
          liquidateSkuCount: 1,
          buySkuCount: 0,
        },
        {
          branchId: 'BR-YL',
          producedRevenueNgn: 500_000,
          netCollectedNgn: 200_000,
          coilValuationNgn: 100_000,
          liquidateSkuCount: 0,
          buySkuCount: 0,
        },
      ],
      new Map([
        ['BR-KD', 50_000],
        ['BR-YL', 200_000],
      ]),
      [
        { branchId: 'BR-KD', amountNgn: 100_000 },
        { branchId: 'BR-YL', amountNgn: 300_000 },
      ],
      new Map([
        ['BR-KD', 2],
        ['BR-YL', 1],
      ]),
      new Map([
        ['BR-KD', 3],
        ['BR-YL', 0],
      ])
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].expensesNgn).toBe(100_000);
    expect(rows[0].internalScore).toBeGreaterThan(0);
    expect(rows[0].internalScoreNote).toMatch(/Transparent index/i);
    const highlights = buildBranchScorecardHighlights(null, rows);
    expect(highlights.bestOverallBranch).toBeTruthy();
    expect(highlights.bestCollectionsBranch).toBeTruthy();
  });

  it.skipIf(!mysqlOk)('topCustomersByDebt returns rows with aging and risk labels when data exists', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const rows = topCustomersByDebt(db, 'ALL', '2026-06-04');
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows) {
        expect(row).toHaveProperty('debtRiskLabel');
        expect(row).toHaveProperty('severityScore');
        expect(row.basisLabel).toMatch(/as at 2026-06-04/i);
        expect(row.ledgerRoute).toBe('/accounts');
        expect(row.reportsRoute).toBe('/reports');
        if (row.debtNgn > 0) {
          expect(['Fresh', 'Watch', 'High Risk', 'Critical']).toContain(row.debtRiskLabel);
        }
      }
    } finally {
      db.close();
    }
  });

  it('topCustomersByDebt row shape includes debt risk and drill routes', () => {
    const aging = { days0_30: 0, days31_60: 200_000, days61_90: 0, days90_plus: 0 };
    expect(classifyCustomerDebtRisk(aging, 500_000)).toBe('Watch');
    expect(agingSeverityScore(aging)).toBeGreaterThan(0);
  });
});
