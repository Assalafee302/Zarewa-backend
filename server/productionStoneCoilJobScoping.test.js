import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { insertCuttingList, insertProductionJob } from './writeOps.js';
import { completeProductionJob, startProductionJob } from './productionTraceability.js';

/**
 * Regression coverage for the stone-coated production register bugs reported by users:
 *  1. "Metres consumed (stone stock)" on a hybrid job appears to not count.
 *  2. Coil / offcut metres entered for the flat-sheet portion of a hybrid job look like they get
 *     counted as roof production.
 *
 * A prior fix (see git history: "Scope stone-metre and coil-allocation checks to each job's own
 * product line") scoped `quotationExpectsCoilAllocation` / `quotationRequiresStoneMetreConsumption`
 * by `job.product_name`, on the theory that a hybrid stone quotation could produce two separate
 * production jobs — one per cutting-list product — that needed to be classified independently.
 * That fix's own test (this file, previously) proved the theory by hand-inserting two
 * `production_jobs` rows with fabricated `product_id` / `product_name` values.
 *
 * Both premises turned out to be wrong:
 *  - `product_name` / `product_id` are NEVER populated by real cutting-list creation for a normal
 *    (non-accessories-only) list: `insertCuttingList` only sets `product_name` when the quotation
 *    is accessories-only (see writeOps.js `insertCuttingList`: `productName = accessoriesOnly ?
 *    'Accessories only' : String(payload.productName ?? '').trim()`, and the frontend
 *    `CuttingListModal.buildPersistPayload` never sends `productName` otherwise). So the scoping
 *    key was always blank in production, and the "fail open to the whole quotation" fallback in
 *    `quotationProductLinesForJobProduct` made the fix a no-op for every real job.
 *  - The "two production jobs on one quotation" scenario the fix targeted cannot occur at all:
 *    `validateQuotationForCuttingList` rejects creating a second (non-draft) cutting list once one
 *    already exists for a quotation ("This quotation already has cutting list ..."), and
 *    `insertProductionJob` marks the cutting list `production_registered` on job creation. So a
 *    quotation has at most ONE cutting list and ONE production job — a hybrid stone-coated
 *    quotation (Roofing Sheet + Flat sheet) is always cut as ONE cutting list carrying both a
 *    'Roof' and a 'Flatsheet' `cutting_list_lines` row, feeding ONE production job.
 *
 * These tests build jobs the way the app actually does — `insertCuttingList` →
 * `insertProductionJob` — and confirm the real bug: a hybrid job's coil/offcut completion sets
 * `actual_meters` (and, before this fix, the ONLY output figure exposed) to the coil/offcut-derived
 * flat-sheet metres alone; the stone-roofing metres consumed via `applyHybridStoneMetreAndSfTx` were
 * never folded into any per-job output figure. That is what made the roof entry look like it
 * "didn't count" while the one visible number (really just the flat-sheet figure) could be misread
 * as roof output. The fix adds `actual_roof_m` / `actual_flatsheet_m` columns populated at
 * completion so both portions are visible and distinct.
 */
