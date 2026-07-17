/**
 * Workspace V3 — rooms, activity, presence, SSE fan-out.
 * Additive on office_threads / office_messages.
 */
import { DEFAULT_BRANCH_ID } from './branches.js';
import { officeScopeFromReq, officeTablesReady } from './officeOps.js';
import { createWorkItem } from './workItems.js';
import { appendAuditLog } from './controlOps.js';
import { userCanSeeConfidentialWorkItem } from '../shared/lib/workspaceConfidentialAccess.js';

/** office_threads.branch_id for company-scoped rooms (NOT NULL column); workspace_rooms.branch_id stays null. */
export const COMPANY_BRANCH_SENTINEL = '__company__';

const EXEC_ROOM_ROLES = new Set(['admin', 'md', 'ceo', 'chairman', 'finance_manager']);

/** Department channel → allowed role_key values. */
const DEPT_ROLE_MAP = {
  sales: ['sales_staff', 'sales_manager'],
  operations: ['operations_officer'],
  production: ['operations_officer'],
  cashier: ['cashier'],
  approvals: ['sales_manager', 'branch_manager', 'finance_manager', 'admin', 'md'],
};

const DEPT_BYPASS_ROLES = new Set(['sales_manager', 'branch_manager', 'admin', 'md']);

const MAX_SSE_CLIENTS_TOTAL = 500;
const MAX_SSE_CLIENTS_PER_USER = 3;

/** Chat attachments: images inline, pdf as download. Kept small — stored as data URLs in attachments_json. */
const MAX_MESSAGE_ATTACHMENTS = 4;
const MAX_ATTACHMENT_DATAURL_CHARS = 1_400_000; // ~1MB binary
const MAX_ATTACHMENTS_TOTAL_CHARS = 1_800_000; // stay under the 2mb express body limit
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

/**
 * Validate and normalize `[{ name, mime, dataUrl }]` from the client.
 * @returns {{ ok: true, attachments: object[] } | { ok: false, error: string }}
 */
function sanitizeMessageAttachments(raw) {
  if (raw == null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'Attachments must be a list.' };
  if (raw.length > MAX_MESSAGE_ATTACHMENTS) {
    return { ok: false, error: `Too many attachments (max ${MAX_MESSAGE_ATTACHMENTS}).` };
  }
  const out = [];
  let total = 0;
  for (const a of raw) {
    const mime = String(a?.mime || '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) {
      return { ok: false, error: 'Only images and PDF attachments are allowed.' };
    }
    const dataUrl = String(a?.dataUrl || '');
    if (!dataUrl.startsWith(`data:${mime};base64,`)) {
      return { ok: false, error: 'Attachment data is invalid.' };
    }
    if (dataUrl.length > MAX_ATTACHMENT_DATAURL_CHARS) {
      return { ok: false, error: 'An attachment is too large (max ~1MB each).' };
    }
    total += dataUrl.length;
    if (total > MAX_ATTACHMENTS_TOTAL_CHARS) {
      return { ok: false, error: 'Attachments are too large in total.' };
    }
    out.push({
      name: String(a?.name || 'attachment').slice(0, 120),
      mime,
      dataUrl,
      isImage: mime.startsWith('image/'),
    });
  }
  return { ok: true, attachments: out };
}

const DEFAULT_CHANNELS = [
  { slug: 'general', name: '#general', description: 'Branch coordination', departmentKey: null },
  { slug: 'sales', name: '#sales', description: 'Sales desk', departmentKey: 'sales' },
  { slug: 'store', name: '#store', description: 'Store & stock', departmentKey: 'operations' },
  { slug: 'production', name: '#production', description: 'Production floor', departmentKey: 'production' },
  { slug: 'cashier', name: '#cashier', description: 'Cashier handover', departmentKey: 'cashier' },
  { slug: 'approvals', name: '#approvals', description: 'Quick endorsement chatter', departmentKey: 'approvals' },
];

const COMPANY_CHANNELS = [
  { slug: 'announcements', name: '#announcements', description: 'Company-wide notices', departmentKey: null },
  { slug: 'leadership', name: '#leadership', description: 'Executive coordination', departmentKey: 'executive' },
];

const MAX_MESSAGE_BODY_LEN = 8000;

/**
 * SSE clients keyed by response with their access scope so events are only
 * fanned out to users allowed to see them (no cross-branch metadata leak).
 * @type {Map<import('http').ServerResponse, { userId: string; branchId: string; viewAll: boolean }>}
 */
const sseClients = new Map();

/**
 * Per-connection memo of provisioned default rooms so GET /rooms doesn't
 * attempt writes on every request. WeakMap-keyed by db handle so separate
 * connections (e.g. test databases) provision independently.
 * @type {WeakMap<object, Set<string>>}
 */
const provisionedRoomsByDb = new WeakMap();

function provisionedSetFor(db) {
  let set = provisionedRoomsByDb.get(db);
  if (!set) {
    set = new Set();
    provisionedRoomsByDb.set(db, set);
  }
  return set;
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

/** SQLite ON CONFLICT with UPDATE/INSERT fallback for MySQL-compatible wrappers. */
function upsertByConflict(db, { conflictInsert, conflictArgs, update, updateArgs, exists, existsArgs, plainInsert, plainArgs }) {
  try {
    db.prepare(conflictInsert).run(...conflictArgs);
    return true;
  } catch {
    try {
      const row = db.prepare(exists).get(...existsArgs);
      if (row) db.prepare(update).run(...updateArgs);
      else db.prepare(plainInsert).run(...plainArgs);
      return true;
    } catch {
      return false;
    }
  }
}

function tableHasColumn(db, table, column) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    return cols.includes(column);
  } catch {
    return false;
  }
}

function userRoleKey(user) {
  return String(user?.roleKey || '').trim().toLowerCase();
}

function userHasWildcardPerm(user) {
  const perms = user?.permissions;
  return Array.isArray(perms) && perms.includes('*');
}

function isExecRoomRole(user) {
  if (userHasWildcardPerm(user)) return true;
  return EXEC_ROOM_ROLES.has(userRoleKey(user));
}

function isLeadershipRoom(room) {
  if (!room || room.scope_kind !== 'company') return false;
  return room.slug === 'leadership' || String(room.department_key || '') === 'executive';
}

function isAnnouncementsRoom(room) {
  return room?.scope_kind === 'company' && room.slug === 'announcements';
}

