/**
 * Investigation platform HTTP.
 * The case file is limited to the MD, the case officer, and members the MD adds.
 * Badges are visible to anyone who can see the underlying record.
 */
import { requireAuth } from '../auth.js';
import { apiError } from '../apiError.js';
import {
  addInvestigationPlatformLink,
  addInvestigationPlatformMember,
  addInvestigationPlatformNote,
  closeInvestigationPlatformCase,
  getInvestigationPlatformCase,
  investigationPlatformBadges,
  liftInvestigationPlatformHold,
  listInvestigationPlatformCases,
  openInvestigationPlatformCase,
  setInvestigationPlatformOfficer,
} from '../office/investigationPlatformOps.js';

function sendResult(res, result) {
  if (!result?.ok) {
    return apiError(res, {
      status: result?.status || 400,
      code: result?.code || 'REQUEST_FAILED',
      error: result?.error || 'Request failed.',
    });
  }
  return res.json(result);
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerInvestigationPlatformRoutes(app, db) {
  app.get('/api/investigation-platform/badges', requireAuth, (req, res) => {
    const ids = String(req.query.ids || req.query.id || '');
    res.json(investigationPlatformBadges(db, req.query.kind, ids));
  });

  app.get('/api/investigation-platform/cases', requireAuth, (req, res) => {
    sendResult(res, listInvestigationPlatformCases(db, req.user));
  });

  app.get('/api/investigation-platform/cases/:id', requireAuth, (req, res) => {
    sendResult(res, getInvestigationPlatformCase(db, req.params.id, req.user));
  });

  app.post('/api/investigation-platform/cases', requireAuth, (req, res) => {
    sendResult(res, openInvestigationPlatformCase(db, req.body || {}, req.user));
  });

  app.post('/api/investigation-platform/cases/:id/links', requireAuth, (req, res) => {
    sendResult(res, addInvestigationPlatformLink(db, req.params.id, req.body || {}, req.user));
  });

  app.post('/api/investigation-platform/cases/:id/notes', requireAuth, (req, res) => {
    sendResult(res, addInvestigationPlatformNote(db, req.params.id, req.body?.text, req.user));
  });

  app.post('/api/investigation-platform/cases/:id/officer', requireAuth, (req, res) => {
    sendResult(res, setInvestigationPlatformOfficer(db, req.params.id, req.body?.userId, req.user));
  });

  app.post('/api/investigation-platform/cases/:id/members', requireAuth, (req, res) => {
    sendResult(res, addInvestigationPlatformMember(db, req.params.id, req.body?.userId, req.user));
  });

  app.post('/api/investigation-platform/cases/:id/lift', requireAuth, (req, res) => {
    sendResult(res, liftInvestigationPlatformHold(db, req.params.id, req.body || {}, req.user));
  });

  app.post('/api/investigation-platform/cases/:id/close', requireAuth, (req, res) => {
    sendResult(res, closeInvestigationPlatformCase(db, req.params.id, req.body || {}, req.user));
  });
}