describe('stone-coated production jobs built the real way (insertCuttingList -> insertProductionJob)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-HY-1', 'Hybrid Test Customer', ?)`
    ).run(DEFAULT_BRANCH_ID);
  });

  afterEach(() => {
    db?.close();
  });

  function insertStoneQuotation(id, products, totalNgn) {
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json,
        date_iso, branch_id, manager_production_approved_at_iso, manager_production_approval_level
      ) VALUES (?, 'CUS-HY-1', 'Hybrid Test Customer', ?, 0, 'Unpaid', 'Approved', ?, '2026-05-01', ?, ?, 'admin')`
    ).run(
      id,
      totalNgn,
      JSON.stringify({
        materialTypeId: 'MAT-005',
        stoneMeterQuote: true,
        materialDesign: 'Bond',
        materialColor: 'Red',
        materialGauge: '0.50mm',
        products,
        accessories: [],
      }),
      DEFAULT_BRANCH_ID,
      '2026-05-01T00:00:00.000Z'
    );
    // `productionGateOverrideEffective` treats an admin-level manager stamp as sufficient
    // regardless of payment, so these tests can focus on stone/coil classification rather than
    // reproducing the payment-gate machinery.
  }

  it('a pure stone-roofing job (no Flat sheet on the quotation) gets a null product_id/product_name from real creation, requires no coil, and its stone metres are recorded as the job output', () => {
    insertStoneQuotation('QT-STONE-PURE-1', [{ name: 'Roofing Sheet', qty: '100', unitPrice: '5000' }], 500000);

    const cl = insertCuttingList(db, {
      quotationRef: 'QT-STONE-PURE-1',
      lines: [{ sheets: 20, lengthM: 5, lineType: 'Roof' }],
    });
    expect(cl.ok).toBe(true);

    const job = insertProductionJob(db, { cuttingListId: cl.id });
    expect(job.ok).toBe(true);

    const jobRow = db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(job.jobID);
    // Confirms the premise the old fix/test got wrong: real job creation never sets these.
    expect(jobRow.product_id).toBeFalsy();
    expect(jobRow.product_name).toBeFalsy();

    const started = startProductionJob(db, job.jobID);
    expect(started.ok).toBe(true);

    // No coil allocation exists and none is required — this must route to the pure stone-metre
    // completion path, not the generic coil/offcut path.
    const empty = completeProductionJob(db, job.jobID, {});
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/stone metres consumed/i);
    expect(empty.error).not.toMatch(/coil allocation/i);

    const done = completeProductionJob(db, job.jobID, { stoneMetersConsumed: 80 });
    expect(done.ok).toBe(true);

    const finalRow = db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(job.jobID);
    expect(finalRow.status).toBe('Completed');
    expect(Number(finalRow.actual_meters)).toBe(80);
    expect(Number(finalRow.actual_roof_m)).toBe(80);
    expect(Number(finalRow.actual_flatsheet_m)).toBe(0);
  });

  it('a hybrid job (one cutting list carrying both a Roof and a Flatsheet line) requires coil/offcut completion, and records stone-roofing metres separately from coil/offcut flat-sheet output', () => {
    insertStoneQuotation(
      'QT-STONE-HYBRID-1',
      [
        { name: 'Roofing Sheet', qty: '100', unitPrice: '5000' },
        { name: 'Flat sheet', qty: '30', unitPrice: '4000' },
      ],
      620000
    );

    const cl = insertCuttingList(db, {
      quotationRef: 'QT-STONE-HYBRID-1',
      lines: [
        { sheets: 20, lengthM: 5, lineType: 'Roof' },
        { sheets: 3, lengthM: 10, lineType: 'Flatsheet' },
      ],
    });
    expect(cl.ok).toBe(true);

    const job = insertProductionJob(db, { cuttingListId: cl.id });
    expect(job.ok).toBe(true);

    const jobRow = db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(job.jobID);
    expect(jobRow.product_id).toBeFalsy();
    expect(jobRow.product_name).toBeFalsy();

    const started = startProductionJob(db, job.jobID);
    expect(started.ok).toBe(true);

    // This job has a Flatsheet line of its own — completing with no coil allocation and no
    // explicit offcut mode must be gated by the coil/offcut path (missing allocations), not the
    // sibling-free "stone metres" gate alone.
    const empty = completeProductionJob(db, job.jobID, {});
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/coil allocation|offcut/i);

    // Complete via offcut mode, providing both the flat-sheet output and the stone-roofing metres.
    const done = completeProductionJob(db, job.jobID, {
      completeMode: 'offcut',
      offcutMetersProduced: 25,
      offcutInventoryMeters: 25,
      stoneMetersConsumed: 60,
    });
    expect(done.ok).toBe(true);

    const finalRow = db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(job.jobID);
    expect(finalRow.status).toBe('Completed');
    // The bug: `actual_meters` alone only ever reflected the coil/offcut (flat-sheet) portion.
    expect(Number(finalRow.actual_meters)).toBe(25);
    // The fix: the stone-roofing portion is now recorded distinctly, instead of nowhere.
    expect(Number(finalRow.actual_roof_m)).toBe(60);
    expect(Number(finalRow.actual_flatsheet_m)).toBe(25);

    // And the stone-coated raw metre stock was actually drawn down for the roofing portion.
    const stoneMovement = db
      .prepare(`SELECT * FROM stock_movements WHERE ref = ? AND type = 'STONE_CONSUMPTION'`)
      .get(job.jobID);
    expect(stoneMovement).toBeTruthy();
    expect(Number(stoneMovement.qty)).toBe(-60);
  });
});
