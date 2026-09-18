import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { updateQuotation } from './writeOps.js';
import { getQuotation } from './readModel.js';
import { buildWorkspaceRevision } from './workspaceRevision.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('quotation gauge edit freshness', () => {
  it('updateQuotation overwrites stamped product line gauge when header gauge changes', () => {
    const db = createDatabase(':memory:');
    const lines = JSON.stringify({
      materialTypeId: 'MT-ALU',
      materialGauge: '0.24mm',
      materialColor: 'IV',
      materialDesign: 'IV',
      products: [{ name: 'Roofing', qty: 10, unitPrice: 5000, gauge: '0.24mm', gaugeLabel: '0.24mm' }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id
      ) VALUES ('QT-GAUGE-1', 'CUS-001', 'Test', '2026-03-29', 50000, 0, 'Unpaid', 'Pending', ?, 'BR-KD')`
    ).run(lines);

    const beforeRev = buildWorkspaceRevision(db, 'ALL').revision;
    updateQuotation(db, 'QT-GAUGE-1', { materialGauge: '0.28mm' });
    const afterRev = buildWorkspaceRevision(db, 'ALL').revision;
    expect(afterRev).not.toBe(beforeRev);

    const raw = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get('QT-GAUGE-1');
    const parsed = JSON.parse(raw.lines_json);
    expect(parsed.materialGauge).toBe('0.28mm');
    expect(parsed.products[0].gauge).toBe('0.28mm');
    expect(parsed.products[0].gaugeLabel).toBe('0.28mm');

    const q = getQuotation(db, 'QT-GAUGE-1');
    expect(q.materialGauge).toBe('0.28mm');
    expect(q.quotationLines.products[0].gauge).toBe('0.28mm');
    db.close();
  });
});
