/**
 * Local HTTP debug server (no MySQL) for transaction → data-load tracing.
 * Listens on PORT or 8787. Uses stub DB + real middleware/revision code.
 *
 * Usage: node scripts/debug-tx-load-server.mjs
 */
import http from 'node:http';
import { debugSessionLog } from '../server/debugSessionLog.js';
import { bumpWorkspaceRevisions, buildWorkspaceRevision } from '../server/workspaceRevision.js';
import {
  domainsForApiPath,
  isShellApiPath,
  workspaceDataEventMiddleware,
} from '../server/workspaceDataEvents.js';

const runId = 'tx-load-http';
const port = Number(process.env.PORT || 8787) || 8787;

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
          all(branchScope) {
            return Object.entries(counters)
              .filter(([k]) => k.startsWith(`${branchScope}:`))
              .map(([k, revision]) => {
                const domain_key = k.slice(String(branchScope).length + 1);
                return { domain_key, revision };
              });
          },
          get: () => null,
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
        const at = depth;
        try {
          const ret = fn(...args);
          if (at === 1) {
            debugSessionLog({
              hypothesisId: 'E',
              location: 'debug-tx-load-server.mjs:txCommit',
              message: 'stub outer transaction committed',
              data: { depth: at },
              runId,
            });
          }
          return ret;
        } catch (e) {
          if (at === 1) {
            debugSessionLog({
              hypothesisId: 'E',
              location: 'debug-tx-load-server.mjs:txRollback',
              message: 'stub outer transaction rolled back',
              data: { depth: at, err: String(e?.message || e).slice(0, 120) },
              runId,
            });
          }
          throw e;
        } finally {
          depth = Math.max(0, depth - 1);
        }
      };
    },
    _tables: tables,
    _counters: counters,
  };
}

const db = makeStubDb();
const eventMw = workspaceDataEventMiddleware(db);

/** Tiny express-like res for middleware compatibility. */
function wrapRes(nodeRes) {
  let statusCode = 200;
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v) {
      statusCode = Number(v) || 200;
    },
    setHeader(k, v) {
      headers[k] = String(v);
    },
    json(body) {
      const payload = JSON.stringify(body);
      nodeRes.writeHead(statusCode, headers);
      nodeRes.end(payload);
      return body;
    },
    end() {
      nodeRes.writeHead(statusCode, headers);
      nodeRes.end();
    },
  };
  return res;
}

const etags = new Map();

