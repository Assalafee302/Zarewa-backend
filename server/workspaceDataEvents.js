/**
 * Tell connected desks that business data moved.
 *
 * Chat has been real-time since the SSE channel was built; business writes never used it,
 * so a saved quotation reached a colleague only when their ninety-second poll happened to
 * notice the workspace revision had changed — and even then only their primary desk
 * refetched. This closes that gap using the channel that already exists.
 *
 * What goes over the wire is an invalidation, not data: which domains moved, nothing
 * about what changed or who can see it. The client then revalidates those packs through
 * the normal authenticated path, so permissions and branch scoping are enforced where
 * they always were rather than here.
 *
 * The poll stays. This fan-out is in-memory and per-process, so under multiple workers a
 * broadcast only reaches clients connected to the same one. SSE makes the common case
 * instant; the revision poll reads the database and remains the guarantee.
 */
import { broadcastWorkspaceEvent } from './workspaceRoomsOps.js';

/** Domains a desk pack can be invalidated for. */
const KNOWN_DOMAINS = new Set(['sales', 'operations', 'finance', 'procurement']);

/**
 * @param {{ domains: string[], shell?: boolean, branchId?: string | null, reason?: string }} p
 */
export function broadcastWorkspaceDataChanged({ domains, shell = false, branchId = null, reason = '' }) {
  const list = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d || '').trim().toLowerCase()))]
    .filter((d) => KNOWN_DOMAINS.has(d));
  if (!list.length && !shell) return;
  try {
    broadcastWorkspaceEvent({
      type: 'workspace.data',
      domains: list,
      // Not everything lives in a desk pack. Users, roles, branches and org settings ride
      // the first-paint shell, and app_users is not among the tables the revision
      // fingerprints — so a colleague's poll can answer 304 and refresh nothing at all
      // after an account is created or a permission changed.
      shell: Boolean(shell),
      // Branch-scoped like every other event: a Kaduna write should not wake Yola desks.
      // An empty branch reaches everyone, which is right for genuinely global changes.
      branchId: String(branchId || '').trim(),
      reason: String(reason || '').slice(0, 60),
      revision: Date.now(),
    });
  } catch {
    // A failed notification must never fail the write that triggered it. The poll will
    // still carry the change; the user just waits as long as they did before.
  }
}

/**
 * Which desks care about each kind of write.
 *
 * Deliberately generous: a receipt shows on the sales desk and the cashier's queue, and
 * telling one desk too many costs a conditional request that answers 304, while telling
 * one too few is the bug this module exists to fix.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const WRITE_DOMAINS = Object.freeze({
  quotation: ['sales'],
  receipt: ['sales', 'finance'],
  refund: ['sales', 'finance'],
  refundCredit: ['sales', 'finance'],
  cuttingList: ['sales', 'operations'],
  productionJob: ['operations'],
  coil: ['operations', 'procurement'],
  purchaseOrder: ['procurement'],
  supplier: ['procurement'],
  expense: ['finance'],
  paymentRequest: ['finance', 'procurement'],
  treasury: ['finance'],
  ledger: ['sales', 'finance'],
});

/**
 * Convenience wrapper: name the thing written rather than the desks it touches, so call
 * sites do not each have to remember that a receipt is also a finance concern.
 * @param {keyof typeof WRITE_DOMAINS} kind
 * @param {string | null} [branchId]
 */
export function notifyWorkspaceWrite(kind, branchId = null) {
  const domains = WRITE_DOMAINS[kind];
  if (!domains) return;
  broadcastWorkspaceDataChanged({ domains: [...domains], branchId, reason: String(kind) });
}