function roleMatchesDepartment(deptKey, rk) {
  const allowed = DEPT_ROLE_MAP[String(deptKey || '').trim()];
  if (!allowed) return false;
  return allowed.includes(rk);
}

function isRoomMuted(db, roomId, userId) {
  if (!roomId || !userId) return false;
  try {
    const row = db
      .prepare(`SELECT muted_until_iso FROM workspace_room_members WHERE room_id = ? AND user_id = ?`)
      .get(roomId, userId);
    const until = String(row?.muted_until_iso || '').trim();
    if (!until) return false;
    return until > nowIso();
  } catch {
    return false;
  }
}

function threadBranchIdForRoom(scopeKind, branchId) {
  // Company rooms: workspace_rooms.branch_id is null; office_threads need a NOT NULL branch_id.
  if (scopeKind === 'company') return DEFAULT_BRANCH_ID;
  return branchId || DEFAULT_BRANCH_ID;
}

function activityBranchForRoom(room, workspaceBranchId) {
  if (room?.scope_kind === 'company') {
    return String(workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  }
  return room?.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID;
}

export function workspaceRoomsTablesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_rooms'`).get()
    );
  } catch {
    return false;
  }
}

/**
 * Fan out an event to eligible SSE clients only:
 * - `event.targetUserIds` (e.g. DM members) restricts delivery to those users.
 * - Otherwise branch-scoped events go to same-branch or viewAll clients;
 *   events without a branch (company-wide) go to everyone.
 */
export function broadcastWorkspaceEvent(event) {
  const { targetUserIds, ...wire } = event || {};
  const payload = `data: ${JSON.stringify(wire)}\n\n`;
  const targets = Array.isArray(targetUserIds) && targetUserIds.length
    ? new Set(targetUserIds.map((u) => String(u)))
    : null;
  const eventBranch = String(wire.branchId || '').trim();
  for (const [res, scope] of sseClients) {
    if (targets && !targets.has(String(scope?.userId || ''))) continue;
    if (!targets && eventBranch && !scope?.viewAll && String(scope?.branchId || '') !== eventBranch) {
      continue;
    }
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

/**
 * Register an SSE client with per-user and global connection limits.
 * Multi-instance deployments need a shared pub/sub (e.g. Redis) — this in-memory
 * fan-out only covers clients on the same Node process.
 *
 * @param {import('http').ServerResponse} res
 * @param {{ userId?: string; branchId?: string; viewAll?: boolean }} [scope]
 * @returns {{ ok: boolean; error?: string }}
 */
export function registerWorkspaceSseClient(res, scope = {}) {
  const userId = String(scope.userId || '');
  if (sseClients.size >= MAX_SSE_CLIENTS_TOTAL) {
    const oldest = sseClients.keys().next().value;
    if (oldest) {
      try {
        oldest.end();
      } catch {
        /* ignore */
      }
      sseClients.delete(oldest);
    }
  }
  if (userId) {
    const userConns = [];
    for (const [r, s] of sseClients) {
      if (String(s?.userId || '') === userId) userConns.push(r);
    }
    while (userConns.length >= MAX_SSE_CLIENTS_PER_USER) {
      const stale = userConns.shift();
      if (stale) {
        try {
          stale.end();
        } catch {
          /* ignore */
        }
        sseClients.delete(stale);
      }
    }
  }
  sseClients.set(res, {
    userId,
    branchId: String(scope.branchId || ''),
    viewAll: Boolean(scope.viewAll),
  });
  res.on('close', () => sseClients.delete(res));
  return { ok: true };
}

function displayNameForUser(db, userId) {
  try {
    const row = db
      .prepare(`SELECT display_name, username FROM app_users WHERE id = ?`)
      .get(String(userId || ''));
    return row?.display_name || row?.username || userId;
  } catch {
    return userId;
  }
}

function insertRoomWithThread(db, { roomId, scopeKind, branchId, departmentKey, slug, name, description, isDefault, uid, now }) {
  db.prepare(
    `INSERT INTO workspace_rooms (
      id, scope_kind, branch_id, department_key, slug, name, description,
      is_default, is_archived, created_by_user_id, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`
  ).run(roomId, scopeKind, branchId, departmentKey, slug, name, description, isDefault ? 1 : 0, uid, now, now);

  const threadId = newId('OTD');
  const hasMode = tableHasColumn(db, 'office_threads', 'conversation_mode');
  const hasRoom = tableHasColumn(db, 'office_threads', 'room_id');

  if (hasMode && hasRoom) {
    db.prepare(
      `INSERT INTO office_threads (
        id, branch_id, created_by_user_id, kind, status, document_class, office_key,
        subject, body, to_user_ids_json, cc_user_ids_json, payload_json,
        conversation_mode, room_id, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )    .run(
      threadId,
      threadBranchIdForRoom(scopeKind, branchId),
      uid,
      scopeKind === 'dm' ? 'dm' : 'channel',
      'open',
      'correspondence',
      'office_admin',
      name,
      description || '',
      '[]',
      '[]',
      JSON.stringify({ channelSlug: slug, roomId, scopeKind }),
      scopeKind === 'dm' ? 'dm' : 'channel',
      roomId,
      now,
      now
    );
  } else {
    db.prepare(
      `INSERT INTO office_threads (
        id, branch_id, created_by_user_id, kind, status, document_class, office_key,
        subject, body, to_user_ids_json, cc_user_ids_json, payload_json, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )    .run(
      threadId,
      threadBranchIdForRoom(scopeKind, branchId),
      uid,
      scopeKind === 'dm' ? 'dm' : 'channel',
      'open',
      'correspondence',
      'office_admin',
      name,
      description || '',
      '[]',
      '[]',
      JSON.stringify({ channelSlug: slug, roomId, scopeKind }),
      now,
      now
    );
  }

  db.prepare(
    `INSERT INTO workspace_room_threads (room_id, thread_id, pinned, pinned_at_iso) VALUES (?,?,0,NULL)`
  ).run(roomId, threadId);

  return threadId;
}

function addRoomMember(db, roomId, userId, role, now) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO workspace_room_members (room_id, user_id, role, joined_at_iso) VALUES (?,?,?,?)`
    ).run(roomId, userId, role, now);
  } catch {
    try {
      const exists = db
        .prepare(`SELECT 1 FROM workspace_room_members WHERE room_id = ? AND user_id = ?`)
        .get(roomId, userId);
      if (!exists) {
        db.prepare(
          `INSERT INTO workspace_room_members (room_id, user_id, role, joined_at_iso) VALUES (?,?,?,?)`
        ).run(roomId, userId, role, now);
      }
    } catch {
      /* membership optional on older schemas */
    }
  }
}

/**
 * Ensure default branch channels exist and have backing office threads.
 */
export function ensureDefaultBranchRooms(db, branchId, actorUserId) {
  if (!workspaceRoomsTablesReady(db) || !officeTablesReady(db)) return;
  const bid = String(branchId || '').trim() || DEFAULT_BRANCH_ID;
  const provisioned = provisionedSetFor(db);
  if (provisioned.has(`branch:${bid}`)) return;
  const uid = String(actorUserId || '').trim() || 'system';
  const now = nowIso();

  for (const ch of DEFAULT_CHANNELS) {
    const existing = db
      .prepare(`SELECT id FROM workspace_rooms WHERE branch_id = ? AND slug = ? AND scope_kind = 'branch'`)
      .get(bid, ch.slug);
    if (existing) continue;

    const roomId = newId('WR');
    try {
      insertRoomWithThread(db, {
        roomId,
        scopeKind: 'branch',
        branchId: bid,
        departmentKey: ch.departmentKey,
        slug: ch.slug,
        name: ch.name,
        description: ch.description,
        isDefault: true,
        uid,
        now,
      });
      addRoomMember(db, roomId, uid, 'owner', now);
    } catch {
      /* unique index conflict — room already provisioned by another request */
    }
  }
  provisioned.add(`branch:${bid}`);
}

/**
 * Ensure company-scoped announcement rooms exist (visible across branches).
 */
export function ensureCompanyRooms(db, actorUserId) {
  if (!workspaceRoomsTablesReady(db) || !officeTablesReady(db)) return;
  const provisioned = provisionedSetFor(db);
  if (provisioned.has('company')) return;
  const uid = String(actorUserId || '').trim() || 'system';
  const now = nowIso();

  for (const ch of COMPANY_CHANNELS) {
    const existing = db
      .prepare(`SELECT id FROM workspace_rooms WHERE scope_kind = 'company' AND slug = ?`)
      .get(ch.slug);
    if (existing) continue;

    const roomId = newId('WR');
    try {
      insertRoomWithThread(db, {
        roomId,
        scopeKind: 'company',
        branchId: null,
        departmentKey: ch.departmentKey,
        slug: ch.slug,
        name: ch.name,
        description: ch.description,
        isDefault: true,
        uid,
        now,
      });
      addRoomMember(db, roomId, uid, 'owner', now);
    } catch {
      /* unique index conflict — room already provisioned */
    }
  }
  provisioned.add('company');
}

function unreadForRoom(db, roomId, userId, threadId) {
  if (!threadId || !userId) return 0;
  try {
    const read = db
      .prepare(`SELECT last_read_at_iso FROM office_thread_reads WHERE user_id = ? AND thread_id = ?`)
      .get(userId, threadId);
    const since = read?.last_read_at_iso || '1970-01-01T00:00:00.000Z';
    // Strict > so the message that marked last_read is not re-counted; exclude self.
    // Attachment-only messages (empty body) still count as unread.
    const hasAttachments = tableHasColumn(db, 'office_messages', 'attachments_json');
    const contentClause = hasAttachments
      ? `AND (IFNULL(TRIM(body),'') != '' OR IFNULL(attachments_json,'') != '')`
      : `AND IFNULL(TRIM(body),'') != ''`;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM office_messages
         WHERE thread_id = ?
           AND created_at_iso > ?
           AND IFNULL(author_user_id,'') != ?
           ${contentClause}`
      )
      .get(threadId, since, userId);
    const n = Number(row?.c || 0);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 9999) : 0;
  } catch {
    return 0;
  }
}

