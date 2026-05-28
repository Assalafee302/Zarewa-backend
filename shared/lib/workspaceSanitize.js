/**
 * Workspace response sanitizers — strip or redact sensitive fields before client/cache/Zare.
 */
import {
  RESTRICTED_WORK_ITEM_PLACEHOLDER,
  isConfidentialLevel,
  redactWorkItemForViewer,
} from './workspaceConfidentialAccess.js';

export const RESTRICTED_MEMO_MESSAGE =
  'Restricted memo — you do not have permission to view this item.';

/** @param {unknown} raw */
export function sanitizeRouteState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const st = { ...raw };
  delete st.body;
  delete st.subject;
  delete st.attachments;
  delete st.messages;
  delete st.threadBody;
  return st;
}

/** @param {unknown} data @param {string} [confidentiality] */
export function sanitizeWorkItemData(data, confidentiality) {
  if (!data || typeof data !== 'object') return {};
  const d = { ...data };
  if (isConfidentialLevel(confidentiality)) {
    if (Array.isArray(d.attachments)) {
      d.attachments = d.attachments.map((a) => ({
        ...(a && typeof a === 'object' ? a : {}),
        name: 'Restricted attachment',
        dataBase64: '',
        mime: a?.mime || 'application/octet-stream',
        redacted: true,
      }));
    }
  }
  return d;
}

/**
 * Strip heavy/sensitive fields from work items in list/bootstrap responses.
 * Caller must already have filtered by ACL.
 * @param {Record<string, unknown>|null|undefined} item
 */
export function sanitizeWorkItemForClient(item) {
  if (!item || typeof item !== 'object') return item;
  const confidentiality = item.confidentiality;
  const { body, ...rest } = item;
  return {
    ...rest,
    body: '',
    summary: isConfidentialLevel(confidentiality)
      ? String(item.summary || '').slice(0, 0)
      : String(item.summary || '').slice(0, 500),
    data: sanitizeWorkItemData(item.data, confidentiality),
    routeState: sanitizeRouteState(item.routeState),
  };
}

/**
 * Safe fields for sessionStorage bootstrap cache.
 * @param {Record<string, unknown>|null|undefined} item
 */
export function sanitizeWorkItemForCache(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.redacted) return redactWorkItemForViewer(item, false);
  const base = sanitizeWorkItemForClient(item);
  if (isConfidentialLevel(item.confidentiality)) {
    return {
      ...base,
      title: String(item.title || 'Restricted memo').slice(0, 120),
      previewText: RESTRICTED_WORK_ITEM_PLACEHOLDER.previewText,
    };
  }
  return base;
}

/**
 * @param {Record<string, unknown>|null|undefined} item
 * @param {boolean} canSeeFull
 */
export function sanitizeWorkspaceItem(item, canSeeFull) {
  if (!item) return item;
  if (!canSeeFull) return redactWorkItemForViewer(item, false);
  return sanitizeWorkItemForClient(item);
}

/**
 * @param {object} thread
 * @param {boolean} canSeeFull
 */
export function sanitizeThreadForUser(thread, canSeeFull) {
  if (!thread || canSeeFull) return thread;
  const payload =
    thread.payload && typeof thread.payload === 'object'
      ? { ...thread.payload, attachments: [] }
      : {};
  return {
    ...thread,
    subject: RESTRICTED_WORK_ITEM_PLACEHOLDER.title,
    body: '',
    messages: [],
    payload,
    redacted: true,
  };
}

/**
 * @param {object} result — search hit
 * @param {object} [row] — raw db row
 * @param {boolean} [canSeeFull=true]
 */
export function sanitizeSearchResult(result, row, canSeeFull = true) {
  if (!result) return result;
  if (!canSeeFull || (row && isConfidentialLevel(row.confidentiality) && result.redacted)) {
    return {
      ...result,
      label: RESTRICTED_WORK_ITEM_PLACEHOLDER.title,
      sublabel: 'Permission required',
      state: result.state ? { workItemId: result.id || result.state?.workItemId } : null,
      redacted: true,
    };
  }
  return {
    ...result,
    state: sanitizeRouteState(result.state),
  };
}

/**
 * @param {Record<string, unknown>|null|undefined} item
 * @param {object} [user]
 */
export function sanitizeWorkspaceItemForZare(item, user = null) {
  void user;
  return sanitizeWorkspaceItem(item, true);
}

/**
 * Safe transaction context for Zare (no confidential amounts unless permitted).
 * @param {Record<string, unknown>|null|undefined} transaction
 * @param {object} [user]
 */
