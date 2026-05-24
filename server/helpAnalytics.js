/**
 * ERP activity analytics for Runa — read-only signals stored as learning events.
 */
import { writeHelpMemory } from '../shared/lib/helpMemory.js';

export function insertWorkflowEvent(db, ev) {
  if (!db) return;
  try {
    if (!db.prepare(`PRAGMA table_info(help_workflow_events)`).all().length) return;
  } catch {
    return;
  }
  const id = `hwe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO help_workflow_events (id, occurred_at_iso, branch_id, event_type, signal_key, payload_json, weight)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    new Date().toISOString(),
    ev.branchId ? String(ev.branchId) : null,
    String(ev.eventType),
    String(ev.signalKey),
    JSON.stringify({ articleId: ev.articleId || null, ...(ev.payload || {}) }),
    Number(ev.weight) || 1
  );
}

export function persistBranchArticleWeights(db, branchId, articleBoosts) {
  if (!db || !branchId) return;
  writeHelpMemory(db, 'branch', branchId, 'workflow_patterns', {
    articleBoosts,
    updatedAt: new Date().toISOString(),
  });
}

export function runHelpAnalyticsJob(db, opts = {}) {
  if (!db) return { events: 0 };
  const branchId = opts.branchId ? String(opts.branchId) : null;
  let events = 0;

  const signal = (eventType, signalKey, articleId, weight = 1, payload = {}) => {
    insertWorkflowEvent(db, { branchId, eventType, signalKey, articleId, weight, payload });
    events += 1;
  };

  try {
    if (db.prepare(`PRAGMA table_info(customer_refunds)`).all().length) {
      let sql = `SELECT COUNT(*) AS c FROM customer_refunds WHERE status IN ('pending','submitted','approved')`;
      const args = [];
      if (branchId) {
        sql += ` AND branch_id = ?`;
        args.push(branchId);
      }
      const c = Number(db.prepare(sql).get(...args)?.c) || 0;
      if (c > 0) signal('refunds', 'open_refunds', 'refund-approval-workflow', Math.min(5, c), { count: c });
    }
  } catch {
    /* optional */
  }

  try {
    if (db.prepare(`PRAGMA table_info(audit_log)`).all().length) {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 7);
      const rows = db
        .prepare(
          `SELECT action, COUNT(*) AS c FROM audit_log
           WHERE occurred_at_iso >= ? AND status IN ('failed','blocked','error')
           GROUP BY action ORDER BY c DESC LIMIT 10`
        )
        .all(since.toISOString());
      for (const r of rows) {
        const action = String(r.action || '');
        let articleId = 'period-locked';
        if (/refund/i.test(action)) articleId = 'refund-headroom-categories';
        else if (/receipt|ledger/i.test(action)) articleId = 'receipt-mistake';
        signal('errors', `audit_${action}`, articleId, Math.min(4, Number(r.c) || 1), { count: r.c });
      }
    }
  } catch {
    /* optional */
  }

  if (branchId) {
    /** @type {Record<string, number>} */
    const branchBoosts = {};
    try {
      const recent = db
        .prepare(
          `SELECT payload_json FROM help_workflow_events WHERE branch_id = ? ORDER BY occurred_at_iso DESC LIMIT 50`
        )
        .all(branchId);
      for (const row of recent) {
        try {
          const articleId = JSON.parse(String(row.payload_json || '{}')).articleId;
          if (articleId) branchBoosts[articleId] = (branchBoosts[articleId] || 0) + 1;
        } catch {
          /* skip */
        }
      }
      persistBranchArticleWeights(db, branchId, branchBoosts);
    } catch {
      /* ignore */
    }
  }

  return { events };
}

export function scheduleHelpAnalytics(db) {
  if (!db) return;
  const run = () => {
    try {
      runHelpAnalyticsJob(db, {});
    } catch (e) {
      console.warn('[zarewa] help analytics job failed', e?.message || e);
    }
  };
  setTimeout(run, 15_000);
  setInterval(run, 6 * 60 * 60 * 1000);
}
