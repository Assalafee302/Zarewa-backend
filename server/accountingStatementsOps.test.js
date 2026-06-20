import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireIntegrationHarness,
  closeIntegrationHarness,
  isMysqlAvailableForTests,
} from './testIntegrationHarness.js';
import { monthBounds, getAccountingStatementsPack } from './accountingStatementsOps.js';

const mysqlOk = isMysqlAvailableForTests();

describe.skipIf(!mysqlOk)('accountingStatementsOps', () => {
  let db;

  beforeAll(() => {
    db = acquireIntegrationHarness().db;
  });

  afterAll(() => {
    closeIntegrationHarness();
  });

  it('monthBounds parses YYYY-MM', () => {
    expect(monthBounds('bad')).toBeNull();
    const b = monthBounds('2026-02');
    expect(b?.start).toBe('2026-02-01');
    expect(b?.end).toBe('2026-02-28');
  });

  it('getAccountingStatementsPack returns structure', () => {
    const p = getAccountingStatementsPack(db, '2026-01', 'ALL');
    expect(p.ok).toBe(true);
    expect(p.profitAndLoss?.lines).toBeDefined();
    expect(p.balanceSheet?.lines).toBeDefined();
    expect(p.reconciliationHints?.salesReceiptsInPeriodNgn).toBeDefined();
  });
});