/** Latest visible message for the room list preview (Teams-style). */
function lastMessageForRoom(db, threadId) {
  if (!threadId) return null;
  try {
    const hasAttachments = tableHasColumn(db, 'office_messages', 'attachments_json');
    const row = db
      .prepare(
        `SELECT author_user_id, body, created_at_iso${hasAttachments ? ', attachments_json' : ''}
         FROM office_messages
         WHERE thread_id = ? AND kind = 'user'
         ORDER BY created_at_iso DESC LIMIT 1`
      )
      .get(threadId);
    if (!row) return null;
    const atts = hasAttachments ? safeJsonParse(row.attachments_json, []) : [];
    const text = String(row.body || '').trim();
    const preview = text || (atts.length ? (atts[0]?.isImage ? '📷 Photo' : '📎 Attachment') : '');
    if (!preview) return null;
    return {
      authorUserId: row.author_user_id || null,
      preview: preview.slice(0, 120),
      createdAtIso: row.created_at_iso,
    };
  } catch {
    return null;
  }
}

/** For DM rooms, the member who isn't the viewer (drives name + presence in the chat list). */
function dmPeerForRoom(db, roomId, userId) {
  try {
    const row = db
      .prepare(
        `SELECT m.user_id, u.display_name, u.username
         FROM workspace_room_members m
         LEFT JOIN app_users u ON u.id = m.user_id
         WHERE m.room_id = ? AND m.user_id != ?
         LIMIT 1`
      )
      .get(roomId, String(userId || ''));
    if (!row) return null;
    return {
      userId: String(row.user_id),
      displayName: row.display_name || row.username || String(row.user_id),
    };
  } catch {
    return null;
  }
}

function primaryThreadId(db, roomId) {
  try {
    const row = db
      .prepare(
        `SELECT thread_id FROM workspace_room_threads WHERE room_id = ? ORDER BY pinned DESC, thread_id ASC LIMIT 1`
      )
      .get(roomId);
    return row?.thread_id || null;
  } catch {
    return null;
  }
}

function userIsRoomMember(db, roomId, userId) {
  if (!roomId || !userId) return false;
  try {
    const mem = db
      .prepare(`SELECT 1 FROM workspace_room_members WHERE room_id = ? AND user_id = ?`)
      .get(roomId, userId);
    return Boolean(mem);
  } catch {
    return false;
  }
}