export function sanitizeTransactionContextForZare(transaction, user = null) {
  if (!transaction || typeof transaction !== 'object') return {};
  const canView = transaction.canView !== false;
  if (!canView || transaction.restricted) {
    return {
      currentPage: transaction.currentPage,
      module: transaction.module,
      transactionType: transaction.transactionType,
      referenceNo: transaction.referenceNo ? String(transaction.referenceNo).slice(0, 40) : undefined,
      status: transaction.status,
      restricted: true,
      canView: false,
      canEdit: false,
      canReverse: false,
      canApprove: false,
      canCreateMemo: Boolean(transaction.canCreateMemo),
    };
  }

  const safe = {
    currentPage: transaction.currentPage,
    module: transaction.module,
    transactionType: transaction.transactionType,
    referenceNo: transaction.referenceNo ? String(transaction.referenceNo).slice(0, 40) : undefined,
    status: transaction.status,
    branchId: transaction.branchId,
    branchName: transaction.branchName ? String(transaction.branchName).slice(0, 80) : undefined,
    createdByCurrentUser: Boolean(transaction.createdByCurrentUser),
    assignedToCurrentUser: Boolean(transaction.assignedToCurrentUser),
    approvalStatus: transaction.approvalStatus,
    settlementStatus: transaction.settlementStatus,
    filingStatus: transaction.filingStatus,
    linkedThreadId: transaction.linkedThreadId,
    availableActions: Array.isArray(transaction.availableActions)
      ? transaction.availableActions.map((a) => String(a).slice(0, 40)).slice(0, 12)
      : [],
    canView: true,
    canEdit: Boolean(transaction.canEdit),
    canReverse: Boolean(transaction.canReverse),
    canApprove: Boolean(transaction.canApprove),
    canRequestCorrection: Boolean(transaction.canRequestCorrection),
    canCreateMemo: transaction.canCreateMemo !== false,
    canAttachDocument: Boolean(transaction.canAttachDocument),
  };

  if (transaction.showFinancialSummary && transaction.amountSummary) {
    safe.amountSummary = String(transaction.amountSummary).slice(0, 80);
  }

  return safe;
}

/**
 * @param {Record<string, unknown>|null|undefined} ctx
 * @param {object} [user]
 */
export function sanitizeZarePageContext(ctx, user = null) {
  if (!ctx || typeof ctx !== 'object') return {};
  const safe = { ...ctx };
  delete safe.routeState;
  delete safe.messages;
  delete safe.body;
  delete safe.threadBody;
  delete safe.attachments;

  if (safe.selectedWorkItem && typeof safe.selectedWorkItem === 'object') {
    const wi = safe.selectedWorkItem;
    const redacted = Boolean(wi.redacted) || isConfidentialLevel(wi.confidentiality);
    safe.selectedWorkItem = sanitizeWorkspaceItemForZare(
      {
        id: wi.id,
        referenceNo: wi.referenceNo,
        title: redacted ? RESTRICTED_WORK_ITEM_PLACEHOLDER.title : String(wi.title || '').slice(0, 120),
        documentType: wi.documentType,
        category: wi.category,
        status: wi.status,
        memoType: wi.memoType,
        requiresApproval: Boolean(wi.requiresApproval),
        requiresResponse: Boolean(wi.requiresResponse),
        actionLabel: wi.actionLabel,
        linkedThreadId: wi.linkedThreadId,
        redacted,
        confidentiality: wi.confidentiality,
      },
      user
    );
  }

  if (safe.transaction && typeof safe.transaction === 'object') {
    safe.transaction = sanitizeTransactionContextForZare(safe.transaction, user);
  }

  if (Array.isArray(safe.suggestions)) {
    safe.suggestions = safe.suggestions.map((s) => String(s || '').slice(0, 120));
  }

  if (safe.counts && typeof safe.counts === 'object') {
    const c = safe.counts;
    safe.counts = {
      actionRequired: Number(c.actionRequired) || 0,
      pendingApproval: Number(c.pendingApproval) || 0,
      overdue: Number(c.overdue) || 0,
    };
  }

  return safe;
}

/** @deprecated Use sanitizeZarePageContext */
export const sanitizeRunaPageContext = sanitizeZarePageContext;

/**
 * @param {object} ev
 * @param {boolean} [includeNoteBody=true]
 */
export function sanitizeTimelineEvent(ev, includeNoteBody = true) {
  if (!ev) return ev;
  if (includeNoteBody) {
    return {
      ...ev,
      note: String(ev.note || '').slice(0, 200),
    };
  }
  return { ...ev, note: ev.note ? '[Details restricted]' : '' };
}

/**
 * @param {Record<string, unknown>[]} items
 */
export function sanitizeWorkItemsForClient(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => sanitizeWorkItemForClient(item));
}
