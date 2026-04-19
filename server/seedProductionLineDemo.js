import { DEFAULT_BRANCH_ID } from './branches.js';
import * as write from './writeOps.js';

function markJobCompletedDemo(db, jobID, cuttingListId, actualMeters) {
  const iso = '2026-03-12T16:00:00.000Z';
  db.prepare(
    `UPDATE production_jobs SET status = 'Completed', completed_at_iso = ?, end_date_iso = ?, actual_meters = ?, actual_weight_kg = ?, conversion_alert_state = 'OK', manager_review_required = 0 WHERE job_id = ?`
  ).run(iso, '2026-03-12', actualMeters, 0, jobID);
  db.prepare(`UPDATE cutting_lists SET status = 'Finished' WHERE id = ?`).run(cuttingListId);
}

/**
 * Idempotent demo chain aligned with seeded data:
 * - QT-2026-003: paid in full (receipt RC-2026-012) → cutting list + active Planned job for the queue.
 * - QT-2026-007: paid in full (receipt RC-2026-008) → cutting list + Completed job for read-only viewing.
 */
export function seedProductionLineDemo(db) {
  try {
    seedActiveJobForQuote003(db);
    seedCompletedJobForQuote007(db);
    seedCompletedJobsForRefundEligibleSeededQuotes(db);
  } catch (e) {
    console.warn('[seed] production line demo:', e?.message || e);
  }
}

/** So default quotations used in refund API tests satisfy POST /api/refunds eligibility (Completed/Cancelled job). */
function seedCompletedJobsForRefundEligibleSeededQuotes(db) {
  const targets = [
    {
      qref: 'QT-2026-001',
      custId: 'CUS-001',
      jobId: 'PRO-SEED-RF-001',
    },
    {
      qref: 'QT-2026-002',
      custId: 'CUS-002',
      jobId: 'PRO-SEED-RF-002',
    },
  ];
  for (const { qref, custId, jobId } of targets) {
    const qok = db.prepare(`SELECT id FROM quotations WHERE id = ?`).get(qref);
    if (!qok) continue;
    const closed = db
      .prepare(
        `SELECT 1 FROM production_jobs WHERE quotation_ref = ? AND status IN ('Completed','Cancelled') LIMIT 1`
      )
      .get(qref);
    if (closed) continue;

    const cl = write.insertCuttingList(
      db,
      {
        quotationRef: qref,
        customerID: custId,
        productID: 'FG-101',
        productName: 'Longspan thin',
        dateISO: '2026-03-28',
        machineName: 'Seed',
        handledBy: 'Seed',
        lines: [{ sheets: 1, lengthM: 10 }],
      },
      DEFAULT_BRANCH_ID
    );
    if (!cl.ok) continue;

    const job = write.insertProductionJob(
      db,
      {
        jobID: jobId,
        cuttingListId: cl.id,
        productID: 'FG-101',
        productName: 'Longspan thin',
        plannedMeters: 10,
        plannedSheets: 1,
        machineName: 'Seed',
      },
      DEFAULT_BRANCH_ID
    );
    if (!job.ok) continue;
    markJobCompletedDemo(db, job.jobID, cl.id, 10);
  }
}

function seedActiveJobForQuote003(db) {
  const clRow = db
    .prepare(`SELECT id, production_registered FROM cutting_lists WHERE quotation_ref = 'QT-2026-003'`)
    .get();
  if (clRow?.production_registered) return;

  if (!clRow) {
    const cl = write.insertCuttingList(
      db,
      {
      quotationRef: 'QT-2026-003',
      productID: 'FG-101',
      productName: 'Longspan thin (Zaidu batch)',
      dateISO: '2026-03-30',
      machineName: 'Production line',
      operatorName: 'Demo',
      handledBy: 'Seed',
      lines: [
        { sheets: 10, lengthM: 12 },
        { sheets: 5, lengthM: 8 },
      ],
    },
      DEFAULT_BRANCH_ID
    );
    if (!cl.ok) return;
    write.insertProductionJob(
      db,
      {
        jobID: 'PRO-DEMO-ACTIVE',
        cuttingListId: cl.id,
        productID: 'FG-101',
        productName: 'Longspan thin (Zaidu batch)',
        plannedMeters: 160,
        plannedSheets: 15,
        machineName: 'Production line',
        operatorName: 'Demo operator',
      },
      DEFAULT_BRANCH_ID
    );
    return;
  }

  const job = write.insertProductionJob(
    db,
    {
      jobID: 'PRO-DEMO-ACTIVE',
      cuttingListId: clRow.id,
      productID: 'FG-101',
      productName: 'Longspan thin (Zaidu batch)',
      plannedMeters: 160,
      plannedSheets: 15,
      machineName: 'Production line',
      operatorName: 'Demo operator',
    },
    DEFAULT_BRANCH_ID
  );
  if (!job.ok) {
    /* e.g. list already tied to another job */
  }
}

function seedCompletedJobForQuote007(db) {
  const clRow = db
    .prepare(`SELECT id, production_registered FROM cutting_lists WHERE quotation_ref = 'QT-2026-007'`)
    .get();

  if (!clRow) {
    const cl = write.insertCuttingList(
      db,
      {
        quotationRef: 'QT-2026-007',
        productID: 'FG-101',
        productName: 'Longspan thin (Grace — demo complete)',
        dateISO: '2026-03-10',
        machineName: 'Production line',
        handledBy: 'Seed',
        lines: [{ sheets: 4, lengthM: 15 }],
      },
      DEFAULT_BRANCH_ID
    );
    if (!cl.ok) return;
    const job = write.insertProductionJob(
      db,
      {
        jobID: 'PRO-DEMO-DONE',
        cuttingListId: cl.id,
        productID: 'FG-101',
        productName: 'Longspan thin (Grace — demo complete)',
        plannedMeters: 60,
        plannedSheets: 4,
        machineName: 'Production line',
      },
      DEFAULT_BRANCH_ID
    );
    if (!job.ok) return;
    markJobCompletedDemo(db, job.jobID, cl.id, 60);
    return;
  }

  const jobs = db.prepare(`SELECT job_id, status FROM production_jobs WHERE cutting_list_id = ?`).all(clRow.id);
  if (jobs.some((j) => j.status === 'Completed')) return;
  if (jobs.length > 0) return;

  if (!clRow.production_registered) {
    const job = write.insertProductionJob(
      db,
      {
        jobID: 'PRO-DEMO-DONE',
        cuttingListId: clRow.id,
        productID: 'FG-101',
        productName: 'Longspan thin (Grace — demo complete)',
        plannedMeters: 60,
        plannedSheets: 4,
        machineName: 'Production line',
      },
      DEFAULT_BRANCH_ID
    );
    if (!job.ok) return;
    markJobCompletedDemo(db, job.jobID, clRow.id, 60);
  }
}
