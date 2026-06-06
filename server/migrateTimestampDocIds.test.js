import { describe, it, expect, vi } from 'vitest';
import {
  migrateTimestampStyleDocumentIds,
  needsLegacyBranchCodeNormalization,
  needsLegacyTimestampIdMigration,
} from './migrateTimestampDocIds.js';

function mockDb(handlers = {}) {
  return {
    pragma: vi.fn(),
    prepare(sql) {
      const s = String(sql);
      for (const [needle, fn] of handlers.prepare || []) {
        if (s.includes(needle)) return fn(s);
      }
      return {
        get: vi.fn(),
        all: vi.fn(() => []),
        run: vi.fn(),
      };
    },
    transaction(fn) {
      return () => fn();
    },
    ...handlers.extra,
  };
}

describe('migrateTimestampStyleDocumentIds', () => {
  it('no-ops when no legacy timestamp ids or branch codes remain', () => {
    const run = vi.fn();
    const db = mockDb({
      prepare: [
        [
          'sqlite_master',
          () => ({
            get: vi.fn((name) => (name === 'ledger_entries' ? { 1: 1 } : undefined)),
            all: vi.fn(() => []),
            run,
          }),
        ],
        [
          'ledger_entries WHERE id REGEXP',
          () => ({
            get: vi.fn(() => undefined),
            all: vi.fn(() => []),
            run,
          }),
        ],
        [
          'cutting_lists WHERE id REGEXP',
          () => ({
            get: vi.fn(() => undefined),
            all: vi.fn(() => []),
            run,
          }),
        ],
        [
          'FROM ledger_entries WHERE id LIKE',
          () => ({
            get: vi.fn(() => undefined),
            all: vi.fn(() => []),
            run,
          }),
        ],
      ],
    });

    migrateTimestampStyleDocumentIds(db);
    expect(run).not.toHaveBeenCalled();
    expect(db.pragma).not.toHaveBeenCalled();
  });

  it('needsLegacyTimestampIdMigration detects legacy ledger ids', () => {
    const db = mockDb({
      prepare: [
        ['sqlite_master', () => ({ get: vi.fn(() => ({ 1: 1 })), all: vi.fn(() => []), run: vi.fn() })],
        [
          'ledger_entries WHERE id REGEXP',
          () => ({
            get: vi.fn(() => ({ id: 'LE-1775318268346-xsvka' })),
            all: vi.fn(() => []),
            run: vi.fn(),
          }),
        ],
      ],
    });
    expect(needsLegacyTimestampIdMigration(db)).toBe(true);
  });

  it('needsLegacyBranchCodeNormalization detects KAD branch codes', () => {
    const db = mockDb({
      prepare: [
        ['sqlite_master', () => ({ get: vi.fn(() => ({ 1: 1 })), all: vi.fn(() => []), run: vi.fn() })],
        [
          'FROM ledger_entries WHERE id LIKE',
          () => ({
            get: vi.fn((_a, _b, _c) => ({ x: 1 })),
            all: vi.fn(() => []),
            run: vi.fn(),
          }),
        ],
      ],
    });
    expect(needsLegacyBranchCodeNormalization(db)).toBe(true);
  });
});
