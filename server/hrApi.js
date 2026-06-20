/**
 * HTTP routes for Zarewa Human Resources (`/api/hr/*`).
 * @module server/hrApi
 */

import {
  acceptHrPolicy,
  acceptHrPoliciesBatch,
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
  listHrAppraisalCycles,
  createHrAppraisalCycle,
  listHrAppraisalForms,
  upsertHrAppraisalForm,
  listHrFeedbackNotes,
  createHrFeedbackNote,
  exportPayrollStatutoryPackCsv,
  exportPayrollTreasuryPackCsv,
  exportPayrollBankUploadCsv,
  exportPayrollApprovalReportPdf,
  exportPayrollHrApprovalCsv,
  listPayrollRunsForFinance,
  listPayrollMissingBankStaff,
  patchPayrollLineAdjustments,
  generateStaffLoanAgreementLetter,
  getHrDailyRollCall,
  getHrAttendanceSummaryForUser,
  getHrInboxSummary,
  listHrProfileWorkQueue,
  getHrMeProfile,
  updateMyHrStaffProfile,
  submitMyHrStaffProfile,
  verifyHrStaffProfile,
  unlockHrStaffProfile,
  getHrMeSchoolProfile,
  getHrMeScholarshipSummary,
  getHrMeDomesticSummary,
  exportScholarshipPaymentStatementPdf,
  exportDomesticPaymentStatementPdf,
  exportDomesticPaymentStatementPdfByProfileId,
  getHrStaffOne,
  getHrOrgChart,
  getPayrollRunById,
  getPayrollRunTotals,
  gmHrReviewRequest,
  hrListScope,
  hrReviewRequest,
  hrTablesReady,
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
  hasHrPolicyAcceptance,
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
  deleteHrSalaryMatrixRow,
  upsertHrStaffProfile,
  seedDemoMultiRoleProfile,
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
  getPayrollMissingPayeStaff,
  getHrPolicyConfig,
  patchHrPolicyConfig,
  getStaffTurnoverTrend,
  getHeadcountSummary,
  applyBonusToPayrollRun,
  runLeaveYearEndCarryOver,
  getHrDashboardAlerts,
  previewHrMatrixCompensation,
} from './hrOps.js';
import {
  COMPENSATION_VARIANCE_TYPES,
  applyBulkMatrixRevisionToProfiles,
  listHrSalaryVarianceReport,
} from './hrCompensationOps.js';
import { getZarewaOrgCatalogMeta, seedZarewaOrgStandard } from './hrOrgSeed.js';
import {
  backfillLegacyPayAdditions,
  findStaffCoveringOffice,
  recommendAppRoleKeys,
} from './hrOrgStaffOps.js';
import {
  deleteHrStaffDocument,
  getHrStaffDocumentRow,
  listHrStaffDocumentMeta,
  setHrStaffPassportPhoto,
  uploadHrStaffDocument,
  verifyHrStaffDocument,
} from './hrStaffDocuments.js';
import { exportStaffRegistrationFormPdf, exportBlankStaffRegistrationFormPdf } from './hrStaffFormPdf.js';
import {
  getHrStaffLifecycle,
  patchHrLifecycleTask,
  patchHrStaffSeparation,
} from './hrStaffLifecycle.js';
import {
  countUnreadHrNotifications,
  createHrNotification,
  listHrNotifications,
  markAllHrNotificationsRead,
  markHrNotificationRead,
  syncScholarshipDueReminders,
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
  deleteHrDesignation,
  deleteHrDepartment,
} from './hrMasterData.js';
import { getDesignationTenureEligibility, getStaffTenureSummary } from './hrTenureOps.js';
import {
  createHrTransferRequest,
  listHrTransferRequests,
  patchHrTransferRequest,
  TRANSFER_TYPES,
} from './hrTransferRequests.js';
import { decryptBankAccount } from './hrBankCrypto.js';
import { getTeamRosterSummary, resolveHrScopeMode } from './hrTeamScope.js';
import { countOpenIncidents } from './hrAccountabilityOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { getHrAnalyticsDashboard } from './hrAnalyticsOps.js';
import { getStaffLoanSchedule, listLoanScheduleIssues } from './hrLoanSchedule.js';
import {
  actorMayManageObligations,
  getStaffObligationAccountDetail,
  listStaffObligationAccounts,
  migrateLegacyStaffLoan,
  recordObligationCashRepayment,
  staffObligationTablesReady,
  OBLIGATION_KIND,
} from './staffObligationOps.js';
import {
  computeStaffPurchaseCreditEligibility,
  ensureStaffSalesCustomer,
  bulkEnsureStaffSalesCustomers,
} from './staffPurchaseCreditOps.js';
import { backfillRecoveryObligationsFromSchedules } from './staffRecoveryObligationOps.js';
import {
  listStaffRecoveriesDueForCashier,
  recordStaffRecoveryCashierPayment,
  enrichRecoveryObligationsForDisplay,
} from './staffRecoveryCashierOps.js';
import {
  buildObligationAccountStatementPdf,
  buildObligationDisbursementVoucherPdf,
  buildObligationRepaymentReceiptPdf,
} from './staffObligationPdf.js';
import {
  addHrExitPropertyItem,
  adminClearHrExit,
  closeHrAbsenceReport,
  createHrAbsenceReport,
  createHrExitClearance,
  exportHrExitClearancePdf,
  financeClearHrExit,
  generateLeaveDecisionLetter,
  getHrAbsenceAlerts,
  getHrExitClearance,
  getPromotionDueReport,
  getTemporaryEmployeeAlerts,
  hrFinalClearHrExit,
  listHrAbsenceReports,
  listHrExitClearance,
  patchHrExitPropertyItem,
  reviewHrAbsenceReport,
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
import { HR_POLICY_REGISTRY, requiredHrPoliciesFor, joiningHrPolicies } from './hrPolicy.js';
import { HR_POLICY_CONTENT, HR_GUARANTOR_FORM_TEMPLATE } from '../shared/lib/hrPolicyContent.js';
import { getHrPolicyPayload, annualLeaveEntitlementDaysForUser } from './hrBusinessRules.js';
import { getHrPolicyReference } from './hrPolicyConstants.js';
import { validateStaffLoanApplication } from './hrBusinessRules.js';
import {
  applyStaffRenumbering,
  getStaffNumberConfig,
  listStaffWithoutEmployeeNo,
  previewStaffRenumbering,
  saveStaffNumberConfig,
} from './hrStaffNumbering.js';
import { previewSampleEmployeeNumber } from '../shared/lib/hrEmployeeNumber.js';
import {
  buildBulkImportTemplateXlsx,
  commitBulkStaffImport,
  listBulkImportRuns,
  previewBulkStaffImport,
} from './hrStaffBulkImport.js';
import { cleanupHrStaffDuplicates, scanHrStaffDuplicates } from './hrStaffDuplicateCleanup.js';
import {
  approveExecutivePayment,
  buildExecutiveBeneficiaryBankExport,
  deleteChairmanExpenseMapped,
  deleteExecutiveSchoolFee,
  getExecutiveBenefitsDashboard,
  getExecutiveBenefitsPayrollForStaff,
  getExecutiveDomesticDashboard,
  getExecutiveFamilyDashboard,
  getExecutivePayment,
  listChairmanExpensesMapped,
  listDomesticStaffProfiles,
  listExecutiveBeneficiaries,
  listExecutivePayments,
  listExecutiveSchoolFees,
  listExecutiveStipends,
  markExecutivePaymentPaid,
  rejectExecutivePayment,
  submitExecutiveSchoolFee,
  upsertChairmanExpenseMapped,
  upsertDomesticStaffProfile,
  upsertExecutiveBeneficiary,
  upsertExecutiveSchoolFee,
  upsertExecutiveStipend,
} from './hrExecutiveBenefitsOps.js';
import {
  createDraftLetter,
  exportLetterPreviewPdf,
  exportOfficialLetterDocx,
  exportOfficialLetterPdf,
  getLetterReferenceConfig,
  gmReviewLetter,
  hrReviewLetter,
  issueLetter,
  listEmploymentLettersDetailed,
  mdApproveLetter,
  previewNextLetterReferences,
  recordLetterPrint,
  rejectLetter,
  resetLetterReferencesForLiveUse,
  saveLetterReferenceConfig,
  submitLetter,
} from './hrLetterWorkflowOps.js';
import {
  addDisciplineCaseEvidence,
  addDisciplineCaseWitness,
  appendDisciplineCaseEvent,
  createDisciplineCase,
  fileDisciplineCaseAppeal,
  generateDisciplineCaseLetter,
  getDisciplineCase,
  getDisciplineCaseAudit,
  getDisciplineCaseDashboard,
  listDisciplineCases,
  patchDisciplineCase,
  staffDisciplinePayrollBlocks,
  applyDecisionActions,
  upsertCaseResponsibility,
  listCaseResponsibility,
  deleteCaseResponsibilityParty,
  assertCaseClosureReady,
} from './hrDisciplineCasesOps.js';
import { createIncident, escalateIncidentMemo, getIncident, listIncidents, listPerformanceRecognitions } from './incidentOps.js';
import { buildIncidentAuditPack, exportIncidentAuditPackPdf } from './incidentAuditPackOps.js';
import {
  cancelRecoverySchedule,
  createRecoverySchedulesFromCase,
  listRecoverySchedulesForCase,
  listRecoverySchedulesForUser,
  recordRecoverySettlement,
} from './hrIncidentRecoveryOps.js';
import {
  listAssetCustodyTimeline,
  listGatePassEvents,
  recordAssetCustodyEvent,
  recordGatePassEvent,
} from './assetCustodyOps.js';
import {
  hrUserHas,
  userCanAccessHrModule,
  userCanAccessMainHrWorkspace,
  userCanAccessTeamHr,
  userCanViewExecutiveBenefits,
  userCanManageExecutiveBenefits,
  userCanEditPensionPolicyRates,
  userCanAccessMyProfileHr,
  hrApiPathAllowedWithoutMainWorkspace,
  hrApiPathForRequest,
  userCanAccessScholarshipDomesticExecutive,
  userCanViewScholarshipDomesticRegisters,
  userCanManageScholarshipDomesticRegisters,
  staffUserIsScholarshipOrDomestic,
  userHasHrSelfServiceOnly,
  userCanEndorseBranchHr,
  userCanGmApproveHr,
  userCanGmApprovePayroll,
  userCanMarkBranchContribution,
  userCanMdApprovePayroll,
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
import { hrSensitiveTokenMiddleware, issueHrSensitiveToken, setHrSensitiveCookie, clearHrSensitiveCookie } from './hrSensitiveGate.js';
import { assertStaffUserIdInHrScope } from './hrStaffScope.js';

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

function assertHrPolicyGate(db, userId, actionKey) {
  const required = requiredHrPoliciesFor(actionKey);
  const missing = listMissingHrPolicyAcceptances(db, userId, required);
  if (missing.length) {
    return {
      ok: false,
      error: 'Complete required policy acknowledgements before this action.',
      code: 'POLICY_ACK_REQUIRED',
      missing,
    };
  }
  return { ok: true };
}

function requireMainHrWorkspace(req, res, next) {
  if (userCanAccessMainHrWorkspace(req.user)) return next();
  const team = userCanAccessTeamHr(req.user);
  return res.status(403).json({
    ok: false,
    code: 'HR_WORKSPACE_DENIED',
    error: team
      ? 'Access restricted. Use Management / Team workspace for branch HR actions.'
      : 'Access restricted. Use My Profile for self-service HR.',
  });
}

function requireExecutiveBenefitsView(req, res, next) {
  if (userCanViewExecutiveBenefits(req.user)) return next();
  return res.status(403).json({ ok: false, error: 'Executive benefits access restricted.' });
}

function requireExecutiveBenefitsManage(req, res, next) {
  if (userCanManageExecutiveBenefits(req.user)) return next();
  return res.status(403).json({ ok: false, error: 'You cannot manage executive benefits.' });
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

  app.use('/api/hr', (req, res, next) => {
    const apiPath = hrApiPathForRequest(req);
    if (apiPath === '/api/hr/health' || req.path === '/health') return next();
    if (userCanAccessMainHrWorkspace(req.user)) return next();
    const team = userCanAccessTeamHr(req.user);
    const self = userCanAccessMyProfileHr(req.user);
    const execScholarship =
      userCanAccessScholarshipDomesticExecutive(req.user) && !userCanAccessMainHrWorkspace(req.user);
    if (!team && !self && !execScholarship) {
      return res.status(403).json({
        ok: false,
        code: 'HR_WORKSPACE_DENIED',
        error: 'Access restricted. Use My Profile for self-service HR.',
      });
    }
    if (
      hrApiPathAllowedWithoutMainWorkspace(apiPath, {
        teamUser: team,
        selfUser: self && !team,
        executiveScholarshipDomesticUser: execScholarship,
      })
    ) {
      return next();
    }
    return res.status(403).json({
      ok: false,
      code: 'HR_WORKSPACE_DENIED',
      error: team
        ? 'Access restricted. Use Management / Team workspace for branch HR actions.'
        : 'Access restricted. Use My Profile for self-service HR.',
    });
  });

  /** @returns {boolean} false when response already sent */
  function staffScopeGate(req, res, userId) {
    const uid = String(userId || '').trim();
    if (!uid) {
      res.status(400).json({ ok: false, error: 'User ID required.' });
      return false;
    }
    if (uid === String(req.user?.id || '').trim()) return true;
    const scope = hrListScope(req);
    if (
      userCanAccessScholarshipDomesticExecutive(req.user) &&
      !userCanAccessMainHrWorkspace(req.user) &&
      staffUserIsScholarshipOrDomestic(db, uid)
    ) {
      scope.viewAll = true;
    }
    const gate = assertStaffUserIdInHrScope(db, scope, uid);
    if (!gate.ok) {
      res.status(gate.status || 403).json(gate);
      return false;
    }
    if (
      userCanAccessScholarshipDomesticExecutive(req.user) &&
      !userCanAccessMainHrWorkspace(req.user) &&
      !staffUserIsScholarshipOrDomestic(db, uid)
    ) {
      res.status(403).json({
        ok: false,
        code: 'FORBIDDEN',
        error: 'Access restricted to scholarship beneficiaries and domestic staff.',
      });
      return false;
    }
    return true;
  }

  /** @returns {boolean} */
  function canViewStaffRecord(req, userId) {
    const uid = String(userId || '').trim();
    if (!uid) return false;
    if (uid === String(req.user?.id || '').trim()) return true;
    if (hrUserHas(req.user, 'hr.directory.view') || hrUserHas(req.user, 'hr.team.view')) return true;
    return (
      userCanViewScholarshipDomesticRegisters(req.user) && staffUserIsScholarshipOrDomestic(db, uid)
    );
  }

  app.get('/api/hr/health', (req, res) => {
    if (!req.user?.id) {
      return res.status(401).json({ ok: false, error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }
    const modules = getHrModuleHealth(db);
    const detailed =
      String(req.user?.roleKey || '').toLowerCase() === 'admin' ||
      (Array.isArray(req.user?.permissions) &&
        (req.user.permissions.includes('*') || req.user.permissions.includes('settings.view')));
    if (!detailed) {
      return res.json({ ok: hrTablesReady(db), hrReady: hrTablesReady(db) });
    }
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
      const uid = req.user?.id;
      const joining = joiningHrPolicies();
      const required = joining.map((p) => {
        const reg = HR_POLICY_REGISTRY.find((r) => r.key === p.key) || {};
        const content = HR_POLICY_CONTENT[p.key] || {};
        const accepted = uid ? hasHrPolicyAcceptance(db, uid, p.key, p.version) : false;
        let signedAtIso = null;
        if (accepted && uid) {
          const row = db
            .prepare(
              `SELECT accepted_at_iso FROM hr_policy_acknowledgements
               WHERE user_id = ? AND policy_key = ? AND policy_version = ? ORDER BY accepted_at_iso DESC LIMIT 1`
            )
            .get(uid, p.key, p.version);
          signedAtIso = row?.accepted_at_iso || null;
        }
        return {
          key: p.key,
          version: p.version,
          label: p.label,
          description: reg.description || content.summary || null,
          summary: content.summary || null,
          body: content.body || null,
          accepted,
          signedAtIso,
        };
      });
      const missing = listMissingHrPolicyAcceptances(db, uid, required);
      return res.json({ ok: true, required, missing, allAccepted: missing.length === 0 });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR policy requirements.' });
    }
  });

  app.post('/api/hr/policy-acknowledgements/batch', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = acceptHrPoliciesBatch(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record policy acknowledgements.' });
    }
  });

  app.get('/api/hr/templates/guarantor-form', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'Not available for your role.' });
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Zarewa-Guarantor-Form.txt"');
      return res.send(HR_GUARANTOR_FORM_TEMPLATE);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load guarantor form template.' });
    }
  });

  app.get(
    '/api/hr/templates/staff-registration-form.pdf',
    requireHrAny('hr.staff.manage', 'hr.settings.manage', 'hr.directory.view'),
    (req, res) => {
      try {
        const r = exportBlankStaffRegistrationFormPdf();
        res.setHeader('Content-Type', r.contentType || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
        return res.send(Buffer.from(r.pdf));
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not load staff registration template.' });
      }
    }
  );

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

  app.get(
    '/api/hr/policy-config',
    requireHrAny(
      'hr.payroll.prepare',
      'hr.payroll.manage',
      'hr.settings.manage',
      'hr.executive.view',
      'hr.executive.benefits.view',
      'hr.executive.benefits.manage'
    ),
    (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json(getHrPolicyConfig(db));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR policy config.' });
    }
  }
  );

  app.get(
    '/api/hr/policy-reference',
    requireHrAny(
      'hr.staff.manage',
      'hr.discipline.manage',
      'hr.leave.manage',
      'hr.transfers.manage',
      'hr.settings.manage',
      'hr.executive.view'
    ),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        return res.json({ ok: true, reference: getHrPolicyReference() });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not load HR policy reference.' });
      }
    }
  );

  app.patch(
    '/api/hr/policy-config',
    requireHrAny('hr.payroll.manage', 'hr.settings.manage', 'hr.executive.benefits.manage', 'hr.payroll.md_approve'),
    (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = req.body || {};
      const pensionKeys = ['pensionEmployeePercent', 'pensionEmployerPercent'];
      if (pensionKeys.some((k) => body[k] !== undefined) && !userCanEditPensionPolicyRates(req.user)) {
        return res.status(403).json({ ok: false, error: 'Only HR Executive can change pension rates.' });
      }
      const r = patchHrPolicyConfig(db, body, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update HR policy config.' });
    }
  }
  );

  app.post('/api/hr/sensitive/verify', (req, res) => {
    try {
      const password = String(req.body?.password || '');
      const r = issueHrSensitiveToken(db, req.user?.id, password, {
        purpose: String(req.body?.purpose || 'general'),
      });
      if (!r.ok) return res.status(401).json(r);
      setHrSensitiveCookie(res, r.token);
      return res.json({ ok: true, expiresAtIso: r.expiresAtIso, ttlSeconds: r.ttlSeconds });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not verify credentials.' });
    }
  });

  app.post('/api/hr/sensitive/lock', (req, res) => {
    try {
      clearHrSensitiveCookie(res);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not lock sensitive view.' });
    }
  });

  app.get('/api/hr/me/school-profile', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      const r = getHrMeSchoolProfile(db, req.user?.id);
      if (!r.ok) return res.status(r.error?.includes('only for') ? 404 : 400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load school profile.' });
    }
  });

  app.get('/api/hr/me/scholarship-summary', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      const staffFull = getHrStaffOne(db, req.user?.id);
      const documents = staffFull?.documents || [];
      const documentSummary = {
        total: documents.length,
        verified: documents.filter((d) => d.verificationStatus === 'verified').length,
        pending: documents.filter((d) => (d.verificationStatus || 'pending') === 'pending').length,
        rejected: documents.filter((d) => d.verificationStatus === 'rejected').length,
      };
      const r = getHrMeScholarshipSummary(db, req.user?.id, { documentSummary });
      if (!r.ok) return res.status(r.error?.includes('only for') ? 404 : 400).json(r);
      syncScholarshipDueReminders(db, req.user?.id, r.reminders || []);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load scholarship summary.' });
    }
  });

  app.get('/api/hr/me/scholarship-statement.pdf', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      const r = exportScholarshipPaymentStatementPdf(db, req.user?.id, {
        academicSession: req.query?.academicSession || req.query?.session,
      });
      if (!r.ok) return res.status(r.error?.includes('only for') ? 404 : 400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename || 'scholarship-statement.pdf'}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate payment statement.' });
    }
  });

  app.get('/api/hr/me/domestic-summary', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      const staffFull = getHrStaffOne(db, req.user?.id);
      const documents = staffFull?.documents || [];
      const documentSummary = {
        total: documents.length,
        verified: documents.filter((d) => d.verificationStatus === 'verified').length,
        pending: documents.filter((d) => (d.verificationStatus || 'pending') === 'pending').length,
        rejected: documents.filter((d) => d.verificationStatus === 'rejected').length,
      };
      const r = getHrMeDomesticSummary(db, req.user?.id, { documentSummary });
      if (!r.ok) return res.status(r.error?.includes('only for') ? 404 : 400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load household staff summary.' });
    }
  });

  app.get('/api/hr/me/domestic-statement.pdf', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      const r = exportDomesticPaymentStatementPdf(db, req.user?.id);
      if (!r.ok) return res.status(r.error?.includes('only for') ? 404 : 400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename || 'household-staff-statement.pdf'}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate payment statement.' });
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
      const completeness = staffFull?.profileCompleteness || null;
      const documents = staffFull?.documents || [];
      const documentSummary = {
        total: documents.length,
        verified: documents.filter((d) => d.verificationStatus === 'verified').length,
        pending: documents.filter((d) => (d.verificationStatus || 'pending') === 'pending').length,
        rejected: documents.filter((d) => d.verificationStatus === 'rejected').length,
      };
      const pendingProfileRequests = db
        .prepare(
          `SELECT id, kind, status, title, created_at_iso AS createdAtIso
           FROM hr_requests
           WHERE user_id = ? AND kind = 'profile_change'
             AND lower(status) NOT IN ('approved', 'rejected', 'cancelled')
           ORDER BY created_at_iso DESC LIMIT 10`
        )
        .all(req.user?.id);
      const urow = db.prepare(`SELECT username_change_count FROM app_users WHERE id = ?`).get(req.user?.id);
      const loanPolicy = getHrPolicyPayload(db);
      const leaveEntitlementDays = annualLeaveEntitlementDaysForUser(db, req.user?.id);
      return res.json({
        ok: true,
        user: {
          ...user,
          usernameChangeCount: Number(urow?.username_change_count) || 0,
          canChangeUsernameFreely: (Number(urow?.username_change_count) || 0) < 1,
        },
        hr: redactedHr,
        lifecycle: staffFull?.lifecycle || null,
        onboardingChecklist: staffFull?.onboardingChecklist || null,
        completeness,
        documents,
        documentSummary,
        pendingProfileRequests,
        loanPolicy,
        leaveEntitlementDays,
        unreadNotifications,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load your HR profile.' });
    }
  });

  app.patch('/api/hr/me/profile', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      if (!hrReady(res, db)) return;
      const r = updateMyHrStaffProfile(db, req.user?.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: req.user?.id });
      const staffFull = getHrStaffOne(db, req.user?.id);
      const profile = staffFull ? redactStaffProfile(staffFull, ctx) : r.profile;
      return res.json({ ok: true, profile });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update your profile.' });
    }
  });

  app.post('/api/hr/me/profile/submit', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      if (!hrReady(res, db)) return;
      const r = submitMyHrStaffProfile(db, req.user?.id);
      if (!r.ok) return res.status(400).json(r);
      const { user, hr } = getHrMeProfile(db, req.user?.id);
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: req.user?.id });
      return res.json({
        ok: true,
        profileSubmittedAtIso: r.profileSubmittedAtIso,
        displayName: r.displayName,
        user: user ? { ...user, displayName: r.displayName || user.displayName } : null,
        hr: hr ? redactStaffProfile({ ...hr, userId: req.user?.id }, ctx) : null,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit your profile.' });
    }
  });

  app.get('/api/hr/me/attendance-summary', (req, res) => {
    try {
      if (!userCanAccessMyProfileHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'HR self-service is not enabled for your role.' });
      }
      if (!hrReady(res, db)) return;
      const periodYyyymm = String(req.query?.periodYyyymm || req.query?.period || '').trim();
      const r = getHrAttendanceSummaryForUser(db, req.user?.id, periodYyyymm || undefined);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load attendance summary.' });
    }
  });

  app.get('/api/hr/dashboard', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const observability = listHrObservability(db, scope);
      const inbox = getHrInboxSummary(db, scope);
      const readiness = buildHrReadiness(db, scope);
      const staffAll = listHrStaff(db, scope, { includeInactive: true, requireProfile: true });
      const todayIso = new Date().toISOString().slice(0, 10);
      const in30 = new Date();
      in30.setDate(in30.getDate() + 30);
      const in30Iso = in30.toISOString().slice(0, 10);
      const in60 = new Date();
      in60.setDate(in60.getDate() + 60);
      const in60Iso = in60.toISOString().slice(0, 10);
      const activeStaff = staffAll.filter((s) => String(s.status || '') === 'active');
      let onProbationEnding = 0;
      for (const s of activeStaff) {
        const end = String(s.probationEndIso || '').slice(0, 10);
        if (end && end >= todayIso && end <= in30Iso) onProbationEnding += 1;
      }
      let documentsExpiring = 0;
      try {
        const activeIds = activeStaff.map((s) => s.userId).filter(Boolean);
        if (activeIds.length) {
          const placeholders = activeIds.map(() => '?').join(',');
          documentsExpiring =
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM hr_staff_documents
                 WHERE user_id IN (${placeholders}) AND expiry_date_iso BETWEEN ? AND ?`
              )
              .get(...activeIds, todayIso, in60Iso)?.c || 0;
        }
      } catch {
        documentsExpiring = 0;
      }
      const staffCounts = {
        total: staffAll.length,
        active: activeStaff.length,
        inactive: staffAll.filter((s) => String(s.status || '') !== 'active').length,
        incompleteProfiles: staffAll.filter((s) => (s.criticalMissing || []).length > 0).length,
        onProbationEnding,
        documentsExpiring,
      };
      const ctx = hrRedactionContextFromReq(req);
      const recentRequests = listHrRequests(db, scope, {})
        .slice(0, 12)
        .map((r) => redactHrRequest(r, { canViewSensitive: ctx.canViewSensitive, isOwner: false }));
      const profileWorkQueue = listHrProfileWorkQueue(db, scope);
      return res.json({
        ok: true,
        observability,
        inbox,
        readiness,
        staffCounts,
        recentRequests,
        profileWorkQueue,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load HR dashboard.' });
    }
  });

  app.get('/api/hr/profile-work-queue', requireHrAny('hr.directory.view', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, ...listHrProfileWorkQueue(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load profile work queue.' });
    }
  });

  app.get('/api/hr/policy-documents/:key', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!userCanAccessMyProfileHr(req.user) && !userCanAccessHrModule(req.user)) {
        return res.status(403).json({ ok: false, error: 'Not available for your role.' });
      }
      const key = String(req.params.key || '').trim();
      const reg = HR_POLICY_REGISTRY.find((p) => p.key === key);
      const content = HR_POLICY_CONTENT[key];
      if (!reg || !content) return res.status(404).json({ ok: false, error: 'Policy not found.' });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${key}-policy.txt"`);
      return res.send(`${reg.label} (v${reg.version})\n\n${content.summary || ''}\n\n${content.body || ''}`);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load policy document.' });
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
      } else if (
        userCanAccessMainHrWorkspace(req.user) &&
        (hrUserHas(req.user, 'hr.staff.manage') || hrUserHas(req.user, 'hr.directory.view'))
      ) {
        scope.viewAll = true;
      } else if (userCanAccessScholarshipDomesticExecutive(req.user)) {
        scope.viewAll = true;
      }
      if (String(req.query?.includeSalary || '') === '1' && !userCanViewOrgSensitiveHr(req.user)) {
        return res.status(403).json({ ok: false, error: 'Sensitive compensation data is restricted.' });
      }
      const includeInactive = String(req.query?.includeInactive || '') === '1';
      const requireProfile = String(req.query?.allUsers || '') !== '1';
      const cohort = String(req.query?.cohort || 'employees').trim();
      const attendanceEligibleOnly = String(req.query?.attendanceEligible || '') === '1';
      const staff = listHrStaff(db, scope, {
        includeInactive,
        requireProfile,
        cohort: attendanceEligibleOnly ? 'employees' : cohort,
        attendanceEligibleOnly,
      });
      const ctx = hrRedactionContextFromReq(req);
      return res.json({ ok: true, staff: redactStaffList(staff, ctx) });
    } catch (e) {
      console.error('[hr/staff/list]', e);
      const detail = String(e?.message || '').trim();
      return res.status(500).json({
        ok: false,
        error: detail ? `Could not list staff: ${detail}` : 'Could not list staff.',
      });
    }
  });

  app.get('/api/hr/staff/:userId', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (!canViewStaffRecord(req, userId)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!staffScopeGate(req, res, userId)) return;
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
      const executiveBenefitsPayroll = getExecutiveBenefitsPayrollForStaff(db, {
        userId: row.userId,
        displayName: row.displayName,
        payrollGroup: row.payrollGroup,
        profileExtra: row.profileExtra,
      });
      return res.json({
        ok: true,
        staff: executiveBenefitsPayroll ? { ...staff, executiveBenefitsPayroll } : staff,
        executiveBenefitsPayroll,
        branchHistory: userCanViewOrgSensitiveHr(req.user) || isSelf ? branchHistory : [],
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load staff profile.' });
    }
  });

  app.get('/api/hr/staff/:userId/registration-form.pdf', requireHrAny('hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = exportStaffRegistrationFormPdf(db, userId);
      if (!r.ok) return res.status(r.error === 'Staff not found.' ? 404 : 400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename || 'staff-registration.pdf'}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not export staff registration form.' });
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
      if (!staffScopeGate(req, res, userId)) return;
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
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const body = { ...(req.body || {}), userId };
      const r = upsertHrStaffProfile(db, req.user?.id, body);
      if (!r.ok) return res.status(400).json(r);
      const ctx = hrRedactionContextFromReq(req, { subjectUserId: req.params.userId });
      return res.json({ ok: true, profile: redactStaffProfile(r.profile, ctx) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update staff profile.' });
    }
  });

  app.post('/api/hr/staff/:userId/profile-verify', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = verifyHrStaffProfile(db, req.user?.id, userId);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ok: true, profileVerifiedAtIso: r.profileVerifiedAtIso });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not verify profile.' });
    }
  });

  app.post('/api/hr/staff/:userId/profile-unlock', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = unlockHrStaffProfile(db, req.user?.id, userId, req.body?.reason);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not unlock profile.' });
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

  app.get('/api/hr/discipline-cases/dashboard', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.directory.view', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      return res.json({ ok: true, dashboard: getDisciplineCaseDashboard(db, scope) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load discipline dashboard.' });
    }
  });

  app.get('/api/hr/discipline-cases', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.directory.view', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const filters = {
        status: req.query.status,
        caseType: req.query.caseType,
        severity: req.query.severity,
        userId: req.query.userId,
        fromIso: req.query.fromIso,
        toIso: req.query.toIso,
      };
      return res.json({ ok: true, cases: listDisciplineCases(db, scope, filters) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load discipline cases.' });
    }
  });

  app.get('/api/hr/discipline-cases/:id', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.directory.view', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const c = getDisciplineCase(db, req.params.id);
      if (!c) return res.status(404).json({ ok: false, error: 'Case not found.' });
      const scope = hrListScope(req);
      const isSubject = String(c.userId) === String(req.user?.id);
      if (!scope.viewAll && !isSubject && c.branchId !== scope.branchId && !hrUserHas(req.user, 'hr.discipline.manage')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      return res.json({ ok: true, case: c });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load discipline case.' });
    }
  });

  app.post('/api/hr/discipline-cases', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createDisciplineCase(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create discipline case.' });
    }
  });

  app.patch('/api/hr/discipline-cases/:id', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.requests.gm_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = patchDisciplineCase(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update discipline case.' });
    }
  });

  app.post('/api/hr/discipline-cases/:id/events', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = appendDisciplineCaseEvent(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not add case event.' });
    }
  });

  app.post('/api/hr/discipline-cases/:id/evidence', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = addDisciplineCaseEvidence(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not add evidence.' });
    }
  });

  app.post('/api/hr/discipline-cases/:id/witnesses', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = addDisciplineCaseWitness(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not add witness.' });
    }
  });

  app.post('/api/hr/discipline-cases/:id/appeals', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = fileDisciplineCaseAppeal(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not file appeal.' });
    }
  });

  app.post('/api/hr/discipline-cases/:id/letters/:letterType', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.letters.generate'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = generateDisciplineCaseLetter(db, req.user, req.params.id, req.params.letterType, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate letter.' });
    }
  });

  app.get('/api/hr/discipline-cases/:id/audit', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, ...getDisciplineCaseAudit(db, req.params.id) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load case audit.' });
    }
  });

  app.get('/api/hr/discipline-cases/:id/responsibility', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, parties: listCaseResponsibility(db, req.params.id) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load responsibility map.' });
    }
  });

  app.put('/api/hr/discipline-cases/:id/responsibility', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertCaseResponsibility(db, req.user, req.params.id, req.body?.parties || req.body || []);
      if (!r.ok) return res.status(400).json(r);
      appendHrAuditEvent(db, {
        actorUserId: req.user?.id,
        action: 'hr.discipline.responsibility_updated',
        entityKind: 'hr_discipline_case',
        entityId: req.params.id,
      });
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save responsibility map.' });
    }
  });

  app.delete('/api/hr/discipline-cases/:id/responsibility/:partyId', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = deleteCaseResponsibilityParty(db, req.user, req.params.id, req.params.partyId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not remove party.' });
    }
  });

  app.get('/api/hr/discipline-cases/:id/closure-check', requireHrAny('hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const gate = assertCaseClosureReady(db, req.params.id);
      return res.json({ ok: true, ...gate });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not check closure readiness.' });
    }
  });

  app.post('/api/hr/discipline-cases/:id/apply-decision', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.requests.gm_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = applyDecisionActions(db, req.user, req.params.id, req.body?.decisionType, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not apply decision.' });
    }
  });

  app.post('/api/hr/discipline-cases/:id/recovery-schedules', requireHrAny('hr.discipline.manage', 'hr.recovery.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createRecoverySchedulesFromCase(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      appendHrAuditEvent(db, {
        actorUserId: req.user?.id,
        action: 'hr.recovery.schedules_created',
        entityKind: 'hr_discipline_case',
        entityId: req.params.id,
      });
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create recovery schedules.' });
    }
  });

  app.get('/api/hr/discipline-cases/:id/recovery-schedules', requireHrAny('hr.discipline.manage', 'hr.recovery.manage', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, schedules: listRecoverySchedulesForCase(db, req.params.id) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load recovery schedules.' });
    }
  });

  app.get('/api/hr/my/recovery-schedules', requireHrAny('hr.self', 'hr.my_payslip.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, schedules: listRecoverySchedulesForUser(db, req.user?.id) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load recovery schedules.' });
    }
  });

  app.patch('/api/hr/recovery-schedules/:id', requireHrAny('hr.recovery.manage', 'hr.discipline.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (req.body?.action === 'cancel') {
        const r = cancelRecoverySchedule(db, req.user, req.params.id, req.body?.reason);
        if (!r.ok) return res.status(400).json(r);
        return res.json(r);
      }
      if (req.body?.action === 'settle') {
        const r = recordRecoverySettlement(db, req.user, req.params.id, req.body || {});
        if (!r.ok) return res.status(400).json(r);
        return res.json(r);
      }
      return res.status(400).json({ ok: false, error: 'Unsupported action. Use action: cancel or settle.' });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update recovery schedule.' });
    }
  });

  app.post('/api/incidents', requireHrAny('hr.incidents.manage', 'hr.discipline.manage', 'hr.staff.manage', 'hr.incident.create'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createIncident(db, req.body || {}, req.user, { workspaceBranchId: req.workspaceBranchId });
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create incident.' });
    }
  });

  app.get('/api/incidents', requireHrAny('hr.incidents.view', 'hr.discipline.manage', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const r = listIncidents(db, scope, {
        incidentKind: req.query?.kind,
        status: req.query?.status,
        severity: req.query?.severity,
        openOnly: req.query?.openOnly === '1',
      });
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list incidents.' });
    }
  });

  app.get('/api/incidents/:id', requireHrAny('hr.incidents.view', 'hr.discipline.manage', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = getIncident(db, req.params.id);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load incident.' });
    }
  });

  app.get('/api/incidents/:id/audit-full', requireHrAny('hr.discipline.manage', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = buildIncidentAuditPack(db, req.params.id);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not build audit pack.' });
    }
  });

  app.get('/api/incidents/:id/audit-full/pdf', requireHrAny('hr.discipline.manage', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = exportIncidentAuditPackPdf(db, req.params.id);
      if (!r.ok) return res.status(404).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not export investigation PDF.' });
    }
  });

  app.get('/api/hr/performance-recognitions', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.team.view', 'hr.incidents.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const r = listPerformanceRecognitions(db, scope, { userId: req.query?.userId });
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list performance recognitions.' });
    }
  });

  app.post('/api/assets/custody-events', requireHrAny('assets.custody.manage', 'hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = recordAssetCustodyEvent(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record custody event.' });
    }
  });

  app.get('/api/assets/:assetId/custody-timeline', requireHrAny('assets.custody.manage', 'hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const events = listAssetCustodyTimeline(db, req.params.assetId, req.query?.machineId);
      return res.json({ ok: true, events });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load custody timeline.' });
    }
  });

  app.post('/api/security/gate-pass-events', requireHrAny('assets.custody.manage', 'hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = recordGatePassEvent(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record gate pass.' });
    }
  });

  app.get('/api/security/gate-pass-events', requireHrAny('assets.custody.manage', 'hr.discipline.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const events = listGatePassEvents(db, scope.branchId, req.query?.passDateIso);
      return res.json({ ok: true, events });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list gate pass events.' });
    }
  });

  app.get('/api/hr/staff/:userId/discipline-payroll-blocks', requireHrAny('hr.discipline.manage', 'hr.payroll.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const blocks = staffDisciplinePayrollBlocks(db, userId);
      return res.json({ ok: true, ...blocks });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load discipline payroll blocks.' });
    }
  });

  app.get('/api/hr/staff/:userId/salary-history', requireHrAny('hr.staff.manage', 'hr.payroll.view_sensitive', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
      const r = applyHrSalaryIncrement(db, req.user?.id, userId, req.body || {}, req.user);
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      if (!staffScopeGate(req, res, userId)) return;
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
      const r = submitHrRequest(db, req.params.requestId, req.user);
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
      const gate = assertHrPolicyGate(db, req.user?.id, 'hr_leave_approve');
      if (!gate.ok) return res.status(403).json(gate);
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

  app.get('/api/hr/attendance/daily-roll', requireHrAny('hr.attendance.mark', 'hr.daily_roll.mark', 'hr.attendance.manage', 'hr.discipline.manage', 'hr.team.view'), (req, res) => {
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

  app.get(
    '/api/hr/payroll-runs/finance-queue',
    requireHrAny('hr.payroll.pay', 'hr.payroll.export', 'finance.view'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        return res.json({ ok: true, runs: listPayrollRunsForFinance(db) });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not load finance payroll queue.' });
      }
    }
  );

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
      const gate = assertHrPolicyGate(db, req.user?.id, 'hr_payroll_edit');
      if (!gate.ok) return res.status(403).json(gate);
      const r = computePayrollRun(db, req.params.runId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not recompute payroll.' });
    }
  });

  app.patch('/api/hr/payroll-runs/:runId', requireHrAny('hr.payroll.prepare', 'hr.payroll.manage', 'hr.payroll.gm_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = req.body || {};
      if (body.status === 'paid' && !userCanPayPayroll(req.user)) {
        return res.status(403).json({ ok: false, error: 'Finance payroll payment permission required.' });
      }
      if (body.status === 'locked' && !userCanPreparePayroll(req.user) && !hrUserHas(req.user, '*')) {
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
      if (!userCanMdApprovePayroll(req.user) && !hrUserHas(req.user, '*')) {
        return res.status(403).json({ ok: false, error: 'Managing Director payroll approval required.' });
      }
      const r = approvePayrollRunByMd(db, req.params.runId, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not approve payroll.' });
    }
  });

  app.get(
    '/api/hr/payroll-runs/:runId/missing-bank',
    requireHrAny('hr.payroll.prepare', 'hr.payroll.manage', 'hr.payroll.export', 'hr.payroll.pay'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        const staff = listPayrollMissingBankStaff(db, req.params.runId);
        return res.json({ ok: true, staff, count: staff.length });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not load missing bank accounts.' });
      }
    }
  );

  app.patch(
    '/api/hr/payroll-runs/:runId/lines/:userId',
    requireHrAny('hr.payroll.prepare', 'hr.payroll.manage'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        const r = patchPayrollLineAdjustments(db, req.params.runId, req.params.userId, req.body || {}, req.user);
        if (!r.ok) return res.status(400).json(r);
        return res.json(r);
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not adjust payroll line.' });
      }
    }
  );

  app.get(
    '/api/hr/payroll-runs/:runId/export/approval-report',
    requireHrAny('hr.payroll.prepare', 'hr.payroll.manage', 'hr.payroll.gm_approve', 'hr.payroll.export'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        const r = exportPayrollApprovalReportPdf(db, req.params.runId);
        if (!r.ok) return res.status(400).json(r);
        res.setHeader('Content-Type', r.contentType || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${r.filename || 'payroll-approval.pdf'}"`);
        return res.send(Buffer.from(r.pdf));
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Approval report export failed.' });
      }
    }
  );

  const exportPayroll = (handler, filename, { binary = false } = {}) => (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!hrUserHas(req.user, 'hr.payroll.export') && !userCanPayPayroll(req.user)) {
        return res.status(403).json({ ok: false, error: 'Payroll export permission required.' });
      }
      const r = handler(db, req.params.runId);
      if (!r.ok) return res.status(400).json(r);
      if (String(filename || '').includes('bank') || String(r.filename || '').includes('bank-payment')) {
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

  app.delete('/api/hr/salary-matrix/:id', requireHrAny('hr.staff.manage', 'hr.settings.manage', 'hr.payroll.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = deleteHrSalaryMatrixRow(db, req.user, {
        id: req.params.id,
        payrollGroup: req.query?.payrollGroup,
        salaryLevel: req.query?.salaryLevel,
        salaryStep: req.query?.salaryStep,
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not delete salary matrix row.' });
    }
  });

  app.get('/api/hr/compensation/variance-types', requireHrAny('hr.staff.manage', 'hr.payroll.prepare', 'hr.settings.manage'), (_req, res) => {
    return res.json({ ok: true, types: COMPENSATION_VARIANCE_TYPES });
  });

  app.get('/api/hr/compensation/matrix-lookup', requireHrAny('hr.staff.manage', 'hr.payroll.prepare', 'hr.settings.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = previewHrMatrixCompensation(db, {
        payrollGroup: req.query?.payrollGroup,
        salaryLevel: req.query?.salaryLevel,
        salaryStep: req.query?.salaryStep,
      });
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not look up salary matrix.' });
    }
  });

  app.get('/api/hr/reports/salary-variance', requireHrAny('hr.staff.manage', 'hr.payroll.view_sensitive', 'hr.settings.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      return res.json({ ok: true, rows: listHrSalaryVarianceReport(db, scope) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load salary variance report.' });
    }
  });

  app.post('/api/hr/org/seed-standard', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = seedZarewaOrgStandard(db);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ...r, catalog: getZarewaOrgCatalogMeta() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not seed standard org catalog.' });
    }
  });

  app.post('/api/hr/org/seed-demo-profile', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = seedDemoMultiRoleProfile(db, req.user?.id, {
        userId: req.body?.userId,
        fallbackUserId: req.user?.id,
        applyRecommendedRoleKey: req.body?.applyRecommendedRoleKey === true,
        applyMultiRolePermissions: req.body?.applyMultiRolePermissions === true,
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not seed demo multi-role profile.' });
    }
  });

  app.get('/api/hr/org/catalog-meta', requireHrAny('hr.directory.view', 'hr.settings.manage', 'hr.staff.manage'), (_req, res) => {
    return res.json({ ok: true, catalog: getZarewaOrgCatalogMeta() });
  });

  app.get('/api/hr/org/office-coverage', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const officeKey = String(req.query.officeKey || '').trim();
      if (!officeKey) return res.status(400).json({ ok: false, error: 'officeKey is required.' });
      const branchId = String(req.query.branchId || '').trim() || undefined;
      return res.json({ ok: true, officeKey, branchId: branchId || null, matches: findStaffCoveringOffice(db, { officeKey, branchId }) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not resolve office coverage.' });
    }
  });

  app.get('/api/hr/staff/:userId/role-hints', requireHrAny('hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const profile = db
        .prepare(
          `SELECT p.designation_id AS designationId, p.profile_extra_json AS profileExtraJson, u.role_key AS roleKey
           FROM hr_staff_profiles p JOIN app_users u ON u.id = p.user_id WHERE p.user_id = ?`
        )
        .get(userId);
      if (!profile) return res.status(404).json({ ok: false, error: 'Staff not found.' });
      const profileExtra = (() => {
        try {
          return JSON.parse(String(profile.profileExtraJson || '{}'));
        } catch {
          return {};
        }
      })();
      return res.json({
        ok: true,
        hints: recommendAppRoleKeys({
          designationId: profile.designationId,
          secondaryRoles: profileExtra?.employmentMeta?.secondaryRoles,
          currentRoleKey: profile.roleKey,
        }),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load role hints.' });
    }
  });

  app.post('/api/hr/compensation/backfill-legacy-pay', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const dryRun = req.body?.execute !== true && req.query?.execute !== '1';
      const autoDocument = req.body?.autoDocument === true || req.query?.autoDocument === '1';
      const r = backfillLegacyPayAdditions(db, hrListScope(req), { dryRun, autoDocument });
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Legacy pay backfill failed.' });
    }
  });

  app.post('/api/hr/compensation/apply-matrix-revision', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const dryRun = req.body?.execute !== true && req.query?.execute !== '1';
      const payrollGroup = String(req.body?.payrollGroup || req.query?.payrollGroup || '').trim() || undefined;
      const r = applyBulkMatrixRevisionToProfiles(db, hrListScope(req), {
        dryRun,
        payrollGroup,
        actorUserId: req.user?.id,
        effectiveFromIso: req.body?.effectiveFromIso,
        reason: req.body?.reason,
        recordHistory: req.body?.recordHistory !== false,
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Matrix revision apply failed.' });
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
      if (!staffScopeGate(req, res, userId)) return;
      return res.json({ ok: true, notes: listHrFeedbackNotes(db, userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load feedback notes.' });
    }
  });

  app.post('/api/hr/feedback', requireHrAny('hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = createHrFeedbackNote(db, req.user, req.body || {}, hrListScope(req));
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
      return res.json({
        ok: true,
        ...getHrReportCatalog({ canViewExecutive: userCanViewExecutiveBenefits(req.user) }),
      });
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
        canViewExecutive: userCanViewExecutiveBenefits(req.user),
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
        canViewExecutive: userCanViewExecutiveBenefits(req.user),
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
      const isSelf = userId === req.user?.id;
      const canOther =
        hrUserHas(req.user, 'hr.letters.generate') || hrUserHas(req.user, 'hr.staff.manage');
      if (!isSelf && !canOther) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!isSelf && !staffScopeGate(req, res, userId)) return;
      const letters = listEmploymentLettersDetailed(db, userId);
      const filtered = userId === req.user?.id
        ? letters.filter((l) => ['approved', 'issued'].includes(String(l.status)))
        : letters;
      return res.json({ ok: true, letters: filtered.length ? filtered : letters });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list employment letters.' });
    }
  });

  app.post('/api/hr/employment-letters/generate', requireHrAny('hr.letters.generate'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = req.body || {};
      const r = createDraftLetter(db, req.user, body);
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate letter.' });
    }
  });

  app.post('/api/hr/employment-letters/:letterId/submit', requireHrAny('hr.letters.generate', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = submitLetter(db, req.user, req.params.letterId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit letter.' });
    }
  });

  app.patch('/api/hr/employment-letters/:letterId/hr-review', requireHrAny('hr.requests.review', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = hrReviewLetter(db, req.user, req.params.letterId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not review letter.' });
    }
  });

  app.patch('/api/hr/employment-letters/:letterId/gm-review', requireHrAny('hr.requests.gm_approve', 'hr.letters.approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = gmReviewLetter(db, req.user, req.params.letterId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not GM-review letter.' });
    }
  });

  app.patch('/api/hr/employment-letters/:letterId/md-approve', requireHrAny('hr.payroll.md_approve', 'hr.executive.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = mdApproveLetter(db, req.user, req.params.letterId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not MD-approve letter.' });
    }
  });

  app.post('/api/hr/employment-letters/:letterId/issue', requireHrAny('hr.letters.approve', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = issueLetter(db, req.user, req.params.letterId);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not issue letter.' });
    }
  });

  app.post('/api/hr/employment-letters/:letterId/reject', requireHrAny('hr.letters.approve', 'hr.requests.review', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = rejectLetter(db, req.user, req.params.letterId, req.body?.reason);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not reject letter.' });
    }
  });

  app.get('/api/hr/employment-letters/:letterId/preview', requireHrAny('hr.letters.generate', 'hr.staff.manage', 'hr.self'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const letterId = String(req.params.letterId || '').trim();
      const row = db.prepare(`SELECT user_id FROM hr_employment_letters WHERE id = ?`).get(letterId);
      if (!row) return res.status(404).json({ ok: false, error: 'Letter not found.' });
      if (row.user_id !== req.user?.id && !hrUserHas(req.user, 'hr.letters.generate') && !hrUserHas(req.user, 'hr.staff.manage')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = exportLetterPreviewPdf(db, letterId);
      if (!r.ok) return res.status(400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not preview letter.' });
    }
  });

  app.get('/api/hr/employment-letters/:letterId/pdf', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const letterId = String(req.params.letterId || '').trim();
      const row = db.prepare(`SELECT user_id, status FROM hr_employment_letters WHERE id = ?`).get(letterId);
      if (!row) return res.status(404).json({ ok: false, error: 'Letter not found.' });
      const isSelf = row.user_id === req.user?.id;
      if (!isSelf && !hrUserHas(req.user, 'hr.letters.generate') && !hrUserHas(req.user, 'hr.staff.manage')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = exportOfficialLetterPdf(db, letterId, req.user);
      if (!r.ok) return res.status(r.code === 'LETTER_NOT_APPROVED' ? 403 : 400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not export letter PDF.' });
    }
  });

  app.get('/api/hr/employment-letters/:letterId/docx', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const letterId = String(req.params.letterId || '').trim();
      const row = db.prepare(`SELECT user_id FROM hr_employment_letters WHERE id = ?`).get(letterId);
      if (!row) return res.status(404).json({ ok: false, error: 'Letter not found.' });
      const isSelf = row.user_id === req.user?.id;
      if (!isSelf && !hrUserHas(req.user, 'hr.letters.generate') && !hrUserHas(req.user, 'hr.staff.manage')) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      const r = exportOfficialLetterDocx(db, letterId, req.user);
      if (!r.ok) return res.status(r.code === 'LETTER_NOT_APPROVED' ? 403 : 400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/msword');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      return res.send(r.body);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not export letter Word document.' });
    }
  });

  app.post('/api/hr/employment-letters/:letterId/print', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = recordLetterPrint(db, req.params.letterId, req.user);
      if (!r.ok) return res.status(r.code === 'LETTER_NOT_APPROVED' ? 403 : 400).json(r);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record print.' });
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
      const selfOnly = userHasHrSelfServiceOnly(req.user);
      let rows = listHrBeneficiaries(db, scope);
      if (mineOnly || selfOnly) {
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
      const r = escalateIncidentMemo(db, req.params.memoId, req.user, req.body || {});
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
      const branchId = scope?.viewAll ? null : scope?.branchId || DEFAULT_BRANCH_ID;
      const countTeamPending = (kind) =>
        listHrRequests(db, scope, { kind, status: 'branch_manager_review' }).filter((r) =>
          teamUserIds.has(r.userId)
        ).length;
      let pendingLeave = 0;
      let pendingLoan = 0;
      let pendingTransfer = 0;
      let openIncidents = 0;
      let onProbation = 0;
      let documentsExpiring = 0;
      try {
        pendingLeave = countTeamPending('leave');
        pendingLoan = countTeamPending('loan');
        pendingTransfer = listHrTransferRequests(db, scope, { pendingOnly: true }).filter((t) =>
          teamUserIds.has(t.userId)
        ).length;
        openIncidents = countOpenIncidents(db, branchId);
        const todayIso = new Date().toISOString().slice(0, 10);
        const in30 = new Date();
        in30.setDate(in30.getDate() + 30);
        const in30Iso = in30.toISOString().slice(0, 10);
        const in60 = new Date();
        in60.setDate(in60.getDate() + 60);
        const in60Iso = in60.toISOString().slice(0, 10);
        for (const uid of teamUserIds) {
          const prob = db.prepare(`SELECT probation_end_iso FROM hr_staff_profiles WHERE user_id = ?`).get(uid);
          const end = prob?.probation_end_iso;
          if (end && end >= todayIso && end <= in30Iso) onProbation += 1;
        }
        if (teamUserIds.size > 0) {
          const placeholders = [...teamUserIds].map(() => '?').join(',');
          documentsExpiring =
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM hr_staff_documents
                 WHERE user_id IN (${placeholders}) AND expiry_date_iso BETWEEN ? AND ?`
              )
              .get(...teamUserIds, todayIso, in60Iso)?.c || 0;
        }
      } catch {
        pendingLeave = 0;
      }
      return res.json({
        ok: true,
        scopeMode: roster.scopeMode,
        count: staff.length,
        roster: redactStaffList(staff.slice(0, 200), ctx),
        pendingLeave,
        pendingLoan,
        pendingTransfer,
        openIncidents,
        onProbation,
        documentsExpiring,
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
      if (!staffScopeGate(req, res, userId)) return;
      return res.json({ ok: true, schedule: getStaffLoanSchedule(db, userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load loan schedule.' });
    }
  });

  app.get('/api/hr/loan-schedule-issues', requireHrAny('hr.loans.manage', 'hr.payroll.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, issues: listLoanScheduleIssues(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load loan schedule issues.' });
    }
  });

  app.get('/api/hr/obligation-accounts', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!staffObligationTablesReady(db)) {
        return res.json({ ok: true, accounts: [], ledgerReady: false });
      }
      const userId = String(req.query?.userId || req.query?.staffId || '').trim();
      const isSelf = userId && userId === req.user?.id;
      if (!userId && !actorMayManageObligations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (userId && !isSelf && !actorMayManageObligations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (userId && !staffScopeGate(req, res, userId)) return;
      const scope = hrListScope(req);
      const accounts = listStaffObligationAccounts(db, {
        userId: userId || undefined,
        kind: String(req.query?.kind || 'loan').trim() || 'loan',
        branchId: scope.viewAll ? 'ALL' : scope.branchId,
      });
      return res.json({ ok: true, ledgerReady: true, accounts });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load obligation accounts.' });
    }
  });

  app.get('/api/hr/obligation-accounts/:accountId', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      if (!staffObligationTablesReady(db)) {
        return res.status(404).json({ ok: false, error: 'Obligation ledger not available.' });
      }
      const detail = getStaffObligationAccountDetail(db, req.params.accountId);
      if (!detail) return res.status(404).json({ ok: false, error: 'Account not found.' });
      const isSelf = detail.userId === req.user?.id;
      if (!isSelf && !actorMayManageObligations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!isSelf && !staffScopeGate(req, res, detail.userId)) return;
      return res.json({ ok: true, account: detail });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load obligation account.' });
    }
  });

  app.post('/api/hr/obligation-accounts/migrate', requireHrAny('hr.loans.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = migrateLegacyStaffLoan(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not register legacy loan.' });
    }
  });

  app.post('/api/hr/obligation-accounts/backfill-recoveries', requireHrAny('hr.loans.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = backfillRecoveryObligationsFromSchedules(db);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not backfill recovery obligations.' });
    }
  });

  app.post('/api/hr/obligation-accounts/:accountId/repayments', requireHrAny('hr.loans.manage', 'finance.post'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = recordObligationCashRepayment(db, req.user, req.params.accountId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record repayment.' });
    }
  });

  app.get(
    '/api/finance/staff-recoveries-due',
    requireHrAny('finance.post', 'finance.pay', 'cashier.desk.view', 'treasury.manage', 'hr.recovery.manage'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        const scope = hrListScope(req);
        const branchScope = scope.viewAll ? 'ALL' : scope.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID;
        const rows = listStaffRecoveriesDueForCashier(db, branchScope);
        return res.json({ ok: true, recoveries: rows, ledgerReady: staffObligationTablesReady(db) });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not load staff recoveries due.' });
      }
    }
  );

  app.post(
    '/api/finance/staff-recoveries/:scheduleId/receive',
    requireHrAny('finance.post', 'finance.pay', 'treasury.manage'),
    (req, res) => {
      try {
        if (!hrReady(res, db)) return;
        const r = recordStaffRecoveryCashierPayment(db, req.user, req.params.scheduleId, {
          ...(req.body || {}),
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        });
        if (!r.ok) return res.status(400).json(r);
        return res.json(r);
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not record staff recovery payment.' });
      }
    }
  );

  app.get('/api/hr/obligation-accounts/:accountId/statement.pdf', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const detail = getStaffObligationAccountDetail(db, req.params.accountId);
      if (!detail) return res.status(404).json({ ok: false, error: 'Account not found.' });
      const isSelf = detail.userId === req.user?.id;
      if (!isSelf && !actorMayManageObligations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!isSelf && !staffScopeGate(req, res, detail.userId)) return;
      const built = buildObligationAccountStatementPdf(db, req.params.accountId);
      if (!built.ok) return res.status(400).json(built);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${built.filename}"`);
      return res.send(built.pdf);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate statement PDF.' });
    }
  });

  app.get('/api/hr/obligation-accounts/:accountId/disbursement-voucher.pdf', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const detail = getStaffObligationAccountDetail(db, req.params.accountId);
      if (!detail) return res.status(404).json({ ok: false, error: 'Account not found.' });
      const isSelf = detail.userId === req.user?.id;
      if (!isSelf && !actorMayManageObligations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!isSelf && !staffScopeGate(req, res, detail.userId)) return;
      const built = buildObligationDisbursementVoucherPdf(db, req.params.accountId);
      if (!built.ok) return res.status(400).json(built);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${built.filename}"`);
      return res.send(built.pdf);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate disbursement voucher.' });
    }
  });

  app.get('/api/hr/obligation-accounts/:accountId/transactions/:txId/receipt.pdf', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const detail = getStaffObligationAccountDetail(db, req.params.accountId);
      if (!detail) return res.status(404).json({ ok: false, error: 'Account not found.' });
      const isSelf = detail.userId === req.user?.id;
      if (!isSelf && !actorMayManageObligations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!isSelf && !staffScopeGate(req, res, detail.userId)) return;
      const built = buildObligationRepaymentReceiptPdf(db, req.params.accountId, req.params.txId);
      if (!built.ok) return res.status(400).json(built);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${built.filename}"`);
      return res.send(built.pdf);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate repayment receipt.' });
    }
  });

  app.get('/api/hr/staff/:userId/money-summary', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      const isSelf = userId === req.user?.id;
      if (!isSelf && !actorMayManageObligations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Permission denied.' });
      }
      if (!staffScopeGate(req, res, userId)) return;
      const loans = staffObligationTablesReady(db)
        ? listStaffObligationAccounts(db, { userId, kind: OBLIGATION_KIND.LOAN })
        : [];
      const purchases = staffObligationTablesReady(db)
        ? listStaffObligationAccounts(db, { userId, kind: OBLIGATION_KIND.PURCHASE })
        : [];
      const recoveriesRaw = staffObligationTablesReady(db)
        ? listStaffObligationAccounts(db, { userId, kind: OBLIGATION_KIND.RECOVERY })
        : [];
      const recoveries = enrichRecoveryObligationsForDisplay(db, recoveriesRaw);
      const purchaseEligibility = computeStaffPurchaseCreditEligibility(db, userId);
      const prof = db
        .prepare(`SELECT branch_id, employee_no FROM hr_staff_profiles WHERE user_id = ?`)
        .get(userId);
      const recoveryDueNgn = recoveries.reduce((s, a) => s + (a.principalOutstandingNgn || 0), 0) || 0;
      const totalOutstanding =
        [...loans, ...purchases, ...recoveries].reduce((s, a) => s + (a.principalOutstandingNgn || 0), 0) || 0;
      return res.json({
        ok: true,
        staffBranchId: prof?.branch_id || null,
        staffEmployeeNo: String(prof?.employee_no || '').trim() || null,
        recoveryDueNgn,
        totalOutstandingNgn: totalOutstanding,
        loans,
        purchases,
        recoveries,
        purchaseEligibility,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load money summary.' });
    }
  });

  app.post('/api/hr/staff/:userId/ensure-sales-customer', requireHrAny('hr.staff.manage', 'hr.loans.manage', 'sales.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = ensureStaffSalesCustomer(db, userId, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not link sales customer.' });
    }
  });

  app.post('/api/hr/staff/bulk-ensure-sales-customers', requireHrAny('hr.staff.manage', 'hr.loans.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const branchId = String(req.body?.branchId || req.query?.branchId || '').trim();
      const scope = hrListScope(req);
      const r = bulkEnsureStaffSalesCustomers(db, req.user, {
        branchId: branchId || (scope.viewAll ? 'ALL' : scope.branchId),
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Bulk link failed.' });
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

  const putHrDepartment = (req, res) => {
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
  };
  app.put('/api/hr/departments', requireHrAny('hr.settings.manage', 'hr.staff.manage'), putHrDepartment);
  app.put('/api/hr/departments/:id', requireHrAny('hr.settings.manage', 'hr.staff.manage'), putHrDepartment);

  app.delete('/api/hr/departments/:id', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const hard = req.query?.hard === '1' || req.query?.hard === 'true';
      const r = deleteHrDepartment(db, req.params.id, req.user, { hard });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not remove department.' });
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

  const putHrDesignation = (req, res) => {
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
  };
  app.put('/api/hr/designations', requireHrAny('hr.settings.manage', 'hr.staff.manage'), putHrDesignation);
  app.put('/api/hr/designations/:id', requireHrAny('hr.settings.manage', 'hr.staff.manage'), putHrDesignation);

  app.delete('/api/hr/designations/:id', requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const hard = req.query?.hard === '1' || req.query?.hard === 'true';
      const r = deleteHrDesignation(db, req.params.id, req.user, { hard });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not remove designation.' });
    }
  });

  app.get('/api/hr/designations/:id/tenure-eligibility', requireHrAny('hr.settings.manage', 'hr.staff.manage', 'hr.directory.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const designationId = String(req.params.id || '').trim();
      const userId = String(req.query.userId || '').trim() || null;
      const r = getDesignationTenureEligibility(db, designationId, userId, {
        dateJoinedIso: req.query.dateJoinedIso,
      });
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not evaluate designation tenure eligibility.' });
    }
  });

  app.get('/api/hr/staff/:userId/tenure', requireHrAny('hr.directory.view', 'hr.staff.manage', 'hr.team.view', 'hr.self', 'hr.my_profile.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const row = db.prepare(`SELECT date_joined_iso, salary_level, salary_step FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
      if (!row) return res.status(404).json({ ok: false, error: 'Staff not found.' });
      const tenure = getStaffTenureSummary(db, userId, {
        dateJoinedIso: row.date_joined_iso,
        salaryLevel: row.salary_level,
        salaryStep: row.salary_step,
      });
      return res.json({ ok: true, tenure });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load tenure summary.' });
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
      const calendarOpts = {};
      if (userHasHrSelfServiceOnly(req.user)) {
        calendarOpts.selfUserId = req.user?.id;
      } else if (hrUserHas(req.user, 'hr.self') && !userCanAccessHrModule(req.user) && !userCanAccessTeamHr(req.user)) {
        calendarOpts.selfUserId = req.user?.id;
      } else if (hrUserHas(req.user, 'hr.team.view') && !userCanAccessHrModule(req.user)) {
        calendarOpts.redactPeerNames = true;
        calendarOpts.selfUserId = req.user?.id;
      }
      return res.json({ ok: true, entries: listHrLeaveCalendar(db, scope, fromIso, toIso, calendarOpts) });
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
    try {
      if(!hrReady(res,db)) return;
      const body = { ...(req.body || {}) };
      if (!userCanAccessHrModule(req.user)) {
        body.userId = req.user?.id;
      }
      const r=createHrIdCardRequest(db,req.user,body);
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to create ID card request.'});}
  });
  app.patch('/api/hr/id-cards/:id', requireHrAny('hr.*','hr.staff.manage'), (req,res) => {
    try { if(!hrReady(res,db)) return; const r=patchHrIdCardRequest(db,req.user,req.params.id,req.body||{}); if(!r.ok) return res.status(404).json(r); return res.json(r); } catch(e){console.error(e);return res.status(500).json({ok:false,error:'Failed to update ID card request.'});}
  });

  app.get('/api/hr/staff/:userId/severance-preview', requireHrAny('hr.*', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = getStaffSeverancePreview(db, userId);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not calculate severance.' });
    }
  });

  app.get('/api/hr/staff/:userId/disciplinary-summary', requireHrAny('hr.discipline.manage', 'hr.staff.manage', 'hr.team.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      return res.json({ ok: true, ...getStaffDisciplinaryQueryCount(db, userId) });
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

  app.get('/api/hr/payroll-runs/:runId/paye-alerts', requireHrAny('hr.payroll.prepare', 'hr.payroll.manage', 'hr.payroll.view_sensitive'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const missing = getPayrollMissingPayeStaff(db, req.params.runId);
      return res.json({ ok: true, missing, count: missing.length });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load PAYE alerts.' });
    }
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
        exitClearancePending: actionAlerts.exitClearancePending,
        promotionDue: actionAlerts.promotionDue,
        missingPolicyAck: actionAlerts.missingPolicyAck,
        expiredDocuments: actionAlerts.expiredDocuments,
        actingRoleAlerts: actionAlerts.actingRoleAlerts,
        actingRolesExpiring: actionAlerts.actingRolesExpiring,
        actingRolesOverdue: actionAlerts.actingRolesOverdue,
        actingRolesMissingEnd: actionAlerts.actingRolesMissingEnd,
        compensationReviewDue: actionAlerts.compensationReviewDue,
        undocumentedCompensationVariance: actionAlerts.undocumentedCompensationVariance,
        pendingTransfers: actionAlerts.pendingTransfers,
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
      const r = getHrExitClearance(db, req.params.id, hrListScope(req));
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
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = setStaffSalaryHold(db, userId, req.body || {}, req.user);
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
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      return res.json({ ok: true, skills: listStaffSkills(db, userId) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load skills.' });
    }
  });

  app.put('/api/hr/staff/:userId/skills', requireHrAny('hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = upsertStaffSkill(db, userId, req.body || {}, req.user);
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
      const userId = String(req.params.userId || '').trim();
      if (!staffScopeGate(req, res, userId)) return;
      const r = getPromotionReadiness(db, userId);
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

  app.post('/api/hr/grievances', requireHrAny('hr.self', 'hr.my_profile.view', 'hr.staff.manage'), (req, res) => {
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

  app.get('/api/hr/staff-import/template', requireMainHrWorkspace, requireHrAny('hr.staff.import', 'hr.staff.manage'), (_req, res) => {
    try {
      const buf = buildBulkImportTemplateXlsx();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="zarewa-staff-import-template.xlsx"');
      return res.send(buf);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not build template.' });
    }
  });

  app.post('/api/hr/staff-import/preview', requireMainHrWorkspace, requireHrAny('hr.staff.import', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const b64 = req.body?.fileBase64 || req.body?.data;
      if (!b64) return res.status(400).json({ ok: false, error: 'fileBase64 is required.' });
      const buf = Buffer.from(String(b64), 'base64');
      const importMode = req.body?.importMode === 'replace' ? 'replace' : 'update';
      const r = previewBulkStaffImport(db, buf, { ...hrListScope(req), importMode });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not preview import.' });
    }
  });

  app.post('/api/hr/staff-import/commit', requireMainHrWorkspace, requireHrAny('hr.staff.import', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const b64 = req.body?.fileBase64 || req.body?.data;
      if (!b64) return res.status(400).json({ ok: false, error: 'fileBase64 is required.' });
      const buf = Buffer.from(String(b64), 'base64');
      const importMode = req.body?.importMode === 'replace' ? 'replace' : 'update';
      const r = commitBulkStaffImport(db, req.user, buf, { ...hrListScope(req), importMode });
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error('[staff-import/commit]', e);
      const detail = String(e?.message || '').trim();
      return res.status(500).json({
        ok: false,
        error: detail ? `Could not import staff: ${detail}` : 'Could not import staff.',
      });
    }
  });

  app.get('/api/hr/staff-import/runs', requireMainHrWorkspace, requireHrAny('hr.staff.import', 'hr.staff.manage', 'hr.reports.view'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, runs: listBulkImportRuns(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list import runs.' });
    }
  });

  app.get('/api/hr/staff-import/duplicates', requireMainHrWorkspace, requireHrAny('hr.staff.import', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const report = scanHrStaffDuplicates(db);
      if (!report.ok) return res.status(400).json(report);
      return res.json(report);
    } catch (e) {
      console.error('[staff-import/duplicates]', e);
      return res.status(500).json({ ok: false, error: 'Could not scan for duplicate staff.' });
    }
  });

  app.post('/api/hr/staff-import/duplicates/cleanup', requireMainHrWorkspace, requireHrAny('hr.staff.import', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const dryRun = body.dryRun !== false;
      const r = cleanupHrStaffDuplicates(db, req.user, {
        dryRun,
        removeOrphans: body.removeOrphans !== false,
        removeDuplicates: body.removeDuplicates !== false,
        userIds: Array.isArray(body.userIds) ? body.userIds : undefined,
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error('[staff-import/duplicates/cleanup]', e);
      const detail = String(e?.message || '').trim();
      return res.status(500).json({
        ok: false,
        error: detail ? `Could not clean duplicate staff: ${detail}` : 'Could not clean duplicate staff.',
      });
    }
  });

  app.get('/api/hr/settings/letter-references', requireMainHrWorkspace, requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const config = getLetterReferenceConfig(db);
      return res.json({ ok: true, config, previewNext: previewNextLetterReferences(db, req.query.letterKind || 'appointment', 5) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load letter reference settings.' });
    }
  });

  app.put('/api/hr/settings/letter-references', requireMainHrWorkspace, requireHrAny('hr.settings.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = saveLetterReferenceConfig(db, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json({ ok: true, config: getLetterReferenceConfig(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save letter reference settings.' });
    }
  });

  app.post('/api/hr/settings/letter-references/reset', requireMainHrWorkspace, requireHrAny('hr.settings.manage', 'hr.payroll.md_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = resetLetterReferencesForLiveUse(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not reset letter references.' });
    }
  });

  app.get('/api/hr/settings/staff-numbering', requireMainHrWorkspace, requireHrAny('hr.settings.manage', 'hr.staff.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const config = getStaffNumberConfig(db);
      const preview = previewStaffRenumbering(db, config);
      const sampleNextNumber = previewSampleEmployeeNumber(config, db, {
        branchId: hrListScope(req).branchId || 'BR-KD',
      });
      return res.json({ ok: true, config, preview, sampleNextNumber, missingNumbers: listStaffWithoutEmployeeNo(db, hrListScope(req)) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load staff numbering settings.' });
    }
  });

  app.put('/api/hr/settings/staff-numbering', requireMainHrWorkspace, requireHrAny('hr.settings.manage'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = saveStaffNumberConfig(db, req.body || {}, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save staff numbering settings.' });
    }
  });

  app.post('/api/hr/settings/staff-numbering/apply', requireMainHrWorkspace, requireHrAny('hr.settings.manage', 'hr.payroll.md_approve'), (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const config = getStaffNumberConfig(db);
      const r = applyStaffRenumbering(db, req.user, { ...config, ...(req.body?.config || {}) }, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not apply staff renumbering.' });
    }
  });

  app.get('/api/hr/my/discipline-cases', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = { subjectUserId: req.user?.id, viewAll: false };
      const cases = listDisciplineCases(db, scope, {}).map((c) => ({
        id: c.id,
        caseNumber: c.caseNumber,
        status: c.status,
        caseType: c.caseType,
        severity: c.severity,
        summary: c.summary,
        description: c.description,
        incidentDateIso: c.incidentDateIso,
        employeeResponse: c.employeeResponse,
        managementDecision: c.managementDecision,
        finalOutcome: c.finalOutcome,
        appealStatus: c.appealStatus,
        openedAtIso: c.openedAtIso,
      }));
      return res.json({ ok: true, cases });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load your discipline cases.' });
    }
  });

  app.patch('/api/hr/my/discipline-cases/:id/response', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const c = getDisciplineCase(db, req.params.id);
      if (!c || c.userId !== req.user?.id) return res.status(404).json({ ok: false, error: 'Case not found.' });
      const r = patchDisciplineCase(db, req.user, req.params.id, { employeeResponse: req.body?.response || req.body?.employeeResponse });
      if (!r.ok) return res.status(400).json(r);
      createHrNotification(db, {
        userId: c.openedByUserId || req.user?.id,
        kind: 'discipline_response',
        title: 'Employee discipline response submitted',
        body: `${c.caseNumber || c.id}: response received.`,
        routePath: `/hr/discipline-exit?tab=accountability&caseId=${encodeURIComponent(c.id)}`,
        entityKind: 'hr_discipline_case',
        entityId: c.id,
      });
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit response.' });
    }
  });

  app.post('/api/hr/my/discipline-cases/:id/appeal', (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const c = getDisciplineCase(db, req.params.id);
      if (!c || c.userId !== req.user?.id) return res.status(404).json({ ok: false, error: 'Case not found.' });
      const r = fileDisciplineCaseAppeal(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      createHrNotification(db, {
        userId: c.openedByUserId || req.user?.id,
        kind: 'discipline_appeal',
        title: 'Discipline appeal submitted',
        body: `${c.caseNumber || c.id}: employee filed an appeal.`,
        routePath: `/hr/discipline-exit?tab=accountability&caseId=${encodeURIComponent(c.id)}`,
        entityKind: 'hr_discipline_case',
        entityId: c.id,
      });
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not file appeal.' });
    }
  });

  // ── Phase 9: Executive benefits ─────────────────────────────
  app.get('/api/hr/executive/dashboard', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, dashboard: getExecutiveBenefitsDashboard(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load executive dashboard.' });
    }
  });

  app.get('/api/hr/executive/family-dashboard', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const linkedExecutive = String(req.query?.linkedExecutive || '').trim() || undefined;
      return res.json({ ok: true, ...getExecutiveFamilyDashboard(db, { linkedExecutive }) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load family dashboard.' });
    }
  });

  app.get('/api/hr/executive/domestic-dashboard', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const assignedExecutive = String(req.query?.assignedExecutive || req.query?.linkedExecutive || '').trim() || undefined;
      return res.json({ ok: true, ...getExecutiveDomesticDashboard(db, { assignedExecutive }) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load household staff dashboard.' });
    }
  });

  app.get('/api/hr/executive/beneficiaries', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, beneficiaries: listExecutiveBeneficiaries(db, req.query || {}) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load beneficiaries.' });
    }
  });

  app.post('/api/hr/executive/beneficiaries', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertExecutiveBeneficiary(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save beneficiary.' });
    }
  });

  app.put('/api/hr/executive/beneficiaries/:id', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertExecutiveBeneficiary(db, req.user, { ...(req.body || {}), id: req.params.id });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update beneficiary.' });
    }
  });

  app.get('/api/hr/executive/school-fees', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, fees: listExecutiveSchoolFees(db, req.query || {}) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load school fees.' });
    }
  });

  app.post('/api/hr/executive/school-fees', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertExecutiveSchoolFee(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save school fee.' });
    }
  });

  app.put('/api/hr/executive/school-fees/:id', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertExecutiveSchoolFee(db, req.user, { ...(req.body || {}), id: req.params.id });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update school fee.' });
    }
  });

  app.post('/api/hr/executive/school-fees/:id/submit', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = submitExecutiveSchoolFee(db, req.user, req.params.id);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not submit school fee.' });
    }
  });

  app.delete('/api/hr/executive/school-fees/:id', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json(deleteExecutiveSchoolFee(db, req.user, req.params.id));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not delete school fee.' });
    }
  });

  app.get('/api/hr/executive/stipends', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, stipends: listExecutiveStipends(db, req.query || {}) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load stipends.' });
    }
  });

  app.post('/api/hr/executive/stipends', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertExecutiveStipend(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save stipend.' });
    }
  });

  app.put('/api/hr/executive/stipends/:id', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertExecutiveStipend(db, req.user, { ...(req.body || {}), id: req.params.id });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update stipend.' });
    }
  });

  app.get('/api/hr/executive/domestic-staff', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, staff: listDomesticStaffProfiles(db, req.query || {}) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load domestic staff.' });
    }
  });

  app.post('/api/hr/executive/domestic-staff', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertDomesticStaffProfile(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save domestic staff.' });
    }
  });

  app.put('/api/hr/executive/domestic-staff/:id', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertDomesticStaffProfile(db, req.user, { ...(req.body || {}), id: req.params.id });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update domestic staff.' });
    }
  });

  app.get('/api/hr/executive/domestic-staff/:id/statement.pdf', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = exportDomesticPaymentStatementPdfByProfileId(db, req.params.id);
      if (!r.ok) return res.status(r.error?.includes('not found') ? 404 : 400).json(r);
      res.setHeader('Content-Type', r.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename || 'household-staff-statement.pdf'}"`);
      return res.send(Buffer.from(r.pdf));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate payment statement.' });
    }
  });

  app.get('/api/hr/executive/payments', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, payments: listExecutivePayments(db, req.query || {}) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load payments.' });
    }
  });

  app.get('/api/hr/executive/payments/:id', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const payment = getExecutivePayment(db, req.params.id);
      if (!payment) return res.status(404).json({ ok: false, error: 'Payment not found.' });
      return res.json({ ok: true, payment });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load payment.' });
    }
  });

  app.post('/api/hr/executive/payments/:id/approve', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = approveExecutivePayment(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not approve payment.' });
    }
  });

  app.post('/api/hr/executive/payments/:id/reject', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = rejectExecutivePayment(db, req.user, req.params.id, req.body?.reason);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not reject payment.' });
    }
  });

  app.post('/api/hr/executive/payments/:id/mark-paid', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = markExecutivePaymentPaid(db, req.user, req.params.id, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not mark payment paid.' });
    }
  });

  app.post('/api/hr/executive/payments/export', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = buildExecutiveBeneficiaryBankExport(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      return res.send(r.csv);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not export payments.' });
    }
  });

  app.get('/api/hr/executive/expenses', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json({ ok: true, expenses: listChairmanExpensesMapped(db, req.query?.period || null) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Failed to load expenses.' });
    }
  });

  app.post('/api/hr/executive/expenses', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertChairmanExpenseMapped(db, req.user, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Failed to save expense.' });
    }
  });

  app.put('/api/hr/executive/expenses/:id', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const r = upsertChairmanExpenseMapped(db, req.user, { ...(req.body || {}), id: req.params.id });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Failed to update expense.' });
    }
  });

  app.delete('/api/hr/executive/expenses/:id', requireExecutiveBenefitsManage, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      return res.json(deleteChairmanExpenseMapped(db, req.params.id));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Failed to delete expense.' });
    }
  });

  app.get('/api/hr/executive/reports/:kind', requireExecutiveBenefitsView, (req, res) => {
    try {
      if (!hrReady(res, db)) return;
      const scope = hrListScope(req);
      const filters = parseReportFilters(req.query || {});
      const r = previewHrReport(db, scope, req.params.kind, filters, {
        actor: req.user,
        canViewExecutive: true,
        canViewSensitive: userCanViewOrgSensitiveHr(req.user),
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Report failed.' });
    }
  });
}