export function listWorkspaceRooms(db, scope, user) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.', rooms: [] };
  const branchId = String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  ensureDefaultBranchRooms(db, branchId, user?.id);
  ensureCompanyRooms(db, user?.id);

  const uid = String(user?.id || '').trim();
  let sql = `SELECT * FROM workspace_rooms WHERE is_archived = 0`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND (
      scope_kind = 'company'
      OR branch_id = ?
      OR (scope_kind = 'dm' AND EXISTS (
        SELECT 1 FROM workspace_room_members m
        WHERE m.room_id = workspace_rooms.id AND m.user_id = ?
      ))
    )`;
    args.push(branchId, uid);
  }
  sql += ` ORDER BY scope_kind ASC, slug ASC`;
  const rows = db.prepare(sql).all(...args);

  const rooms = [];
  for (const r of rows) {
    if (!userMayAccessRoom(db, scope, user, r)) continue;
    const threadId = primaryThreadId(db, r.id);
    const muted = isRoomMuted(db, r.id, uid);
    const unread = muted ? 0 : unreadForRoom(db, r.id, uid, threadId);
    const isDm = r.scope_kind === 'dm';
    const peer = isDm ? dmPeerForRoom(db, r.id, uid) : null;
    rooms.push({
      id: r.id,
      scopeKind: r.scope_kind,
      branchId: r.branch_id,
      departmentKey: r.department_key,
      slug: r.slug,
      // DMs show the other person's name, like Teams chat — not "A · B".
      name: isDm && peer ? peer.displayName : r.name,
      description: r.description,
      isDefault: Boolean(r.is_default),
      kind: isDm ? 'dm' : 'channel',
      threadId,
      unreadCount: unread,
      muted,
      peerUserId: peer?.userId || null,
      lastMessage: lastMessageForRoom(db, threadId),
      createdAtIso: r.created_at_iso,
      updatedAtIso: r.updated_at_iso,
    });
  }
  return { ok: true, rooms };
}

function userMayAccessRoom(db, scope, user, room) {
  if (!room) return false;
  if (Number(room.is_archived) === 1) return false;
  const uid = String(user?.id || '').trim();
  const rk = userRoleKey(user);

  if (room.scope_kind === 'dm') {
    return userIsRoomMember(db, room.id, uid);
  }

  if (isLeadershipRoom(room) && !isExecRoomRole(user)) {
    return false;
  }

  if (room.scope_kind === 'company') return true;

  if (scope?.viewAll) return true;

  const bid = String(scope?.branchId || '').trim();
  if (String(room.branch_id || '') !== bid) return false;

  const deptKey = String(room.department_key || '').trim();
  const slug = String(room.slug || '').trim();
  if (deptKey && slug !== 'general') {
    if (userIsRoomMember(db, room.id, uid)) return true;
    if (DEPT_BYPASS_ROLES.has(rk)) return true;
    if (roleMatchesDepartment(deptKey, rk)) return true;
    return false;
  }

  return true;
}

export function userMayPostInRoom(db, scope, user, room) {
  if (!userMayAccessRoom(db, scope, user, room)) return false;
  if (isAnnouncementsRoom(room) || isLeadershipRoom(room)) {
    return isExecRoomRole(user);
  }
  return true;
}

export function markRoomRead(db, scope, user, roomId) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.' };
  const room = db.prepare(`SELECT * FROM workspace_rooms WHERE id = ?`).get(String(roomId || ''));
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!userMayAccessRoom(db, scope, user, room)) return { ok: false, error: 'Forbidden.' };

  const threadId = primaryThreadId(db, room.id);
  if (!threadId) return { ok: true };

  const uid = String(user?.id || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  const now = nowIso();
  try {
    upsertByConflict(db, {
      conflictInsert: `INSERT INTO office_thread_reads (user_id, thread_id, last_read_at_iso) VALUES (?,?,?)
         ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_at_iso = excluded.last_read_at_iso`,
      conflictArgs: [uid, threadId, now],
      update: `UPDATE office_thread_reads SET last_read_at_iso = ? WHERE user_id = ? AND thread_id = ?`,
      updateArgs: [now, uid, threadId],
      exists: `SELECT 1 AS ok FROM office_thread_reads WHERE user_id = ? AND thread_id = ?`,
      existsArgs: [uid, threadId],
      plainInsert: `INSERT INTO office_thread_reads (user_id, thread_id, last_read_at_iso) VALUES (?,?,?)`,
      plainArgs: [uid, threadId, now],
    });
  } catch {
    return { ok: false, error: 'Could not mark room read.' };
  }
  return { ok: true, threadId };
}

export function getRoomMessages(db, scope, user, roomId, { limit = 80, beforeIso, markRead = false } = {}) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.' };
  const room = db.prepare(`SELECT * FROM workspace_rooms WHERE id = ?`).get(String(roomId || ''));
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!userMayAccessRoom(db, scope, user, room)) return { ok: false, error: 'Forbidden.' };

  const threadId = primaryThreadId(db, room.id);
  if (!threadId) return { ok: true, messages: [], pinned: [], threadId: null };

  const hasParent = tableHasColumn(db, 'office_messages', 'parent_message_id');
  const hasMentions = tableHasColumn(db, 'office_messages', 'mentions_json');
  const hasAttachments = tableHasColumn(db, 'office_messages', 'attachments_json');
  const hasWorkCard = tableHasColumn(db, 'office_messages', 'work_card_json');

  // Optional columns are folded into the single query — no per-message
  // follow-up SELECTs (was an N+1 of up to 200 queries per load).
  const extraCols = [
    hasParent ? 'parent_message_id' : null,
    hasMentions ? 'mentions_json' : null,
    hasAttachments ? 'attachments_json' : null,
    hasWorkCard ? 'work_card_json' : null,
  ]
    .filter(Boolean)
    .map((c) => `, ${c}`)
    .join('');

  // Author names resolved once per distinct author, not once per message.
  const nameCache = new Map();
  const authorName = (uid) => {
    const key = String(uid || '');
    if (!nameCache.has(key)) nameCache.set(key, displayNameForUser(db, key));
    return nameCache.get(key);
  };

  const messages = db
    .prepare(
      `SELECT id, thread_id, author_user_id, body, kind, created_at_iso${extraCols}
       FROM office_messages
       WHERE thread_id = ?${beforeIso ? ' AND created_at_iso < ?' : ''}
       ORDER BY created_at_iso DESC LIMIT ?`
    )
    .all(...(beforeIso ? [threadId, String(beforeIso), Math.min(200, Math.max(1, Number(limit) || 80))] : [threadId, Math.min(200, Math.max(1, Number(limit) || 80))]))
    .reverse()
    .map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      authorUserId: m.author_user_id,
      authorDisplayName: authorName(m.author_user_id),
      body: m.body,
      kind: m.kind,
      createdAtIso: m.created_at_iso,
      parentMessageId: hasParent ? m.parent_message_id || null : null,
      mentions: hasMentions ? safeJsonParse(m.mentions_json, []) : [],
      attachments: hasAttachments ? safeJsonParse(m.attachments_json, []) : [],
      workCard: hasWorkCard ? safeJsonParse(m.work_card_json, null) : null,
    }));

  const pinnedRows = db
    .prepare(
      `SELECT thread_id, pinned FROM workspace_room_threads WHERE room_id = ? AND pinned = 1`
    )
    .all(room.id);
  const pinned = [];
  for (const pr of pinnedRows) {
    const payload = db
      .prepare(`SELECT payload_json, subject, related_work_item_id FROM office_threads WHERE id = ?`)
      .get(pr.thread_id);
    const card = safeJsonParse(payload?.payload_json, {});
    if (card.pinnedWorkCard) pinned.push(card.pinnedWorkCard);
    else if (payload?.related_work_item_id) {
      pinned.push({
        id: payload.related_work_item_id,
        workItemId: payload.related_work_item_id,
        title: payload.subject || 'Pinned work',
        kind: 'work_item',
      });
    }
  }

  if (markRead) {
    try {
      const now = nowIso();
      const uid = String(user?.id || '').trim();
      if (uid && threadId) {
        upsertByConflict(db, {
          conflictInsert: `INSERT INTO office_thread_reads (user_id, thread_id, last_read_at_iso) VALUES (?,?,?)
           ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_at_iso = excluded.last_read_at_iso`,
          conflictArgs: [uid, threadId, now],
          update: `UPDATE office_thread_reads SET last_read_at_iso = ? WHERE user_id = ? AND thread_id = ?`,
          updateArgs: [now, uid, threadId],
          exists: `SELECT 1 AS ok FROM office_thread_reads WHERE user_id = ? AND thread_id = ?`,
          existsArgs: [uid, threadId],
          plainInsert: `INSERT INTO office_thread_reads (user_id, thread_id, last_read_at_iso) VALUES (?,?,?)`,
          plainArgs: [uid, threadId, now],
        });
      }
    } catch {
      /* optional */
    }
  }

  return { ok: true, messages, pinned, threadId };
}

export function postRoomMessage(db, scope, actor, workspaceBranchId, roomId, body) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.' };
  const room = db.prepare(`SELECT * FROM workspace_rooms WHERE id = ?`).get(String(roomId || ''));
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!userMayPostInRoom(db, scope, actor, room)) return { ok: false, error: 'Forbidden.' };

  let threadId = primaryThreadId(db, room.id);
  if (!threadId) return { ok: false, error: 'Room has no thread.' };

  const text = String(body?.body ?? '').trim();
  const attRes = sanitizeMessageAttachments(body?.attachments);
  if (!attRes.ok) return { ok: false, error: attRes.error };
  const attachments = attRes.attachments;
  if (!text && attachments.length === 0) return { ok: false, error: 'Message is required.' };
  if (text.length > MAX_MESSAGE_BODY_LEN) {
    return { ok: false, error: `Message too long (max ${MAX_MESSAGE_BODY_LEN} characters).` };
  }

  const mid = newId('OM');
  const now = nowIso();
  const uid = String(actor?.id || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };

  const mentionHandles = [...text.matchAll(/@([a-zA-Z0-9_](?:[a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_])?)/g)]
    .map((m) => m[1])
    .slice(0, 20);

  const resolvedMentions = [];
  const activityBranch = activityBranchForRoom(room, workspaceBranchId);
  let dmTargetUserIds = null;

  if (room.scope_kind === 'dm') {
    try {
      dmTargetUserIds = db
        .prepare(`SELECT user_id FROM workspace_room_members WHERE room_id = ?`)
        .all(room.id)
        .map((r) => String(r.user_id));
    } catch {
      dmTargetUserIds = [uid];
    }
  }

  try {
    db.transaction(() => {
      const hasMentionsCol = tableHasColumn(db, 'office_messages', 'mentions_json');
      const hasAttachmentsCol = tableHasColumn(db, 'office_messages', 'attachments_json');
      const cols = ['id', 'thread_id', 'author_user_id', 'body', 'kind', 'created_at_iso'];
      const vals = [mid, threadId, uid, text, 'user', now];
      if (hasMentionsCol && mentionHandles.length) {
        cols.push('mentions_json');
        vals.push(JSON.stringify(mentionHandles));
      }
      if (hasAttachmentsCol && attachments.length) {
        cols.push('attachments_json');
        vals.push(JSON.stringify(attachments));
      }
      db.prepare(
        `INSERT INTO office_messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...vals);
      db.prepare(`UPDATE office_threads SET updated_at_iso = ? WHERE id = ?`).run(now, threadId);

      for (const mention of mentionHandles) {
        const target = db
          .prepare(`SELECT id FROM app_users WHERE lower(username) = lower(?) LIMIT 1`)
          .get(mention);
        if (!target?.id) continue;
        resolvedMentions.push({ userId: target.id });
        const eid = newId('WME');
        db.prepare(
          `INSERT INTO workspace_mentions (id, message_id, mentioned_user_id, mentioned_role_key, room_id, thread_id, created_at_iso)
           VALUES (?,?,?,?,?,?,?)`
        ).run(eid, mid, target.id, null, room.id, threadId, now);
        emitActivityEvent(
          db,
          {
            branchId: activityBranch,
            actorUserId: actor?.id,
            targetUserId: target.id,
            eventKind: 'mention',
            targetKind: 'message',
            targetId: mid,
            summaryText: `${displayNameForUser(db, actor?.id)} mentioned you`,
            payload: { roomId: room.id, threadId },
          },
          { deferBroadcast: true }
        );
      }
    })();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) || 'Could not send message.' };
  }

  for (const m of resolvedMentions) {
    const activityTargets = dmTargetUserIds || [m.userId];
    broadcastWorkspaceEvent({
      type: 'activity.created',
      branchId: activityBranch,
      payload: { eventKind: 'mention', targetUserId: m.userId },
      revision: Date.now(),
      targetUserIds: activityTargets,
    });
  }

  const message = {
    id: mid,
    threadId,
    authorUserId: actor?.id,
    authorDisplayName: displayNameForUser(db, actor?.id),
    body: text,
    kind: 'user',
    createdAtIso: now,
    mentions: mentionHandles,
    attachments,
  };

  try {
    db.prepare(`UPDATE workspace_rooms SET updated_at_iso = ? WHERE id = ?`).run(nowIso(), room.id);
  } catch {
    /* optional */
  }

  appendAuditLog(db, {
    actor,
    action: 'workspace.room.message',
    entityKind: 'workspace_room',
    entityId: room.id,
    note: (text || `[${attachments.length} attachment${attachments.length === 1 ? '' : 's'}]`).slice(0, 120),
    details: { messageId: mid, threadId, attachmentCount: attachments.length },
  });

  broadcastWorkspaceEvent({
    type: 'message.created',
    branchId: activityBranch,
    roomId: room.id,
    payload: { messageId: message.id, threadId },
    revision: Date.now(),
    ...(dmTargetUserIds ? { targetUserIds: dmTargetUserIds } : {}),
  });

  return { ok: true, message };
}

