/**
 * Build reporting-line org chart trees from flat HR staff rows.
 */

const SENIORITY_RANK = { leadership: 0, senior: 1, mid: 2, entry: 3, unknown: 4 };

function sortNodes(list) {
  return list.sort((a, b) => {
    const sa = SENIORITY_RANK[a.seniority] ?? 4;
    const sb = SENIORITY_RANK[b.seniority] ?? 4;
    if (sa !== sb) return sa - sb;
    const dr = (b.directReportCount || 0) - (a.directReportCount || 0);
    if (dr !== 0) return dr;
    return String(a.displayName).localeCompare(String(b.displayName), undefined, { sensitivity: 'base' });
  });
}

function sortTree(node) {
  sortNodes(node.children);
  for (const c of node.children) sortTree(c);
}

function annotateDirectReports(node) {
  const count = node.children?.length || 0;
  node.directReportCount = count;
  let maxDepth = 0;
  for (const child of node.children || []) {
    const childDepth = annotateDirectReports(child);
    maxDepth = Math.max(maxDepth, childDepth);
  }
  node.subtreeSize = 1 + (node.children || []).reduce((sum, c) => sum + (c.subtreeSize || 1), 0);
  return maxDepth + 1;
}

function flattenChart(chart) {
  const all = [];
  const walk = (node) => {
    all.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const root of chart?.roots || []) walk(root);
  for (const orphan of chart?.orphans || []) all.push(orphan);
  return all;
}

/**
 * @param {Array<{ userId: string; displayName?: string; username?: string; jobTitle?: string; branchId?: string; department?: string; lineManagerUserId?: string | null; payrollGroup?: string; normalized?: { orgNode?: string; taxonomy?: { roleFamily?: string; seniority?: string } } }>} staff
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
      payrollGroup: s.payrollGroup || s.profileExtra?.payrollGroup || null,
      orgNode: s.normalized?.orgNode || s.payrollGroup || null,
      roleFamily: s.normalized?.taxonomy?.roleFamily || null,
      seniority: s.normalized?.taxonomy?.seniority || null,
      mergedOffices: Array.isArray(s.mergedOffices) ? s.mergedOffices : null,
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

  sortNodes(roots);
  sortNodes(orphans);
  for (const r of roots) sortTree(r);
  for (const r of roots) annotateDirectReports(r);
  for (const o of orphans) {
    o.directReportCount = 0;
    o.subtreeSize = 1;
  }

  return {
    roots,
    orphans,
    total: byId.size,
  };
}

/**
 * @param {{ roots?: object[]; orphans?: object[]; total?: number }} chart
 */
export function summarizeHrOrgChart(chart) {
  const nodes = flattenChart(chart);
  const byDepartment = new Map();
  const byBranch = new Map();
  const byOrgNode = new Map();
  const byRoleFamily = new Map();
  let leadership = 0;
  let maxDepth = 0;

  const depthWalk = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children || []) depthWalk(child, depth + 1);
  };
  for (const root of chart?.roots || []) depthWalk(root, 0);

  for (const node of nodes) {
    const dept = String(node.department || '').trim() || 'Unassigned';
    const branch = String(node.branchId || '').trim() || 'Unassigned';
    const unit = String(node.orgNode || node.payrollGroup || '').trim() || 'branch_ops';
    const family = String(node.roleFamily || '').trim() || 'general';

    byDepartment.set(dept, (byDepartment.get(dept) || 0) + 1);
    byBranch.set(branch, (byBranch.get(branch) || 0) + 1);
    byOrgNode.set(unit, (byOrgNode.get(unit) || 0) + 1);
    byRoleFamily.set(family, (byRoleFamily.get(family) || 0) + 1);
    if (node.seniority === 'leadership') leadership += 1;
  }

  const toSorted = (map) =>
    Array.from(map.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    total: chart?.total || nodes.length,
    roots: chart?.roots?.length || 0,
    orphans: chart?.orphans?.length || 0,
    leadership,
    maxDepth,
    departments: toSorted(byDepartment),
    branches: toSorted(byBranch),
    orgUnits: toSorted(byOrgNode),
    roleFamilies: toSorted(byRoleFamily),
  };
}

/**
 * Build grouped section trees for department / branch / org-unit lenses.
 * @param {{ roots?: object[]; orphans?: object[] }} chart
 * @param {'department' | 'branch' | 'unit'} groupBy
 */
export function buildHrOrgChartGrouped(chart, groupBy = 'department') {
  const nodes = flattenChart(chart);
  const buckets = new Map();

  const bucketKey = (node) => {
    if (groupBy === 'branch') return String(node.branchId || '').trim() || 'Unassigned';
    if (groupBy === 'unit') return String(node.orgNode || node.payrollGroup || '').trim() || 'branch_ops';
    return String(node.department || '').trim() || 'Unassigned';
  };

  for (const node of nodes) {
    const key = bucketKey(node);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
  }

  const sections = [];
  for (const [key, members] of buckets.entries()) {
    const memberIds = new Set(members.map((m) => m.userId));
    const localRoots = members.filter((m) => {
      const mgr = m.lineManagerUserId;
      return !mgr || !memberIds.has(mgr);
    });
    sortNodes(localRoots);
    sections.push({
      key,
      count: members.length,
      roots: localRoots.map((r) => ({ ...r, children: (r.children || []).filter((c) => memberIds.has(c.userId)) })),
      orphans: members.filter((m) => m.orphanReason && localRoots.every((r) => r.userId !== m.userId)),
    });
  }

  sections.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return sections;
}

/**
 * True if assigning newManagerUserId as line manager of subjectUserId would create a cycle.
 * @param {Array<{ userId: string; lineManagerUserId?: string | null }>} staff
 * @param {string} subjectUserId
 * @param {string | null | undefined} newManagerUserId
 */
export function wouldCreateReportingCycle(staff, subjectUserId, newManagerUserId) {
  const subject = String(subjectUserId || '').trim();
  let current = String(newManagerUserId || '').trim();
  if (!current) return false;
  if (current === subject) return true;
  const byId = new Map();
  for (const s of staff) {
    const id = String(s.userId || '').trim();
    if (id) byId.set(id, s);
  }
  const seen = new Set();
  while (current) {
    if (current === subject) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const row = byId.get(current);
    current = row?.lineManagerUserId ? String(row.lineManagerUserId).trim() : '';
  }
  return false;
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
