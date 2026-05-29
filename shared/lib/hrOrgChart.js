/**
 * Build reporting-line org chart trees from flat HR staff rows.
 */

/**
 * @param {Array<{ userId: string; displayName?: string; username?: string; jobTitle?: string; branchId?: string; department?: string; lineManagerUserId?: string | null }>} staff
 */
export function buildHrOrgChart(staff = []) {
  const byId = new Map();
  for (const s of staff) {
    const userId = String(s.userId || '').trim();
    if (!userId) continue;
    byId.set(userId, {
      userId,
      displayName: String(s.displayName || s.username || userId).trim(),
      jobTitle: s.jobTitle || null,
      branchId: s.branchId || null,
      department: s.department || null,
      lineManagerUserId: s.lineManagerUserId ? String(s.lineManagerUserId) : null,
      children: [],
    });
  }

  const roots = [];
  const orphans = [];

  for (const node of byId.values()) {
    const mgrId = node.lineManagerUserId;
    if (mgrId && mgrId === node.userId) {
      orphans.push({ ...node, orphanReason: 'self_manager' });
      continue;
    }
    if (mgrId && byId.has(mgrId)) {
      byId.get(mgrId).children.push(node);
      continue;
    }
    if (!mgrId) {
      roots.push(node);
      continue;
    }
    orphans.push({ ...node, orphanReason: 'manager_not_in_list' });
  }

  const sortNodes = (list) =>
    list.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), undefined, { sensitivity: 'base' }));

  const sortTree = (node) => {
    sortNodes(node.children);
    for (const c of node.children) sortTree(c);
  };

  sortNodes(roots);
  sortNodes(orphans);
  for (const r of roots) sortTree(r);

  return {
    roots,
    orphans,
    total: byId.size,
  };
}

/**
 * @param {Array<{ userId: string; displayName?: string; username?: string; jobTitle?: string; lineManagerUserId?: string | null }>} staff
 * @param {string} userId
 */
export function hrStaffReportingContext(staff, userId) {
  const uid = String(userId || '').trim();
  const byId = new Map();
  for (const s of staff) {
    if (s.userId) byId.set(String(s.userId), s);
  }
  const subject = byId.get(uid);
  if (!subject) {
    return { lineManager: null, directReports: [] };
  }
  const mgrId = subject.lineManagerUserId ? String(subject.lineManagerUserId) : '';
  const mgr = mgrId && byId.has(mgrId) ? byId.get(mgrId) : null;
  const directReports = staff
    .filter((s) => String(s.lineManagerUserId || '') === uid)
    .map((s) => ({
      userId: s.userId,
      displayName: s.displayName || s.username || s.userId,
      jobTitle: s.jobTitle || null,
    }))
    .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), undefined, { sensitivity: 'base' }));
  return {
    lineManager: mgr
      ? {
          userId: mgr.userId,
          displayName: mgr.displayName || mgr.username || mgr.userId,
          jobTitle: mgr.jobTitle || null,
        }
      : null,
    directReports,
  };
}
