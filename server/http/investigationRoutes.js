/**
 * Investigation register HTTP.
 * Managing Director, Head of Accounts, and Operations Manager only.
 */
import { requireAuth } from '../auth.js';
import { apiError } from '../apiError.js';
import { parseListQuery } from '../listPagination.js';
import {
  addInvestigationLink,
  addInvestigationNote,
  closeInvestigationCase,
  createInvestigationCase,
  exportInvestigationCasesCsv,
  getInvestigationCase,
  holdRefundForInvestigation,
  investigationPartyWarning,
  investigationReminders,
  listInvestigationCases,
  suspendReceiptForInvestigation,
  updateInvestigationCase,
} from '../office/investigationOps.js';
import { userMayManageInvestigations } from '../../shared/lib/investigationRegister.js';

function gate(req, res) {
  if (!userMayManageInvestigations(req.user)) {
    apiError(res, {
      status: 403,
      code: 'FORBIDDEN',
      error: 'Only the Managing Director, Head of Accounts, or Operations Manager can use the investigation register.',
    });
    return false;
  }
  return true;
}

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
export function registerInvestigationRoutes(app, db) {
  app.get('/api/investigations', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    const page = parseListQuery(req, { defaultLimit: 100, maxLimit: 500 });
    const listed = listInvestigationCases(db, {
      status: req.query.status,
      caseType: req.query.type || req.query.caseType,
      staffId: req.query.staffId,
      customerId: req.query.customerId,
      limit: page.unlimited ? 0 : page.limit,
      offset: page.offset,
    });
    res.json({ ...listed, limit: page.limit, offset: page.offset });
  });

  app.get('/api/investigations/export.csv', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    const packed = exportInvestigationCasesCsv(db, {
      status: req.query.status,
      caseType: req.query.type,
      staffId: req.query.staffId,
      customerId: req.query.customerId,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(packed.csv);
  });

  app.get('/api/investigations/reminders', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    res.json(investigationReminders(db, req.query.asOf));
  });

  app.get('/api/investigations/flags', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    res.json({
      ok: true,
      ...investigationPartyWarning(db, {
        customerId: req.query.customerId,
        staffId: req.query.staffId,
        quotationId: req.query.quotationId,
      }),
    });
  });

  app.get('/api/investigations/:id', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, getInvestigationCase(db, req.params.id));
  });

  app.post('/api/investigations', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, createInvestigationCase(db, req.body || {}, req.user));
  });

  app.patch('/api/investigations/:id', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, updateInvestigationCase(db, req.params.id, req.body || {}, req.user));
  });

  app.post('/api/investigations/:id/notes', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, addInvestigationNote(db, req.params.id, req.body?.text, req.user));
  });

  app.post('/api/investigations/:id/links', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, addInvestigationLink(db, req.params.id, req.body || {}, req.user));
  });

  app.post('/api/investigations/:id/suspend-receipt', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, suspendReceiptForInvestigation(db, req.params.id, req.body || {}, req.user));
  });

  app.post('/api/investigations/:id/hold-refund', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, holdRefundForInvestigation(db, req.params.id, req.body?.refundId, req.user));
  });

  app.post('/api/investigations/:id/close', requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    sendResult(res, closeInvestigationCase(db, req.params.id, req.body || {}, req.user));
  });
}
