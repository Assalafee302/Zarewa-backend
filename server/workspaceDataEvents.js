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
 * @param {{ domains: string[], branchId?: string | null, reason?: string }} p
 */
export function broadcastWorkspaceDataChanged({ domains, branchId = null, reason = '' }) {
  const list = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d || '').trim().toLowerCase()))]
    .filter((d) => KNOWN_DOMAINS.has(d));
  if (!list.length) return;
  try {
    broadcastWorkspaceEvent({
      type: 'workspace.data',
      domains: list,
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
