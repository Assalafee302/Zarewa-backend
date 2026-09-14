import { describe, it, expect } from 'vitest';
import { parseListQuery, sendPaginatedList, slicePage } from './listPagination.js';

const reqWith = (query) => ({ query });

function resStub() {
  const headers = {};
  return {
    headers,
    body: null,
    setHeader: (k, v) => {
      headers[k] = v;
    },
    json(b) {
      this.body = b;
      return b;
    },
  };
}

describe('parseListQuery', () => {
  it('keeps ordinary paging offsets intact', () => {
    expect(parseListQuery(reqWith({ offset: '250' })).offset).toBe(250);
  });

  it('treats negative and junk offsets as the first page', () => {
    for (const offset of ['-5', 'abc', '', 'NaN']) {
      expect(parseListQuery(reqWith({ offset })).offset).toBe(0);
    }
  });

  it('honors unlimited=1', () => {
    expect(parseListQuery(reqWith({ unlimited: '1' }))).toEqual({ limit: 0, offset: 0, unlimited: true });
  });

  it('clamps limit to maxLimit and falls back on junk', () => {
    expect(parseListQuery(reqWith({ limit: '99999' }), { maxLimit: 500 }).limit).toBe(500);
    expect(parseListQuery(reqWith({ limit: '0' }), { defaultLimit: 200 }).limit).toBe(200);
    expect(parseListQuery(reqWith({ limit: 'abc' }), { defaultLimit: 200 }).limit).toBe(200);
  });
});

describe('sendPaginatedList', () => {
  it('does not set Cache-Control by default', () => {
    const res = resStub();
    sendPaginatedList(res, { items: [], limit: 50, offset: 0 });
    expect(res.headers['Cache-Control']).toBeUndefined();
  });

  it('reports truncation only when a total is known', () => {
    const res = resStub();
    sendPaginatedList(res, { items: [1, 2], total: 10, limit: 2, offset: 0 });
    expect(res.body.truncated).toBe(true);

    const res2 = resStub();
    sendPaginatedList(res2, { items: [1, 2], total: 2, limit: 2, offset: 0 });
    expect(res2.body.truncated).toBe(false);
  });
});

describe('slicePage', () => {
  it('slices to the page, and to the tail when limit is 0', () => {
    const items = [1, 2, 3, 4, 5];
    expect(slicePage(items, 1, 2)).toEqual([2, 3]);
    expect(slicePage(items, 3, 0)).toEqual([4, 5]);
  });
});