export function pinRoomWorkCard(db, scope, actor, roomId, payload) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.' };
  const room = db.prepare(`SELECT * FROM workspace_rooms WHERE id = ?`).get(String(roomId || ''));
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!userMayPostInRoom(db, scope, actor, room)) return { ok: false, error: 'Forbidden.' };

  const threadId = primaryThreadId(db, room.id);
  if (!threadId) return { ok: false, error: 'Room has no thread.' };

  const workItemId = payload?.workItemId ? String(payload.workItemId).trim() : null;
  if (workItemId) {
    try {
      const wi = db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(workItemId);
      if (!wi) return { ok: false, error: 'Work item not found.' };
      if (!userCanSeeConfidentialWorkItem(scope, actor, wi)) {
        return { ok: false, error: 'Forbidden.' };
      }
      if (room.scope_kind === 'branch' && wi.branch_id) {
        const bid = String(scope?.branchId || '').trim();
        if (!scope?.viewAll && String(wi.branch_id) !== bid) {
          return { ok: false, error: 'Work item is not in this branch.' };
        }
      }
    } catch {
      return { ok: false, error: 'Could not verify work item.' };
    }
  }

  const card = {
    id: String(payload?.id || workItemId || newId('WC')),
    workItemId,
    title: String(payload?.title || 'Pinned work').slice(0, 200),
    subtitle: String(payload?.subtitle || '').slice(0, 300) || null,
    kind: String(payload?.kind || 'work_item'),
    status: payload?.status || null,
  };

  const row = db.prepare(`SELECT payload_json FROM office_threads WHERE id = ?`).get(threadId);
  const existing = safeJsonParse(row?.payload_json, {});
  existing.pinnedWorkCard = card;
  db.prepare(`UPDATE office_threads SET payload_json = ?, updated_at_iso = ? WHERE id = ?`).run(
    JSON.stringify(existing),
    nowIso(),
    threadId
  );
  db.prepare(
    `UPDATE workspace_room_threads SET pinned = 1, pinned_at_iso = ? WHERE room_id = ? AND thread_id = ?`
  ).run(nowIso(), room.id, threadId);

  appendAuditLog(db, {
    actor,
    action: 'workspace.room.pin',
    entityKind: 'workspace_room',
    entityId: room.id,
    note: card.title,
    details: { workItemId: card.workItemId, threadId },
  });

  return { ok: true, pinned: card };
}

