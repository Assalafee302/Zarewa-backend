import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveListLimit,
  sqlLimitClause,
  sqlLimitOffsetClause,
  rowListOpts,
  DEFAULT_LIST_LIMIT,
  productionHistoryListOpts,
  financeHistoryListOpts,
  salesCustomersListOpts,
  receiptsHistoryListOpts,
} from './listQueryOpts.js';

describe('listQueryOpts', () => {
  afterEach(() => {
    delete process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT;
    delete process.env.ZAREWA_FINANCE_HISTORY_LIMIT;
    delete process.env.ZAREWA_SALES_CUSTOMERS_LIMIT;
    delete process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT;
    delete process.env.ZAREWA_RECEIPTS_HISTORY_DEFAULT;
  });

  it('resolveListLimit returns DEFAULT_LIST_LIMIT when opts omitted', () => {
    expect(resolveListLimit()).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit({})).toBe(DEFAULT_LIST_LIMIT);
  });

  it('resolveListLimit returns 0 when useDefaultLimit is false', () => {
    expect(resolveListLimit({ useDefaultLimit: false })).toBe(0);
  });

  it('resolveListLimit honors unlimited', () => {
    expect(resolveListLimit({ unlimited: true, limit: 100 })).toBe(0);
  });

  it('resolveListLimit rejects limit 0 / NaN (never unbounded)', () => {
    expect(resolveListLimit({ limit: 500 })).toBe(500);
    expect(resolveListLimit({ limit: 0 })).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit({ limit: -1 })).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit({ limit: 99_999 })).toBe(50_000);
  });

  it('sqlLimitClause', () => {
    expect(sqlLimitClause(0)).toBe('');
    expect(sqlLimitClause(10)).toBe(' LIMIT ?');
  });

  it('sqlLimitOffsetClause', () => {
    expect(sqlLimitOffsetClause(0, 0)).toEqual({ sql: '', args: [] });
    expect(sqlLimitOffsetClause(25, 50)).toEqual({ sql: ' LIMIT ? OFFSET ?', args: [25, 50] });
    expect(sqlLimitOffsetClause(0, 10)).toEqual({ sql: ' LIMIT ? OFFSET ?', args: [50_000, 10] });
  });

  it('rowListOpts', () => {
    expect(rowListOpts({}, 'quotations')).toEqual({});
    expect(rowListOpts({ listLimits: { quotations: 600 } }, 'quotations')).toEqual({ limit: 600 });
    expect(rowListOpts({ listLimits: { quotations: 0 } }, 'quotations')).toEqual({ unlimited: true });
  });

  it('productionHistoryListOpts defaults to capped desk limit', () => {
    expect(productionHistoryListOpts()).toEqual({ limit: 5000 });
  });

  it('productionHistoryListOpts honors ZAREWA_PRODUCTION_HISTORY_LIMIT', () => {
    process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT = '2500';
    expect(productionHistoryListOpts()).toEqual({ limit: 2500 });
    process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT = '0';
    expect(productionHistoryListOpts()).toEqual({ unlimited: true });
  });

  it('financeHistoryListOpts defaults to capped desk limit', () => {
    expect(financeHistoryListOpts()).toEqual({ limit: 3000 });
  });

  it('financeHistoryListOpts honors ZAREWA_FINANCE_HISTORY_LIMIT', () => {
    process.env.ZAREWA_FINANCE_HISTORY_LIMIT = '8000';
    expect(financeHistoryListOpts()).toEqual({ limit: 8000 });
    process.env.ZAREWA_FINANCE_HISTORY_LIMIT = '0';
    expect(financeHistoryListOpts()).toEqual({ unlimited: true });
  });

  it('salesCustomersListOpts defaults to capped directory', () => {
    expect(salesCustomersListOpts()).toEqual({ limit: 5000 });
  });

  it('salesCustomersListOpts honors ZAREWA_SALES_CUSTOMERS_LIMIT', () => {
    process.env.ZAREWA_SALES_CUSTOMERS_LIMIT = '1200';
    expect(salesCustomersListOpts()).toEqual({ limit: 1200 });
    process.env.ZAREWA_SALES_CUSTOMERS_LIMIT = '0';
    expect(salesCustomersListOpts()).toEqual({ unlimited: true });
  });

  it('receiptsHistoryListOpts defaults to capped desk limit', () => {
    expect(receiptsHistoryListOpts()).toEqual({ limit: 3000 });
  });

  it('receiptsHistoryListOpts honors ZAREWA_RECEIPTS_HISTORY_LIMIT', () => {
    process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT = '4000';
    expect(receiptsHistoryListOpts()).toEqual({ limit: 4000 });
    process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT = '0';
    expect(receiptsHistoryListOpts()).toEqual({ unlimited: true });
  });
});
