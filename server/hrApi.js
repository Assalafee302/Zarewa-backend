/**
 * HTTP routes for Zarewa Human Resources (`/api/hr/*`).
 * @module server/hrApi
 */

import {
  acceptHrPolicy,
  adjustHrLeaveBalance,
  appendHrAuditEvent,
  approvePayrollRunByGmHr,
  approvePayrollRunByMd,
  branchManagerEndorseRequest,
  computePayrollRun,
  createHrRequest,
  createPayrollRun,
  deleteHrRequestDraft,
  exportPayrollGlJournalTemplateCsv,
  exportPayrollPayslipsCsv,
  exportPayrollStatutoryPackCsv,
  exportPayrollTreasuryPackCsv,
  generateEmploymentLetter,
  getHrDailyRollCall,
  getHrInboxSummary,
  getHrMeProfile,
  getHrStaffOne,
  getPayrollRunById,
  getPayrollRunTotals,
  gmHrReviewRequest,
  hrListScope,
  hrNextUatReadiness,
  hrReviewRequest,
  hrTablesReady,
  listEmploymentLetters,
  listHrAttendance,
  listHrCompensationInsights,
  listHrLeaveBalances,
  listHrObservability,
  listHrPublicHolidays,
  listHrRequests,
  listHrStaff,
  listHrStaffBranchHistory,
  listRecentBranchTransfers,
  listRecentDisciplinaryEvents,
  appendHrDisciplinaryEvent,
  listHrAuditEventsForStaff,
  listHrAttendanceDeductionPreview,
  listHrBranchPayrollContributions,
  listHrPayslipsForUser,
  listHrSalaryMatrix,
  listMissingHrPolicyAcceptances,
  listPayrollLines,
  listPayrollRuns,
  managerReviewRequest,
  patchHrLoanMaintenance,
  patchPayrollRun,
  putHrPublicHoliday,
  recomputeHrLeaveBalances,
  registerNewStaffWithProfile,
  salaryWelfareSnapshot,
  submitHrRequest,
  uploadHrAttendance,
  upsertHrBranchPayrollContribution,
  upsertHrDailyRollCall,
  upsertHrSalaryMatrixRow,
  upsertHrStaffProfile,
} from './hrOps.js';
import { HR_POLICY_REGISTRY } from './hrPolicy.js';
import { validateStaffLoanApplication } from './hrBusinessRules.js';
import {
  hrUserHas,
  userCanAccessHrModule,
  userCanAccessMyProfileHr,
  userCanEndorseBranchHr,
  userCanGmApproveHr,
  userCanGmApprovePayroll,
  userCanMdApprovePayroll,
  userCanMarkBranchContribution,
  userCanPayPayroll,
  userCanPreparePayroll,
  userCanReviewHrRequests,
  userCanViewOrgSensitiveHr,
} from './hrPermissions.js';
import {
  hrRedactionContextFromReq,
  redactHrRequest,
  redactPayrollLine,
  redactStaffList,
  redactStaffProfile,
} from './hrRedaction.js';
import { hrSensitiveTokenMiddleware, issueHrSensitiveToken } from './hrSensitiveGate.js';

function hrReady(res, db) {
  if (!hrTablesReady(db)) {
    res.status(503).json({ ok: false, error: 'HR module is not initialised on this database.' });
    return false;
  }
  return true;
}

