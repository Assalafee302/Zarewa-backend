import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  listWorkspaceRooms,
  postRoomMessage,
  getRoomMessages,
  markRoomRead,
  muteRoom,
  archiveRoom,
  editRoomMessage,
  deleteRoomMessage,
  promoteFromRoom,
  createDmRoom,
  listActivityEvents,
  upsertPresence,
  listPresence,
  markActivityRead,
  userMayPostInRoom,
  MAX_MESSAGE_BODY_LEN,
} from './workspaceRoomsOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('workspaceRoomsOps', () => {
  let db;
  const user = {
    id: 'u_ws_v3_test',
    roleKey: 'sales_staff',
    permissions: ['office.use', '*'],
    displayName: 'WS V3 Test',
  };
  const peer = {
    id: 'u_ws_v3_peer',
    roleKey: 'sales_manager',
    permissions: ['office.use', '*'],
    displayName: 'WS V3 Peer',
  };
  const otherBranchUser = {
    id: 'u_ws_v3_other',
    roleKey: 'sales_staff',
    permissions: ['office.use'],
    displayName: 'Other Branch',
  };
  const staffUser = {
    id: 'u_ws_v3_staff',
    roleKey: 'sales_staff',
    permissions: ['office.use'],
    displayName: 'Staff Only',
  };
  const bystander = {
    id: 'u_ws_v3_bystander',
    roleKey: 'sales_staff',
    permissions: ['office.use'],
    displayName: 'Bystander',
  };
  const execUser = {
    id: 'u_ws_v3_exec',
    roleKey: 'md',
    permissions: ['office.use', '*'],
    displayName: 'MD User',
  };
  const scope = { viewAll: false, branchId: DEFAULT_BRANCH_ID };
  const otherScope = { viewAll: false, branchId: 'branch-other-xyz' };

  function insertUser(u) {
    try {
      db.prepare(
        `INSERT INTO app_users (id, username, display_name, role_key, password_hash, active, created_at_iso)
         VALUES (?,?,?,?,?,1,?)`
      ).run(u.id, u.id, u.displayName, u.roleKey, 'x', new Date().toISOString());
    } catch {
      try {
        db.prepare(
          `INSERT INTO app_users (id, username, display_name, role_key, password_hash, created_at_iso)
           VALUES (?,?,?,?,?,?)`
        ).run(u.id, u.id, u.displayName, u.roleKey, 'x', new Date().toISOString());
      } catch {
        /* may exist */
      }
    }
  }

  function roomBySlug(slug, roomsUser = user) {
    const { rooms } = listWorkspaceRooms(db, scope, roomsUser);
    return rooms.find((x) => x.slug === slug);
  }

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    insertUser(user);
    insertUser(peer);
    insertUser(otherBranchUser);
    insertUser(staffUser);
    insertUser(execUser);
    insertUser(bystander);
  });

  afterEach(() => {
    try {
      db?.close?.();
    } catch {
      /* ignore */
    }
  });

  it('provisions default branch rooms and company rooms', () => {
    const r = listWorkspaceRooms(db, scope, user);
    expect(r.ok).toBe(true);
    expect(r.rooms.length).toBeGreaterThanOrEqual(6);
    expect(r.rooms.some((x) => x.slug === 'general')).toBe(true);
    expect(r.rooms.some((x) => x.scopeKind === 'company' || x.slug === 'announcements')).toBe(true);
  });

  it('sends and lists room messages; plain posts stay out of the activity feed', () => {
    const general = roomBySlug('general');
    expect(general).toBeTruthy();
    const sent = postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, { body: 'Hello ops' });
    expect(sent.ok).toBe(true);
    expect(sent.message.body).toBe('Hello ops');
    const listed = getRoomMessages(db, scope, user, general.id);
    expect(listed.ok).toBe(true);
    expect(listed.messages.some((m) => m.body === 'Hello ops')).toBe(true);
    const a = listActivityEvents(db, scope, user);
    expect(a.events.some((e) => e.eventKind === 'message.created')).toBe(false);
  });

  it('mentions emit activity for target only (username resolution)', () => {
    const general = roomBySlug('general');
    const sent = postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
      body: `Ping @${peer.id} please review`,
    });
    expect(sent.ok).toBe(true);
    const forPeer = listActivityEvents(db, scope, peer);
    const forBystander = listActivityEvents(db, scope, bystander);
    expect(forPeer.events.some((e) => e.eventKind === 'mention')).toBe(true);
    expect(forBystander.events.some((e) => e.eventKind === 'mention')).toBe(false);
  });

  it('denies leadership room access to non-exec staff', () => {
    listWorkspaceRooms(db, scope, execUser);
    const leadership = db
      .prepare(`SELECT * FROM workspace_rooms WHERE scope_kind = 'company' AND slug = 'leadership'`)
      .get();
    expect(leadership).toBeTruthy();
    const denied = getRoomMessages(db, scope, staffUser, leadership.id);
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Forbidden/i);
    const allowed = getRoomMessages(db, scope, execUser, leadership.id);
    expect(allowed.ok).toBe(true);
  });

  it('denies announcement posts for non-exec staff but allows exec', () => {
    listWorkspaceRooms(db, scope, user);
    const announcements = db
      .prepare(`SELECT * FROM workspace_rooms WHERE scope_kind = 'company' AND slug = 'announcements'`)
      .get();
    expect(announcements).toBeTruthy();
    expect(userMayPostInRoom(db, scope, staffUser, announcements)).toBe(false);
    expect(userMayPostInRoom(db, scope, execUser, announcements)).toBe(true);
    const denied = postRoomMessage(db, scope, staffUser, DEFAULT_BRANCH_ID, announcements.id, {
      body: 'Staff cannot post here',
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Forbidden/i);
    const allowed = postRoomMessage(db, scope, execUser, DEFAULT_BRANCH_ID, announcements.id, {
      body: 'Exec notice',
    });
    expect(allowed.ok).toBe(true);
  });

  it('marks own activity events as read for the actor', () => {
    const general = roomBySlug('general');
    promoteFromRoom(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
      kind: 'work_item',
      excerpt: 'Own event unread check',
    });
    const mine = listActivityEvents(db, scope, user);
    const own = mine.events.filter((e) => e.actorUserId === user.id);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.read === true)).toBe(true);
  });

  it('mutes and unmutes an accessible room and exposes the mute expiry', () => {
    const general = roomBySlug('general');
    const until = new Date(Date.now() + 60_000).toISOString();
    const muted = muteRoom(db, scope, staffUser, general.id, { mutedUntilIso: until });
    expect(muted).toEqual({ ok: true, muted: true, mutedUntilIso: until });
    const listed = listWorkspaceRooms(db, scope, staffUser);
    expect(listed.rooms.find((r) => r.id === general.id)?.mutedUntilIso).toBe(until);
    expect(muteRoom(db, scope, staffUser, general.id, { mutedUntilIso: null })).toEqual({
      ok: true,
      muted: false,
      mutedUntilIso: null,
    });
  });

  it('archives rooms only for owners, admins, executives, or creators', () => {
    const general = roomBySlug('general');
    expect(archiveRoom(db, scope, staffUser, general.id, { archived: true }).ok).toBe(false);
    expect(archiveRoom(db, scope, user, general.id, { archived: true })).toEqual({
      ok: true,
      archived: true,
    });
    expect(listWorkspaceRooms(db, scope, user).rooms.some((r) => r.id === general.id)).toBe(false);
    expect(archiveRoom(db, scope, user, general.id, { archived: false })).toEqual({
      ok: true,
      archived: false,
    });
  });

  it('supports replies, author edits, executive moderation, and deleted tombstones', () => {
    const general = roomBySlug('general');
    const parent = postRoomMessage(db, scope, staffUser, DEFAULT_BRANCH_ID, general.id, {
      body: 'Parent message',
    });
    const reply = postRoomMessage(db, scope, staffUser, DEFAULT_BRANCH_ID, general.id, {
      body: 'Reply message',
      parentMessageId: parent.message.id,
    });
    expect(reply.ok).toBe(true);
    expect(reply.message.parentMessageId).toBe(parent.message.id);

    const denied = editRoomMessage(db, scope, bystander, general.id, reply.message.id, {
      body: 'Not mine',
    });
    expect(denied.error).toBe('Forbidden.');
    const edited = editRoomMessage(db, scope, staffUser, general.id, reply.message.id, {
      body: 'Edited reply',
    });
    expect(edited.ok).toBe(true);
    expect(edited.message.editedAtIso).toBeTruthy();

    expect(deleteRoomMessage(db, scope, execUser, general.id, reply.message.id).ok).toBe(true);
    const listed = getRoomMessages(db, scope, staffUser, general.id);
    const tombstone = listed.messages.find((m) => m.id === reply.message.id);
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.body).toBe('This message was deleted');
    expect(
      postRoomMessage(db, scope, staffUser, DEFAULT_BRANCH_ID, general.id, {
        body: 'Cannot reply to deleted',
        parent_message_id: reply.message.id,
      }).ok
    ).toBe(false);
  });

  it('rejects empty and oversized messages', () => {
    const general = roomBySlug('general');
    expect(postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, { body: '  ' }).ok).toBe(false);
    const huge = 'x'.repeat(MAX_MESSAGE_BODY_LEN + 1);
    expect(postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, { body: huge }).ok).toBe(false);
  });

  it('promotes room chat to work item and requires excerpt', () => {
    const general = roomBySlug('general');
    expect(
      promoteFromRoom(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
        kind: 'work_item',
        excerpt: '',
      }).ok
    ).toBe(false);
    const r = promoteFromRoom(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
      kind: 'work_item',
      excerpt: 'Need coil transfer urgently',
    });
    expect(r.ok).toBe(true);
    expect(r.workItemId).toBeTruthy();
  });

  it('rejects promote when messageId is not in room thread', () => {
    const general = roomBySlug('general');
    const other = postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, { body: 'seed' });
    const foreignMsgId = 'OM-foreign-not-in-thread';
    const r = promoteFromRoom(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
      kind: 'work_item',
      excerpt: 'Bad promote',
      messageId: foreignMsgId,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Message not found/i);
    const good = promoteFromRoom(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
      kind: 'work_item',
      excerpt: 'Good promote',
      messageId: other.message?.id,
    });
    expect(good.ok).toBe(true);
  });

  it('creates DM and hides it from non-members', () => {
    const dm = createDmRoom(db, scope, user, peer.id);
    expect(dm.ok).toBe(true);
    expect(dm.room?.scopeKind || dm.room?.kind).toMatch(/dm/i);
    const forUser = listWorkspaceRooms(db, scope, user);
    expect(forUser.rooms.some((r) => r.id === dm.room.id)).toBe(true);
    const forStranger = listWorkspaceRooms(db, scope, otherBranchUser);
    expect(forStranger.rooms.some((r) => r.id === dm.room.id)).toBe(false);
  });

  it('blocks cross-branch room access', () => {
    const general = roomBySlug('general');
    const denied = getRoomMessages(db, otherScope, otherBranchUser, general.id);
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Forbidden/i);
  });

  it('markRoomRead marks thread without loading messages', () => {
    const general = roomBySlug('general');
    postRoomMessage(db, scope, peer, DEFAULT_BRANCH_ID, general.id, { body: 'unread ping' });
    const listed = listWorkspaceRooms(db, scope, user);
    const room = listed.rooms.find((r) => r.id === general.id);
    expect(room?.unreadCount).toBeGreaterThan(0);
    expect(markRoomRead(db, scope, user, general.id).ok).toBe(true);
    const after = listWorkspaceRooms(db, scope, user);
    const roomAfter = after.rooms.find((r) => r.id === general.id);
    expect(roomAfter?.unreadCount || 0).toBe(0);
  });

  it('records presence with desk key', () => {
    expect(
      upsertPresence(db, user, { status: 'online', branchId: DEFAULT_BRANCH_ID, deskKey: 'sales' }).ok
    ).toBe(true);
    const p = listPresence(db, scope);
    expect(p.ok).toBe(true);
    const row = p.presence.find((x) => x.userId === user.id);
    expect(row?.deskKey).toBe('sales');
    expect(markActivityRead(db, user.id).ok).toBe(true);
    const a = listActivityEvents(db, scope, user);
    expect(a.ok).toBe(true);
    expect(Array.isArray(a.events)).toBe(true);
  });

  it('reuses existing DM between same peers', () => {
    const a = createDmRoom(db, scope, user, peer.id);
    const b = createDmRoom(db, scope, user, peer.id);
    expect(a.ok && b.ok).toBe(true);
    expect(b.reused).toBe(true);
    expect(b.room.id).toBe(a.room.id);
  });
});
