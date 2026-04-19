import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';

describe('ZAREWA_EMPTY_SEED', () => {
  beforeAll(() => {
    process.env.ZAREWA_EMPTY_SEED = '1';
  });
  afterAll(() => {
    delete process.env.ZAREWA_EMPTY_SEED;
  });

  it('bootstraps in-memory DB without transactional demo data', () => {
    const db = createDatabase(':memory:');
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM customers').get().c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM quotations').get().c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM suppliers').get().c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM treasury_accounts').get().c).toBe(1);
      expect(db.prepare('SELECT balance FROM treasury_accounts LIMIT 1').get().balance).toBe(0);
    } finally {
      db.close();
    }
  });
});
