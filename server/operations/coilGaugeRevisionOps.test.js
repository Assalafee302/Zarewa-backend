import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from '../db.js';
import { isMysqlAvailableForTests } from '../testIntegrationHarness.js';
import { patchCoilLotMasterData } from '../writeOps.js';
import { buildWorkspaceRevision } from '../workspaceRevision.js';
import { coilGaugeLabelAsOf, gaugeLabelsSameThickness } from './coilGaugeRevisionOps.js';

const mysqlOk = isMysqlAvailableForTests();

describe('gaugeLabelsSameThickness', () => {
  it('treats spacing as the same thickness and a real step as different', () => {
    expect(gaugeLabelsSameThickness('0.45mm', '0.45 mm')).toBe(true);
    expect(gaugeLabelsSameThickness('0.45mm', '0.22mm')).toBe(false);
  });
});

describe.skipIf(!mysqlOk)('coil gauge revision', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  it('stores the new gauge and leaves earlier job gauges on the old thickness', () => {
    db.prepare(
      `INSERT INTO products (product_id, name, category, stock_level, unit)
       VALUES ('COIL-ALU', 'Alu coil', 'Raw Material', 4000, 'kg')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (
        coil_no, product_id, branch_id, gauge_label, colour,
        qty_received, weight_kg, qty_remaining, qty_reserved, current_weight_kg, current_status,
        received_at_iso
      ) VALUES ('CL-G-1', 'COIL-ALU', 'BR-KD', '0.45mm', 'IV', 4000, 4000, 4000, 0, 4000, 'Available', '2026-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, status, created_at_iso, actual_meters)
       VALUES ('JOB-G-1', 'Completed', '2026-02-01T00:00:00.000Z', 20)`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (
        id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, meters_produced, allocated_at_iso
      ) VALUES ('PJC-G-1', 'JOB-G-1', 1, 'CL-G-1', '0.45mm', 100, 20, '2026-02-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, status, created_at_iso)
       VALUES ('JOB-G-2', 'Completed', '2026-02-02T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (
        id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, allocated_at_iso
      ) VALUES ('PJC-G-2', 'JOB-G-2', 1, 'CL-G-1', NULL, 50, '2026-02-02T00:00:00.000Z')`
    ).run();

    const beforeRev = buildWorkspaceRevision(db, 'BR-KD').revision;
    const r = patchCoilLotMasterData(
      db,
      'CL-G-1',
      { gaugeLabel: '0.22 mm' },
      { workspaceBranchId: 'BR-KD' }
    );
    expect(r.ok).toBe(true);
    expect(r.gaugeLabel).toBe('0.22mm');
    expect(r.gaugeRevision?.changed).toBe(true);

    const lot = db.prepare(`SELECT gauge_label, gauge_revised_at_iso FROM coil_lots WHERE coil_no = ?`).get('CL-G-1');
    expect(lot.gauge_label).toBe('0.22mm');
    expect(String(lot.gauge_revised_at_iso || '')).not.toBe('');
    expect(buildWorkspaceRevision(db, 'BR-KD').revision).not.toBe(beforeRev);

    const kept = db.prepare(`SELECT gauge_label FROM production_job_coils WHERE id = ?`).get('PJC-G-1');
    expect(kept.gauge_label).toBe('0.45mm');
    const stamped = db.prepare(`SELECT gauge_label FROM production_job_coils WHERE id = ?`).get('PJC-G-2');
    expect(stamped.gauge_label).toBe('0.45mm');

    const changedAt = r.gaugeRevision.effectiveFromIso;
    expect(coilGaugeLabelAsOf(db, 'CL-G-1', '2026-03-01T00:00:00.000Z', lot.gauge_label)).toBe('0.45mm');
    expect(coilGaugeLabelAsOf(db, 'CL-G-1', changedAt, lot.gauge_label)).toBe('0.22mm');
  });
});