/**
 * Create or reuse a DM room between actor and peer.
 */
export function createDmRoom(db, scope, actor, peerUserId) {
  if (!workspaceRoomsTablesReady(db) || !officeTablesReady(db)) {
    return { ok: false, error: 'Rooms not available.' };
  }
  const uid = String(actor?.id || '').trim();
  const peer = String(peerUserId || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  if (!peer) return { ok: false, error: 'Peer user is required.' };
  if (peer === uid) return { ok: false, error: 'Cannot DM yourself.' };

  let peerRow = null;
  try {
    const hasActive = tableHasColumn(db, 'app_users', 'active');
    peerRow = db
      .prepare(
        `SELECT id, display_name, username${hasActive ? ', active' : ''} FROM app_users WHERE id = ?`
      )
      .get(peer);
    if (peerRow && hasActive && Number(peerRow.active) === 0) {
      return { ok: false, error: 'Peer user is not active.' };
    }
  } catch {
    peerRow = null;
  }
  if (!peerRow) return { ok: false, error: 'Peer user not found.' };

  // Reuse existing DM that has both members.
  try {
    const candidates = db
      .prepare(
        `SELECT r.id FROM workspace_rooms r
         INNER JOIN workspace_room_members m1 ON m1.room_id = r.id AND m1.user_id = ?
         INNER JOIN workspace_room_members m2 ON m2.room_id = r.id AND m2.user_id = ?
         WHERE r.scope_kind = 'dm' AND r.is_archived = 0
         LIMIT 1`
      )
      .get(uid, peer);
    if (candidates?.id) {
      const listed = listWorkspaceRooms(db, scope, actor);
      const room = listed.rooms?.find((r) => r.id === candidates.id);
      return { ok: true, room: room || { id: candidates.id, scopeKind: 'dm', kind: 'dm' }, reused: true };
    }
  } catch {
    /* fall through to create */
  }

  const branchId = String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const now = nowIso();
  const peerName = peerRow.display_name || peerRow.username || peer;
  const actorName = displayNameForUser(db, uid);
  const roomId = newId('WR');
  const slug = `dm-${[uid, peer].sort().join('-').slice(0, 80)}`;
  const name = `${actorName} · ${peerName}`;

  try {
    const existingBySlug = db
      .prepare(`SELECT id FROM workspace_rooms WHERE scope_kind = 'dm' AND slug = ? AND is_archived = 0`)
      .get(slug);
    if (existingBySlug?.id) {
      const listed = listWorkspaceRooms(db, scope, actor);
      const room = listed.rooms?.find((r) => r.id === existingBySlug.id);
      return { ok: true, room: room || { id: existingBySlug.id, scopeKind: 'dm', kind: 'dm' }, reused: true };
    }
  } catch {
    /* fall through */
  }

  try {
    db.transaction(() => {
      insertRoomWithThread(db, {
        roomId,
        scopeKind: 'dm',
        branchId,
        departmentKey: null,
        slug,
        name,
        description: 'Direct message',
        isDefault: false,
        uid,
        now,
      });
      addRoomMember(db, roomId, uid, 'owner', now);
      addRoomMember(db, roomId, peer, 'member', now);
    })();
  } catch (e) {
    try {
      const fallback = db
        .prepare(`SELECT id FROM workspace_rooms WHERE scope_kind = 'dm' AND slug = ? LIMIT 1`)
        .get(slug);
      if (fallback?.id) {
        const listed = listWorkspaceRooms(db, scope, actor);
        const room = listed.rooms?.find((r) => r.id === fallback.id);
        return { ok: true, room: room || { id: fallback.id, scopeKind: 'dm', kind: 'dm' }, reused: true };
      }
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(e?.message || e) || 'Could not create DM.' };
  }

  appendAuditLog(db, {
    actor,
    action: 'workspace.room.dm.create',
    entityKind: 'workspace_room',
    entityId: roomId,
    note: name.slice(0, 120),
    details: { peerUserId: peer, slug },
  });

  const listed = listWorkspaceRooms(db, scope, actor);
  const room = listed.rooms?.find((r) => r.id === roomId) || {
    id: roomId,
    scopeKind: 'dm',
    kind: 'dm',
    name,
    slug,
    branchId,
  };
  return { ok: true, room, reused: false };
}

export function promoteFromRoom(db, scope, actor, workspaceBranchId, roomId, body) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.' };
  const room = db.prepare(`SELECT * FROM workspace_rooms WHERE id = ?`).get(String(roomId || ''));
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!userMayAccessRoom(db, scope, actor, room)) return { ok: false, error: 'Forbidden.' };

  const threadId = primaryThreadId(db, room.id);
  const kind = String(body?.kind || 'work_item').trim();
  const excerpt = String(body?.excerpt || '').trim();
  if (!excerpt) return { ok: false, error: 'Excerpt is required to promote.' };

  const messageId = body?.messageId ? String(body.messageId).trim() : null;
  if (messageId) {
    if (!threadId) return { ok: false, error: 'Room has no thread.' };
    const msg = db
      .prepare(`SELECT id FROM office_messages WHERE id = ? AND thread_id = ?`)
      .get(messageId, threadId);
    if (!msg) return { ok: false, error: 'Message not found in this room.' };
  }

  const title = excerpt.slice(0, 120);

  if (kind === 'memo' || kind === 'expense' || kind === 'material') {
    return {
      ok: true,
      promoteToWizard: kind,
      excerpt,
      roomId: room.id,
      threadId,
      originRoomId: room.id,
      originMessageId: body?.messageId || null,
    };
  }

  if (kind !== 'work_item') {
    return { ok: false, error: 'Unknown promote kind.' };
  }

  const wr = createWorkItem(
    db,
    {
      branchId: room.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID,
      title,
      body: excerpt || `Promoted from room ${room.name}`,
      summary: `Room promote · ${room.slug}`,
      documentClass: 'request',
      documentType: 'workspace_promote',
      officeKey: 'office_admin',
      status: 'open',
      priority: 'normal',
      senderUserId: actor?.id,
      senderDisplayName: displayNameForUser(db, actor?.id),
      senderRoleKey: actor?.roleKey,
      senderBranchId: room.branch_id,
      linkedThreadId: threadId,
      sourceKind: 'workspace_room',
      sourceId: room.id,
      data: {
        originRoomId: room.id,
        originMessageId: body?.messageId || null,
      },
      requiresResponse: true,
    },
    {}
  );

  if (!wr.ok) return wr;

  try {
    const cols = new Set(db.prepare(`PRAGMA table_info(work_items)`).all().map((c) => c.name));
    if (cols.has('origin_room_id')) {
      db.prepare(`UPDATE work_items SET origin_room_id = ?, origin_message_id = ? WHERE id = ?`).run(
        room.id,
        messageId || null,
        wr.item?.id || wr.id
      );
    }
  } catch {
    /* optional columns */
  }

  emitActivityEvent(db, {
    branchId: activityBranchForRoom(room, workspaceBranchId),
    actorUserId: actor?.id,
    eventKind: 'work_item.created',
    targetKind: 'work_item',
    targetId: wr.item?.id || wr.id,
    summaryText: `${displayNameForUser(db, actor?.id)} created work from ${room.name}`,
    payload: { roomId: room.id },
  });

  appendAuditLog(db, {
    actor,
    action: 'workspace.room.promote',
    entityKind: 'work_item',
    entityId: wr.item?.id || wr.id,
    note: title.slice(0, 120),
    details: { roomId: room.id, kind },
  });

  broadcastWorkspaceEvent({
    type: 'work_item.updated',
    branchId: room.branch_id,
    roomId: room.id,
    payload: { workItemId: wr.item?.id || wr.id },
    revision: Date.now(),
  });

  return { ok: true, workItemId: wr.item?.id || wr.id, item: wr.item };
}

