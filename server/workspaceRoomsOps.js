/**
 * Workspace V3 — rooms, activity, presence, SSE fan-out.
 * Additive on office_threads / office_messages.
 */
import { DEFAULT_BRANCH_ID } from './branches.js';
import { officeScopeFromReq, officeTablesReady } from './officeOps.js';
import { createWorkItem } from './workItems.js';
import { appendAuditLog } from './controlOps.js';

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
 * @param {import('http').ServerResponse} res
 * @param {{ userId?: string; branchId?: string; viewAll?: boolean }} [scope]
 */
export function registerWorkspaceSseClient(res, scope = {}) {
  sseClients.set(res, {
    userId: String(scope.userId || ''),
    branchId: String(scope.branchId || ''),
    viewAll: Boolean(scope.viewAll),
  });
  res.on('close', () => sseClients.delete(res));
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
    ).run(
      threadId,
      branchId || DEFAULT_BRANCH_ID,
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
    ).run(
      threadId,
      branchId || DEFAULT_BRANCH_ID,
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
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM office_messages
         WHERE thread_id = ?
           AND created_at_iso > ?
           AND IFNULL(author_user_id,'') != ?
           AND IFNULL(TRIM(body),'') != ''`
      )
      .get(threadId, since, userId);
    const n = Number(row?.c || 0);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 9999) : 0;
  } catch {
    return 0;
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

  let sql = `SELECT * FROM workspace_rooms WHERE is_archived = 0`;
  const args = [];
  if (!scope?.viewAll) {
    // Branch channels + company rooms; DMs filtered by membership below (not by branch alone).
    sql += ` AND (scope_kind = 'company' OR scope_kind = 'dm' OR branch_id = ?)`;
    args.push(branchId);
  }
  sql += ` ORDER BY scope_kind ASC, slug ASC`;
  const rows = db.prepare(sql).all(...args);
  const uid = String(user?.id || '').trim();

  const rooms = [];
  for (const r of rows) {
    // DMs are private — never list without membership (even when viewAll).
    if (r.scope_kind === 'dm' && !userIsRoomMember(db, r.id, uid)) continue;
    // Non-viewAll: never leak another branch's channel via null/wrong branch_id.
    if (!scope?.viewAll && r.scope_kind === 'branch') {
      if (String(r.branch_id || '') !== branchId) continue;
    }
    const threadId = primaryThreadId(db, r.id);
    rooms.push({
      id: r.id,
      scopeKind: r.scope_kind,
      branchId: r.branch_id,
      departmentKey: r.department_key,
      slug: r.slug,
      name: r.name,
      description: r.description,
      isDefault: Boolean(r.is_default),
      kind: r.scope_kind === 'dm' ? 'dm' : 'channel',
      threadId,
      unreadCount: unreadForRoom(db, r.id, uid, threadId),
      createdAtIso: r.created_at_iso,
      updatedAtIso: r.updated_at_iso,
    });
  }
  return { ok: true, rooms };
}

function userMayAccessRoom(db, scope, user, room) {
  if (!room) return false;
  if (Number(room.is_archived) === 1) return false;
  if (room.scope_kind === 'dm') {
    return userIsRoomMember(db, room.id, user?.id);
  }
  if (room.scope_kind === 'company') return true;
  if (scope?.viewAll) return true;
  const bid = String(scope?.branchId || '').trim();
  return String(room.branch_id || '') === bid;
}

export function getRoomMessages(db, scope, user, roomId, { limit = 80 } = {}) {
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
      `SELECT id, thread_id, author_user_id, body, kind, created_at_iso${extraCols} FROM office_messages WHERE thread_id = ? ORDER BY created_at_iso DESC LIMIT ?`
    )
    .all(threadId, Math.min(200, Math.max(1, Number(limit) || 80)))
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

  return { ok: true, messages, pinned, threadId };
}

export function postRoomMessage(db, scope, actor, workspaceBranchId, roomId, body) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.' };
  const room = db.prepare(`SELECT * FROM workspace_rooms WHERE id = ?`).get(String(roomId || ''));
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!userMayAccessRoom(db, scope, actor, room)) return { ok: false, error: 'Forbidden.' };

  let threadId = primaryThreadId(db, room.id);
  if (!threadId) return { ok: false, error: 'Room has no thread.' };

  const text = String(body?.body ?? '').trim();
  if (!text) return { ok: false, error: 'Message is required.' };
  if (text.length > MAX_MESSAGE_BODY_LEN) {
    return { ok: false, error: `Message too long (max ${MAX_MESSAGE_BODY_LEN} characters).` };
  }

  // Room ACL already checked — insert directly so channel threads (empty To/Cc) stay usable.
  const mid = newId('OM');
  const now = nowIso();
  const uid = String(actor?.id || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO office_messages (id, thread_id, author_user_id, body, kind, created_at_iso) VALUES (?,?,?,?,?,?)`
      ).run(mid, threadId, uid, text, 'user', now);
      db.prepare(`UPDATE office_threads SET updated_at_iso = ? WHERE id = ?`).run(now, threadId);
    })();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) || 'Could not send message.' };
  }

  // Mention tokens must start and end alphanumeric so trailing punctuation
  // ("@ali.") doesn't pollute the handle.
  const mentions = [...text.matchAll(/@([a-zA-Z0-9_](?:[a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_])?)/g)]
    .map((m) => m[1])
    .slice(0, 20);
  if (mentions.length) {
    try {
      if (tableHasColumn(db, 'office_messages', 'mentions_json')) {
        db.prepare(`UPDATE office_messages SET mentions_json = ? WHERE id = ?`).run(
          JSON.stringify(mentions),
          mid
        );
      }
      for (const mention of mentions) {
        const target = db
          .prepare(
            `SELECT id FROM app_users WHERE lower(username) = lower(?) OR lower(display_name) = lower(?) LIMIT 1`
          )
          .get(mention, mention);
        if (target?.id) {
          const eid = newId('WME');
          db.prepare(
            `INSERT INTO workspace_mentions (id, message_id, mentioned_user_id, mentioned_role_key, room_id, thread_id, created_at_iso)
             VALUES (?,?,?,?,?,?,?)`
          ).run(eid, mid, target.id, null, room.id, threadId, now);
          emitActivityEvent(db, {
            branchId: room.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID,
            actorUserId: actor?.id,
            eventKind: 'mention',
            targetKind: 'message',
            targetId: mid,
            summaryText: `${displayNameForUser(db, actor?.id)} mentioned you in ${room.name}`,
            payload: { roomId: room.id, threadId },
          });
        }
      }
    } catch {
      /* mentions optional */
    }
  }

  const message = {
    id: mid,
    threadId,
    authorUserId: actor?.id,
    authorDisplayName: displayNameForUser(db, actor?.id),
    body: text,
    kind: 'user',
    createdAtIso: now,
  };

  try {
    db.prepare(`UPDATE workspace_rooms SET updated_at_iso = ? WHERE id = ?`).run(nowIso(), room.id);
  } catch {
    /* optional */
  }

  // Plain channel posts do NOT emit activity events — the SSE broadcast keeps
  // unread counts live and the Activity feed stays reserved for mentions,
  // assignments, and work-item events instead of every message.

  // DM messages are private: deliver the SSE event to members only.
  let targetUserIds = null;
  if (room.scope_kind === 'dm') {
    try {
      targetUserIds = db
        .prepare(`SELECT user_id FROM workspace_room_members WHERE room_id = ?`)
        .all(room.id)
        .map((r) => String(r.user_id));
    } catch {
      targetUserIds = [uid];
    }
  }

  broadcastWorkspaceEvent({
    type: 'message.created',
    branchId: room.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID,
    roomId: room.id,
    payload: { messageId: message.id, threadId },
    revision: Date.now(),
    ...(targetUserIds ? { targetUserIds } : {}),
  });

  return { ok: true, message };
}