const server = http.createServer((nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url || '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  /** @type {any} */
  const req = {
    method: nodeReq.method || 'GET',
    originalUrl: path + url.search,
    url: path + url.search,
    workspaceBranchId: 'KD',
    headers: nodeReq.headers,
  };
  const res = wrapRes(nodeRes);

  const finish = () => {
    if (path === '/api/health') {
      return res.json({ ok: true, mode: 'debug-tx-load-stub' });
    }

    if (path === '/api/workspace/revision' && req.method === 'GET') {
      const payload = buildWorkspaceRevision(db, 'ALL');
      const etag = `W/"${payload.revision}"`;
      const inm = String(req.headers['if-none-match'] || '');
      if (inm && inm === etag) {
        debugSessionLog({
          hypothesisId: 'D',
          location: 'debug-tx-load-server.mjs:revision304',
          message: 'workspace revision 304',
          data: { revision: payload.revision, domains: payload.domains },
          runId,
        });
        res.statusCode = 304;
        return res.end();
      }
      debugSessionLog({
        hypothesisId: 'D',
        location: 'debug-tx-load-server.mjs:revision200',
        message: 'workspace revision 200',
        data: { revision: payload.revision, domains: payload.domains },
        runId,
      });
      res.setHeader('ETag', etag);
      etags.set('revision', etag);
      return res.json(payload);
    }

    if (path === '/api/workspace/finance-snapshot' && req.method === 'GET') {
      const rev = buildWorkspaceRevision(db, 'ALL');
      const domainRev = rev.domains?.finance || rev.revision;
      const etag = `W/"finance-${domainRev}"`;
      const inm = String(req.headers['if-none-match'] || '');
      if (inm && inm === etag) {
        debugSessionLog({
          hypothesisId: 'D',
          location: 'debug-tx-load-server.mjs:snapshot304',
          message: 'finance snapshot 304',
          data: { domainRev },
          runId,
        });
        res.statusCode = 304;
        return res.end();
      }
      debugSessionLog({
        hypothesisId: 'D',
        location: 'debug-tx-load-server.mjs:snapshot200',
        message: 'finance snapshot rebuilt',
        data: { domainRev, receiptCount: db._tables.sales_receipts.c },
        runId,
      });
      res.setHeader('ETag', etag);
      return res.json({
        ok: true,
        domain: 'finance',
        revision: domainRev,
        salesReceiptsCount: db._tables.sales_receipts.c,
        ledgerCount: db._tables.ledger_entries.c,
      });
    }

    if (path === '/api/bootstrap' && req.method === 'GET') {
      const poll = url.searchParams.get('poll') === '1';
      const cacheKey = 'bootstrap-shell';
      if (poll && etags.has(cacheKey)) {
        const hit = etags.get(cacheKey);
        debugSessionLog({
          hypothesisId: 'C',
          location: 'debug-tx-load-server.mjs:bootstrapCacheHit',
          message: 'bootstrap poll cache hit (stub)',
          data: { etag: hit },
          runId,
        });
        res.setHeader('ETag', hit);
        return res.json({ ok: true, mode: 'shell', cached: true, revision: buildWorkspaceRevision(db, 'ALL').revision });
      }
      const rev = buildWorkspaceRevision(db, 'ALL').revision;
      const etag = `W/"boot-${rev}"`;
      etags.set(cacheKey, etag);
      debugSessionLog({
        hypothesisId: 'C',
        location: 'debug-tx-load-server.mjs:bootstrapBuilt',
        message: 'bootstrap rebuilt',
        data: { revision: rev, poll },
        runId,
      });
      res.setHeader('ETag', etag);
      return res.json({ ok: true, mode: 'shell', cached: false, revision: rev });
    }

    if (path === '/api/receipts' && req.method === 'POST') {
      // Real middleware path: wrap res.json so bump+SSE run after commit.
      return eventMw(req, res, () => {
        try {
          db.transaction(() => {
            db._tables.sales_receipts = {
              c: (db._tables.sales_receipts.c || 0) + 1,
              m: new Date().toISOString().slice(0, 10),
            };
            db._tables.ledger_entries = {
              c: (db._tables.ledger_entries.c || 0) + 1,
              m: new Date().toISOString().slice(0, 10),
            };
          })();
          // Clear stub bootstrap cache so post-write load is measurable as rebuild vs stale.
          etags.delete('bootstrap-shell');
          res.json({
            ok: true,
            delta: { receipts: [{ id: `RCPT-DEBUG-${db._tables.sales_receipts.c}` }] },
          });
        } catch (e) {
          res.statusCode = 500;
          res.json({ ok: false, error: String(e?.message || e) });
        }
      });
    }

    if (path === '/api/mystery-endpoint' && req.method === 'POST') {
      return eventMw(req, res, () => {
        res.json({ ok: true });
      });
    }

    debugSessionLog({
      hypothesisId: 'A',
      location: 'debug-tx-load-server.mjs:404',
      message: 'unknown route',
      data: { method: req.method, path, mapped: domainsForApiPath(path), shell: isShellApiPath(path) },
      runId,
    });
    res.statusCode = 404;
    return res.json({ ok: false, error: 'not found' });
  };

  if (req.method === 'POST') {
    let raw = '';
    nodeReq.on('data', (c) => {
      raw += c;
    });
    nodeReq.on('end', finish);
  } else {
    finish();
  }
});

server.listen(port, '127.0.0.1', () => {
  debugSessionLog({
    hypothesisId: 'pipeline',
    location: 'debug-tx-load-server.mjs:listen',
    message: 'debug tx-load stub server listening',
    data: { port },
    runId,
  });
  console.log(`[debug-tx-load-server] http://127.0.0.1:${port}/api/health`);
});