/** @param {string[]} perms — any one grants access */
function requireHrAny(...perms) {
  return (req, res, next) => {
    if (hrUserHas(req.user, '*') || perms.some((p) => hrUserHas(req.user, p))) return next();
    return res.status(403).json({ ok: false, error: 'You do not have permission for this HR action.' });
  };
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerHrApi(app, db) {
  app.use('/api/hr', hrSensitiveTokenMiddleware(db));

  app.get('/api/hr/health', (_req, res) => {
    res.json({ ok: true, hrReady: hrTablesReady(db) });
  });

  app.get('/api/hr/policy-requirements', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const required = HR_POLICY_REGISTRY.map((p) => ({
        key: p.key,
        version: p.version,
        label: p.label,
      }));
      const missing = listMissingHrPolicyAcceptances(db, req.user?.id, required);
      return res.json({ ok: true, required, missing });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR policy requirements.' });
    }
  });

  app.post('/api/hr/policy-acknowledgements', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = acceptHrPolicy(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record policy acknowledgement.' });
    }
  });

  app.post('/api/hr/sensitive/verify', (req, res) => {
    try {
      const password = String(req.body?.password || '');
      const r = issueHrSensitiveToken(db, req.user?.id, password, {
        purpose: String(req.body?.purpose || 'general'),
      });
      if (!r.ok) return res.status(401).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not verify credentials.' });
    }
  });

  app.get('/api/hr/me', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: req.user?.id });
      const { user, hr } = getHrMeProfile(db, req.user?.id);
      const redactedHr = hr ? redactStaffProfile({ ...hr, userId: req.user?.id }, ctx) : null;
      return res.json({ ok: true, user, hr: redactedHr });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load your HR profile.' });
    }
  });

  app.get('/api/hr/dashboard', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const observability = listHrObservability(db, scope);
      const inbox = getHrInboxSummary(db, scope);
      const readiness = hrNextUatReadiness(db, scope);
      const staffAll = listHrStaff(db, scope, { includeInactive: true });
      const staffCounts = {
        total: staffAll.length,
        active: staffAll.filter((s) => String(s.status || '') === 'active').length,
        inactive: staffAll.filter((s) => String(s.status || '') !== 'active').length,
        incompleteProfiles: staffAll.filter((s) => (s.criticalMissing || []).length > 0).length,
      };
      const ctx = hrRedactionContextFromReq(req);
      const recentRequests = listHrRequests(db, scope, {})
        .slice(0, 12)
        .map((r) => redactHrRequest(r, { canViewSensitive: ctx.canViewSensitive, isOwner: false }));
      return res.json({
        ok: true,
        observability,
        inbox,
        readiness,
        staffCounts,
        recentRequests,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR dashboard.' });
    }
  });

  app.get('/api/hr/inbox-summary', requireHrAny('hr.directory.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, summary: getHrInboxSummary(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR inbox.' });
    }
  });

  app.get('/api/hr/staff', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      if (hrUserHas(req.user, 'hr.team.view') && !userCanAccessHrModule(req.user)) {
        scope.viewAll = false;
      }
      const includeInactive = String(req.query?.includeInactive || '') === '1';
      const staff = listHrStaff(db, scope, { includeInactive });
      const ctx = hrRedactionContextFromReq(req);
      return res.json({ ok: true, staff: redactStaffList(staff, ctx) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list staff.' });
    }
  });

  app.get('/api/hr/staff/:userId', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (!isSelf && !hrUserHas(req.user, 'hr.directory.view') && !hrUserHas(req.user, 'hr.team.view')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const row = getHrStaffOne(db, userId);
      if (!row) return res.status(404).json({ ok: false, error: 'Staff record not found.' });
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: userId });
      const branchHistory = listHrStaffBranchHistory(db, userId);
      return res.json({
        ok: true,
        staff: redactStaffProfile(row, ctx),
        branchHistory: userCanViewOrgSensitiveHr(req.user) || isSelf ? branchHistory : [],
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load staff profile.' });
    }
  });

  app.post('/api/hr/staff/register', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = registerNewStaffWithProfile(db, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not register staff.' });
    }
  });

  app.get('/api/hr/staff/:userId/audit-events', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const events = listHrAuditEventsForStaff(db, userId, 60);
      return res.json({ ok: true, events });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load audit trail.' });
    }
  });

  app.patch('/api/hr/staff/:userId', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = { ...(req.body || {}), userId: req.params.userId };
      const r = upsertHrStaffProfile(db, req.user?.id, body);
      if (!r.ok) return res.status(400).json(r);
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: req.params.userId });
      return res.json({ ok: true, profile: redactStaffProfile(r.profile, ctx) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update staff profile.' });
    }
  });

  app.get('/api/hr/branch-transfers', requireHrAny('hr.transfers.manage', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const transfers = listRecentBranchTransfers(db, scope);
      return res.json({ ok: true, transfers });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load branch transfers.' });
    }
  });

  app.get('/api/hr/disciplinary-events', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const events = listRecentDisciplinaryEvents(db, scope, { includeInactive: true });
      return res.json({ ok: true, events });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load disciplinary events.' });
    }
  });

  app.post('/api/hr/staff/:userId/disciplinary-events', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const r = appendHrDisciplinaryEvent(db, userId, req.body || {}, req.user?.id);
      if (!r.ok) return res.status(400).json(r);
      appendHrAuditEvent(db, {
        actorUserId: req.user?.id,
        action: 'hr.discipline.recorded',
        entityKind: 'hr_staff_profile',
        entityId: userId,
        details: { kind: req.body?.kind, dateIso: req.body?.dateIso },
      });
      return res.status(201).json({ ok: true, events: r.events });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record disciplinary event.' });
    }
  });

  app.get('/api/hr/requests', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scopeParam = String(req.query?.scope || 'mine').trim().toLowerCase();
      const scope = hrListScope(req);
      let filter = {
        status: req.query?.status,
        kind: req.query?.kind,
        search: req.query?.search,
      };
      if (scopeParam === 'mine') {
        filter.userId = req.user?.id;
      } else if (scopeParam === 'hr_queue') {
        if (!userCanReviewHrRequests(req.user)) {
          return res.status(403).json({ ok: false, error: 'Permission denied.' });
        }
        filter.status = filter.status || 'hr_review';
      } else if (scopeParam === 'endorse_queue') {
        if (!userCanEndorseBranchHr(req.user)) {
          return res.status(403).json({ ok: false, error: 'Permission denied.' });
        }
        filter.status = filter.status || 'branch_manager_review';
      } else if (scopeParam === 'gm_queue' || scopeParam === 'exec_queue') {
        if (!userCanGmApproveHr(req.user) && !hrUserHas(req.user, 'hr.executive.view')) {
          return res.status(403).json({ ok: false, error: 'Permission denied.' });
        }
        filter.status = filter.status || 'gm_hr_review';
      } else if (scopeParam === 'all') {
        if (!hrUserHas(req.user, 'hr.staff.manage') && !hrUserHas(req.user, 'hr.directory.view')) {
          return res.status(403).json({ ok: false, error: 'Permission denied.' });
        }
      } else {
        return res.status(400).json({ ok: false, error: 'Invalid scope.' });
      }
      const rows = listHrRequests(db, scope, filter);
      const ctxBase = hrRedactionContextFromReq(req);
      const requests = rows.map((r) => {
        const isOwner = String(r.userId) === String(req.user?.id);
        const ctx = { ...ctxBase, canViewSensitive: ctxBase.canViewSensitive || false };
        return redactHrRequest(r, { canViewSensitive: ctx.canViewSensitive, isOwner });
      });
      return res.json({ ok: true, requests });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list HR requests.' });
    }
  });

  app.post('/api/hr/requests', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const forUserId = String(req.body?.userId || req.user?.id || '').trim();
      const isSelf = forUserId === req.user?.id;
      if (!isSelf && !hrUserHas(req.user, 'hr.staff.manage')) {
        return res.status(403).json({ ok: false, error: 'You can only create requests for yourself.' });
      }
      if (String(req.body?.kind) === 'loan' && isSelf) {
        const check = validateStaffLoanApplication(db, forUserId, {
          amountNgn: Number(req.body?.loan?.amountNgn ?? req.body?.amountNgn),
          repaymentMonths: Number(req.body?.loan?.repaymentMonths ?? req.body?.repaymentMonths),
        });
        if (!check.ok) return res.status(400).json(check);
      }
      const r = createHrRequest(db, forUserId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create HR request.' });
    }
  });

  app.patch('/api/hr/requests/:requestId/submit', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = submitHrRequest(db, req.params.requestId, req.user?.id);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit request.' });
    }
  });

  app.patch('/api/hr/requests/:requestId/hr-review', requireHrAny('hr.requests.review', 'hr.requests.hr_review'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const { approve, note, reasonCode } = req.body || {};
      const r = hrReviewRequest(db, req.params.requestId, req.user, Boolean(approve), note, reasonCode);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not complete HR review.' });
    }
  });

  app.patch('/api/hr/requests/:requestId/branch-endorse', requireHrAny('hr.branch.endorse_staff', 'hr.leave.endorse'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const { approve, note, reasonCode } = req.body || {};
      const r = branchManagerEndorseRequest(db, req.params.requestId, req.user, Boolean(approve), note, reasonCode);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not complete branch endorsement.' });
    }
  });

  app.patch('/api/hr/requests/:requestId/gm-hr-review', requireHrAny('hr.requests.gm_approve', 'hr.requests.final_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const { approve, note, reasonCode } = req.body || {};
      const r = gmHrReviewRequest(db, req.params.requestId, req.user, Boolean(approve), note, reasonCode);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not complete GM HR review.' });
    }
  });

  app.patch('/api/hr/requests/:requestId/manager-review', requireHrAny('hr.branch.endorse_staff', 'hr.requests.gm_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const { approve, note, reasonCode } = req.body || {};
      const r = managerReviewRequest(db, req.params.requestId, req.user, Boolean(approve), note, reasonCode);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not complete manager review.' });
    }
  });

  app.delete('/api/hr/requests/:requestId', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = deleteHrRequestDraft(db, req.params.requestId, req.user?.id);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not delete request.' });
    }
  });

  app.get('/api/hr/attendance/uploads', requireHrAny('hr.attendance.manage', 'hr.attendance.upload', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, uploads: listHrAttendance(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list attendance uploads.' });
    }
  });

  app.post('/api/hr/attendance/uploads', requireHrAny('hr.attendance.upload', 'hr.attendance.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = uploadHrAttendance(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not upload attendance.' });
    }
  });

  app.get('/api/hr/attendance/daily-roll', requireHrAny('hr.attendance.mark', 'hr.daily_roll.mark', 'hr.attendance.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const branchId = String(req.query?.branchId || req.workspaceBranchId || '').trim();
      const dayIso = String(req.query?.dayIso || '').trim().slice(0, 10);
      const r = getHrDailyRollCall(db, hrListScope(req), branchId, dayIso);
      return res.json({ ok: true, ...r });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load daily roll call.' });
    }
  });

  app.put('/api/hr/attendance/daily-roll', requireHrAny('hr.attendance.mark', 'hr.daily_roll.mark', 'hr.attendance.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertHrDailyRollCall(db, req.user, hrListScope(req), req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save daily roll call.' });
    }
  });

  app.get(
    '/api/hr/attendance/deduction-preview',
    requireHrAny('hr.deductions.manage', 'hr.attendance.manage', 'hr.staff.manage'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        const periodYyyymm = String(req.query?.periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
        if (!/^\d{6}$/.test(periodYyyymm)) {
          return res.status(400).json({ ok: false, error: 'periodYyyymm must be YYYYMM.' });
        }
        const scope = hrListScope(req);
        const items = listHrAttendanceDeductionPreview(db, scope, periodYyyymm);
        return res.json({ ok: true, periodYyyymm, items });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not load deduction preview.' });
      }
    }
  );

  app.get('/api/hr/leave/balances', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const requestedUserId = String(req.query?.userId || '').trim();
      const canViewOthers =
        hrUserHas(req.user, 'hr.leave.manage') || hrUserHas(req.user, 'hr.staff.manage');
      if (requestedUserId && requestedUserId !== req.user?.id && !canViewOthers) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const filter = { periodYyyymm: req.query?.periodYyyymm };
      if (requestedUserId) {
        filter.userId = requestedUserId;
      } else if (!canViewOthers) {
        filter.userId = req.user?.id;
      }
      return res.json({
        ok: true,
        balances: listHrLeaveBalances(db, filter),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load leave balances.' });
    }
  });

  app.post('/api/hr/leave/balances/recompute', requireHrAny('hr.leave.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = recomputeHrLeaveBalances(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not recompute leave balances.' });
    }
  });

  app.post('/api/hr/leave/balances/adjust', requireHrAny('hr.leave.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = adjustHrLeaveBalance(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not adjust leave balance.' });
    }
  });

  app.get('/api/hr/payroll-runs', requireHrAny('hr.payroll.prepare', 'hr.payroll.manage', 'hr.payroll.view_sensitive', 'hr.payroll.pay'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const runs = listPayrollRuns(db);
      if (!userCanViewOrgSensitiveHr(req.user)) {
        return res.json({
          ok: true,
          runs: runs.map((r) => ({
            id: r.id,
            periodYyyymm: r.periodYyyymm,
            status: r.status,
            createdAtIso: r.createdAtIso,
          })),
        });
      }
      return res.json({ ok: true, runs });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list payroll runs.' });
    }
  });

  app.post('/api/hr/payroll-runs', requireHrAny('hr.payroll.prepare', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createPayrollRun(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create payroll run.' });
    }
  });

  app.get('/api/hr/payroll-runs/:runId', requireHrAny('hr.payroll.prepare', 'hr.payroll.view_sensitive', 'hr.payroll.pay'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const run = getPayrollRunById(db, req.params.runId);
      if (!run) return res.status(404).json({ ok: false, error: 'Payroll run not found.' });
      return res.json({ ok: true, run });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load payroll run.' });
    }
  });

  app.get('/api/hr/payroll-runs/:runId/lines', requireHrAny('hr.payroll.prepare', 'hr.payroll.view_sensitive', 'hr.payroll.pay'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const ctx = hrRedactionContextFromReq(req);
      const lines = listPayrollLines(db, req.params.runId).map((l) => redactPayrollLine(l, ctx));
      return res.json({ ok: true, lines });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load payroll lines.' });
    }
  });

  app.get(
    '/api/hr/payroll-runs/:runId/totals',
    requireHrAny('hr.payroll.prepare', 'hr.payroll.view_sensitive', 'hr.payroll.pay'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        const run = getPayrollRunById(db, req.params.runId);
        if (!run) return res.status(404).json({ ok: false, error: 'Payroll run not found.' });
        const ctx = hrRedactionContextFromReq(req);
        const totals = getPayrollRunTotals(db, req.params.runId);
        if (!ctx.canViewSensitive) {
          return res.json({
            ok: true,
            totals: { headcount: totals.headcount, amountsRedacted: true },
            run,
          });
        }
        return res.json({ ok: true, totals, run });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not load payroll totals.' });
      }
    }
  );

  app.post('/api/hr/payroll-runs/:runId/recompute', requireHrAny('hr.payroll.prepare', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = computePayrollRun(db, req.params.runId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not recompute payroll.' });
    }
  });

  app.patch('/api/hr/payroll-runs/:runId', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = req.body || {};
      if (body.status === 'paid' && !userCanPayPayroll(req.user)) {
        return res.status(403).json({ ok: false, error: 'Finance payroll payment permission required.' });
      }
      if (
        (body.status === 'locked' || body.taxPercent != null) &&
        !userCanPreparePayroll(req.user) &&
        !hrUserHas(req.user, '*')
      ) {
        return res.status(403).json({ ok: false, error: 'Payroll preparation permission required.' });
      }
      const r = patchPayrollRun(db, req.params.runId, body, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update payroll run.' });
    }
  });

  app.post('/api/hr/payroll-runs/:runId/gm-approve', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!userCanGmApprovePayroll(req.user)) {
        return res.status(403).json({ ok: false, error: 'GM HR payroll approval required.' });
      }
      const r = approvePayrollRunByGmHr(db, req.params.runId, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not approve payroll.' });
    }
  });

  app.post('/api/hr/payroll-runs/:runId/md-approve', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!userCanMdApprovePayroll(req.user)) {
        return res.status(403).json({ ok: false, error: 'MD payroll approval required.' });
      }
      const r = approvePayrollRunByMd(db, req.params.runId, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not approve payroll.' });
    }
  });

  const exportPayroll = (handler, filename) => (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!hrUserHas(req.user, 'hr.payroll.export') && !userCanPayPayroll(req.user)) {
        return res.status(403).json({ ok: false, error: 'Payroll export permission required.' });
      }
      const r = handler(db, req.params.runId);
      if (!r.ok) return res.status(400).json(r);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(r.csv);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Export failed.' });
    }
  };

  app.get('/api/hr/payslips', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.query?.userId || req.user?.id || '').trim();
      const isSelf = userId === req.user?.id;
      if (
        !isSelf &&
        !hrUserHas(req.user, 'hr.payroll.view_sensitive') &&
        !hrUserHas(req.user, 'hr.staff.manage')
      ) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const ctx = hrRedactionContextFromReq(req);
      const slips = listHrPayslipsForUser(db, userId).map((s) =>
        ctx.canViewSensitive || isSelf
          ? s
          : {
              ...s,
              grossNgn: null,
              netNgn: null,
              taxNgn: null,
              pensionNgn: null,
              attendanceDeductionNgn: null,
              otherDeductionNgn: null,
              amountsRedacted: true,
            }
      );
      return res.json({ ok: true, payslips: slips });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load payslips.' });
    }
  });

  app.get('/api/hr/salary-matrix', requireHrAny('hr.payroll.prepare', 'hr.staff.manage', 'hr.settings.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, matrix: listHrSalaryMatrix(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load salary matrix.' });
    }
  });

  app.put('/api/hr/salary-matrix', requireHrAny('hr.staff.manage', 'hr.settings.manage', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertHrSalaryMatrixRow(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save salary matrix row.' });
    }
  });

  app.get('/api/hr/branch-contributions', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!userCanMarkBranchContribution(req.user) && !hrUserHas(req.user, 'hr.executive.view')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const periodYyyymm = String(req.query?.periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
      if (!/^\d{6}$/.test(periodYyyymm)) {
        return res.status(400).json({ ok: false, error: 'periodYyyymm must be YYYYMM.' });
      }
      return res.json({ ok: true, periodYyyymm, contributions: listHrBranchPayrollContributions(db, periodYyyymm) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load branch contributions.' });
    }
  });

  app.put('/api/hr/branch-contributions', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!userCanMarkBranchContribution(req.user)) {
        return res.status(403).json({ ok: false, error: 'Managing Director permission required.' });
      }
      const r = upsertHrBranchPayrollContribution(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save branch contribution.' });
    }
  });

  app.get('/api/hr/payroll-runs/:runId/export/treasury', exportPayroll(exportPayrollTreasuryPackCsv, 'payroll-treasury.csv'));
  app.get('/api/hr/payroll-runs/:runId/export/payslips', exportPayroll(exportPayrollPayslipsCsv, 'payroll-payslips.csv'));
  app.get('/api/hr/payroll-runs/:runId/export/statutory', exportPayroll(exportPayrollStatutoryPackCsv, 'payroll-statutory.csv'));
  app.get('/api/hr/payroll-runs/:runId/export/gl', exportPayroll(exportPayrollGlJournalTemplateCsv, 'payroll-gl.csv'));

  app.get('/api/hr/employment-letters', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.query?.userId || req.user?.id || '').trim();
      const canOther =
        hrUserHas(req.user, 'hr.letters.generate') ||
        hrUserHas(req.user, 'hr.staff.manage') ||
        hrUserHas(req.user, 'hr.self');
      if (userId !== req.user?.id && !canOther) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      return res.json({ ok: true, letters: listEmploymentLetters(db, userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list employment letters.' });
    }
  });

  app.post('/api/hr/employment-letters/generate', requireHrAny('hr.letters.generate'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = generateEmploymentLetter(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate letter.' });
    }
  });

  app.get('/api/hr/compensation-insights', requireHrAny('hr.payroll.view_sensitive', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!userCanViewOrgSensitiveHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'Sensitive compensation data is restricted.' });
      }
      const insights = listHrCompensationInsights(db, hrListScope(req), { canViewSensitiveHr: true });
      return res.json({ ok: true, insights });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load compensation insights.' });
    }
  });

  app.get('/api/hr/salary-welfare-snapshot', requireHrAny('hr.payroll.view_sensitive', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!userCanViewOrgSensitiveHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      return res.json({ ok: true, snapshot: salaryWelfareSnapshot(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load salary snapshot.' });
    }
  });

  app.get('/api/hr/public-holidays', requireHrAny('hr.leave.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, holidays: listHrPublicHolidays(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load holidays.' });
    }
  });

  app.put('/api/hr/public-holidays', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = putHrPublicHoliday(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save holiday.' });
    }
  });

  app.patch('/api/hr/loans/:requestId', requireHrAny('hr.loan_maintain', 'hr.loans.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchHrLoanMaintenance(db, req.params.requestId, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update loan.' });
    }
  });
}
