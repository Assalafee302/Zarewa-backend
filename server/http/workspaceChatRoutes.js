/**
 * Workspace V3 chat HTTP — rooms, DMs, activity, presence, SSE.
 *
 * Gated by ZAREWA_WORKSPACE_ROOMS_ENABLED (off by default). Does not register
 * branch snapshots, revision, search, or Office filing.
 */
import { requireAuth, requirePermission } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { officeScopeFromReq } from '../officeOps.js';
import { requireWorkspaceRoomsEnabled } from '../workspace/chatFlags.js';
import {
  archiveRoom,
  createDmRoom,
  deleteRoomMessage,
  editRoomMessage,
  getRoomMessages,
  listActivityEvents,
  listPresence,
  listWorkspaceRooms,
  markActivityRead,
  markRoomRead,
  muteRoom,
  pinRoomWorkCard,
  postRoomMessage,
  promoteFromRoom,
  registerWorkspaceSseClient,
  upsertPresence,
} from '../workspaceRoomsOps.js';

const chatAuth = [requireAuth, requireWorkspaceRoomsEnabled, requirePermission('office.use')];

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerWorkspaceChatRoutes(app, db) {
  app.get('/api/workspace/rooms', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = listWorkspaceRooms(db, scope, req.user);
      res.status(r.ok ? 200 : 503).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not list rooms.', rooms: [] });
    }
  });

  app.get('/api/workspace/rooms/:roomId/messages', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const limit = Number(req.query.limit) || 80;
      const beforeIso = req.query.beforeIso ? String(req.query.beforeIso) : undefined;
      const markRead =
        req.query.markRead === '1' || String(req.query.markRead || '').toLowerCase() === 'true';
      const r = getRoomMessages(db, scope, req.user, String(req.params.roomId || ''), {
        limit,
        beforeIso,
        markRead,
      });
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load messages.' });
    }
  });

  app.post('/api/workspace/rooms/:roomId/read', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = markRoomRead(db, scope, req.user, String(req.params.roomId || ''));
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not mark room read.' });
    }
  });

  app.post('/api/workspace/rooms/:roomId/mute', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = muteRoom(db, scope, req.user, String(req.params.roomId || ''), {
        mutedUntilIso: req.body?.unmute ? null : req.body?.mutedUntilIso,
      });
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update room mute.' });
    }
  });

  app.post('/api/workspace/rooms/:roomId/archive', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = archiveRoom(db, scope, req.user, String(req.params.roomId || ''), {
        archived: req.body?.archived !== false,
      });
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update room archive.' });
    }
  });

  app.post('/api/workspace/rooms/:roomId/messages', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = postRoomMessage(
        db,
        scope,
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID,
        String(req.params.roomId || ''),
        req.body || {}
      );
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.status(201).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not send message.' });
    }
  });

  app.patch('/api/workspace/rooms/:roomId/messages/:messageId', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = editRoomMessage(
        db,
        scope,
        req.user,
        String(req.params.roomId || ''),
        String(req.params.messageId || ''),
        req.body || {}
      );
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.' || r.error === 'Message not found in this room.') {
          return res.status(404).json(r);
        }
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not edit room message.' });
    }
  });

  app.delete('/api/workspace/rooms/:roomId/messages/:messageId', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = deleteRoomMessage(
        db,
        scope,
        req.user,
        String(req.params.roomId || ''),
        String(req.params.messageId || '')
      );
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.' || r.error === 'Message not found in this room.') {
          return res.status(404).json(r);
        }
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not delete room message.' });
    }
  });

  app.post('/api/workspace/rooms/:roomId/pin', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = pinRoomWorkCard(db, scope, req.user, String(req.params.roomId || ''), req.body || {});
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not pin work card.' });
    }
  });

  app.post('/api/workspace/rooms/:roomId/promote', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = promoteFromRoom(
        db,
        scope,
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID,
        String(req.params.roomId || ''),
        req.body || {}
      );
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Room not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not promote from room.' });
    }
  });

  app.post('/api/workspace/rooms/dm', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = createDmRoom(db, scope, req.user, req.body?.peerUserId || req.body?.userId);
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Peer user not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      res.status(r.reused ? 200 : 201).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not create DM.' });
    }
  });

  app.get('/api/workspace/activity', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = listActivityEvents(db, scope, req.user, { limit: Number(req.query.limit) || 50 });
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load activity.', events: [] });
    }
  });

  app.post('/api/workspace/activity/read', ...chatAuth, (req, res) => {
    try {
      const r = markActivityRead(db, req.user?.id);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not mark activity read.' });
    }
  });

  app.get('/api/workspace/presence', ...chatAuth, (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = listPresence(db, scope);
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load presence.', presence: [] });
    }
  });

  app.post('/api/workspace/presence/heartbeat', ...chatAuth, (req, res) => {
    try {
      const r = upsertPresence(db, req.user, {
        status: req.body?.status || 'online',
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update presence.' });
    }
  });

  app.get('/api/workspace/realtime', ...chatAuth, (req, res) => {
    // Cookie/session auth via requireAuth; EventSource clients must set withCredentials: true.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`retry: 5000\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'connected', revision: Date.now() })}\n\n`);
    const scope = officeScopeFromReq(req);
    registerWorkspaceSseClient(res, {
      userId: req.user?.id,
      branchId: scope?.branchId,
      viewAll: Boolean(scope?.viewAll),
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);
    req.on('close', () => clearInterval(heartbeat));
  });
}
