import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { postPurchaseOrderTransport } from './writeOps.js';

function dbReady() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dbReady())('postPurchaseOrderTransport on Received PO', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO purchase_orders (
         po_id, supplier_id, supplier_name, order_date_iso, status, branch_id,
         transport_agent_id, transport_agent_name, transport_amount_ngn, transport_advance_ngn
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PO-RCV-1',
      'SUP-1',
      'Steel Co',
      '2026-06-01',
      'Received',
      'BR-KD',
      'AG-1',
      'Haul Co',
      50_000,
      50_000
    );
  });

  afterEach(() => {
    db?.close();
  });

  it('allows treasury payment when goods are already received', () => {
    const acct = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id LIMIT 1`).get();
    expect(acct?.id).toBeTruthy();

    const r = postPurchaseOrderTransport(db, 'PO-RCV-1', {
      treasuryAccountId: acct.id,
      amountNgn: 50_000,
      dateISO: '2026-06-02',
      reference: 'WB-RCV',
    });
    expect(r.ok).toBe(true);

    const row = db.prepare(`SELECT status, transport_paid, transport_paid_ngn FROM purchase_orders WHERE po_id = ?`).get(
      'PO-RCV-1'
    );
    expect(row.status).toBe('Received');
    expect(row.transport_paid).toBe(1);
    expect(row.transport_paid_ngn).toBe(50_000);
  });
});