export function emitActivityEvent(db, evt, opts = {}) {
  if (!workspaceRoomsTablesReady(db)) return null;
  try {
    const ready = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_activity_events'`)
      .get();
    if (!ready) return null;
    const id = newId('WAE');
    const now = nowIso();
    const hasTargetUser = tableHasColumn(db, 'workspace_activity_events', 'target_user_id');
    const targetUserId = evt.targetUserId ? String(evt.targetUserId) : null;

    if (hasTargetUser) {
      db.prepare(
        `INSERT INTO workspace_activity_events (
          id, branch_id, actor_user_id, target_user_id, event_kind, target_kind, target_id, summary_text, payload_json, created_at_iso
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        evt.branchId || DEFAULT_BRANCH_ID,
        evt.actorUserId || null,
        targetUserId,
        evt.eventKind || 'event',
        evt.targetKind || null,
        evt.targetId || null,
        String(evt.summaryText || '').slice(0, 400),
        JSON.stringify(evt.payload || {}),
        now
      );
    } else {
      db.prepare(
        `INSERT INTO workspace_activity_events (
          id, branch_id, actor_user_id, event_kind, target_kind, target_id, summary_text, payload_json, created_at_iso
        ) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        evt.branchId || DEFAULT_BRANCH_ID,
        evt.actorUserId || null,
        evt.eventKind || 'event',
        evt.targetKind || null,
        evt.targetId || null,
        String(evt.summaryText || '').slice(0, 400),
        JSON.stringify(evt.payload || {}),
        now
      );
    }

    if (!opts.deferBroadcast) {
      const broadcastTargets =
        Array.isArray(evt.targetUserIds) && evt.targetUserIds.length
          ? evt.targetUserIds.map((u) => String(u))
          : targetUserId
            ? [targetUserId]
            : null;
      broadcastWorkspaceEvent({
        type: 'activity.created',
        branchId: evt.branchId,
        payload: { id, eventKind: evt.eventKind, targetUserId },
        revision: Date.now(),
        ...(broadcastTargets ? { targetUserIds: broadcastTargets } : {}),
      });
    }
    return id;
  } catch {
    return null;
  }
}