/**
 * Which desks each API resource feeds.
 *
 * Matched on the first path segment after /api/. Generous on purpose: naming one desk too
 * many costs a conditional request that answers 304, while naming one too few leaves a
 * colleague staring at stale data — which is the whole bug.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const RESOURCE_DOMAINS = Object.freeze({
  quotations: ['sales'],
  customers: ['sales'],
  receipts: ['sales', 'finance'],
  ledger: ['sales', 'finance'],
  refunds: ['sales', 'finance'],
  'cutting-lists': ['sales', 'operations'],
  'staff-purchase-credits': ['sales', 'finance'],
  'credit-exceptions': ['sales'],

  'production-jobs': ['operations'],
  deliveries: ['operations'],
  'coil-lots': ['operations', 'procurement'],
  'coil-control': ['operations'],
  'coil-requests': ['operations', 'procurement'],
  'material-incidents': ['operations'],
  'material-requests': ['operations'],
  'stock-register': ['operations', 'procurement'],
  inventory: ['operations', 'procurement'],
  maintenance: ['operations'],

  expenses: ['finance'],
  'expense-categories': ['finance'],
  'payment-requests': ['finance', 'procurement'],
  treasury: ['finance'],
  'bank-deposits': ['finance'],
  'bank-reconciliation': ['finance'],
  'accounts-payable': ['finance', 'procurement'],
  accounting: ['finance'],
  gl: ['finance'],
  'partner-wallets': ['finance'],
  'inter-branch-loans': ['finance'],

  'purchase-orders': ['procurement'],
  suppliers: ['procurement'],
  pricing: ['sales', 'procurement'],

  // Cross-cutting: approvals and edits land on whichever desk raised them, and the work
  // queue itself is read by all four.
  'work-items': ['sales', 'operations', 'finance', 'procurement'],
  'edit-approvals': ['sales', 'operations', 'finance', 'procurement'],
  controls: ['sales', 'operations', 'finance', 'procurement'],
});

/** Methods that can change something worth telling other desks about. */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Resources that change the shell rather than a desk pack: accounts, roles, permissions,
 * branches and org settings. These are what a colleague's poll cannot see, because
 * app_users is not one of the tables the workspace revision fingerprints.
 */
const SHELL_RESOURCES = new Set(['users', 'settings', 'branches', 'org', 'setup', 'controls']);

/** @param {string} path e.g. /api/quotations/QT-1 */
export function domainsForApiPath(path) {
  const m = /^\/api\/([a-z0-9-]+)/i.exec(String(path || ''));
  const resource = m ? m[1].toLowerCase() : '';
  return RESOURCE_DOMAINS[resource] ? [...RESOURCE_DOMAINS[resource]] : [];
}

/** @param {string} path @returns {boolean} whether this write changes shell-level data */
export function isShellApiPath(path) {
  const m = /^\/api\/([a-z0-9-]+)/i.exec(String(path || ''));
  return m ? SHELL_RESOURCES.has(m[1].toLowerCase()) : false;
}

/**
 * Announce successful writes without asking twenty route handlers to remember to.
 *
 * Wrapping the response rather than editing each handler is deliberate: a missed call
 * site is invisible until someone reports stale data weeks later, and each hand-edit in
 * a money path is a chance to break something that currently works. The trade is that
 * the resource-to-desk mapping is central rather than at the point of the write — which
 * is also the only place it can be reviewed as a whole.
 *
 * Fires after the handler has produced its response, so after its transaction committed.
 * Only on a 2xx that did not carry `ok: false`, because several routes report refusals
 * that way rather than by status code.
 */
export function workspaceDataEventMiddleware(req, res, next) {
  if (!MUTATING_METHODS.has(String(req.method || '').toUpperCase())) return next();
  const path = req.originalUrl || req.url || '';
  const domains = domainsForApiPath(path);
  const shell = isShellApiPath(path);
  if (!domains.length && !shell) return next();

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    const out = sendJson(body);
    try {
      const okStatus = res.statusCode >= 200 && res.statusCode < 300;
      if (okStatus && body?.ok !== false) {
        broadcastWorkspaceDataChanged({
          domains,
          shell,
          // Accounts, roles and branches are not branch-scoped concerns: an empty branch
          // reaches every connected desk, which is what a new colleague needs.
          branchId: shell ? null : req.workspaceBranchId || null,
          reason: String(req.method),
        });
      }
    } catch {
      // Never let announcing a write disturb the write's own response.
    }
    return out;
  };
  next();
}
