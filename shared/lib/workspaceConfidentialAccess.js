/**
 * Shared confidential memo / work-item visibility rules.
 * Used by backend office/work-item modules and frontend defense-in-depth.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/workspaceConfidentialAccess.js
 */

export const RESTRICTED_WORK_ITEM_PLACEHOLDER = {
  title: 'Restricted memo',
  summary: 'You do not have permission to view this item.',
  previewText: 'Restricted — permission required',
  body: '',
  redacted: true,
};

function permissionsForUser(user) {
  if (!user) return [];
  if (Array.isArray(user.permissions)) return user.permissions;
  return [];
}

function userHasPermission(user, permission) {
  if (!user || !permission) return false;
  const perms = permissionsForUser(user);
  return perms.includes('*') || perms.includes(permission);
}

function canUseAllBranchesRollup(user) {
  const roleKey = String(user?.roleKey || '').trim().toLowerCase();
  return roleKey === 'admin' || roleKey === 'md' || roleKey === 'ceo' || roleKey === 'chairman';
}

/**
 * @param {string} raw
 */
export function normalizeConfidentiality(raw) {
  const c = String(raw || 'internal').trim().toLowerCase();
  if (c === 'confidential' || c === 'restricted') return c;
  return 'internal';
}

/**
 * @param {string} confidentiality
 */
export function isConfidentialLevel(confidentiality) {
  return normalizeConfidentiality(confidentiality) === 'confidential';
}

/**
 * @param {string} userId
 * @param {string[]} participantUserIds
 */
export function userIsDistributionParticipant(userId, participantUserIds = []) {
  const uid = String(userId || '').trim();
  if (!uid) return false;
  return participantUserIds.map((x) => String(x || '').trim()).filter(Boolean).includes(uid);
}

/**
 * @param {{ viewAll?: boolean, branchId?: string }} scope
 * @param {object} user
 * @param {object} row
 */
export function userCanSeeOfficeThreadRow(scope, user, row) {
  const uid = String(user?.id || '').trim();
  if (!uid || !row) return false;
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  const payload =
    row.payload && typeof row.payload === 'object'
      ? row.payload
      : safeJsonParse(row.payload_json, {});
  const confidentiality = normalizeConfidentiality(payload?.confidentiality ?? row.confidentiality);
  const to = Array.isArray(row.toUserIds)
    ? row.toUserIds
    : parseUserIdsJson(row.to_user_ids_json);
  const cc = Array.isArray(row.ccUserIds)
    ? row.ccUserIds
    : parseUserIdsJson(row.cc_user_ids_json);
  const createdBy = String(row.created_by_user_id ?? row.createdByUserId ?? '').trim();
  const participant = userIsDistributionParticipant(uid, [createdBy, ...to, ...cc]);

  // Workspace channel/DM threads are membership-gated — admin/HQ rollup must not
  // browse every DM via the office desk API.
  const mode = String(row.conversation_mode ?? row.conversationMode ?? payload?.scopeKind ?? '').toLowerCase();
  const kind = String(row.kind || '').toLowerCase();
  const isWorkspaceChat = mode === 'dm' || mode === 'channel' || kind === 'dm' || kind === 'channel';
  if (isWorkspaceChat) {
    if (String(createdBy) === uid || participant) return true;
    return false;
  }

  if (userHasPermission(user, '*')) return true;
  if (rk === 'admin') return true;

  const hqRollup = canUseAllBranchesRollup(user) && scope?.viewAll;
  if (hqRollup && (rk === 'admin' || rk === 'md')) {
    if (confidentiality === 'confidential') return participant;
    return true;
  }

  const bid = String(row.branch_id ?? row.branchId ?? '').trim();
  if (!scope?.viewAll && bid && bid !== String(scope.branchId || '').trim()) {
    return false;
  }
  if (String(createdBy) === uid) return true;
  return participant;
}

/**
 * @param {object} user
 * @param {object} row
 * @param {{ visibilityKind: string, visibilityValue: string }[]} [visibility]
 */
export function userIsWorkItemParticipant(user, row, visibility = []) {
  const uid = String(user?.id || '').trim();
  if (!uid || !row) return false;
  if (String(row.sender_user_id ?? row.senderUserId ?? '').trim() === uid) return true;
  if (String(row.responsible_user_id ?? row.responsibleUserId ?? '').trim() === uid) return true;
  for (const entry of visibility) {
    if (entry.visibilityKind === 'user_id' && entry.visibilityValue === uid) return true;
  }
  return false;
}

/**
 * @param {{ viewAll?: boolean, branchId?: string }} scope
 * @param {object} user
 * @param {object} row
 * @param {{ visibilityKind: string, visibilityValue: string }[]} [visibility]
 */
export function userCanSeeConfidentialWorkItem(scope, user, row, visibility = []) {
  if (!isConfidentialLevel(row?.confidentiality)) return true;
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  if (userHasPermission(user, '*') || rk === 'admin') return true;
  const hqRollup = canUseAllBranchesRollup(user) && scope?.viewAll;
  if (hqRollup && rk === 'md') {
    return userIsWorkItemParticipant(user, row, visibility);
  }
  return userIsWorkItemParticipant(user, row, visibility);
}

/**
 * @param {Record<string, unknown>} item
 * @param {boolean} canSeeFull
 */
export function redactWorkItemForViewer(item, canSeeFull) {
  if (!item || canSeeFull) return item;
  if (!item.redacted && !isConfidentialLevel(item.confidentiality)) return item;
  return {
    ...item,
    ...RESTRICTED_WORK_ITEM_PLACEHOLDER,
    id: item.id,
    referenceNo: item.referenceNo,
    branchId: item.branchId,
    documentType: item.documentType,
    documentClass: item.documentClass,
    category: item.category,
    status: item.status,
    priority: item.priority,
    confidentiality: item.confidentiality,
    updatedAtIso: item.updatedAtIso,
    createdAtIso: item.createdAtIso,
    linkedThreadId: item.linkedThreadId,
    routePath: item.routePath,
    routeState: item.routeState,
    visibility: [],
    data: {},
  };
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const v = JSON.parse(String(raw));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function parseUserIdsJson(json) {
  const a = safeJsonParse(json, []);
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x || '').trim()).filter(Boolean);
}
