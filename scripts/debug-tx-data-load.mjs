/**
 * Offline diagnostic for write-transaction → workspace revision → data load.
 * Uses stub DB when MySQL is down so the pipeline can still be traced.
 *
 * Usage: node scripts/debug-tx-data-load.mjs
 */
import { debugSessionLog } from '../server/debugSessionLog.js';
import { bumpWorkspaceRevisions, buildWorkspaceRevision } from '../server/workspaceRevision.js';
import {
  broadcastWorkspaceDataChanged,
  domainsForApiPath,
  isShellApiPath,
  workspaceDataEventMiddleware,
  WRITE_DOMAINS,
} from '../server/workspaceDataEvents.js';

const runId = 'tx-load-diag';

/** Minimal stub covering revision fingerprints + revision counter upserts. */
function makeStubDb() {
  /** @type {Record<string, number>} */
  const counters = {};
  const tables = {
    quotations: { c: 10, m: '2026-09-01' },
    sales_receipts: { c: 5, m: '2026-09-01' },
    customers: { c: 100, m: '2026-09-01' },
    cutting_lists: { c: 3, m: '2026-09-01' },
    production_jobs: { c: 7, m: '2026-09-01' },
    purchase_orders: { c: 4, m: '2026-09-01' },
    coil_lots: { c: 20, m: '2026-09-01' },
    ledger_entries: { c: 50, m: '2026-09-01' },
    treasury_movements: { c: 8, m: '2026-09-01' },
    expenses: { c: 12, m: '2026-09-01' },
    payment_requests: { c: 2, m: '2026-09-01' },
    work_items: { c: 6, m: '2026-09-01' },
    customer_refunds: { c: 1, m: '2026-09-01', credit_sum: 0, paid_sum: 0 },
    workspace_domain_revisions: true,
  };

  let depth = 0;
  return {
    get inTransaction() {
      return depth > 0;
    },
    prepare(sql) {
      const s = String(sql || '');
      if (/workspace_domain_revisions/.test(s) && /INSERT/i.test(s)) {
        return {
          run(branchId, domainKey) {
            const key = `${branchId}:${domainKey}`;
            counters[key] = (counters[key] || 0) + 1;
          },
        };
      }
      if (/workspace_domain_revisions/.test(s) && /SELECT/i.test(s)) {
        return {
          all() {
            return Object.entries(counters).map(([k, revision]) => {
              const [branch_id, domain_key] = k.split(':');
              return { branch_id, domain_key, revision };
            });
          },
          get() {
            return null;
          },
        };
      }
      const table = /FROM\s+(\w+)/i.exec(s)?.[1] ?? '';
      return {
        get: () => tables[table] ?? { c: 0, m: '' },
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    },
    transaction(fn) {
      return (...args) => {
        depth += 1;
        const depthAtEnter = depth;
        try {
          const ret = fn(...args);
          // #region agent log
          if (depthAtEnter === 1) {
            debugSessionLog({
              hypothesisId: 'E',
              location: 'debug-tx-data-load.mjs:stubTxCommit',
              message: 'stub outer transaction committed',
              data: { depth: depthAtEnter },
              runId,
            });
          }
          // #endregion
          return ret;
        } catch (e) {
          debugSessionLog({
            hypothesisId: 'E',
            location: 'debug-tx-data-load.mjs:stubTxRollback',
            message: 'stub outer transaction rolled back',
            data: { depth: depthAtEnter, err: String(e?.message || e).slice(0, 120) },
            runId,
          });
          throw e;
        } finally {
          depth = Math.max(0, depth - 1);
        }
      };
    },
    _counters: counters,
    _tables: tables,
  };
}

function simulateHttpWrite(db, { method, path, body, statusCode = 200, workspaceBranchId = 'KD' }) {
  const mw = workspaceDataEventMiddleware(db);
  /** @type {any} */
  let jsonBody = null;
  /** @type {any} */
  const req = { method, originalUrl: path, url: path, workspaceBranchId };
  /** @type {any} */
  const res = {
    statusCode,
    json(b) {
      jsonBody = b;
      return b;
    },
  };
  mw(req, res, () => {
    res.json(body);
  });
  return jsonBody;
}

function main() {
  debugSessionLog({
    hypothesisId: 'pipeline',
    location: 'debug-tx-data-load.mjs:start',
    message: 'starting offline transaction→load diagnostic',
    data: { mode: 'stub-db' },
    runId,
  });

  const db = makeStubDb();

  // H-A: path mapping
  const mapped = {
    receipts: domainsForApiPath('/api/receipts'),
    quotations: domainsForApiPath('/api/quotations'),
    expenses: domainsForApiPath('/api/expenses'),
    unmapped: domainsForApiPath('/api/unknown-resource-xyz'),
    usersShell: isShellApiPath('/api/users'),
    writeDomainsReceipt: WRITE_DOMAINS.receipt,
  };
  debugSessionLog({
    hypothesisId: 'A',
    location: 'debug-tx-data-load.mjs:pathMap',
    message: 'RESOURCE_DOMAINS / WRITE_DOMAINS samples',
    data: mapped,
    runId,
  });

  const before = buildWorkspaceRevision(db, 'ALL');
  debugSessionLog({
    hypothesisId: 'D',
    location: 'debug-tx-data-load.mjs:beforeRev',
    message: 'revision before write+bump',
    data: { revision: before.revision, domains: before.domains },
    runId,
  });

  // Simulate business write inside a transaction (money lands here in real code)
  db.transaction(() => {
    db._tables.sales_receipts = { c: 6, m: '2026-09-14' };
    db._tables.ledger_entries = { c: 51, m: '2026-09-14' };
  })();

  // Simulate successful HTTP response → middleware bump + SSE invalidate
  simulateHttpWrite(db, {
    method: 'POST',
    path: '/api/receipts',
    body: { ok: true, delta: { receipts: [{ id: 'RCPT-DEBUG-1' }] } },
  });

  // Unmapped mutating path (should log unmapped and not bump via middleware)
  simulateHttpWrite(db, {
    method: 'POST',
    path: '/api/mystery-endpoint',
    body: { ok: true },
  });

  const after = buildWorkspaceRevision(db, 'ALL');
  debugSessionLog({
    hypothesisId: 'D',
    location: 'debug-tx-data-load.mjs:afterRev',
    message: 'revision after receipt write+bump',
    data: {
      before: before.revision,
      after: after.revision,
      changed: before.revision !== after.revision,
      salesChanged: before.domains?.sales !== after.domains?.sales,
      financeChanged: before.domains?.finance !== after.domains?.finance,
      domainsBefore: before.domains,
      domainsAfter: after.domains,
      counters: db._counters,
    },
    runId,
  });

  // Direct bump failure path (H-B) — broken prepare
  const brokenDb = {
    prepare() {
      throw new Error('simulated bump failure');
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
  bumpWorkspaceRevisions(brokenDb, { domains: ['finance'], branchId: 'KD' });

  // Load implication: if revision changed, snapshot would rebuild (200); else 304
  const would304 = before.domains?.finance === after.domains?.finance;
  debugSessionLog({
    hypothesisId: 'C',
    location: 'debug-tx-data-load.mjs:loadImplication',
    message: 'what client load would do after this write',
    data: {
      financeSnapshotWould304: would304,
      financeSnapshotWouldRebuild: !would304,
      note: 'bootstrap poll cache can still serve stale shell for ~8s even when revision moved',
      flow: 'db.transaction(commit) → res.json middleware → bumpWorkspaceRevisions → SSE workspace.data → client GET revision/snapshot/bootstrap',
    },
    runId,
  });

  broadcastWorkspaceDataChanged({
    domains: ['sales', 'finance'],
    branchId: 'KD',
    reason: 'debug-diag',
  });

  debugSessionLog({
    hypothesisId: 'pipeline',
    location: 'debug-tx-data-load.mjs:done',
    message: 'offline diagnostic complete',
    data: {
      revisionChanged: before.revision !== after.revision,
      receiptMapsTo: mapped.receipts,
    },
    runId,
  });

  console.log('[debug-tx-data-load] done — revision changed:', before.revision !== after.revision);
  console.log('[debug-tx-data-load] logs: debug-513ebb.log and .cursor/debug-513ebb.log');
}

main();
