import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveListLimit,
  sqlLimitClause,
  sqlLimitOffsetClause,
  rowListOpts,
  DEFAULT_LIST_LIMIT,
  DEFAULT_DESK_PAGE_SIZE,
  productionHistoryListOpts,
  financeHistoryListOpts,
  financeRegisterListOpts,
  salesCustomersListOpts,
  receiptsHistoryListOpts,
  coilDeskListOpts,
  buildBackgroundHydrateMeta,
  deskPageListOpts,
} from './listQueryOpts.js';

describe('listQueryOpts', () => {
  afterEach(() => {
    delete process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT;
    delete process.env.ZAREWA_FINANCE_HISTORY_LIMIT;
    delete process.env.ZAREWA_SALES_CUSTOMERS_LIMIT;
    delete process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT;
    delete process.env.ZAREWA_RECEIPTS_HISTORY_DEFAULT;
    delete process.env.ZAREWA_COIL_DESK_FULL;
    delete process.env.ZAREWA_COIL_DESK_LIMIT;
    delete process.env.ZAREWA_DESK_PAGE_SIZE;
    delete process.env.ZAREWA_DEFAULT_LIST_LIMIT;
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

  it('desk pages default to recent ~150 rows (not thousands)', () => {
    expect(DEFAULT_DESK_PAGE_SIZE).toBe(150);
    expect(DEFAULT_LIST_LIMIT).toBe(150);
    expect(deskPageListOpts()).toEqual({ limit: 150 });
    expect(productionHistoryListOpts()).toEqual({ limit: 150 });
    expect(financeHistoryListOpts()).toEqual({ limit: 150 });
    expect(salesCustomersListOpts()).toEqual({ limit: 150 });
    expect(receiptsHistoryListOpts()).toEqual({ limit: 150 });
    expect(financeRegisterListOpts()).toEqual({ limit: 150 });
  });

  it('productionHistoryListOpts honors ZAREWA_PRODUCTION_HISTORY_LIMIT', () => {
    process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT = '2500';
    expect(productionHistoryListOpts()).toEqual({ limit: 2500 });
    process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT = '0';
    expect(productionHistoryListOpts()).toEqual({ unlimited: true });
  });

  it('financeHistoryListOpts honors ZAREWA_FINANCE_HISTORY_LIMIT', () => {
    process.env.ZAREWA_FINANCE_HISTORY_LIMIT = '8000';
    expect(financeHistoryListOpts()).toEqual({ limit: 8000 });
    process.env.ZAREWA_FINANCE_HISTORY_LIMIT = '0';
    expect(financeHistoryListOpts()).toEqual({ unlimited: true });
  });

  it('salesCustomersListOpts honors ZAREWA_SALES_CUSTOMERS_LIMIT', () => {
    process.env.ZAREWA_SALES_CUSTOMERS_LIMIT = '1200';
    expect(salesCustomersListOpts()).toEqual({ limit: 1200 });
    process.env.ZAREWA_SALES_CUSTOMERS_LIMIT = '0';
    expect(salesCustomersListOpts()).toEqual({ unlimited: true });
  });

  it('receiptsHistoryListOpts honors ZAREWA_RECEIPTS_HISTORY_LIMIT', () => {
    process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT = '4000';
    expect(receiptsHistoryListOpts()).toEqual({ limit: 4000 });
    process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT = '0';
    expect(receiptsHistoryListOpts()).toEqual({ unlimited: true });
  });

  it('coilDeskListOpts defaults to active on-hand pack (not recent-N)', () => {
    expect(coilDeskListOpts()).toEqual({ activeOnly: true });
  });

  it('coilDeskListOpts escape hatch restores full historical register', () => {
    process.env.ZAREWA_COIL_DESK_FULL = '1';
    expect(coilDeskListOpts()).toEqual({ unlimited: true });
    delete process.env.ZAREWA_COIL_DESK_FULL;
    process.env.ZAREWA_COIL_DESK_LIMIT = '0';
    expect(coilDeskListOpts()).toEqual({ unlimited: true });
  });

  it('buildBackgroundHydrateMeta lists next recent-first pages for the SPA to prefetch', () => {
    const meta = buildBackgroundHydrateMeta(
      [
        { key: 'quotations', path: '/api/quotations', limit: 150, loaded: 150 },
        { key: 'customers', path: '/api/customers', limit: 150, loaded: 40, querySuffix: '&sort=recent' },
        { key: 'receipts', path: '/api/receipts', limit: 150, loaded: 150 },
      ],
      { pageSize: 150 }
    );
    expect(meta.enabled).toBe(true);
    expect(meta.strategy).toBe('recent_first');
    expect(meta.resources).toEqual([
      {
        key: 'quotations',
        href: '/api/quotations?limit=150&offset=150',
        offset: 150,
        limit: 150,
      },
      {
        key: 'receipts',
        href: '/api/receipts?limit=150&offset=150',
        offset: 150,
        limit: 150,
      },
    ]);
  });
});
