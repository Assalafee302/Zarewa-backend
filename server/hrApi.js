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
  exportPayrollBankUploadCsv,
  exportPayrollHrApprovalCsv,
  generateEmploymentLetter,
  generateStaffLoanAgreementLetter,
  getHrDailyRollCall,
  getHrInboxSummary,
  getHrMeProfile,
  getHrStaffOne,
  getHrOrgChart,
  getPayrollRunById,
  getPayrollRunTotals,
  gmHrReviewRequest,
  hrListScope,
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
  listHrAuditEventsGlobal,
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
  listChairmanSchoolFees,
  upsertChairmanSchoolFee,
  deleteChairmanSchoolFee,
  listChairmanExpenses,
  upsertChairmanExpense,
  deleteChairmanExpense,
  listHrIdCardRequests,
  createHrIdCardRequest,
  patchHrIdCardRequest,
  getStaffSeverancePreview,
  getStaffDisciplinaryQueryCount,
  detectThreeDayNoShows,
  getAttendanceTrends,
  getChronicAbsentees,
  getLoanPortfolioAnalytics,
  getPayrollVarianceAlerts,
  getStaffTurnoverTrend,
  getHeadcountSummary,
  applyBonusToPayrollRun,
  runLeaveYearEndCarryOver,
  getHrDashboardAlerts,
} from './hrOps.js';
import {
  deleteHrStaffDocument,
  getHrStaffDocumentRow,
  listHrStaffDocumentMeta,
  setHrStaffPassportPhoto,
  uploadHrStaffDocument,
  verifyHrStaffDocument,
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
  DEFAULT_INTERVIEW_CRITERIA,
  generateOfferLetter,
  getHrApplicantRegisterPrefill,
  getHrJobPosting,
  listHrApplicants,
  listHrJobPostings,
  patchHrApplicant,
  patchHrJobPosting,
} from './hrRecruiting.js';
import { buildHrModuleBlockers, buildHrReadiness, getHrModuleHealth } from './hrModuleHealth.js';
import { lastBootPhase } from './db.js';
import { getHrTableDiagnostics } from './hrTableChecks.js';
import { mysqlConfigFromEnv } from './mysqlDatabase.js';
import {
  approvePayrollBonusRequest,
  getPayrollReconciliation,
  listPayrollBonusRequests,
  recordPayrollBankExport,
  rejectPayrollBonusRequest,
  requestPayrollBonus,
  setPayrollLineHold,
  setStaffSalaryHold,
} from './hrPayrollControl.js';
import {
  createGrievance,
  getExitInterview,
  getPromotionReadiness,
  listGrievances,
  listStaffSkills,
  patchGrievance,
  upsertExitInterview,
  upsertStaffSkill,
} from './hrGovernanceOps.js';
import {
  exportHrEngagementTrendsCsv,
  exportHrTrainingExpiryCsv,
} from './hrReportsExport.js';
import {
  exportHrReportDocument,
  getHrReportCatalog,
  LEGACY_EXPORT_KIND_MAP,
  parseReportFilters,
  previewHrReport,
} from './hrReportsHub.js';
import { getHrDashboardActionAlerts, getHrNotificationSummary, getHrOperationalReadiness } from './hrOperationalReadiness.js';
import {
  listHrDepartments,
  listHrDesignations,
  upsertHrDepartment,
  upsertHrDesignation,
  getHrDepartment,
  getHrDesignation,
} from './hrMasterData.js';
import {
  createHrTransferRequest,
  getHrTransferRequest,
  listHrTransferRequests,
  patchHrTransferRequest,
  TRANSFER_TYPES,
} from './hrTransferRequests.js';
import { decryptBankAccount } from './hrBankCrypto.js';
import { getTeamRosterSummary, resolveHrScopeMode } from './hrTeamScope.js';
import { getHrAnalyticsDashboard } from './hrAnalyticsOps.js';
import { getStaffLoanSchedule, listLoanScheduleIssues } from './hrLoanSchedule.js';
import {
  adminClearHrExit,
  approveHrOvertimeRequest,
  branchReviewHrOvertimeRequest,
  cancelHrOvertimeRequest,
  closeHrAbsenceReport,
  createHrAbsenceReport,
  createHrExitClearance,
  createHrOvertimeRequest,
  exportHrExitClearancePdf,
  financeClearHrExit,
  generateHrLetterFromTemplate,
  generateLeaveDecisionLetter,
  getHrAbsenceAlerts,
  getHrExitClearance,
  getPromotionDueReport,
  getTemporaryEmployeeAlerts,
  hrFinalClearHrExit,
  hrReviewHrOvertimeRequest,
  listHrAbsenceReports,
  listHrExitClearance,
  listHrOvertimeRequests,
  patchHrExitPropertyItem,
  rejectHrOvertimeRequest,
  reviewHrAbsenceReport,
  submitHrOvertimeRequest,
} from './hrPhase2Ops.js';
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
  if (!db) {
    console.warn('[hr] 503 DB_UNAVAILABLE — database handle missing; bootPhase=%s', lastBootPhase);
    res.status(503).json({
      ok: false,
      code: 'DB_UNAVAILABLE',
      error: 'Database connection is not available.',
      bootPhase: lastBootPhase,
      fixHint: 'Start MySQL and restart the API. Run: npm run mysql:smoke',
    });
    return false;
  }
  if (!hrTablesReady(db)) {
    const cfg = mysqlConfigFromEnv();
    const diagnostics = getHrTableDiagnostics(db);
    console.warn(
      '[hr] 503 HR_NOT_INITIALIZED — missing tables: %s; target=%s:%s/%s',
      (diagnostics.missingCore || []).join(', ') || 'unknown',
      cfg.host,
      cfg.port,
      cfg.database
    );
    res.status(503).json({
      ok: false,
      code: 'HR_NOT_INITIALIZED',
      error: 'HR module is not initialised on this database.',
      bootPhase: lastBootPhase,
      mysqlTarget: `${cfg.host}:${cfg.port}/${cfg.database}`,
      diagnostics: getHrTableDiagnostics(db),
      fixHint: 'Run npm run db:migrate then restart the server.',
    });
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
    const modules = getHrModuleHealth(db);
    const cfg = mysqlConfigFromEnv();
    res.json({
      ok: hrTablesReady(db),
      hrReady: hrTablesReady(db),
      bootPhase: lastBootPhase,
      mysqlTarget: `${cfg.host}:${cfg.port}/${cfg.database}`,
      diagnostics: getHrTableDiagnostics(db),
      modules,
      productionReady: modules.allReady,
      blockers: buildHrModuleBlockers(modules),
    });
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
      const readiness = buildHrReadiness(db, scope);
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
      let staff = redactStaffProfile(row, ctx);
      if (ctx.canViewSensitive && userCanViewOrgSensitiveHr(req.user)) {
        const bankRow = db.prepare(`SELECT bank_account_no FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
        if (bankRow?.bank_account_no) {
          staff = { ...staff, bankAccountNo: decryptBankAccount(bankRow.bank_account_no) };
          appendHrAuditEvent(db, {
            actorUserId: req.user?.id,
            action: 'hr.staff.bank_viewed',
            entityKind: 'hr_staff_profile',
            entityId: userId,
            branchId: row.branchId,
            details: { context: 'staff_profile_get' },
          });
        }
      }
      const branchHistory = listHrStaffBranchHistory(db, userId);
      return res.json({
        ok: true,
        staff,
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

  app.get('/api/hr/audit-events', requireHrAny('hr.staff.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const events = listHrAuditEventsGlobal(db, hrListScope(req), {
        limit: Number(req.query.limit) || 150,
        fromIso: req.query.fromIso,
        toIso: req.query.toIso,
        action: req.query.action,
      });
      return res.json({ ok: true, events });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR audit log.' });
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

  app.patch('/api/hr/staff/:userId/documents/:docId/verify', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const r = verifyHrStaffDocument(db, req.user?.id, userId, req.params.docId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update document verification.' });
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
      if (String(filename || '').includes('bank-upload')) {
        appendHrAuditEvent(db, {
          actorUserId: req.user?.id,
          action: 'hr.payroll.bank_export',
          entityKind: 'hr_payroll_run',
          entityId: req.params.runId,
          details: { filename: r.filename || filename },
        });
      }
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
  app.get('/api/hr/payroll-runs/:runId/export/bank-upload', exportPayroll(exportPayrollBankUploadCsv, 'bank-upload-salary.csv'));
  app.get('/api/hr/payroll-runs/:runId/export/hr-approval', exportPayroll(exportPayrollHrApprovalCsv, 'hr-approval-payroll.csv'));
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

  app.get('/api/hr/recruiting/interview-criteria', requireHrAny('hr.staff.manage', 'hr.directory.view'), (_req, res) => {
    return res.json({ ok: true, criteria: DEFAULT_INTERVIEW_CRITERIA });
  });

  app.post('/api/hr/recruiting/applicants/:applicantId/offer-letter', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = generateOfferLetter(db, req.params.applicantId, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate offer letter.' });
    }
  });

  app.get('/api/hr/reports/catalog', requireHrAny('hr.reports.view', 'hr.staff.manage', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, ...getHrReportCatalog() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load report catalog.' });
    }
  });

  app.get('/api/hr/reports/preview/:kind', requireHrAny('hr.reports.view', 'hr.staff.manage', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const ctx = hrRedactionContextFromReq(req);
      const filters = parseReportFilters(req.query || {});
      const r = previewHrReport(db, scope, req.params.kind, filters, {
        actor: req.user,
        canViewSensitive: ctx.canViewSensitive,
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Report preview failed.' });
    }
  });

  app.get('/api/hr/reports/export/:kind', requireHrAny('hr.reports.view', 'hr.staff.manage', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const kind = String(req.params.kind || '').trim();
      const format = String(req.query.format || 'csv').trim().toLowerCase();
      const scope = hrListScope(req);
      const ctx = hrRedactionContextFromReq(req);
      const filters = parseReportFilters(req.query || {});

      const legacyOnly = ['training-expiry', 'engagement-trends'];
      if (format === 'csv' && legacyOnly.includes(kind)) {
        const exporters = {
          'training-expiry': () => exportHrTrainingExpiryCsv(db, scope),
          'engagement-trends': () => exportHrEngagementTrendsCsv(db),
        };
        const r = exporters[kind]();
        if (!r.ok) return res.status(400).json(r);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
        return res.send(r.csv);
      }

      const hubId = LEGACY_EXPORT_KIND_MAP[kind] || kind;
      const r = exportHrReportDocument(db, scope, hubId, filters, format, {
        actor: req.user,
        canViewSensitive: ctx.canViewSensitive,
      });
      if (!r.ok) return res.status(400).json(r);
      res.setHeader('Content-Type', r.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      return res.send(r.body);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Export failed.' });
    }
  });

  app.get('/api/hr/operational-readiness', requireHrAny('hr.reports.view', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getHrOperationalReadiness(db, hrListScope(req));
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load operational readiness.' });
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
      const body = req.body || {};
      const r =
        body.letterKind && body.letterKind !== 'employment'
          ? generateHrLetterFromTemplate(db, req.user, body)
          : generateEmploymentLetter(db, req.user, body);
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate letter.' });
    }
  });

  app.post('/api/hr/leave-requests/:requestId/decision-letter', requireHrAny('hr.letters.generate', 'hr.leave.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = generateLeaveDecisionLetter(db, req.user, { requestId: req.params.requestId, ...req.body });
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate leave letter.' });
    }
  });

  app.post('/api/hr/loan-requests/:requestId/agreement-letter', requireHrAny('hr.letters.generate', 'hr.loans.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = generateStaffLoanAgreementLetter(db, req.user, { requestId: req.params.requestId });
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate loan agreement.' });
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

  app.get('/api/hr/notification-summary', requireHrAny('hr.*', 'hr.staff.manage', 'hr.directory.view', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, summary: getHrNotificationSummary(db, hrListScope(req), req.user) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR notification summary.' });
    }
  });

  app.get('/api/hr/team/summary', requireHrAny('hr.team.view', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const scopeMode = resolveHrScopeMode(req.user, req.query?.scope || scope.scopeMode || 'team');
      const roster = getTeamRosterSummary(db, scope, req.user, scopeMode);
      const staff = listHrStaff(db, { ...scope, scopeMode }, { includeInactive: false });
      const ctx = hrRedactionContextFromReq(req);
      const teamUserIds = new Set(staff.map((s) => s.userId));
      let pendingLeave = 0;
      try {
        pendingLeave = listHrRequests(db, scope, { kind: 'leave', status: 'submitted' }).filter((r) =>
          teamUserIds.has(r.userId)
        ).length;
      } catch {
        pendingLeave = 0;
      }
      return res.json({
        ok: true,
        scopeMode: roster.scopeMode,
        count: staff.length,
        roster: redactStaffList(staff.slice(0, 200), ctx),
        pendingLeave,
        pendingOvertime: 0,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load team summary.' });
    }
  });

  app.get('/api/hr/analytics/dashboard', requireHrAny('hr.*', 'hr.reports.view', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const canViewSensitive = userCanViewOrgSensitiveHr(req.user);
      return res.json({ ok: true, analytics: getHrAnalyticsDashboard(db, scope, { canViewSensitive }) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR analytics.' });
    }
  });

  app.get('/api/hr/staff/:userId/loan-schedule', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (!isSelf && !hrUserHas(req.user, 'hr.loans.manage') && !hrUserHas(req.user, 'hr.staff.manage')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      return res.json({ ok: true, schedule: getStaffLoanSchedule(db, userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load loan schedule.' });
    }
  });

  app.get('/api/hr/loan-schedule-issues', requireHrAny('hr.loans.manage', 'hr.payroll.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, issues: listLoanScheduleIssues(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load loan schedule issues.' });
    }
  });

  app.get('/api/hr/departments', requireHrAny('hr.settings.manage', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, departments: listHrDepartments(db, hrListScope(req), { includeInactive: req.query.all === '1' }) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load departments.' });
    }
  });

  app.put('/api/hr/departments/:id?', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = { ...req.body, id: req.params.id || req.body?.id };
      const r = upsertHrDepartment(db, body, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save department.' });
    }
  });

  app.get('/api/hr/designations', requireHrAny('hr.settings.manage', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({
        ok: true,
        designations: listHrDesignations(db, { departmentId: req.query.departmentId, includeInactive: req.query.all === '1' }),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load designations.' });
    }
  });

  app.put('/api/hr/designations/:id?', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = { ...req.body, id: req.params.id || req.body?.id };
      const r = upsertHrDesignation(db, body, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save designation.' });
    }
  });

  app.get('/api/hr/transfer-requests', requireHrAny('hr.transfers.manage', 'hr.team.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const filters = {
        userId: req.query.userId,
        status: req.query.status,
        transferType: req.query.transferType,
        pendingOnly: req.query.pending === '1',
      };
      return res.json({ ok: true, transfers: listHrTransferRequests(db, scope, filters), transferTypes: TRANSFER_TYPES });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load transfer requests.' });
    }
  });

  app.post('/api/hr/transfer-requests', requireHrAny('hr.transfers.manage', 'hr.team.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrTransferRequest(db, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create transfer request.' });
    }
  });

  app.patch('/api/hr/transfer-requests/:id', requireHrAny('hr.transfers.manage', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchHrTransferRequest(db, req.params.id, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update transfer request.' });
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

  // ── Chairman School Fees ──────────────────────────
  app.get('/api/hr/chairman/school-fees', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; return res.json({ok:true,fees:listChairmanSchoolFees(db)}); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to load school fees.'});}
  });
  app.post('/api/hr/chairman/school-fees', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; const r=upsertChairmanSchoolFee(db,req.user,req.body||{}); return res.status(201).json(r); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to save school fee.'});}
  });
  app.put('/api/hr/chairman/school-fees/:id', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; const r=upsertChairmanSchoolFee(db,req.user,{...req.body,id:req.params.id}); return res.json(r); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to update school fee.'});}
  });
  app.delete('/api/hr/chairman/school-fees/:id', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; deleteChairmanSchoolFee(db,req.params.id); return res.json({ok:true}); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to delete.'});}
  });

  // ── Chairman Expenses ────────────────────────────
  app.get('/api/hr/chairman/expenses', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; return res.json({ok:true,expenses:listChairmanExpenses(db,req.query.period||null)}); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to load expenses.'});}
  });
  app.post('/api/hr/chairman/expenses', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; const r=upsertChairmanExpense(db,req.user,req.body||{}); return res.status(201).json(r); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to save expense.'});}
  });
  app.put('/api/hr/chairman/expenses/:id', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; const r=upsertChairmanExpense(db,req.user,{...req.body,id:req.params.id}); return res.json(r); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to update expense.'});}
  });
  app.delete('/api/hr/chairman/expenses/:id', requireHrAny('hr.*','hr.chairman.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; deleteChairmanExpense(db,req.params.id); return res.json({ok:true}); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to delete.'});}
  });

  // ── ID Cards ─────────────────────────────────────
  app.get('/api/hr/id-cards', (req,res) => {
    try { if(!hrReady(res,db)) return; const userId = userCanAccessHrModule(req.user) ? (req.query.userId||null) : req.user?.id; return res.json({ok:true,requests:listHrIdCardRequests(db,userId)}); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to load ID card requests.'});}
  });
  app.post('/api/hr/id-cards', (req,res) => {
    try { if(!hrReady(res,db)) return; const r=createHrIdCardRequest(db,req.user,req.body||{}); return res.status(201).json(r); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to create ID card request.'});}
  });
  app.patch('/api/hr/id-cards/:id', requireHrAny('hr.*','hr.staff.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; const r=patchHrIdCardRequest(db,req.user,req.params.id,req.body||{}); if(!r.ok) return res.status(404).json(r); return res.json(r); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to update ID card request.'});}
  });

  app.get('/api/hr/staff/:userId/severance-preview', requireHrAny('hr.*', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getStaffSeverancePreview(db, req.params.userId);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not calculate severance.' });
    }
  });

  app.get('/api/hr/staff/:userId/disciplinary-summary', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, ...getStaffDisciplinaryQueryCount(db, req.params.userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load disciplinary summary.' });
    }
  });

  app.get('/api/hr/attendance/no-show-alerts', requireHrAny('hr.*', 'hr.attendance.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const flagged = detectThreeDayNoShows(db, req.query.branchId || null);
      return res.json({ ok: true, flagged });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not check no-show alerts.' });
    }
  });

  // ── Analytics ─────────────────────────────────────

  app.get('/api/hr/analytics/attendance-trends', requireHrAny('hr.*', 'hr.attendance.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const trends = getAttendanceTrends(db, req.query.branchId || null, Number(req.query.months) || 6);
      const chronic = getChronicAbsentees(db, req.query.branchId || null, Number(req.query.threshold) || 5);
      return res.json({ ok: true, trends, chronicAbsentees: chronic });
    } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'Could not load attendance analytics.' }); }
  });

  app.get('/api/hr/analytics/loan-portfolio', requireHrAny('hr.*', 'hr.loans.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, ...getLoanPortfolioAnalytics(db) });
    } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'Could not load loan portfolio.' }); }
  });

  app.get('/api/hr/payroll-runs/:runId/variance-alerts', requireHrAny('hr.*', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, ...getPayrollVarianceAlerts(db, req.params.runId, req.query.threshold) });
    } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'Could not run variance check.' }); }
  });

  app.get('/api/hr/analytics/turnover-trend', requireHrAny('hr.*', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, trend: getStaffTurnoverTrend(db, Number(req.query.months) || 12) });
    } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'Could not load turnover trend.' }); }
  });

  app.get('/api/hr/analytics/headcount', requireHrAny('hr.*', 'hr.reports.view', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, ...getHeadcountSummary(db) });
    } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'Could not load headcount.' }); }
  });

  // ── Phase 10: Bonus, Leave Carry-Over, Dashboard Alerts ───────────────────

  app.post('/api/hr/payroll-runs/:runId/apply-bonus', requireHrAny('hr.*', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = applyBonusToPayrollRun(db, req.params.runId, req.body?.bonusType || 'half_month', req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not apply bonus.' });
    }
  });

  app.post('/api/hr/leave/year-end-carryover', requireHrAny('hr.*', 'hr.leave.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const year = Number(req.body?.year) || new Date().getFullYear();
      const r = runLeaveYearEndCarryOver(db, req.user, year);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not run year-end carry-over.' });
    }
  });

  app.get('/api/hr/dashboard/alerts', requireHrAny('hr.*', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const base = getHrDashboardAlerts(db);
      const temp = getTemporaryEmployeeAlerts(db, scope);
      const absence = getHrAbsenceAlerts(db, scope);
      const actionAlerts = getHrDashboardActionAlerts(db, scope);
      return res.json({
        ok: true,
        ...base,
        temporaryEmployees: [
          ...(temp.missingContractEnd || []),
          ...(temp.contractEndingSoon || []),
          ...(temp.exceedsSixMonths || []),
          ...(temp.pastContractEnd || []),
        ],
        temporaryEmployeeAlerts: temp,
        absenceAlerts: absence,
        voluntaryTerminationRisk: absence.voluntaryTerminationRisk || [],
        actionAlerts,
        absenceAwaitingReview: actionAlerts.absenceAwaitingReview,
        overtimeAwaitingApproval: actionAlerts.overtimeAwaitingApproval,
        exitClearancePending: actionAlerts.exitClearancePending,
        promotionDue: actionAlerts.promotionDue,
        missingPolicyAck: actionAlerts.missingPolicyAck,
        expiredDocuments: actionAlerts.expiredDocuments,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load dashboard alerts.' });
    }
  });

  // ── Phase 2: Absence reports ─────────────────────
  app.get('/api/hr/absence-reports', requireHrAny('hr.absence.view', 'hr.absence.manage', 'hr.absence.review', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const filters = {
        userId: req.query.userId,
        status: req.query.status,
        absenceType: req.query.absenceType,
        fromIso: req.query.fromIso,
        toIso: req.query.toIso,
      };
      return res.json({ ok: true, reports: listHrAbsenceReports(db, scope, filters) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load absence reports.' });
    }
  });

  app.get('/api/hr/absence-reports/alerts', requireHrAny('hr.absence.review', 'hr.absence.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, alerts: getHrAbsenceAlerts(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load absence alerts.' });
    }
  });

  app.post('/api/hr/absence-reports', requireHrAny('hr.absence.manage', 'hr.self'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = req.body || {};
      if (!hrUserHas(req.user, 'hr.absence.manage') && body.userId && body.userId !== req.user?.id) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = createHrAbsenceReport(db, req.user, body);
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create absence report.' });
    }
  });

  app.patch('/api/hr/absence-reports/:id/review', requireHrAny('hr.absence.review', 'hr.absence.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = reviewHrAbsenceReport(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not review absence report.' });
    }
  });

  app.patch('/api/hr/absence-reports/:id/close', requireHrAny('hr.absence.manage', 'hr.absence.review'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = closeHrAbsenceReport(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not close absence report.' });
    }
  });

  // ── Phase 2: Overtime ────────────────────────────
  app.get('/api/hr/overtime-requests', requireHrAny('hr.overtime.view', 'hr.overtime.request', 'hr.overtime.review', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const filters = { userId: req.query.userId, status: req.query.status, fromIso: req.query.fromIso, toIso: req.query.toIso };
      return res.json({ ok: true, requests: listHrOvertimeRequests(db, hrListScope(req), filters) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load overtime requests.' });
    }
  });

  app.post('/api/hr/overtime-requests', requireHrAny('hr.overtime.request', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrOvertimeRequest(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create overtime request.' });
    }
  });

  app.patch('/api/hr/overtime-requests/:id/submit', requireHrAny('hr.overtime.request'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = submitHrOvertimeRequest(db, req.user, req.params.id);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit overtime request.' });
    }
  });

  app.patch('/api/hr/overtime-requests/:id/branch-review', requireHrAny('hr.overtime.review', 'hr.branch.endorse_staff'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = branchReviewHrOvertimeRequest(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not review overtime request.' });
    }
  });

  app.patch('/api/hr/overtime-requests/:id/hr-review', requireHrAny('hr.overtime.review', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = hrReviewHrOvertimeRequest(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not HR-review overtime request.' });
    }
  });

  app.patch('/api/hr/overtime-requests/:id/approve', requireHrAny('hr.overtime.approve', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = approveHrOvertimeRequest(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not approve overtime request.' });
    }
  });

  app.patch('/api/hr/overtime-requests/:id/reject', requireHrAny('hr.overtime.approve', 'hr.overtime.review'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = rejectHrOvertimeRequest(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not reject overtime request.' });
    }
  });

  app.patch('/api/hr/overtime-requests/:id/cancel', requireHrAny('hr.overtime.request', 'hr.overtime.review'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = cancelHrOvertimeRequest(db, req.user, req.params.id);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not cancel overtime request.' });
    }
  });

  // ── Phase 2: Exit clearance ──────────────────────
  app.get('/api/hr/exit-clearance', requireHrAny('hr.exit.view', 'hr.exit.initiate', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const filters = { userId: req.query.userId, status: req.query.status };
      return res.json({ ok: true, clearances: listHrExitClearance(db, hrListScope(req), filters) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load exit clearance.' });
    }
  });

  app.post('/api/hr/exit-clearance', requireHrAny('hr.exit.initiate', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrExitClearance(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not initiate exit clearance.' });
    }
  });

  app.get('/api/hr/exit-clearance/:id', requireHrAny('hr.exit.view', 'hr.exit.initiate', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getHrExitClearance(db, req.params.id);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load exit clearance.' });
    }
  });

  app.post('/api/hr/exit-clearance/:id/items', requireHrAny('hr.exit.initiate', 'hr.exit.admin_clear', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = addHrExitPropertyItem(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not add property item.' });
    }
  });

  app.patch('/api/hr/exit-clearance/:id/items/:itemId', requireHrAny('hr.exit.admin_clear', 'hr.exit.initiate', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchHrExitPropertyItem(db, req.user, req.params.id, req.params.itemId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update property item.' });
    }
  });

  app.patch('/api/hr/exit-clearance/:id/finance-clear', requireHrAny('hr.exit.finance_clear', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = financeClearHrExit(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not finance-clear exit.' });
    }
  });

  app.patch('/api/hr/exit-clearance/:id/admin-clear', requireHrAny('hr.exit.admin_clear', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = adminClearHrExit(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not admin-clear exit.' });
    }
  });

  app.patch('/api/hr/exit-clearance/:id/hr-final-clear', requireHrAny('hr.exit.final_clear', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = hrFinalClearHrExit(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not complete HR final clearance.' });
    }
  });

  app.get('/api/hr/exit-clearance/:id/pdf', requireHrAny('hr.exit.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = exportHrExitClearancePdf(db, req.params.id);
      if (!r.ok) return res.status(400).json(r);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      return res.send(r.pdf);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not export exit clearance PDF.' });
    }
  });

  // ── Phase 2: Temp staff & promotion due ─────────
  app.get('/api/hr/staff/temporary-alerts', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, alerts: getTemporaryEmployeeAlerts(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load temporary employee alerts.' });
    }
  });

  app.get('/api/hr/reports/promotion-due', requireHrAny('hr.reports.view', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const dueOnly = req.query.dueOnly === '1' || req.query.dueOnly === 'true';
      return res.json({ ok: true, rows: getPromotionDueReport(db, hrListScope(req), { dueOnly }) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load promotion due report.' });
    }
  });

  // ── Phase 6: Payroll control ─────────────────────
  app.get('/api/hr/payroll-runs/:runId/reconciliation', requireHrAny('hr.*', 'hr.payroll.manage', 'hr.payroll.view_sensitive'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getPayrollReconciliation(db, req.params.runId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load payroll reconciliation.' });
    }
  });

  app.post('/api/hr/payroll-runs/:runId/bank-export-record', requireHrAny('hr.*', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = recordPayrollBankExport(db, req.params.runId, req.body?.totalNgn, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record bank export.' });
    }
  });

  app.patch('/api/hr/payroll-runs/:runId/lines/:userId/hold', requireHrAny('hr.*', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = setPayrollLineHold(db, req.params.runId, req.params.userId, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update payroll hold.' });
    }
  });

  app.patch('/api/hr/staff/:userId/salary-hold', requireHrAny('hr.*', 'hr.payroll.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = setStaffSalaryHold(db, req.params.userId, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update salary hold.' });
    }
  });

  app.get('/api/hr/payroll-runs/:runId/bonus-requests', requireHrAny('hr.*', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, requests: listPayrollBonusRequests(db, req.params.runId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load bonus requests.' });
    }
  });

  app.post('/api/hr/payroll-runs/:runId/bonus-requests', requireHrAny('hr.*', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = requestPayrollBonus(db, req.params.runId, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not request bonus.' });
    }
  });

  app.post('/api/hr/bonus-requests/:id/approve', requireHrAny('hr.*', 'hr.payroll.gm_approve', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = approvePayrollBonusRequest(db, req.params.id, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not approve bonus.' });
    }
  });

  app.post('/api/hr/bonus-requests/:id/reject', requireHrAny('hr.*', 'hr.payroll.gm_approve', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = rejectPayrollBonusRequest(db, req.params.id, req.body?.reason, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not reject bonus.' });
    }
  });

  // ── Phase 6: Skills, grievances, exit interviews ─
  app.get('/api/hr/staff/:userId/skills', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, skills: listStaffSkills(db, req.params.userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load skills.' });
    }
  });

  app.put('/api/hr/staff/:userId/skills', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertStaffSkill(db, req.params.userId, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save skill.' });
    }
  });

  app.get('/api/hr/staff/:userId/promotion-readiness', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getPromotionReadiness(db, req.params.userId);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load promotion readiness.' });
    }
  });

  app.get('/api/hr/grievances', requireHrAny('hr.staff.manage', 'hr.discipline.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, grievances: listGrievances(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load grievances.' });
    }
  });

  app.post('/api/hr/grievances', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createGrievance(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit grievance.' });
    }
  });

  app.patch('/api/hr/grievances/:id', requireHrAny('hr.staff.manage', 'hr.discipline.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchGrievance(db, req.params.id, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update grievance.' });
    }
  });

  app.get('/api/hr/exit-clearance/:id/interview', requireHrAny('hr.exit.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const interview = getExitInterview(db, req.params.id);
      return res.json({ ok: true, interview });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load exit interview.' });
    }
  });

  app.put('/api/hr/exit-clearance/:id/interview', requireHrAny('hr.exit.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertExitInterview(db, req.params.id, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save exit interview.' });
    }
  });
}