export function listActivityEvents(db, scope, user, { limit = 50 } = {}) {
  try {
    const ready = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_activity_events'`)
      .get();
    if (!ready) return { ok: true, events: [] };
  } catch {
    return { ok: true, events: [] };
  }

  const uid = String(user?.id || '').trim();
  let lastRead = '1970-01-01T00:00:00.000Z';
  try {
    const row = db.prepare(`SELECT last_read_at_iso FROM workspace_activity_reads WHERE user_id = ?`).get(uid);
    if (row?.last_read_at_iso) lastRead = row.last_read_at_iso;
  } catch {
    /* optional */
  }

  const hasTargetUser = tableHasColumn(db, 'workspace_activity_events', 'target_user_id');
  let sql = `SELECT * FROM workspace_activity_events WHERE 1=1`;
  const args = [];
  if (hasTargetUser && uid) {
    sql += ` AND (target_user_id IS NULL OR target_user_id = ? OR actor_user_id = ?)`;
    args.push(uid, uid);
  }
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID));
  } else {
    sql += ` AND IFNULL(branch_id,'') != ''`;
  }
  sql += ` ORDER BY created_at_iso DESC LIMIT ?`;
  args.push(Math.min(100, Math.max(1, Number(limit) || 50)));

  const rows = db.prepare(sql).all(...args);
  const events = rows.map((r) => {
    const payload = safeJsonParse(r.payload_json, {});
    // A user's own actions are never "unread" for them.
    const isOwn = uid && String(r.actor_user_id || '') === uid;
    return {
      id: r.id,
      branchId: r.branch_id,
      actorUserId: r.actor_user_id,
      eventKind: r.event_kind,
      targetKind: r.target_kind,
      targetId: r.target_id,
      summaryText: r.summary_text,
      roomId: payload.roomId || null,
      createdAtIso: r.created_at_iso,
      read: isOwn || String(r.created_at_iso) <= lastRead,
      payload,
    };
  });
  return { ok: true, events };
}

export function markActivityRead(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  const now = nowIso();
  const ok = upsertByConflict(db, {
    conflictInsert: `INSERT INTO workspace_activity_reads (user_id, last_read_at_iso) VALUES (?,?)
       ON CONFLICT(user_id) DO UPDATE SET last_read_at_iso = excluded.last_read_at_iso`,
    conflictArgs: [uid, now],
    update: `UPDATE workspace_activity_reads SET last_read_at_iso = ? WHERE user_id = ?`,
    updateArgs: [now, uid],
    exists: `SELECT 1 AS ok FROM workspace_activity_reads WHERE user_id = ?`,
    existsArgs: [uid],
    plainInsert: `INSERT INTO workspace_activity_reads (user_id, last_read_at_iso) VALUES (?,?)`,
    plainArgs: [uid, now],
  });
  return ok ? { ok: true } : { ok: false, error: 'Could not mark activity read.' };
}

export function upsertPresence(db, user, { status = 'online', branchId, deskKey } = {}) {
  const uid = String(user?.id || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  try {
    const ready = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_presence'`)
      .get();
    if (!ready) return { ok: true };
    const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
    const st = ['online', 'away', 'busy', 'offline'].includes(status) ? status : 'online';
    const desk = deskKey != null && String(deskKey).trim() ? String(deskKey).trim().slice(0, 80) : null;
    const now = nowIso();
    const ok = upsertByConflict(db, {
      conflictInsert: `INSERT INTO workspace_presence (user_id, status, branch_id, desk_key, last_seen_at_iso)
       VALUES (?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = excluded.status,
         branch_id = excluded.branch_id,
         desk_key = excluded.desk_key,
         last_seen_at_iso = excluded.last_seen_at_iso`,
      conflictArgs: [uid, st, bid, desk, now],
      update: `UPDATE workspace_presence SET status = ?, branch_id = ?, desk_key = ?, last_seen_at_iso = ? WHERE user_id = ?`,
      updateArgs: [st, bid, desk, now, uid],
      exists: `SELECT 1 AS ok FROM workspace_presence WHERE user_id = ?`,
      existsArgs: [uid],
      plainInsert: `INSERT INTO workspace_presence (user_id, status, branch_id, desk_key, last_seen_at_iso) VALUES (?,?,?,?,?)`,
      plainArgs: [uid, st, bid, desk, now],
    });
    if (!ok) return { ok: false, error: 'Could not update presence.' };
    broadcastWorkspaceEvent({
      type: 'presence.changed',
      branchId: bid,
      payload: { userId: uid, status: st, deskKey: desk },
      revision: Date.now(),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function listPresence(db, scope) {
  try {
    const ready = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_presence'`)
      .get();
    if (!ready) return { ok: true, presence: [] };
  } catch {
    return { ok: true, presence: [] };
  }

  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let sql = `SELECT p.*, u.display_name, u.username FROM workspace_presence p
    LEFT JOIN app_users u ON u.id = p.user_id
    WHERE p.last_seen_at_iso >= ?`;
  const args = [cutoff];
  if (!scope?.viewAll) {
    sql += ` AND p.branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID));
  }
  sql += ` ORDER BY p.last_seen_at_iso DESC LIMIT 80`;
  const rows = db.prepare(sql).all(...args);
  return {
    ok: true,
    presence: rows.map((r) => ({
      userId: r.user_id,
      status: r.status,
      branchId: r.branch_id,
      deskKey: r.desk_key || null,
      displayName: r.display_name || r.username || r.user_id,
      lastSeenAtIso: r.last_seen_at_iso,
    })),
  };
}

export { officeScopeFromReq, DEFAULT_CHANNELS, COMPANY_CHANNELS, MAX_MESSAGE_BODY_LEN, EXEC_ROOM_ROLES };