export function pinRoomWorkCard(db, scope, actor, roomId, payload) {
  if (!workspaceRoomsTablesReady(db)) return { ok: false, error: 'Rooms not available.' };
  const room = db.prepare(`SELECT * FROM workspace_rooms WHERE id = ?`).get(String(roomId || ''));
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!userMayAccessRoom(db, scope, actor, room)) return { ok: false, error: 'Forbidden.' };

  const threadId = primaryThreadId(db, room.id);
  if (!threadId) return { ok: false, error: 'Room has no thread.' };

  const card = {
    id: String(payload?.id || payload?.workItemId || newId('WC')),
    workItemId: payload?.workItemId || null,
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
    peerRow = db.prepare(`SELECT id, display_name, username FROM app_users WHERE id = ?`).get(peer);
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
    return { ok: false, error: String(e?.message || e) || 'Could not create DM.' };
  }

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
        body?.messageId || null,
        wr.item?.id || wr.id
      );
    }
  } catch {
    /* optional columns */
  }

  emitActivityEvent(db, {
    branchId: room.branch_id,
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

export function emitActivityEvent(db, evt) {
  if (!workspaceRoomsTablesReady(db)) return null;
  try {
    const ready = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_activity_events'`)
      .get();
    if (!ready) return null;
    const id = newId('WAE');
    const now = nowIso();
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
    broadcastWorkspaceEvent({
      type: 'activity.created',
      branchId: evt.branchId,
      payload: { id, eventKind: evt.eventKind },
      revision: Date.now(),
    });
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

  let sql = `SELECT * FROM workspace_activity_events WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID));
  } else {
    // viewAll still excludes orphan events with empty branch when present
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

export function upsertPresence(db, user, { status = 'online', branchId } = {}) {
  const uid = String(user?.id || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  try {
    const ready = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_presence'`)
      .get();
    if (!ready) return { ok: true };
    const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
    const st = ['online', 'away', 'busy', 'offline'].includes(status) ? status : 'online';
    const now = nowIso();
    const ok = upsertByConflict(db, {
      conflictInsert: `INSERT INTO workspace_presence (user_id, status, branch_id, desk_key, last_seen_at_iso)
       VALUES (?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = excluded.status,
         branch_id = excluded.branch_id,
         last_seen_at_iso = excluded.last_seen_at_iso`,
      conflictArgs: [uid, st, bid, null, now],
      update: `UPDATE workspace_presence SET status = ?, branch_id = ?, last_seen_at_iso = ? WHERE user_id = ?`,
      updateArgs: [st, bid, now, uid],
      exists: `SELECT 1 AS ok FROM workspace_presence WHERE user_id = ?`,
      existsArgs: [uid],
      plainInsert: `INSERT INTO workspace_presence (user_id, status, branch_id, desk_key, last_seen_at_iso) VALUES (?,?,?,?,?)`,
      plainArgs: [uid, st, bid, null, now],
    });
    if (!ok) return { ok: false, error: 'Could not update presence.' };
    broadcastWorkspaceEvent({
      type: 'presence.changed',
      branchId: bid,
      payload: { userId: uid, status: st },
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
      displayName: r.display_name || r.username || r.user_id,
      lastSeenAtIso: r.last_seen_at_iso,
    })),
  };
}

export { officeScopeFromReq, DEFAULT_CHANNELS, COMPANY_CHANNELS, MAX_MESSAGE_BODY_LEN };
