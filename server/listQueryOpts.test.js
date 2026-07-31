import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveListLimit,
  sqlLimitClause,
  rowListOpts,
  DEFAULT_LIST_LIMIT,
  productionHistoryListOpts,
} from './listQueryOpts.js';

describe('listQueryOpts', () => {
  afterEach(() => {
    delete process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT;
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

  it('resolveListLimit clamps limit', () => {
    expect(resolveListLimit({ limit: 500 })).toBe(500);
    expect(resolveListLimit({ limit: 0 })).toBe(0);
    expect(resolveListLimit({ limit: 99_999 })).toBe(50_000);
  });

  it('sqlLimitClause', () => {
    expect(sqlLimitClause(0)).toBe('');
    expect(sqlLimitClause(10)).toBe(' LIMIT ?');
  });

  it('rowListOpts', () => {
    expect(rowListOpts({}, 'quotations')).toEqual({});
    expect(rowListOpts({ listLimits: { quotations: 600 } }, 'quotations')).toEqual({ limit: 600 });
    expect(rowListOpts({ listLimits: { quotations: 0 } }, 'quotations')).toEqual({ unlimited: true });
  });

  it('productionHistoryListOpts defaults to unlimited', () => {
    expect(productionHistoryListOpts()).toEqual({ unlimited: true });
  });

  it('productionHistoryListOpts honors ZAREWA_PRODUCTION_HISTORY_LIMIT', () => {
    process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT = '2500';
    expect(productionHistoryListOpts()).toEqual({ limit: 2500 });
    process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT = '0';
    expect(productionHistoryListOpts()).toEqual({ unlimited: true });
  });
});
