/**
 * The HR modules used to carry ~40 hand-copied definitions of these helpers,
 * with three different `safeJsonParse` behaviours between them. Pin the two
 * behaviours that survived so they do not drift back together.
 */
import { describe, it, expect } from 'vitest';
import {
  diffDays,
  isoDateShift,
  newId,
  newTimeId,
  nowIso,
  parseJsonArray,
  parseJsonObject,
  parseJsonValue,
} from './hrCommon.js';

describe('nowIso / isoDateShift', () => {
  it('stamps UTC ISO-8601', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('shifts whole days off the same UTC clock nowIso uses', () => {
    expect(isoDateShift(0)).toBe(nowIso().slice(0, 10));
    const today = Date.parse(`${isoDateShift(0)}T00:00:00Z`);
    expect(Date.parse(`${isoDateShift(-2)}T00:00:00Z`)).toBe(today - 2 * 86_400_000);
    expect(Date.parse(`${isoDateShift(30)}T00:00:00Z`)).toBe(today + 30 * 86_400_000);
  });
});

describe('newId / newTimeId', () => {
  it('prefixes and defaults to 8 random bytes', () => {
    expect(newId('HRDOC')).toMatch(/^HRDOC-[0-9a-f]{16}$/);
  });

  it('honours a wider id where the caller asked for one', () => {
    expect(newId('HRAUD', 10)).toMatch(/^HRAUD-[0-9a-f]{20}$/);
  });

  it('does not collide across a burst', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('X')));
    expect(ids.size).toBe(500);
  });

  it('keeps time-ordered ids sortable by their timestamp segment', () => {
    const id = newTimeId('xfer');
    expect(id).toMatch(/^xfer_\d+_[a-z0-9]+$/);
  });
});

describe('parseJsonObject', () => {
  it('returns the parsed object', () => {
    expect(parseJsonObject('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('falls back for scalars, null, empty, and malformed input', () => {
    const fallback = { fallback: true };
    for (const raw of ['7', '"text"', 'null', '', null, undefined, '{oops']) {
      expect(parseJsonObject(raw, fallback)).toBe(fallback);
    }
  });

  it('passes arrays through, since arrays are objects', () => {
    expect(parseJsonObject('[1,2]', {})).toEqual([1, 2]);
  });
});

describe('parseJsonValue', () => {
  it('keeps scalars and arrays that parseJsonObject would reject', () => {
    expect(parseJsonValue('7', null)).toBe(7);
    expect(parseJsonValue('"text"', null)).toBe('text');
    expect(parseJsonValue('[1,2]', null)).toEqual([1, 2]);
  });

  it('falls back for empty and malformed input', () => {
    expect(parseJsonValue('', 'fb')).toBe('fb');
    expect(parseJsonValue(null, 'fb')).toBe('fb');
    expect(parseJsonValue('{oops', 'fb')).toBe('fb');
  });
});

describe('parseJsonArray', () => {
  it('returns an array or an empty one', () => {
    expect(parseJsonArray('[1,2]')).toEqual([1, 2]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray('nope')).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
  });
});

describe('diffDays', () => {
  it('counts whole days between ISO dates', () => {
    expect(diffDays('2026-09-01', '2026-09-04')).toBe(3);
    expect(diffDays('2026-09-04', '2026-09-01')).toBe(-3);
    expect(diffDays('2026-09-01T23:59:00Z', '2026-09-02T00:01:00Z')).toBe(1);
  });

  it('reads 0 rather than NaN when either side is unusable', () => {
    expect(diffDays('', '2026-09-04')).toBe(0);
    expect(diffDays('2026-09-04', null)).toBe(0);
    expect(diffDays('not-a-date', 'also-not')).toBe(0);
  });
});
