import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';

function dbAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dbAvailable())('migrateEnsureQuotationGauges2026', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
  });

  afterAll(() => {
    db?.close();
  });

  it('backfills gauges that seedMasterData would skip on a non-empty table', () => {
    // Simulate a long-lived DB that only ever got the original nine gauges.
    db.prepare(`DELETE FROM setup_gauges`).run();
    const ins = db.prepare(
      `INSERT INTO setup_gauges (gauge_id, label, gauge_mm, active, sort_order) VALUES (?,?,?,?,?)`
    );
    for (const [id, label, mm, sort] of [
      ['GAU-001', '0.20mm', 0.2, 1],
      ['GAU-002', '0.22mm', 0.22, 2],
      ['GAU-003', '0.24mm', 0.24, 3],
      ['GAU-004', '0.28mm', 0.28, 4],
      ['GAU-005', '0.30mm', 0.3, 5],
      ['GAU-006', '0.40mm', 0.4, 6],
      ['GAU-007', '0.45mm', 0.45, 7],
      ['GAU-008', '0.55mm', 0.55, 8],
      ['GAU-009', '0.70mm', 0.7, 9],
    ]) {
      ins.run(id, label, mm, 1, sort);
    }

    runMigrations(db);

    const labels = db
      .prepare(`SELECT label FROM setup_gauges WHERE active = 1 ORDER BY sort_order ASC, gauge_mm ASC`)
      .all()
      .map((r) => r.label);

    expect(labels).toEqual([
      '0.18mm',
      '0.20mm',
      '0.22mm',
      '0.24mm',
      '0.28mm',
      '0.30mm',
      '0.35mm',
      '0.40mm',
      '0.45mm',
      '0.50mm',
      '0.55mm',
      '0.60mm',
      '0.70mm',
    ]);
  });

  it('reactivates gauges that were marked inactive', () => {
    db.prepare(`UPDATE setup_gauges SET active = 0 WHERE gauge_id = 'GAU-010'`).run();
    runMigrations(db);
    const row = db.prepare(`SELECT active, label FROM setup_gauges WHERE gauge_id = 'GAU-010'`).get();
    expect(Number(row.active)).toBe(1);
    expect(row.label).toBe('0.18mm');
  });
});
