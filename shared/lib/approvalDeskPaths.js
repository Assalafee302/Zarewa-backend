/**
 * Approval / attention deep-links by role (shared — keep in sync with frontend desk paths).
 * MD/CEO/Chairman → Command Centre Decide; branch managers → `/manager`.
 */

const EXEC_DECIDE = '/exec?tab=decide';

function normalizeRoleKey(roleKey) {
  return String(roleKey || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

export function roleUsesExecutiveApprovalDesk(roleKey) {
  const rk = normalizeRoleKey(roleKey);
  return rk === 'md' || rk === 'ceo' || rk === 'chairman';
}

export function approvalAttentionPathForRole(roleKey, inbox = 'attention') {
  if (roleUsesExecutiveApprovalDesk(roleKey)) return EXEC_DECIDE;
  const id = String(inbox || 'attention').trim() || 'attention';
  return `/manager?tab=approvals&inbox=${encodeURIComponent(id)}`;
}

export function approvalDeskHomeForRole(roleKey) {
  if (roleUsesExecutiveApprovalDesk(roleKey)) return EXEC_DECIDE;
  return '/manager';
}
