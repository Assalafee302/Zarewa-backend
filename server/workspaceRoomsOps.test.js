import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  listWorkspaceRooms,
  postRoomMessage,
  getRoomMessages,
  promoteFromRoom,
  createDmRoom,
  listActivityEvents,
  upsertPresence,
  listPresence,
  markActivityRead,
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

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    insertUser(user);
    insertUser(peer);
    insertUser(otherBranchUser);
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
    const { rooms } = listWorkspaceRooms(db, scope, user);
    const general = rooms.find((x) => x.slug === 'general');
    expect(general).toBeTruthy();
    const sent = postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, { body: 'Hello ops' });
    expect(sent.ok).toBe(true);
    expect(sent.message.body).toBe('Hello ops');
    const listed = getRoomMessages(db, scope, user, general.id);
    expect(listed.ok).toBe(true);
    expect(listed.messages.some((m) => m.body === 'Hello ops')).toBe(true);
    // Feed is reserved for mentions/assignments/work-item events — a plain
    // channel post must NOT create a message.created activity entry.
    const a = listActivityEvents(db, scope, user);
    expect(a.events.some((e) => e.eventKind === 'message.created')).toBe(false);
  });

  it('mentions emit activity and reject trailing punctuation in handles', () => {
    const { rooms } = listWorkspaceRooms(db, scope, user);
    const general = rooms.find((x) => x.slug === 'general');
    const sent = postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
      body: `Ping @${peer.id}. please review`,
    });
    expect(sent.ok).toBe(true);
    const a = listActivityEvents(db, scope, peer);
    const mention = a.events.find((e) => e.eventKind === 'mention');
    expect(mention).toBeTruthy();
  });

  it('marks own activity events as read for the actor', () => {
    const { rooms } = listWorkspaceRooms(db, scope, user);
    const general = rooms.find((x) => x.slug === 'general');
    promoteFromRoom(db, scope, user, DEFAULT_BRANCH_ID, general.id, {
      kind: 'work_item',
      excerpt: 'Own event unread check',
    });
    const mine = listActivityEvents(db, scope, user);
    const own = mine.events.filter((e) => e.actorUserId === user.id);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.read === true)).toBe(true);
  });

  it('rejects empty and oversized messages', () => {
    const { rooms } = listWorkspaceRooms(db, scope, user);
    const general = rooms.find((x) => x.slug === 'general');
    expect(postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, { body: '  ' }).ok).toBe(false);
    const huge = 'x'.repeat(MAX_MESSAGE_BODY_LEN + 1);
    expect(postRoomMessage(db, scope, user, DEFAULT_BRANCH_ID, general.id, { body: huge }).ok).toBe(false);
  });

  it('promotes room chat to work item and requires excerpt', () => {
    const { rooms } = listWorkspaceRooms(db, scope, user);
    const general = rooms.find((x) => x.slug === 'general');
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
    const { rooms } = listWorkspaceRooms(db, scope, user);
    const general = rooms.find((x) => x.slug === 'general');
    const denied = getRoomMessages(db, otherScope, otherBranchUser, general.id);
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Forbidden/i);
  });

  it('records presence, mark read, and activity list is safe', () => {
    expect(upsertPresence(db, user, { status: 'online', branchId: DEFAULT_BRANCH_ID }).ok).toBe(true);
    const p = listPresence(db, scope);
    expect(p.ok).toBe(true);
    expect(p.presence.some((x) => x.userId === user.id)).toBe(true);
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
