import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase } from './db.js';

describe('ensureLegacyDemoPack', () => {
  let db;

  afterEach(() => {
    db?.close();
  });

  it('applies legacy demo rows without FK errors on a fresh database', () => {
    db = createDatabase(':memory:');

    const cust = db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-NDA');
    expect(cust?.customer_id).toBe('CUS-NDA');

    const qt = db.prepare(`SELECT id FROM quotations WHERE id = ?`).get('QT-2026-027');
    expect(qt?.id).toBe('QT-2026-027');

    const rc = db.prepare(`SELECT id FROM sales_receipts WHERE id = ?`).get('RC-2026-1849');
    expect(rc?.id).toBe('RC-2026-1849');

    const cl = db.prepare(`SELECT id, quotation_ref FROM cutting_lists WHERE id = ?`).get('CL-2026-1592');
    expect(cl?.id).toBe('CL-2026-1592');
    expect(String(cl?.quotation_ref || '').trim()).toBe('QT-2026-027');

    const lineCount = db
      .prepare(`SELECT COUNT(*) AS c FROM cutting_list_lines WHERE cutting_list_id = ?`)
      .get('CL-2026-1592')?.c;
    expect(Number(lineCount)).toBeGreaterThan(0);
  });
});
