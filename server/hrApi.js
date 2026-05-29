/**
 * HTTP routes for Zarewa Human Resources (`/api/hr/*`).
 * @module server/hrApi
 */

import {
  acceptHrPolicy,
  adjustHrLeaveBalance,
  applyHrSalaryIncrement,
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
  exportPayrollPayslipsPdf,
  exportSinglePayslipPdf,
  exportEmploymentLetterPdf,
  listHrAppraisalCycles,
  createHrAppraisalCycle,
  listHrAppraisalForms,
  upsertHrAppraisalForm,
  listHrFeedbackNotes,
  createHrFeedbackNote,
  exportPayrollStatutoryPackCsv,
  exportPayrollTreasuryPackCsv,
  generateEmploymentLetter,
  getHrDailyRollCall,
  getHrInboxSummary,
  getHrMeProfile,
  getHrStaffOne,
  getHrOrgChart,
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
  listHrSalaryHistory,
  listRecentBranchTransfers,
  listRecentDisciplinaryEvents,
  appendHrDisciplinaryEvent,
  listHrAuditEventsForStaff,
  listHrAttendanceDeductionPreview,
  listHrBranchPayrollContributions,
  listHrPayslipsForUser,
  listHrSalaryMatrix,
  listHrBeneficiaries,
  listHrBenefitPayments,
  listHrIncidentMemos,
  listHrLeaveCalendar,
  listHrTransferRecommendations,
  listExceptionalLoanQueue,
  listRecentOrgSalaryChanges,
  listDraftPayrollRunIds,
  getHrReportsSummary,
  upsertHrBeneficiary,
  recordHrBenefitPayment,
  createHrIncidentMemo,
  escalateHrIncidentToDiscipline,
  createHrTransferRecommendation,
  reviewHrTransferRecommendation,
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
import {
  deleteHrStaffDocument,
  getHrStaffDocumentRow,
  listHrStaffDocumentMeta,
  setHrStaffPassportPhoto,
  uploadHrStaffDocument,
} from './hrStaffDocuments.js';
import {
  getHrStaffLifecycle,
  patchHrLifecycleTask,
  patchHrStaffSeparation,
} from './hrStaffLifecycle.js';
import {
  countUnreadHrNotifications,
  listHrNotifications,
  markAllHrNotificationsRead,
  markHrNotificationRead,
} from './hrNotifications.js';
import {
  createHrApplicant,
  createHrJobPosting,
  getHrApplicantRegisterPrefill,
  getHrJobPosting,
  listHrApplicants,
  listHrJobPostings,
  patchHrApplicant,
  patchHrJobPosting,
} from './hrRecruiting.js';
import {
  createHrTrainingRecord,
  deleteHrTrainingRecord,
  listHrTrainingRecords,
} from './hrLearning.js';
import {
  createHrEngagementSurvey,
  getHrEngagementSurveySummary,
  listHrEngagementSurveys,
  listOpenSurveysForUser,
  patchHrEngagementSurvey,
  submitHrEngagementResponse,
} from './hrEngagement.js';
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
      const staffFull = getHrStaffOne(db, req.user?.id);
      const unreadNotifications = countUnreadHrNotifications(db, req.user?.id);
      return res.json({
        ok: true,
        user,
        hr: redactedHr,
        lifecycle: staffFull?.lifecycle || null,
        onboardingChecklist: staffFull?.onboardingChecklist || null,
        unreadNotifications,
      });
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

  app.get('/api/hr/org-chart', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      if (hrUserHas(req.user, 'hr.team.view') && !userCanAccessHrModule(req.user)) {
        scope.viewAll = false;
      }
      const chart = getHrOrgChart(db, scope);
      return res.json({ ok: true, chart });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load org chart.' });
    }
  });

  app.get('/api/hr/staff', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      if (hrUserHas(req.user, 'hr.team.view') && !userCanAccessHrModule(req.user)) {
        scope.viewAll = false;
      }
      if (String(req.query?.includeSalary || '') === '1' && !userCanViewOrgSensitiveHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'Sensitive compensation data is restricted.' });
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
      const body = req.body || {};
      const r = registerNewStaffWithProfile(db, req.user?.id, body);
      if (!r.ok) return res.status(400).json(r);
      const applicantId = String(body.applicantId || '').trim();
      if (applicantId && r.userId) {
        patchHrApplicant(db, applicantId, { status: 'hired', hiredUserId: r.userId });
      }
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

  app.get('/api/hr/staff/:userId/salary-history', requireHrAny('hr.staff.manage', 'hr.payroll.view_sensitive', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const history = listHrSalaryHistory(db, userId);
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: userId });
      if (!ctx.canViewSensitive) {
        return res.json({
          ok: true,
          history: history.map((h) => ({
            ...h,
            baseSalaryNgn: null,
            housingAllowanceNgn: null,
            transportAllowanceNgn: null,
            amountsRedacted: true,
          })),
        });
      }
      return res.json({ ok: true, history });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load salary history.' });
    }
  });

  app.post('/api/hr/staff/:userId/salary-increment', requireHrAny('hr.staff.manage', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const r = applyHrSalaryIncrement(db, req.user?.id, userId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: userId });
      return res.json({ ok: true, profile: redactStaffProfile(r.profile, ctx) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not apply salary increment.' });
    }
  });

  function canEditStaffFile(req, userId) {
    const uid = String(userId || '').trim();
    if (uid === req.user?.id) return userCanAccessMyProfileHr(req.user);
    return hrUserHas(req.user, 'hr.staff.manage');
  }

  app.get('/api/hr/staff/:userId/documents', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (!isSelf && !hrUserHas(req.user, 'hr.directory.view') && !hrUserHas(req.user, 'hr.team.view')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const documents = listHrStaffDocumentMeta(db, userId);
      return res.json({ ok: true, documents });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list documents.' });
    }
  });

  app.get('/api/hr/staff/:userId/documents/:docId/download', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (!isSelf && !hrUserHas(req.user, 'hr.directory.view') && !hrUserHas(req.user, 'hr.team.view')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const row = getHrStaffDocumentRow(db, userId, req.params.docId);
      if (!row) return res.status(404).json({ ok: false, error: 'Document not found.' });
      const buf = Buffer.from(String(row.data_b64 || ''), 'base64');
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name || 'document')}"`);
      return res.send(buf);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not download document.' });
    }
  });

  app.post('/api/hr/staff/:userId/documents', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!canEditStaffFile(req, userId)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = uploadHrStaffDocument(db, req.user?.id, userId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not upload document.' });
    }
  });

  app.delete('/api/hr/staff/:userId/documents/:docId', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!canEditStaffFile(req, userId)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = deleteHrStaffDocument(db, userId, req.params.docId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not delete document.' });
    }
  });

  app.patch('/api/hr/staff/:userId/passport-photo', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!canEditStaffFile(req, userId)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = setHrStaffPassportPhoto(db, req.user?.id, userId, req.body?.avatarUrl ?? null);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ok: true, user: r.user });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update passport photo.' });
    }
  });

  app.get('/api/hr/staff/:userId/lifecycle', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (
        !isSelf &&
        !hrUserHas(req.user, 'hr.directory.view') &&
        !hrUserHas(req.user, 'hr.team.view') &&
        !hrUserHas(req.user, 'hr.staff.manage')
      ) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = getHrStaffLifecycle(db, userId);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load lifecycle.' });
    }
  });

  app.patch('/api/hr/staff/:userId/lifecycle/tasks', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      const workflow = String(req.body?.workflow || '').trim();
      const taskKey = String(req.body?.taskKey || '').trim();
      const done = Boolean(req.body?.done);
      const canManage = hrUserHas(req.user, 'hr.staff.manage');
      const employeePolicyAck = isSelf && workflow === 'onboarding' && taskKey === 'policy_ack';
      if (!canManage && !employeePolicyAck) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = patchHrLifecycleTask(db, req.user, userId, workflow, taskKey, done);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update task.' });
    }
  });

  app.patch('/api/hr/staff/:userId/lifecycle/separation', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const r = patchHrStaffSeparation(db, req.user, userId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update separation.' });
    }
  });

  app.get('/api/hr/notifications', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user) && !userCanAccessHrModule(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const userId = String(req.query?.userId || req.user?.id || '').trim();
      if (userId !== req.user?.id && !hrUserHas(req.user, 'hr.staff.manage')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const unreadOnly = String(req.query?.unreadOnly || '') === '1';
      const notifications = listHrNotifications(db, userId, { unreadOnly });
      const unreadCount = countUnreadHrNotifications(db, userId);
      return res.json({ ok: true, notifications, unreadCount });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load notifications.' });
    }
  });

  app.patch('/api/hr/notifications/:notificationId/read', (req, res) => {
    try {
      const notificationId = String(req.params.notificationId || '').trim();
      const r = markHrNotificationRead(db, req.user?.id, notificationId);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ok: true, unreadCount: countUnreadHrNotifications(db, req.user?.id) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update notification.' });
    }
  });

  app.post('/api/hr/notifications/mark-all-read', (req, res) => {
    try {
      const r = markAllHrNotificationsRead(db, req.user?.id);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ok: true, unreadCount: 0 });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update notifications.' });
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

  const exportPayroll = (handler, filename, { binary = false } = {}) => (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!hrUserHas(req.user, 'hr.payroll.export') && !userCanPayPayroll(req.user)) {
        return res.status(403).json({ ok: false, error: 'Payroll export permission required.' });
      }
      const r = handler(db, req.params.runId);
      if (!r.ok) return res.status(400).json(r);
      if (binary && r.pdf) {
        res.setHeader('Content-Type', r.contentType || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${r.filename || filename}"`);
        return res.send(Buffer.from(r.pdf));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename || filename}"`);
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
  app.get(
    '/api/hr/payroll-runs/:runId/export/payslips-pdf',
    exportPayroll(exportPayrollPayslipsPdf, 'payroll-payslips.pdf', { binary: true })
  );

  app.get('/api/hr/payroll-runs/:runId/payslips/:userId/pdf', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const runId = String(req.params.runId || '').trim();
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      const run = getPayrollRunById(db, runId);
      if (!run) return res.status(404).json({ ok: false, error: 'Payroll run not found.' });
      const canHr =
        hrUserHas(req.user, 'hr.payroll.view_sensitive') ||
        hrUserHas(req.user, 'hr.staff.manage') ||
        hrUserHas(req.user, 'hr.payroll.prepare');
      if (!isSelf && !canHr) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (isSelf && !['locked', 'paid'].includes(String(run.status || ''))) {
        return res.status(403).json({ ok: false, error: 'Payslip is available after payroll is locked.' });
      }
      const r = exportSinglePayslipPdf(db, runId, userId);
      if (!r.ok) return res.status(400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename || 'payslip.pdf'}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'PDF export failed.' });
    }
  });

  app.get('/api/hr/payroll-runs/:runId/export/statutory', exportPayroll(exportPayrollStatutoryPackCsv, 'payroll-statutory.csv'));
  app.get('/api/hr/payroll-runs/:runId/export/gl', exportPayroll(exportPayrollGlJournalTemplateCsv, 'payroll-gl.csv'));

  app.get('/api/hr/appraisal-cycles', requireHrAny('hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, cycles: listHrAppraisalCycles(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load appraisal cycles.' });
    }
  });

  app.post('/api/hr/appraisal-cycles', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrAppraisalCycle(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create appraisal cycle.' });
    }
  });

  app.get('/api/hr/appraisal-cycles/:cycleId/forms', requireHrAny('hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const cycleId = String(req.params.cycleId || '').trim();
      const forms = listHrAppraisalForms(db, cycleId).map((f) => {
        let scores = null;
        if (f.scoresJson) {
          try {
            scores = JSON.parse(f.scoresJson);
          } catch {
            scores = null;
          }
        }
        return { ...f, scores };
      });
      return res.json({ ok: true, forms });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load appraisal forms.' });
    }
  });

  app.post('/api/hr/appraisal-forms', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertHrAppraisalForm(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save appraisal form.' });
    }
  });

  app.get('/api/hr/staff/:userId/feedback', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (
        !isSelf &&
        !hrUserHas(req.user, 'hr.staff.manage') &&
        !hrUserHas(req.user, 'hr.directory.view') &&
        !hrUserHas(req.user, 'hr.team.view')
      ) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      return res.json({ ok: true, notes: listHrFeedbackNotes(db, userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load feedback notes.' });
    }
  });

  app.post('/api/hr/feedback', requireHrAny('hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrFeedbackNote(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save feedback note.' });
    }
  });

  app.get('/api/hr/recruiting/jobs', requireHrAny('hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const status = String(req.query?.status || '').trim();
      return res.json({ ok: true, jobs: listHrJobPostings(db, { status }) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load jobs.' });
    }
  });

  app.post('/api/hr/recruiting/jobs', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrJobPosting(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create job.' });
    }
  });

  app.patch('/api/hr/recruiting/jobs/:jobId', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchHrJobPosting(db, req.params.jobId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update job.' });
    }
  });

  app.get('/api/hr/recruiting/jobs/:jobId/applicants', requireHrAny('hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const jobId = String(req.params.jobId || '').trim();
      if (!getHrJobPosting(db, jobId)) return res.status(404).json({ ok: false, error: 'Job not found.' });
      return res.json({ ok: true, applicants: listHrApplicants(db, jobId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load applicants.' });
    }
  });

  app.post('/api/hr/recruiting/applicants', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrApplicant(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not add applicant.' });
    }
  });

  app.patch('/api/hr/recruiting/applicants/:applicantId', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchHrApplicant(db, req.params.applicantId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update applicant.' });
    }
  });

  app.get('/api/hr/recruiting/applicants/:applicantId/prefill', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getHrApplicantRegisterPrefill(db, req.params.applicantId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load prefill.' });
    }
  });

  app.get('/api/hr/training-records', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.query?.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (
        !isSelf &&
        !hrUserHas(req.user, 'hr.staff.manage') &&
        !hrUserHas(req.user, 'hr.directory.view') &&
        !hrUserHas(req.user, 'hr.team.view')
      ) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      return res.json({ ok: true, records: listHrTrainingRecords(db, userId || req.user?.id) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load training records.' });
    }
  });

  app.post('/api/hr/training-records', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrTrainingRecord(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save training record.' });
    }
  });

  app.delete('/api/hr/training-records/:recordId', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = deleteHrTrainingRecord(db, req.params.recordId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not delete training record.' });
    }
  });

  app.get('/api/hr/engagement/surveys', requireHrAny('hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, surveys: listHrEngagementSurveys(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load surveys.' });
    }
  });

  app.post('/api/hr/engagement/surveys', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrEngagementSurvey(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create survey.' });
    }
  });

  app.patch('/api/hr/engagement/surveys/:surveyId', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchHrEngagementSurvey(db, req.params.surveyId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update survey.' });
    }
  });

  app.get('/api/hr/engagement/surveys/:surveyId/summary', requireHrAny('hr.staff.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getHrEngagementSurveySummary(db, req.params.surveyId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load survey summary.' });
    }
  });

  app.get('/api/hr/engagement/open', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, surveys: listOpenSurveysForUser(db, req.user?.id) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load surveys.' });
    }
  });

  app.post('/api/hr/engagement/responses', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!hrReady(res, db)) return;
      const r = submitHrEngagementResponse(db, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit response.' });
    }
  });

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

  app.get('/api/hr/employment-letters/:letterId/pdf', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const letterId = String(req.params.letterId || '').trim();
      const row = db.prepare(`SELECT user_id FROM hr_employment_letters WHERE id = ?`).get(letterId);
      if (!row) return res.status(404).json({ ok: false, error: 'Letter not found.' });
      const isSelf = row.user_id === req.user?.id;
      if (
        !isSelf &&
        !hrUserHas(req.user, 'hr.letters.generate') &&
        !hrUserHas(req.user, 'hr.staff.manage')
      ) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = exportEmploymentLetterPdf(db, letterId);
      if (!r.ok) return res.status(400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not export letter PDF.' });
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

  app.get('/api/hr/beneficiaries', requireHrAny('hr.benefits.manage', 'hr.staff.manage', 'hr.self'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const mineOnly = String(req.query?.mine || '') === '1';
      let rows = listHrBeneficiaries(db, scope);
      if (mineOnly) {
        rows = rows.filter((b) => b.userId === req.user?.id);
      }
      return res.json({ ok: true, beneficiaries: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load beneficiaries.' });
    }
  });

  app.put('/api/hr/beneficiaries', requireHrAny('hr.benefits.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertHrBeneficiary(db, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save beneficiary.' });
    }
  });

  app.get('/api/hr/benefit-payments', requireHrAny('hr.benefits.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const periodYyyymm = String(req.query?.periodYyyymm || '').replace(/\D/g, '').slice(0, 6);
      return res.json({ ok: true, payments: listHrBenefitPayments(db, periodYyyymm) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load benefit payments.' });
    }
  });

  app.post('/api/hr/benefit-payments', requireHrAny('hr.benefits.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = recordHrBenefitPayment(db, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record benefit payment.' });
    }
  });

  app.get('/api/hr/incident-memos', requireHrAny('hr.team.view', 'hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      if (hrUserHas(req.user, 'hr.team.view') && !userCanAccessHrModule(req.user)) {
        scope.viewAll = false;
      }
      return res.json({ ok: true, memos: listHrIncidentMemos(db, scope) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load incident memos.' });
    }
  });

  app.post('/api/hr/incident-memos', requireHrAny('hr.team.view', 'hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrIncidentMemo(db, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create incident memo.' });
    }
  });

  app.post('/api/hr/incident-memos/:memoId/escalate', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = escalateHrIncidentToDiscipline(db, req.params.memoId, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not escalate incident.' });
    }
  });

  app.get('/api/hr/transfer-recommendations', requireHrAny('hr.transfers.manage', 'hr.team.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      if (hrUserHas(req.user, 'hr.team.view') && !userCanAccessHrModule(req.user)) {
        scope.viewAll = false;
      }
      return res.json({ ok: true, recommendations: listHrTransferRecommendations(db, scope) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load transfer recommendations.' });
    }
  });

  app.post('/api/hr/transfer-recommendations', requireHrAny('hr.transfers.manage', 'hr.team.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrTransferRecommendation(db, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create transfer recommendation.' });
    }
  });

  app.patch('/api/hr/transfer-recommendations/:id', requireHrAny('hr.transfers.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = reviewHrTransferRecommendation(db, req.user?.id, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update recommendation.' });
    }
  });

  app.get('/api/hr/leave/calendar', requireHrAny('hr.team.view', 'hr.leave.manage', 'hr.directory.view', 'hr.self'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const fromIso = String(req.query?.from || '').slice(0, 10);
      const toIso = String(req.query?.to || '').slice(0, 10);
      const scope = hrListScope(req);
      if (hrUserHas(req.user, 'hr.team.view') && !userCanAccessHrModule(req.user)) {
        scope.viewAll = false;
      }
      return res.json({ ok: true, entries: listHrLeaveCalendar(db, scope, fromIso, toIso) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load leave calendar.' });
    }
  });

  app.get('/api/hr/loans/exceptional-queue', requireHrAny('hr.exceptional_loan.approve', 'hr.executive.view', 'hr.requests.gm_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = { viewAll: true, branchId: hrListScope(req).branchId };
      const ctx = hrRedactionContextFromReq(req);
      const loans = listExceptionalLoanQueue(db, scope).map((r) =>
        redactHrRequest(r, { canViewSensitive: ctx.canViewSensitive, isOwner: false })
      );
      return res.json({ ok: true, loans });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load exceptional loan queue.' });
    }
  });

  app.get('/api/hr/reports/summary', requireHrAny('hr.reports.view', 'hr.staff.manage', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, summary: getHrReportsSummary(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR reports.' });
    }
  });

  app.get('/api/hr/salary-changes/recent', requireHrAny('hr.executive.view', 'hr.payroll.view_sensitive', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const ctx = hrRedactionContextFromReq(req);
      let changes = listRecentOrgSalaryChanges(db, scope, req.query?.limit);
      if (!ctx.canViewSensitive) {
        changes = changes.map((c) => ({
          ...c,
          baseSalaryNgn: null,
          amountsRedacted: true,
        }));
      }
      return res.json({ ok: true, changes });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load salary changes.' });
    }
  });

  app.get('/api/hr/payroll-runs/drafts', requireHrAny('hr.payroll.prepare', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, runs: listDraftPayrollRunIds(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list draft payroll runs.' });
    }
  });
}
