/**
 * HTTP route composer. Do not add new route groups here — extract them into
 * `server/http/*Routes.js` (see docs/FILE_STRUCTURE_CAMPAIGN.md). Writes belong
 * in *Ops modules; this file should only wire HTTP to ops.
 */
import {
  advanceBalanceFromEntries,
  overpayCreditBalanceFromEntries,
  amountDueOnQuotationFromEntries,
  ledgerReceiptTotalFromEntries,
  planAdvanceIn,
  planAdvanceApplied,
  planReceiptWithQuotation,
  planRefundAdvance,
  receiptResultFromSavedRows,
} from '../shared/lib/customerLedgerCore.js';
import { quotationPaymentPolicySnapshot } from '../shared/lib/accountingPolicyV1.js';
import { readFinanceFeatureFlags, accountingPolicyV1HealthCapabilities } from './financeFeatureFlags.js';
import { ACCOUNTING_OPENING_DATE_ISO } from '../shared/lib/accountingCutover.js';
import { evaluateDeliveryPaymentRelease } from './deliveryReleaseGate.js';
import { isEffectivelyFullyPaid } from '../shared/lib/paymentOutstandingTolerance.js';
import { buildMaterialTransactionReport } from '../shared/lib/materialTransactionReportCore.js';
import { buildConversionSummaryReport } from './conversionSummaryReport.js';
import { buildPurchaseReport } from '../shared/lib/purchaseReportCore.js';
import {
  arAsAtReportRows,
  receiptsRegisterReportRows,
  revenueProductionReportRows,
  salesBridgeReportRows,
} from '../shared/lib/standardReportsSales.js';
import { expensesPackReport, refundsPackReport } from '../shared/lib/standardReportsFinance.js';
import {
  purchasesOrderedRows,
  purchasesPaidRows,
  purchasesReceivedRows,
} from '../shared/lib/standardReportsPurchases.js';
import { stockCoilAsAtRows } from '../shared/lib/standardReportsStock.js';
import { isInventoryMovementType } from '../shared/lib/inventoryMovementTypes.js';
import {
  advanceStockRegisterWorkflow,
  buildStockRegisterForBranch,
  captureStockRegisterClosing,
  getStockRegisterLineDetail,
  getStockRegisterWorkflow,
  listStockRegisterInbox,
  patchCoilStockForm,
  reopenStockRegisterClosing,
  saveStockRegisterBmAdjustments,
  saveStockRegisterLineClearance,
  saveStockRegisterPrintSnapshot,
  saveStockRegisterStoreChecklist,
} from './stockRegisterOps.js';
import { buildBootstrap, buildDashboardBootstrap } from './bootstrap.js';
import { DOMAIN_SNAPSHOT_BUILDERS } from './domainBootstrap.js';
import { ifNoneMatchHit, jsonWeakEtag, setWeakEtag } from './httpEtag.js';
import { buildWorkspaceRevision, workspaceRevisionEtag } from './workspaceRevision.js';
import {
  ASSOCIATED_STAFF_MANAGE_PERMS,
  ASSOCIATED_STAFF_READ_PERMS,
  CUSTOMER_AND_AR_READ_PERMS,
  canReadOperationsDomain,
  canReadSalesDomain,
  LEDGER_RELATED_PERMS,
  OPERATIONS_DOMAIN_PERMS,
  PROCUREMENT_DOMAIN_PERMS,
  REFUNDS_VISIBLE_PERMS,
  SALES_DOMAIN_PERMS,
} from './workspaceAccess.js';
import {
  allKnownPermissionKeys,
  canUseAllBranchesRollup,
  changePassword,
  clearCsrfCookie,
  clearSessionCookie,
  completePasswordReset,
  completeUserTraining,
  adminSetUserPassword,
  adminUnlockAccount,
  canRevealUserPasswords,
  createAppUserRecord,
  listAllAppUsers,
  loginWithPassword,
  logoutSession,
  setSessionTimeoutAuditHook,
  patchAppUserWorkspaceDepartment,
  canIssuePasswordResetCodes,
  issuePasswordResetForAdmin,
  requestPasswordReset,
  requireActivePassword,
  requireAuth,
  requirePermission,
  ROLE_DEFINITIONS,
  setCsrfCookie,
  setSessionCookie,
  updateAppUserPermissions,
  updateAppUserRole,
  updateAppUserStatus,
  updateUserProfile,
  deleteAppUser,
  userCanApproveEditMutations,
  userMayEditCoilLotMasterData,
  userHasPermission,
  userMaySelectSessionWorkspaceBranch,
  userMayViewManagementReports,
} from './auth.js';
import {
  bulkDeleteZeroAuditUsers,
  listZeroAuditUserCandidates,
  ZERO_AUDIT_BULK_DELETE_CONFIRM_PHRASE,
} from './userZeroAuditCleanup.js';
import { ensureHrStaffProfileForUser, ensureHrStaffProfilesForUnlinkedUsers } from './hrOps.js';
import {
  buildFinanceLiveProfileReport,
  financeProfileTokenMatches,
  openFinanceProfileMysqlConnection,
} from './financeLiveProfileReadonly.js';
import {
  userMayViewAp3CostingReadiness,
  userMayViewAccountingSubledger,
  userMayManageAccountingSubledger,
} from './financeDeskAccess.js';
import { userMayAccessAccountingGlApis } from './legacyAccountsAccess.js';
import { buildCustomPermissionOverrideAudit } from './customPermissionAudit.js';
import {
  buildCreditorsRegister,
  buildDebtorsRegister,
  clearAccountingRegisterLine,
  createAccountingRegisterLine,
  getAccountingRegisterLine,
  updateAccountingRegisterLine,
} from './accountingSubledgerOps.js';
import {
  createRegisterSettlement,
  decideRegisterSettlement,
  getRegisterSettlement,
  listRegisterSettlements,
  payRegisterSettlement,
  registerLineSettlementCapacity,
  withdrawRegisterSettlement,
} from './accountingRegisterSettlementOps.js';
import {
  createFixedAsset,
  listFixedAssets,
  updateFixedAsset,
} from './accountingPhase2Ops.js';
import { disposeFixedAsset } from './fixedAssetDisposalOps.js';
import { buildFinanceTrialExceptionSummary } from './financeTrialExceptions.js';
import { MIN_REFUND_QUOTATION_REMAINING_NGN } from '../shared/refundConstants.js';
import { buildRefundProductionFulfillmentSummary } from '../shared/lib/refundProductionFulfillment.js';
import { refundProductionAlignmentWarnings, suggestRefundCategoriesFromProduction, validateRefundProductionAlignmentAtSubmit } from './refundProductionAlignment.js';
import { buildGovernancePack, governancePackToCsv } from './governancePackOps.js';
import { buildFraudIndicatorsReport } from './fraudIndicatorsOps.js';
import { getProductionJobIntel } from './productionJobIntelOps.js';
import { buildQuotationLifecycleTimeline } from './quotationLifecycleTimelineOps.js';
import {
  buildPendingApprovalsReport,
  buildProductionStatusReport,
} from './operationalReportsOps.js';
import { conversionReasonOptionsForBand } from '../shared/productionConversionReasons.js';
import { mysqlConfigFromEnv, databaseLabel } from './mysqlDatabase.js';
import {
  assertCustomerLedgerPostingBranch,
  assertEntityBranchForWorkspaceWrite,
  assertSingleBranchWorkspaceForBulkWrite,
  assertSingleBranchWorkspaceForCreate,
  assertTreasuryAccountsBulkForWorkspace,
  resolveBootstrapBranchScope,
} from './branchScope.js';
import {
  assertCuttingListIdInWorkspace,
  assertCuttingListRowInWorkspace,
  assertDeliveryIdInWorkspace,
  assertPaymentRequestIdInWorkspace,
  assertProductIdInWorkspace,
  assertProductionJobIdInWorkspace,
  assertPurchaseOrderIdInWorkspace,
  assertQuotationIdInWorkspace,
  assertRefundIdInWorkspace,
  assertSalesReceiptIdInWorkspace,
} from './workspaceBranchGuards.js';
import { sendIdempotentReplayIfAny, storeIdempotentSuccess, normalizeIdempotencyKey } from './idempotency.js';
import { parseListQuery, sendPaginatedList, slicePage } from './listPagination.js';
import { financeHistoryListOpts, productionHistoryListOpts } from './listQueryOpts.js';
import { apiError, apiForbidden, safeErrorMessage } from './apiError.js';
import { humanizeValidationMessage } from './validationLabels.js';
import { permissionGuidanceMessage } from './permissionMessages.js';
import {
  receiptDuplicateAcrossQuotationsSignals,
  receiptDuplicateSignalsFromLedgerRows,
} from './receiptPostingGuards.js';
import {
  collectCustomerPaymentIntegrityIssues,
  customerPaymentIntegritySummary,
  duplicateQuotationCreateSignals,
  refundPaymentIntegrityIssues,
} from './customerPaymentIntegrityOps.js';
import {
  DEFAULT_BRANCH_ID,
  getBranch,
  listBranches,
  setBranchCuttingListMinPaidFraction,
} from './branches.js';
import {
  appendAuditLog,
  verifyAuditLogChain,
  assertPeriodOpen,
  cancelApprovedPaymentRequestBeforePay,
  cancelApprovedRefundBeforePay,
  decidePaymentRequest,
  decideRefundRequest,
  deleteTreasuryAccount,
  getPaymentRequestGlPreview,
  insertPaymentRequest,
  reclassifyPaymentRequestCategory,
  insertRefundRequest,
  lockAccountingPeriod,
  previewRefundRequest,
  buildRefundEconomicFloorSummary,
  quotationActiveRefundedTotalNgn,
  updatePaymentRequest,
  refundSubstitutionDataQualityIssues,
  refundCuttingListQuotationMetreIssues,
  dedupeRefundDataQualityIssues,
  getEligibleRefundQuotations,
  quotationMeetsRefundEligibility,
  reviewQuotation,
  setQuotationRefundsBlocked,
  unlockAccountingPeriod,
  upsertTreasuryAccount,
} from './controlOps.js';
import { listCustomerMasterQualityIssues } from './sales/customerMasterQualityOps.js';
import { buildExpenseCategoryMetaForActor } from '../shared/expenseCategoryPolicy.js';
import { userMayReviewPaymentRequests } from '../shared/workspaceGovernance.js';
import { buildExpenseCategoryExceptionReport, buildExpenseCategoryExceptionCsv, buildExpenseCategoryMonthlyAlert, buildExpenseCategoryOthersTrendReport } from './expenseCategoryReportOps.js';
import { suggestExpenseCategoryForActor } from '../shared/lib/expenseCategorySuggestions.js';
import {
  getPaidExpenseCategoryReclassPreview,
  reclassifyPaidExpenseCategory,
  reclassifyPaidPaymentRequestCategory,
} from './expenseCategoryReclassOps.js';
import {
  buildExpenseImportTemplateXlsx,
  parseExpenseImportWorkbook,
  previewExpenseBulkImport,
  commitExpenseBulkImport,
  normalizeExpenseImportRows,
} from './expenseBulkImport.js';
import { EXPENSE_CATEGORY_OPTIONS } from '../shared/expenseCategories.js';
import {
  ADMIN_DATA_RESET_CONFIRM_PHRASE,
  ADMIN_DATA_RESET_PRESETS,
  applyAdminDataReset,
} from './adminDataResetOps.js';
import {
  approveEditApproval,
  rejectEditApproval,
  createEditApprovalRequest,
  cuttingListEditRequiresEditApproval,
  getEditApprovalDetail,
  handlePatchWithEditApproval,
  handlePatchWithEditApprovalQuotation,
  handleWriteWithEditApproval,
  ledgerReceiptMovementRevisionRequiresEditApproval,
  expenseOutflowCorrectionRequiresEditApproval,
  listPendingEditApprovals,
  receiptFinanceSettlementRequiresEditApproval,
  stripEditApprovalFromBody,
} from './editApproval.js';
import {
  addOfficeMessage,
  convertOfficeThreadToPaymentRequest,
  convertOfficeThreadToMaterialRequest,
  createOfficeThread,
  getOfficeSummary,
  getOfficeThread,
  listOfficeDirectory,
  listOfficeThreads,
  markOfficeThreadRead,
  officeScopeFromReq,
} from './officeOps.js';
import {
  listWorkspaceRooms,
  getRoomMessages,
  markRoomRead,
  muteRoom,
  archiveRoom,
  postRoomMessage,
  editRoomMessage,
  deleteRoomMessage,
  pinRoomWorkCard,
  promoteFromRoom,
  createDmRoom,
  listActivityEvents,
  markActivityRead,
  upsertPresence,
  listPresence,
  registerWorkspaceSseClient,
} from './workspaceRoomsOps.js';
import { fileOfficeThread } from './filingNumberOps.js';
import {
  listOfficeRecordVersions,
  patchOfficeRecordByBranchManager,
} from './officeRecordOps.js';
import {
  acknowledgeOfficialNotice,
  createOfficialNotice,
  listOfficialNoticesForUser,
} from './officialNoticesOps.js';
import { addForumPost, createForumTopic, listForumTopics } from './forumOps.js';
import {
  deleteOfficeMemoDraft,
  listOfficeMemoDrafts,
  upsertOfficeMemoDraft,
} from './officeDraftOps.js';
import {
  bulkArchiveWorkItems,
  bulkMarkWorkItemsRead,
  getOfficeThreadTimeline,
  getWorkItemRelatedRecords,
  getWorkItemTimeline,
  getWorkspaceCounts,
  getWorkspaceMonitoring,
} from './workspaceOps.js';
import {
  getOfficeThreadFiling,
  listOfficeThreadFilingForUser,
  saveOfficeThreadFilingFromAi,
} from './officeFilingOps.js';
import { getOrgGovernanceLimits, setOrgGovernanceLimits } from './orgPolicy.js';
import { getCreditPolicyConfig } from './creditPolicy.js';
import {
  createCreditExceptionRequest,
  decideCreditException,
  getQuotationCreditStatus,
  listCreditExceptions,
  revokeCreditException,
  userMayViewCreditExceptions,
} from './creditExceptionOps.js';
import {
  createStaffPurchaseCreditRequest,
  decideStaffPurchaseCredit,
  getQuotationStaffPurchaseCreditStatus,
  linkSalesCustomerToStaff,
  listStaffForSalesCustomerLink,
  listStaffPurchaseCreditQueue,
  listStaffQuotationsForPurchaseCredit,
  syncQuotationStaffPurchaseFlag,
  unlinkSalesCustomerFromStaff,
  userMayLinkStaffSalesCustomer,
  userMayRequestStaffPurchaseCredit,
  userMayApproveStaffPurchaseCredit,
  userMayRejectStaffPurchaseCredit,
} from './staffPurchaseCreditOps.js';
import {
  countPendingStaffPurchaseCreditRequests,
  summarizePendingStaffPurchaseCreditByBranch,
} from './staffPurchaseCreditWorkItems.js';
import { issueZarewaFilingReference } from './referenceIssuance.js';
import {
  createInterBranchRequest,
  listInterBranchRequestsForUser,
  resolveInterBranchRequest,
} from './interBranchOfficeOps.js';
import { buildMdOperationsPack } from './mdOperationsPack.js';
import { registerHrApi } from './hrApi.js';
import { registerOtApi } from './otApi.js';
import { registerAiKnowledgeCenterRoutes } from './aiKnowledgeCenter/index.js';
import { registerAiIntelligenceRouterRoutes } from './aiIntelligenceRouter/index.js';
import {
  registerUnifiedAiRoutes,
  runUnifiedHelpChat,
  enrichExpenseSuggest,
} from './aiUnificationLayer/index.js';
import {
  registerAiAutomationRoutes,
  processExpenseAutomationHook,
} from './aiAutomationEngine/index.js';
import { registerAiProviderRoutes } from './aiProviders/index.js';
import { registerPublicCareersApi } from './hrRecruiting.js';
import { listMdAttentionInbox } from './mdAttentionOps.js';
import { buildExecutiveDashboard, resolveExecDashboardBranchScope, resolveExecDashboardPeriod } from './execDashboardOps.js';
import { buildExecCustomerBrief, buildMdCustomerIntelPack } from './mdCustomerIntelOps.js';
import { buildMdTracePack } from './mdTraceOps.js';
import {
  getExecReservePolicyResponse,
  RESERVE_POLICY_MANAGE_PERMISSION,
  setExecReservePolicy,
} from './execReservePolicyOps.js';
import { getMdReviewNote, saveMdReviewNote } from './execReviewNoteOps.js';
import { enrichQuotationAuditPayload, listManagerPoAudit } from './mdJourneyOps.js';
import { buildExecutiveDailyPack, buildExecutiveWeeklyPack } from './mdReportPacks.js';
import { OFFICE_OPERATION_TEMPLATES } from '../shared/officeComposeTemplates.js';
import {
  appendWorkItemDecision,
  createMaterialRequest,
  createMaintenanceWorkOrder,
  createWorkItem,
  listMachines,
  officeKeyForUser,
  upsertWorkItemBySource,
  ensureWorkItemsForVisibleOfficeThreads,
  ensureWorkItemForOfficeThread,
  getUnifiedWorkItem,
  syncDerivedWorkItems,
  linkWorkItemToOfficeThread,
  listMaterialRequests,
  listMaintenancePlans,
  listMaintenanceWorkOrders,
  listUnifiedWorkItems,
  userMayDecideWorkItem,
} from './workItems.js';
import {
  createMaintenanceVendor,
  listMaintenanceTechnicians,
  listMaintenanceVendors,
  updateMaintenanceVendor,
  updateStaffTechnicianFlags,
} from './maintenanceVendorsOps.js';
import {
  acknowledgeMaintenanceWorkOrder,
  assignMaintenanceWorkOrder,
  attachWorkOrderFinance,
  createMaintenanceCostLine,
  getMaintenanceWorkOrder,
  linkWorkOrderPaymentRequest,
  listOpenMaintenanceIssues,
  resolveMaintenanceWorkOrder,
} from './maintenanceWorkOrderOps.js';
import { buildMaintenanceInsightsPack } from './maintenanceInsightsOps.js';
import { buildManagerBranchBenchmark } from './managerBranchBenchmarkOps.js';
import { mergeManagerTargetsBlob } from '../shared/lib/managerOrgTargets.js';
import { mergeOrgStoreRestockBlob, normalizeOrgStoreRestock } from './orgStoreRestock.js';
import { createBranchShiftNote, listBranchShiftNotes } from './branchShiftNotesOps.js';
import { createChecklistEvent, listChecklistEvents } from './checklistEventsOps.js';
import { listOtBoard } from './hrOtBoardOps.js';
import { buildOpsHealthAnalyticsPack, opsHealthAnalyticsToCsv } from './opsHealthAnalyticsOps.js';
import {
  createCustomerComplaint,
  getCustomerComplaint,
  listCustomerComplaints,
  updateCustomerComplaint,
  COMPLAINT_CATEGORIES,
  COMPLAINT_CHANNELS,
  COMPLAINT_SEVERITIES,
} from './customerComplaintsOps.js';
import { deleteMasterDataRecord, listMasterData, upsertMasterDataRecord } from './masterData.js';
import { parseSupplierProfileJson } from './supplierProfile.js';
import {
  applyCompletedProductionAccessoryCorrections,
  applyCompletedProductionCoilCorrections,
  applyCompletedProductionStoneFlatsheetCorrections,
  applyCompletedProductionStoneMetresCorrections,
  applyProductionCompletionAdjustment,
  cancelProductionJob,
  completeProductionJob,
  listProductionJobCoilsForJob,
  listProductionJobCoils,
  listCoilProductionHolders,
  listCoilProductionBookReconciliationIssues,
  summarizeCoilProductionHoldersBook,
  recalculateAllCoilProductionJobStock,
  reconcileCoilReservationFromProductionJobs,
  recalculateProductionJobCoilStock,
  syncProductionJobCoilConsumedWeightsForCoil,
  previewProductionConversion,
  saveProductionCoilRunLogDraft,
  returnProductionJobToPlanned,
  saveProductionJobAllocations,
  signOffProductionManagerReview,
  startProductionJob,
} from './productionTraceability.js';
import {
  getCustomer,
  listQuotations,
  listQuotationsForCustomer,
  listProductionJobsForQuotationRefs,
  listQuotationIds,
  getQuotation,
  quotationLinkedToProductionContext,
  getCuttingList,
  listLedgerEntries,
  countLedgerEntries,
  listLedgerEntriesForCustomer,
  countLedgerEntriesForCustomer,
  listLedgerEntriesForQuotation,
  listSuppliers,
  listTransportAgents,
  listAssociatedStaff,
  listRefunds,
  listExpenses,
  getRefundIntelligenceForQuotation,
  listAdvanceInEvents,
  listAuditLog,
  listAuditLogNdjsonRows,
  listApprovalActions,
  listPeriodLocks,
  listCustomerCrmInteractions,
  listCoilLots,
  searchCoilLots,
  listPurchaseOrders,
  listInventoryCoilSnapshots,
  listCoilControlEvents,
  listStockMovementsForProduct,
  listStockMovementsForBranchPeriod,
  listStockMovementsForBranchThrough,
  listProductionJobs,
  listDeliveries,
  listProductionJobAccessoryUsage,
  listProducts,
  getJsonBlob,
  setJsonBlob,
  workspaceReportAggregateCounts,
  dashboardSummary,
  execOrgSummary,
  listManagementItems,
  listManagerQuotationAudit,
  listBankReconciliation,
  getPaymentRequestDetail,
  getCustomerRefundDetail,
  listSalesReceipts,
  enrichSalesReceiptRowsWithCashFromLedger,
  listTreasuryMovements,
  procurementDashboardSummary,
  procurementSpendTrend,
  procurementSupplierScorecard,
  procurementPayablesAging,
  procurementCoilRisk,
  procurementAlerts,
  salesDashboardSummary,
  salesDashboardRevenueTrend,
  salesDashboardReceivablesAging,
  salesDashboardTopCustomers,
  salesDashboardDemandMix,
  salesDashboardAlerts,
} from './readModel.js';
import { quotationPaymentCashBreakdown } from './quotationPaymentCash.js';
import { recalculateQuotationIntegrity, listStaleOpenRefundsForQuotation } from './quotationRecalcOrchestrator.js';
import { auditQuotationLineIntegrity } from './quotationLineIntegrityAudit.js';
import {
  approveMdPriceExceptionForQuotation,
  approveBranchManagerPriceExceptionForQuotation,
  deletePriceListItem,
  listPriceListItems,
  priceListItemsToCsv,
  quotationPriceViolations,
  upsertPriceListItem,
  normalizePricingAsAtIso,
  quotationPricingAsAtIso,
} from './pricingOps.js';
import { getPricingPolicyBundle, patchPricingPolicyBundle } from './pricingPolicyOps.js';
import { buildCustomerPriceBookHtml } from './customerPriceBook.js';
import { buildMaterialWorkbookAllHtml } from './materialWorkbookAllHtml.js';
import {
  deleteMaterialPricingSheetRow,
  listMaterialPricingEvents,
  listMaterialPricingSheet,
  publishMaterialPricingSheet,
  upsertMaterialPricingSheetRow,
  upsertMaterialPricingSheetRowsBulk,
} from './materialPricingOps.js';
import { workspaceQuickSearch } from './workspaceSearchOps.js';
import {
  logWorkspaceSearchMiss,
  rebuildWorkspaceSearchFts,
  workspaceSearchFtsReady,
} from './workspaceSearchFts.js';
import { insertLedgerRows } from './writeOps.js';
import { resolveQuotedUnitPrice } from './pricingResolve.js';
import { ensureStoneFlatsheetProduct, ensureStoneProduct, isStoneMeterQuotationLinesJson } from './stoneInventory.js';
import * as write from './writeOps.js';
import { recordBankCharge } from './bankChargeOps.js';
import * as refundCreditApplyOps from './refundCreditApplyOps.js';
import {
  allocateBankDepositTx,
  findSimilarOpenBankDeposits,
  getBankDepositById,
  listBankDepositAllocationsForDeposit,
  listBankDepositDuplicateExceptions,
  listBankDeposits,
  mergeBankDepositDuplicate,
  reclassBankDeposit,
  registerBankDeposit,
  releaseBankDepositReservation,
  reserveBankDeposit,
  reverseBankDeposit,
} from './bankDepositOps.js';
import { BANK_DEPOSIT_ALLOC_KIND_ADVANCE, BANK_DEPOSIT_ALLOC_KIND_RECEIPT } from '../shared/lib/bankDeposits.js';
import {
  approveMaterialIncident,
  computePoolSummary,
  createCoilDamageMaterialIncident,
  createMaterialIncidentDraft,
  listPendingCoilDamageIncidents,
  createRefundFromMaterialIncident,
  getMaterialIncident,
  getMaterialIncidentAttachment,
  getMaterialIncidentPrintPayload,
  issueMaterialIncidentMeters,
  listMaterialIncidents,
  materialIncidentLossReport,
  materialIncidentAgingReport,
  materialIncidentPoolReconciliationReport,
  rejectMaterialIncident,
  submitMaterialIncident,
  unlockMaterialIncidentEdit,
  updateMaterialIncidentDraft,
  voidMaterialIncident,
} from './materialIncidentOps.js';
import crypto from 'node:crypto';
import {
  syncFinancePoTransportWorkItem,
  syncFinanceBankReconExceptionWorkItem,
  createCollectionsFollowUpWorkItem,
} from './financeWorkItems.js';
import {
  buildBankReconFingerprintSetForBranch,
  partitionBankReconImportRows,
} from './bankReconImportCore.js';
import { registerIntegrationReadApi, hashToken as hashIntegrationToken } from './integrationReadApi.js';
import {
  createInterBranchLoan,
  getInterBranchLoan,
  interBranchLoanBalances,
  listInterBranchLoans,
  mdApproveInterBranchLoan,
  mdRejectInterBranchLoan,
  recordInterBranchLoanRepayment,
} from './interBranchLoanOps.js';
import {
  listGlAccounts,
  listGlActivityLines,
  listGlJournalEntries,
  listGlJournalLinesForJournal,
  postBalancedJournal,
  trialBalanceRows,
  tryPostCustomerAdvanceGl,
  tryPostCustomerReceiptGl,
} from './glOps.js';
import {
  buildFinanceReconciliationPackEnvelope,
  getCashFlowPack,
  getReconciliationPack,
  isValidFinancePackPeriodKey,
} from './accountingReconciliationOps.js';
import { getAccountingStatementsPack } from './accountingStatementsOps.js';
import {
  getOpeningBalanceStatus,
  openingBalanceSourceId,
  postOpeningBalanceJournal,
  ensureArchitecturalGlAccounts,
} from './accountingPostingOps.js';
import { buildOpeningPackReport, postOpeningPackJournal } from './accountingOpeningPackOps.js';
import { buildControlTieOutReport } from './accountingControlTieOutOps.js';
import { buildMonthEndCloseChecklist } from './accountingCloseOps.js';
import { buildCutoverActionPlan } from './accountingCutoverPlanOps.js';
import { buildAccountingDeskOverview } from './accountingDeskOverviewOps.js';
import { previewDepreciationRun, postDepreciationRun } from './depreciationRunOps.js';
import {
  payrollGlStatusForRun,
  tryPostPayrollAccrualGlTx,
  tryPostPayrollStatutoryRemittanceGlTx,
} from './payrollGlOps.js';
import {
  listInTransitLoads,
  syncInTransitLoadFromGrn,
  syncInTransitLoadFromPoLink,
  syncInTransitLoadFromTransportPost,
} from './inTransitOps.js';
import { readAiAssistConfig, runAiChat, runOfficeMemoPolish } from './aiAssist.js';
import { buildAiContextForRequest, readAiStatusForRequest } from './aiAssistContext.js';
import { loadBusinessIntelligencePack } from './businessIntelligenceOps.js';
import { buildBusinessIntelligenceXlsx } from './businessIntelligenceExport.js';
import { buildEnteredDataXlsx, collectEnteredDataPack, enteredDataFilename } from './enteredDataExport.js';
import { BI_ENGINE_REV } from '../shared/lib/businessIntelligence.js';
import { handleMemoAssist } from './helpMemoAssist.js';
import { sanitizeZarePageContext, sanitizeWorkItemsForClient } from '../shared/lib/workspaceSanitize.js';
import { buildHelpPersonalizationFromSnapshot, computeMergedLearnedBoosts, insertHelpQueryLog, recordHelpQuerySignal } from './helpQueryOps.js';
import { getRunaIntelligenceDashboard } from './helpIntelligenceAdmin.js';
import { runHelpAnalyticsJob } from './helpAnalytics.js';
import { reviewSuggestedArticle } from '../shared/lib/helpGapAnalysis.js';
import { RUNA_DESIGN_LIMITS } from '../shared/lib/helpDesignLimits.js';
import { readRunaAiConfig } from './helpAiService.js';
import { buildLoginSecuritySummary, listActiveSessions } from './sessionSecurityOps.js';
import { HELP_ARTICLE_COUNT } from '../shared/lib/helpKnowledge.js';
import { allowRateLimit, clientIp, isRateLimited, skipAuthedRateLimit } from './rateLimit.js';
const loginAttemptBuckets = new Map();
const forgotPasswordBuckets = new Map();
const ledgerPostBuckets = new Map();
const bankFinanceImportBuckets = new Map();
const aiChatBuckets = new Map();
const helpChatBuckets = new Map();
const aiKnowledgeBuckets = new Map();
const aiRouterBuckets = new Map();
const aiUnifiedBuckets = new Map();
const aiAutomationBuckets = new Map();
const workItemSyncLastAt = new Map();
const WORK_ITEM_SYNC_DEBOUNCE_MS = 30_000;
/** @type {Map<string, { payload: object; etag: string; expires: number }>} */
const bootstrapPollCache = new Map();
const BOOTSTRAP_POLL_CACHE_MS = Math.max(
  1000,
  Math.min(30_000, Number(process.env.ZAREWA_BOOTSTRAP_POLL_CACHE_MS) || 1000)
);

function bootstrapPayloadEtag(payload) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64');
  return `W/"${hash.slice(0, 48)}"`;
}

function bootstrapPollCacheKey(req, { branchScope, mode, includeControls, includeUsers }) {
  return [
    String(req.user?.id || ''),
    String(branchScope || ''),
    String(mode || ''),
    includeControls ? '1' : '0',
    includeUsers ? '1' : '0',
  ].join(':');
}

function clearBootstrapPollCacheForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return;
  const prefix = `${uid}:`;
  for (const key of bootstrapPollCache.keys()) {
    if (key.startsWith(prefix)) bootstrapPollCache.delete(key);
  }
}

function respondBootstrap(res, payload, ifNoneMatch) {
  const etag = bootstrapPayloadEtag(payload);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }
  res.setHeader('ETag', etag);
  return res.json(payload);
}

function shouldSyncDerivedWorkItemsNow(userId, branchId) {
  const uid = String(userId || '').trim();
  const bid = String(branchId || '').trim();
  if (!uid) return false;
  const key = `${uid}:${bid}`;
  const now = Date.now();
  const last = workItemSyncLastAt.get(key) || 0;
  if (now - last < WORK_ITEM_SYNC_DEBOUNCE_MS) return false;
  workItemSyncLastAt.set(key, now);
  return true;
}

const STRICT_BRANCH_AUDIT_TABLES = [
  { table: 'customers', idColumn: 'customer_id' },
  { table: 'customer_crm_interactions', idColumn: 'id' },
  { table: 'suppliers', idColumn: 'supplier_id' },
  { table: 'transport_agents', idColumn: 'id' },
  { table: 'products', idColumn: 'product_id' },
  { table: 'quotations', idColumn: 'id' },
  { table: 'ledger_entries', idColumn: 'id' },
  { table: 'sales_receipts', idColumn: 'id' },
  { table: 'cutting_lists', idColumn: 'id' },
  { table: 'purchase_orders', idColumn: 'po_id' },
  { table: 'coil_lots', idColumn: 'coil_no' },
  { table: 'deliveries', idColumn: 'id' },
  { table: 'production_jobs', idColumn: 'id' },
  { table: 'customer_refunds', idColumn: 'refund_id' },
  { table: 'expenses', idColumn: 'expense_id' },
];

function tableHasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

/** @param {Map<string, { count: number; resetAt: number }>} buckets */
function rateLimitAuthedUser(buckets, label, maxEvents, windowMs) {
  return (req, res, next) => {
    if (skipAuthedRateLimit) return next();
    const uid = String(req.user?.id || '').trim();
    if (!uid) return next();
    const key = `${label}:${uid}`;
    if (!allowRateLimit(buckets, key, maxEvents, windowMs)) {
      return res.status(429).json({
        ok: false,
        error: 'Too many requests. Try again shortly.',
        code: 'RATE_LIMIT',
      });
    }
    return next();
  };
}

const ledgerPostMax = (() => {
  const raw = process.env.ZAREWA_LEDGER_POST_MAX;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    return Math.max(1, Math.min(50_000, Number.isFinite(n) ? n : 45));
  }
  return 45;
})();
const ledgerPostWindowMs = (() => {
  const raw = process.env.ZAREWA_LEDGER_POST_WINDOW_MS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    return Math.max(5_000, Math.min(3_600_000, Number.isFinite(n) ? n : 60_000));
  }
  return 60_000;
})();

function ledgerPostRateLimit() {
  return rateLimitAuthedUser(ledgerPostBuckets, 'ledger-post', ledgerPostMax, ledgerPostWindowMs);
}

const loginDelayMs = () =>
  new Promise((resolve) => setTimeout(resolve, 90 + Math.floor(Math.random() * 70)));

function normalizeTreasuryLines(body) {
  const rawLines = Array.isArray(body?.paymentLines)
    ? body.paymentLines
    : body?.treasuryAccountId
      ? [
          {
            treasuryAccountId: body.treasuryAccountId,
            amountNgn: body.amountNgn,
            reference: body.reference ?? body.bankReference,
          },
        ]
      : [];
  return rawLines
    .map((line) => ({
      treasuryAccountId: Number(line?.treasuryAccountId),
      amountNgn: Math.round(Number(line?.amountNgn) || 0),
      reference: String(line?.reference ?? '').trim(),
      note: String(line?.note ?? '').trim(),
      dateISO: String(line?.dateISO ?? line?.postedAtISO ?? '').trim().slice(0, 10),
    }))
    .filter((line) => line.treasuryAccountId && line.amountNgn > 0);
}

function totalTreasuryLines(lines) {
  return (lines || []).reduce((sum, line) => sum + (Number(line.amountNgn) || 0), 0);
}

/** Top-level bankReference or, when absent, joined payment line references (API / scripts compatibility). */
function effectiveReceiptBankReference(body) {
  const direct = String(body?.bankReference ?? '').trim();
  if (direct) return direct;
  const lines = normalizeTreasuryLines(body || {});
  const parts = lines.map((l) => String(l.reference || '').trim()).filter(Boolean);
  if (parts.length) return parts.join(' | ');
  return '';
}

function recentAdvanceDuplicateSignals(db, { customerID, amountNgn, bankReference, dateISO }) {
  const amount = Math.round(Number(amountNgn) || 0);
  if (!(customerID && amount > 0)) return [];
  const rows = db
    .prepare(
      `SELECT le.id, le.amount_ngn, le.at_iso, le.bank_reference
       FROM ledger_entries le
       WHERE le.type = 'ADVANCE_IN' AND le.customer_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM ledger_entries rev
           WHERE rev.type = 'ADVANCE_REVERSAL'
             AND (rev.bank_reference = 'REVERSAL_OF:' || le.id OR rev.note LIKE '%' || le.id || '%')
         )
       ORDER BY le.at_iso DESC
       LIMIT 40`
    )
    .all(customerID);
  const signals = receiptDuplicateSignalsFromLedgerRows(rows, { amountNgn, bankReference });
  const day = String(dateISO || '').slice(0, 10);
  if (day && !signals.some((s) => s.code === 'DUPLICATE_AMOUNT')) {
    for (const row of rows) {
      const rowAmount = Math.round(Number(row.amount_ngn) || 0);
      const rowDay = String(row.at_iso || '').slice(0, 10);
      if (rowAmount === amount && rowDay === day) {
        signals.push({
          code: 'DUPLICATE_AMOUNT_SAME_DAY',
          message: `An advance for ₦${amount.toLocaleString('en-NG')} was already posted on ${day} (${row.id}).`,
          advanceId: row.id,
        });
        break;
      }
    }
  }
  return signals;
}

function recentReceiptDuplicateSignals(db, { customerID, quotationId, amountNgn, bankReference, dateISO }) {
  const amount = Math.round(Number(amountNgn) || 0);
  if (!(customerID && quotationId && amount > 0)) return [];
  const rows = db
    .prepare(
      `SELECT id, amount_ngn, at_iso, bank_reference
       FROM ledger_entries
       WHERE type = 'RECEIPT' AND customer_id = ? AND quotation_ref = ?
       ORDER BY at_iso DESC
       LIMIT 40`
    )
    .all(customerID, quotationId);
  const crossRows = db
    .prepare(
      `SELECT id, amount_ngn, at_iso, quotation_ref
       FROM ledger_entries
       WHERE type = 'RECEIPT' AND customer_id = ?
       ORDER BY at_iso DESC
       LIMIT 80`
    )
    .all(customerID);
  return [
    ...receiptDuplicateSignalsFromLedgerRows(rows, { amountNgn, bankReference }),
    ...receiptDuplicateAcrossQuotationsSignals(crossRows, { quotationId, amountNgn, dateISO }),
  ];
}

function requireManagementReportsView(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: 'Sign in required.', code: 'AUTH_REQUIRED' });
  }
  if (!userMayViewManagementReports(req.user)) {
    return res.status(403).json({ ok: false, error: 'You do not have permission for this action.', code: 'FORBIDDEN' });
  }
  return next();
}

function requireCoilSnapshotCapture(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: 'Sign in required.', code: 'AUTH_REQUIRED' });
  }
  if (!userMayViewManagementReports(req.user)) {
    return res.status(403).json({ ok: false, error: 'You do not have permission for this action.', code: 'FORBIDDEN' });
  }
  if (!userHasPermission(req.user, 'finance.view') && !userHasPermission(req.user, 'reports.view')) {
    return res.status(403).json({ ok: false, error: 'You do not have permission for this action.', code: 'FORBIDDEN' });
  }
  return next();
}

/**
 * @param {import('express').Express} app
 * @param {object} db MySQL adapter from `createDatabase`
 */
import { registerMobileApi } from './mobileApi.js';
import { registerLivenessRoutes } from './http/livenessRoutes.js';
import { registerFinanceDiagnosticRoutes } from './http/financeDiagnosticRoutes.js';
import { registerPartnerWalletRoutes } from './http/partnerWalletRoutes.js';
import { registerRefundClaimingStaffRoutes, ensureQuotationHandlerSalesCustomer } from './http/refundClaimingStaffRoutes.js';
import { registerWorkspaceListRoutes } from './http/workspaceListRoutes.js';
import { registerMaintenanceRoutes } from './http/maintenanceRoutes.js';
import { registerChairmanOfficeRoutes } from './http/chairmanOfficeRoutes.js';

export function registerHttpApi(app, db) {
  registerMobileApi(app, db);

  setSessionTimeoutAuditHook(({ user }) => {
    appendAuditLog(db, {
      actor: user,
      action: 'session.timeout',
      entityKind: 'user',
      entityId: user?.id ?? '',
      note: 'Session expired due to inactivity',
    });
  });

  const livenessCapabilities = {
    cuttingListRegisterProduction: true,
    /** Confirms this process includes Office Desk routes (e.g. POST /api/office/ai/polish-memo). */
    officeDesk: true,
    materialIncidentBoot: 'po-line-type-migrate-v4',
    /** Present when BI analytics engine includes productionKgInRange fix (42372a4+). */
    businessIntelligence: BI_ENGINE_REV,
    /** Phase B3a trial exception API (GET /api/finance/trial-exceptions). */
    trialExceptionsB3a: 'v1',
    fastProductionBoot: 'v1',
    ...accountingPolicyV1HealthCapabilities(readFinanceFeatureFlags()),
  };
  registerLivenessRoutes(app, { livenessCapabilities });

  /**
   * Read-only finance desk data profile (aggregates only, no PII).
   * Auth: header X-Finance-Profile-Token matching env ZAREWA_FINANCE_PROFILE_TOKEN (temporary),
   * or signed-in user with audit.view or settings.view.
   */
  app.get('/api/admin/finance-live-profile', async (req, res) => {
    try {
      const tokenConfigured = Boolean(String(process.env.ZAREWA_FINANCE_PROFILE_TOKEN || '').trim());
      if (process.env.NODE_ENV === 'production' && !tokenConfigured && !req.user) {
        return res.status(503).json({ ok: false, error: 'Finance profile endpoint is disabled.' });
      }
      const tokenOk = financeProfileTokenMatches(req);
      const userOk =
        req.user &&
        (userHasPermission(req.user, 'audit.view') || userHasPermission(req.user, 'settings.view'));
      if (!tokenOk && !userOk) {
        return res.status(403).json({
          ok: false,
          error: 'Forbidden. Set ZAREWA_FINANCE_PROFILE_TOKEN or sign in as admin/audit.',
        });
      }
      const cfg = mysqlConfigFromEnv();
      const conn = await openFinanceProfileMysqlConnection(cfg);
      try {
        const report = await buildFinanceLiveProfileReport(conn, { target: databaseLabel(cfg) });
        return res.json(report);
      } finally {
        await conn.end();
      }
    } catch (e) {
      console.error('[finance-live-profile]', e);
      return res.status(500).json({ ok: false, error: 'Profile failed.' });
    }
  });

  registerFinanceDiagnosticRoutes(app, db);
  registerPartnerWalletRoutes(app, db);
  registerRefundClaimingStaffRoutes(app, db);
  registerMaintenanceRoutes(app, db);
  registerChairmanOfficeRoutes(app, db);

  /** Accounting sub-ledgers — Creditors, Debtors, Assets register. */
  function accountingListBranchId(req) {
    const branchScope = resolveBootstrapBranchScope(req);
    return branchScope === 'ALL' ? null : branchScope;
  }

  function assertRegisterLineWorkspaceWrite(req, lineId) {
    const found = getAccountingRegisterLine(db, lineId);
    if (!found.ok) return { ok: false, status: 404, error: found.error };
    const gate = assertEntityBranchForWorkspaceWrite(
      req.user,
      found.line.branchId,
      req.workspaceBranchId,
      req.workspaceViewAll
    );
    if (!gate.ok) return { ok: false, status: 403, error: gate.error };
    return { ok: true, line: found.line };
  }

  function assertRegisterLineWorkspaceRead(req, lineId) {
    const found = getAccountingRegisterLine(db, lineId);
    if (!found.ok) return { ok: false, status: 404, error: found.error };
    const lineBranch = String(found.line.branchId || '').trim();
    const workspaceBranch = String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
    if (req.workspaceViewAll && canUseAllBranchesRollup(req.user)) {
      return { ok: true, line: found.line };
    }
    if (!lineBranch || lineBranch === workspaceBranch) {
      return { ok: true, line: found.line };
    }
    return {
      ok: false,
      status: 403,
      error: `This register line belongs to branch ${lineBranch}. Switch workspace to that branch, or turn on All branches view.`,
    };
  }

  function assertFixedAssetWorkspaceWrite(req, assetId) {
    const row = db.prepare(`SELECT branch_id FROM fixed_assets WHERE id = ?`).get(String(assetId || '').trim());
    if (!row) return { ok: false, status: 404, error: 'Asset not found.' };
    const gate = assertEntityBranchForWorkspaceWrite(
      req.user,
      row.branch_id,
      req.workspaceBranchId,
      req.workspaceViewAll
    );
    if (!gate.ok) return { ok: false, status: 403, error: gate.error };
    return { ok: true };
  }

  app.get('/api/accounting/creditors', requireAuth, (req, res) => {
    try {
      if (!userMayViewAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const branchId = accountingListBranchId(req);
      return res.json(buildCreditorsRegister(db, { branchId }));
    } catch (e) {
      console.error('[accounting-creditors]', e);
      return res.status(500).json({ ok: false, error: 'Creditors register failed.' });
    }
  });

  app.get('/api/accounting/debtors', requireAuth, (req, res) => {
    try {
      if (!userMayViewAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const branchId = accountingListBranchId(req);
      return res.json(buildDebtorsRegister(db, { branchId }));
    } catch (e) {
      console.error('[accounting-debtors]', e);
      return res.status(500).json({ ok: false, error: 'Debtors register failed.' });
    }
  });

  app.get('/api/accounting/assets', requireAuth, (req, res) => {
    try {
      if (!userMayViewAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(listFixedAssets(db, branchScope));
    } catch (e) {
      console.error('[accounting-assets]', e);
      return res.status(500).json({ ok: false, error: 'Fixed assets register failed.' });
    }
  });

  app.post('/api/accounting/register-lines', requireAuth, (req, res) => {
    try {
      if (!userMayManageAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return res.status(403).json({ ok: false, error: createGate.error });
      const body = {
        ...(req.body || {}),
        branchId: String(req.body?.branchId || req.workspaceBranchId || '').trim(),
      };
      const branchGate = assertEntityBranchForWorkspaceWrite(
        req.user,
        body.branchId,
        req.workspaceBranchId,
        req.workspaceViewAll
      );
      if (!branchGate.ok) return res.status(403).json({ ok: false, error: branchGate.error });
      const result = createAccountingRegisterLine(db, body, req.user);
      if (!result.ok) return res.status(400).json(result);
      return res.status(201).json(result);
    } catch (e) {
      console.error('[accounting-register-create]', e);
      return res.status(500).json({ ok: false, error: 'Could not create register line.' });
    }
  });

  app.post('/api/accounting/register-lines/:lineId/clear', requireAuth, (req, res) => {
    try {
      if (!userMayManageAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const lineGate = assertRegisterLineWorkspaceWrite(req, req.params.lineId);
      if (!lineGate.ok) return res.status(lineGate.status).json({ ok: false, error: lineGate.error });
      const result = clearAccountingRegisterLine(db, req.params.lineId, req.user);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error('[accounting-register-clear]', e);
      return res.status(500).json({ ok: false, error: 'Could not clear register line.' });
    }
  });

  app.patch('/api/accounting/register-lines/:lineId', requireAuth, (req, res) => {
    try {
      if (!userMayManageAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const lineGate = assertRegisterLineWorkspaceWrite(req, req.params.lineId);
      if (!lineGate.ok) return res.status(lineGate.status).json({ ok: false, error: lineGate.error });
      const body = {
        ...(req.body || {}),
        branchId: String(req.body?.branchId ?? lineGate.line.branchId ?? req.workspaceBranchId ?? '').trim(),
      };
      const branchGate = assertEntityBranchForWorkspaceWrite(
        req.user,
        body.branchId,
        req.workspaceBranchId,
        req.workspaceViewAll
      );
      if (!branchGate.ok) return res.status(403).json({ ok: false, error: branchGate.error });
      const result = updateAccountingRegisterLine(db, req.params.lineId, body, req.user);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error('[accounting-register-update]', e);
      return res.status(500).json({ ok: false, error: 'Could not update register line.' });
    }
  });

  app.get('/api/accounting/settlements', requireAuth, (req, res) => {
    try {
      if (!userMayViewAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const branchId = accountingListBranchId(req);
      const result = listRegisterSettlements(db, {
        registerLineId: req.query?.registerLineId || req.query?.lineId,
        status: req.query?.status,
        branchId,
      });
      return res.json(result);
    } catch (e) {
      console.error('[accounting-settlements-list]', e);
      return res.status(500).json({ ok: false, error: 'Could not list settlements.' });
    }
  });

  app.get('/api/accounting/settlements/:settlementId', requireAuth, (req, res) => {
    try {
      const canSee =
        userMayViewAccountingSubledger(req.user) ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'refunds.approve') ||
        userHasPermission(req.user, '*');
      if (!canSee) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const result = getRegisterSettlement(db, req.params.settlementId);
      if (!result.ok) return res.status(404).json(result);
      const lineId = String(result.settlement?.registerLineId || '').trim();
      if (lineId) {
        const lineGate = assertRegisterLineWorkspaceRead(req, lineId);
        if (!lineGate.ok) {
          return res.status(lineGate.status === 403 ? 403 : 404).json({ ok: false, error: lineGate.error });
        }
      }
      return res.json(result);
    } catch (e) {
      console.error('[accounting-settlement-get]', e);
      return res.status(500).json({ ok: false, error: 'Could not load settlement.' });
    }
  });

  app.get('/api/accounting/register-lines/:lineId/settlement-capacity', requireAuth, (req, res) => {
    try {
      if (!userMayViewAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const lineGate = assertRegisterLineWorkspaceRead(req, req.params.lineId);
      if (!lineGate.ok && lineGate.status === 403) {
        return res.status(403).json({ ok: false, error: lineGate.error });
      }
      if (!lineGate.ok) return res.status(404).json({ ok: false, error: lineGate.error });
      const capacity = registerLineSettlementCapacity(db, req.params.lineId);
      if (capacity.ok === false) return res.status(404).json(capacity);
      return res.json(capacity);
    } catch (e) {
      console.error('[accounting-settlement-capacity]', e);
      return res.status(500).json({ ok: false, error: 'Could not read settlement capacity.' });
    }
  });

  app.post('/api/accounting/register-lines/:lineId/settlements', requireAuth, (req, res) => {
    try {
      if (!userMayManageAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const lineGate = assertRegisterLineWorkspaceWrite(req, req.params.lineId);
      if (!lineGate.ok) return res.status(lineGate.status).json({ ok: false, error: lineGate.error });
      const result = createRegisterSettlement(
        db,
        {
          ...(req.body || {}),
          registerLineId: req.params.lineId,
          branchId: lineGate.line.branchId || req.workspaceBranchId,
        },
        req.user
      );
      if (!result.ok) return res.status(400).json(result);
      const settlement = result.settlement;
      if (settlement) {
        const amt = Math.round(Number(settlement.amountNgn) || 0);
        // Always Executive office — Finance/MD approve; do not send to branch_manager.
        upsertWorkItemBySource(db, {
          actor: req.user,
          sourceKind: 'register_settlement',
          sourceId: String(settlement.settlementId || ''),
          branchId: settlement.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID,
          officeKey: 'executive',
          responsibleOfficeKey: 'executive',
          documentClass: 'approval',
          documentType: 'register_settlement',
          status: 'pending',
          title: `Register withdrawal ${String(settlement.settlementId || '').trim()}`,
          summary: `${settlement.partyName || 'Party'} · ₦${amt.toLocaleString('en-NG')} · ${String(settlement.reason || 'Withdrawal request').trim()}`,
          requiresApproval: true,
          visibilityEntries: [
            { visibilityKind: 'office_key', visibilityValue: 'executive' },
            { visibilityKind: 'office_key', visibilityValue: 'finance' },
          ],
          data: {
            amountNgn: amt,
            routePath: '/exec',
            routeState: { tab: 'decide', settlementId: settlement.settlementId },
          },
        });
      }
      return res.status(201).json(result);
    } catch (e) {
      console.error('[accounting-settlement-create]', e);
      return res.status(500).json({ ok: false, error: 'Could not create settlement request.' });
    }
  });

  app.post('/api/accounting/settlements/:settlementId/decision', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'refunds.approve') ||
        userHasPermission(req.user, '*');
      if (!can) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const result = decideRegisterSettlement(db, req.params.settlementId, req.body || {}, req.user);
      if (result.ok) {
        try {
          const outcome = String(req.body?.status || '').trim() || 'reviewed';
          const settlement = result.settlement;
          const amt = Math.round(Number(settlement?.approvedAmountNgn || settlement?.amountNgn) || 0);
          const approved = String(outcome).toLowerCase() === 'approved';
          // After MD/finance approval, hand off to Finance office for cashier payout.
          const target = upsertWorkItemBySource(db, {
            actor: req.user,
            sourceKind: 'register_settlement',
            sourceId: String(req.params.settlementId || ''),
            branchId: settlement?.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID,
            officeKey: approved ? 'finance' : 'executive',
            responsibleOfficeKey: approved ? 'finance' : 'executive',
            documentClass: approved ? 'request' : 'approval',
            documentType: 'register_settlement',
            status: approved ? 'awaiting_payment' : outcome.toLowerCase(),
            title: approved
              ? `Pay register withdrawal ${String(req.params.settlementId || '').trim()}`
              : `Register settlement ${String(req.params.settlementId || '').trim()}`,
            summary:
              String(req.body?.note || '').trim() ||
              `${settlement?.partyName || 'Party'} · ₦${amt.toLocaleString('en-NG')}${
                approved ? ' · Approved — record treasury payout' : ''
              }`,
            requiresApproval: !approved,
            requiresResponse: approved,
            closedAtIso: approved ? '' : undefined,
            visibilityEntries: [
              { visibilityKind: 'office_key', visibilityValue: 'executive' },
              { visibilityKind: 'office_key', visibilityValue: 'finance' },
            ],
            data: {
              amountNgn: amt,
              routePath: approved ? '/accounts' : '/accounting',
              routeState: approved
                ? { accountsTab: 'desk', settlementId: req.params.settlementId }
                : { focusTab: 'debtors', settlementId: req.params.settlementId },
            },
          });
          if (target.ok) {
            appendWorkItemDecision(db, {
              workItemId: target.item.id,
              actor: req.user,
              actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
              decisionKey: 'register_settlement_review',
              outcomeStatus: outcome.toLowerCase(),
              nextStatus: approved ? 'awaiting_payment' : outcome.toLowerCase(),
              note: String(req.body?.note || '').trim() || `Settlement ${outcome.toLowerCase()}`,
            });
          }
        } catch (syncErr) {
          console.error('[register-settlement-work-item-sync]', syncErr);
        }
      }
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      console.error('[accounting-settlement-decision]', e);
      return res.status(500).json({ ok: false, error: 'Could not decide settlement.' });
    }
  });

  app.post('/api/accounting/settlements/:settlementId/withdraw', requireAuth, (req, res) => {
    try {
      if (!userMayViewAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const existing = getRegisterSettlement(db, req.params.settlementId);
      if (!existing.ok) return res.status(404).json(existing);
      const lineGate = assertRegisterLineWorkspaceWrite(req, existing.settlement.registerLineId);
      if (!lineGate.ok && lineGate.status === 403) {
        return res.status(403).json({ ok: false, error: lineGate.error });
      }
      if (!lineGate.ok) return res.status(404).json({ ok: false, error: lineGate.error });
      const result = withdrawRegisterSettlement(db, req.params.settlementId, req.user);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error('[accounting-settlement-withdraw]', e);
      return res.status(500).json({ ok: false, error: 'Could not withdraw settlement.' });
    }
  });

  app.post('/api/accounting/settlements/:settlementId/pay', requirePermission('finance.pay'), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'register_settlement.pay')) return;
      const result = payRegisterSettlement(db, req.params.settlementId, {
        ...(req.body || {}),
        paidBy: req.user?.displayName,
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      if (result.ok) {
        try {
          const settlement = result.settlement;
          const amt = Math.round(Number(settlement?.approvedAmountNgn || settlement?.amountNgn) || 0);
          const fullyPaid = Boolean(result.fullyPaid);
          upsertWorkItemBySource(db, {
            actor: req.user,
            sourceKind: 'register_settlement',
            sourceId: String(req.params.settlementId || ''),
            branchId: settlement?.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID,
            officeKey: 'finance',
            responsibleOfficeKey: 'finance',
            documentClass: 'request',
            documentType: 'register_settlement',
            status: fullyPaid ? 'paid' : 'awaiting_payment',
            title: fullyPaid
              ? `Register withdrawal ${String(req.params.settlementId || '').trim()} paid`
              : `Pay register withdrawal ${String(req.params.settlementId || '').trim()}`,
            summary: fullyPaid
              ? `${settlement?.partyName || 'Party'} · Fully paid`
              : `${settlement?.partyName || 'Party'} · Partial payout — balance still due`,
            requiresApproval: false,
            requiresResponse: !fullyPaid,
            closedAtIso: fullyPaid ? new Date().toISOString() : '',
            visibilityEntries: [
              { visibilityKind: 'office_key', visibilityValue: 'executive' },
              { visibilityKind: 'office_key', visibilityValue: 'finance' },
            ],
            data: {
              amountNgn: amt,
              routePath: '/accounts',
              routeState: { accountsTab: 'desk', settlementId: req.params.settlementId },
            },
          });
        } catch (syncErr) {
          console.error('[register-settlement-pay-work-item-sync]', syncErr);
        }
      }
      if (result.ok) storeIdempotentSuccess(db, req, 'register_settlement.pay', 201, result);
      return res.status(result.ok ? 201 : 400).json(result);
    } catch (e) {
      console.error('[accounting-settlement-pay]', e);
      return res.status(500).json({ ok: false, error: 'Could not pay settlement.' });
    }
  });

  app.post('/api/accounting/assets', requireAuth, (req, res) => {
    try {
      if (!userMayManageAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return res.status(403).json({ ok: false, error: createGate.error });
      const body = {
        ...(req.body || {}),
        branchId: String(req.body?.branchId || req.workspaceBranchId || '').trim(),
      };
      const branchGate = assertEntityBranchForWorkspaceWrite(
        req.user,
        body.branchId,
        req.workspaceBranchId,
        req.workspaceViewAll
      );
      if (!branchGate.ok) return res.status(403).json({ ok: false, error: branchGate.error });
      const result = createFixedAsset(db, body, req.user);
      if (!result.ok) return res.status(400).json(result);
      return res.status(201).json(result);
    } catch (e) {
      console.error('[accounting-asset-create]', e);
      return res.status(500).json({ ok: false, error: 'Could not create fixed asset.' });
    }
  });

  app.patch('/api/accounting/assets/:assetId', requireAuth, (req, res) => {
    try {
      if (!userMayManageAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const assetGate = assertFixedAssetWorkspaceWrite(req, req.params.assetId);
      if (!assetGate.ok) return res.status(assetGate.status).json({ ok: false, error: assetGate.error });
      const body = {
        ...(req.body || {}),
        branchId: String(req.body?.branchId ?? req.workspaceBranchId ?? '').trim() || undefined,
      };
      if (body.branchId) {
        const branchGate = assertEntityBranchForWorkspaceWrite(
          req.user,
          body.branchId,
          req.workspaceBranchId,
          req.workspaceViewAll
        );
        if (!branchGate.ok) return res.status(403).json({ ok: false, error: branchGate.error });
      }
      const result = updateFixedAsset(db, req.params.assetId, body, req.user);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error('[accounting-asset-update]', e);
      return res.status(500).json({ ok: false, error: 'Could not update fixed asset.' });
    }
  });

  app.post('/api/accounting/assets/:assetId/dispose', requireAuth, (req, res) => {
    try {
      if (!userMayManageAccountingSubledger(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const assetGate = assertFixedAssetWorkspaceWrite(req, req.params.assetId);
      if (!assetGate.ok) return res.status(assetGate.status).json({ ok: false, error: assetGate.error });
      const disposalDateIso = String(req.body?.disposalDateIso || '').slice(0, 10);
      const result = disposeFixedAsset(db, req.params.assetId, {
        disposalDateIso,
        saleProceedsNgn: req.body?.saleProceedsNgn,
        treasuryAccountId: req.body?.treasuryAccountId,
        reference: req.body?.reference,
        note: req.body?.note,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      }, req.user);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error('[accounting-asset-dispose]', e);
      return res.status(500).json({ ok: false, error: 'Could not dispose fixed asset.' });
    }
  });

  const coilMaterialPerms = ['inventory.adjust', 'operations.manage', 'production.manage'];

  registerPublicCareersApi(app, db);

  app.get('/api/ai/status', requireAuth, (req, res) => {
    res.json(readAiStatusForRequest(req, readAiAssistConfig().enabled));
  });

  app.post(
    '/api/ai/chat',
    requireAuth,
    rateLimitAuthedUser(aiChatBuckets, 'ai-chat', 24, 60_000),
    async (req, res) => {
    try {
      const aiEnabled = readAiAssistConfig().enabled;
      if (!aiEnabled) {
        return res.status(503).json({ ok: false, error: 'AI assistant is not configured on this server.' });
      }
      const { messages, context, mode, pageContext } = req.body || {};
      const liveContext = buildAiContextForRequest(db, req, {
        messages,
        context,
        mode,
        pageContext: pageContext && typeof pageContext === 'object' ? pageContext : {},
      });
      const result = await runAiChat({
        messages,
        context: typeof context === 'string' ? context : '',
        mode: liveContext.mode,
        retrievedContext: liveContext.retrievedContext,
        userDisplay: req.user?.displayName,
      });
      return res.json({ ok: true, message: result.content });
    } catch (e) {
      const code = e?.code;
      if (code === 'AI_BAD_REQUEST') {
        return res.status(400).json({ ok: false, error: String(e.message || e) });
      }
      if (code === 'AI_FORBIDDEN') {
        return res.status(403).json({ ok: false, error: String(e.message || e) });
      }
      console.error('AI chat error', e);
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  }
  );

  app.get('/api/help/status', requireAuth, (_req, res) => {
    const ai = readRunaAiConfig();
    res.json({
      ok: true,
      available: true,
      selfContained: true,
      articleCount: HELP_ARTICLE_COUNT,
      externalAi: ai.chatEnabled,
      aiProvider: ai.provider,
      intelligence: ai.mode,
      architecture: 'rag+agent+learning',
      designLimits: RUNA_DESIGN_LIMITS,
      rag: { semanticSearch: true, vectorStore: 'help_rag_chunks' },
      agent: {
        router: true,
        textToSql: ai.chatEnabled,
        nativeErpTools: true,
        coaching: true,
        fullLlmGeneration: ai.chatEnabled,
      },
      embeddingModel: ai.embeddingModel,
      chatModel: ai.chatModel,
      polishModel: ai.polishModel,
    });
  });

  app.get('/api/help/personalization', requireAuth, (req, res) => {
    const pathname = String(req.query?.pathname || '/').slice(0, 200);
    const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
    const personalization = buildHelpPersonalizationFromSnapshot(db, null, {
      userId: req.user?.id,
      branchId,
      roleKey: req.user?.roleKey,
      pathname,
      user: req.user,
    });
    return res.json({ ok: true, ...personalization });
  });

  app.post(
    '/api/help/memo-assist',
    requireAuth,
    requirePermission('office.use'),
    rateLimitAuthedUser(helpChatBuckets, 'help-memo-assist', 60, 60_000),
    async (req, res) => {
      try {
        const r = await handleMemoAssist(db, req.user, req.body || {});
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error('Memo assist error', e);
        res.status(500).json({ ok: false, error: 'Memo assist failed.' });
      }
    }
  );

  app.post(
    '/api/help/chat',
    requireAuth,
    rateLimitAuthedUser(helpChatBuckets, 'help-chat', 40, 60_000),
    async (req, res) => {
      try {
        const { message, messages, pathname, clientDraftMs, pageContext } = req.body || {};
        const msg = typeof message === 'string' ? message : '';
        const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
        const branchScope = resolveBootstrapBranchScope(req);
        const learnedBoosts = computeMergedLearnedBoosts(db, {
          branchId,
          userId: req.user?.id,
          queryText: msg,
        });
        const safePageContext = sanitizeZarePageContext(
          pageContext && typeof pageContext === 'object' ? pageContext : {}
        );
        const result = await runUnifiedHelpChat(db, {
          message: msg,
          messages,
          pathname: typeof pathname === 'string' ? pathname : '',
          pageContext: safePageContext,
          user: req.user,
          userDisplay: req.user?.displayName,
          userId: req.user?.id,
          branchId,
          branchScope,
          roleKey: req.user?.roleKey,
          learnedBoosts,
          clientDraftMs: Number(clientDraftMs) || 0,
        });
        return res.json({
          ok: true,
          message: result.content,
          source: result.source,
          links: Array.isArray(result.links) ? result.links : [],
          logId: result.logId || null,
          agentRoute: result.agentRoute || null,
          sources: Array.isArray(result.sources) ? result.sources : [],
          coaching: result.coaching || null,
        });
      } catch (e) {
        const code = e?.code;
        if (code === 'HELP_BAD_REQUEST') {
          return res.status(400).json({ ok: false, error: String(e.message || e) });
        }
        console.error('Help chat error', e);
        return res.status(502).json({ ok: false, error: 'Help assistant is temporarily unavailable.' });
      }
    }
  );

  app.post('/api/help/signal', requireAuth, (req, res) => {
    const { logId, signal, readMs } = req.body || {};
    const id = String(logId || '').trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: 'logId is required.' });
    }
    const sig = String(signal || '').trim();
    let feedback = null;
    let followUp = false;
    let linkClicked = false;
    if (sig === 'helpful') feedback = 'helpful';
    else if (sig === 'not_helpful') feedback = 'not_helpful';
    else if (sig === 'follow_up') followUp = true;
    else if (sig === 'link_click') linkClicked = true;
    else {
      return res.status(400).json({ ok: false, error: 'Invalid signal.' });
    }
    const ok = recordHelpQuerySignal(db, {
      logId: id,
      userId: req.user?.id,
      feedback,
      readMs: Number(readMs) || 0,
      followUp,
      linkClicked,
    });
    if (!ok) {
      return res.status(404).json({ ok: false, error: 'Help log entry not found.' });
    }
    return res.json({ ok: true });
  });

  app.post('/api/help/log-query', requireAuth, (req, res) => {
    const { message, pathname, matchedArticleIds, source, topScore, clientDraftMs, responseMs } = req.body || {};
    const text = String(message || '').trim();
    if (!text) {
      return res.status(400).json({ ok: false, error: 'message is required.' });
    }
    const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
    const logId = insertHelpQueryLog(db, {
      userId: req.user?.id,
      branchId,
      roleKey: req.user?.roleKey,
      pathname: typeof pathname === 'string' ? pathname : '',
      queryText: text,
      matchedArticleIds: Array.isArray(matchedArticleIds) ? matchedArticleIds : [],
      source: String(source || 'kb').slice(0, 32),
      topScore: Number(topScore) || 0,
      responseChars: 0,
      responseMs: Number(responseMs) || 0,
      clientDraftMs: Number(clientDraftMs) || 0,
      sessionTurn: 1,
    });
    return res.json({ ok: true, logId: logId || null });
  });

  app.get(
    '/api/help/admin/dashboard',
    requireAuth,
    requirePermission(['settings.manage', 'audit.view']),
    (req, res) => {
      const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      const dashboard = getRunaIntelligenceDashboard(db, {
        branchId,
        days: Number(req.query?.days) || 30,
      });
      return res.json({ ok: true, dashboard });
    }
  );

  app.get(
    '/api/help/admin/gaps',
    requireAuth,
    requirePermission(['settings.manage', 'audit.view']),
    (req, res) => {
      const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      const dashboard = getRunaIntelligenceDashboard(db, { branchId });
      return res.json({ ok: true, gaps: dashboard.knowledgeGaps, suggestedArticles: dashboard.suggestedArticles });
    }
  );

  app.post(
    '/api/help/admin/run-analytics',
    requireAuth,
    requirePermission(['settings.manage']),
    (req, res) => {
      const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      const result = runHelpAnalyticsJob(db, { branchId });
      return res.json({ ok: true, result });
    }
  );

  app.post(
    '/api/help/admin/suggested-articles/:id/review',
    requireAuth,
    requirePermission(['settings.manage']),
    (req, res) => {
      const id = String(req.params?.id || '').trim();
      const status = String(req.body?.status || '').trim();
      if (!id || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'id and status (approved|rejected) are required.' });
      }
      const result = reviewSuggestedArticle(db, {
        id,
        status,
        reviewerId: req.user?.id,
      });
      if (!result.ok) {
        return res.status(result.error === 'Draft not found.' ? 404 : 400).json(result);
      }
      return res.json({
        ok: true,
        ...result,
        note: 'Review recorded. Publishing to live guides still requires a developer to merge into helpKnowledge.js.',
      });
    }
  );

  app.get(
    '/api/management/items',
    requirePermission(['audit.view', 'refunds.approve', 'sales.manage', 'quotations.manage']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        res.json(listManagementItems(db, branchScope));
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to load management items.' });
      }
    }
  );

  app.post('/api/edit-approvals/request', requireAuth, (req, res) => {
    try {
      const { entityKind, entityId, changeSummary, changeDetails } = req.body || {};
      const r = createEditApprovalRequest(db, {
        entityKind,
        entityId,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        actor: req.user,
        changeSummary,
        changeDetails,
      });
      res.status(r.ok ? 200 : r.code === 'EDIT_APPROVAL_ALREADY_PENDING' ? 409 : 400).json(r);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/edit-approvals/pending', requireAuth, (req, res) => {
    if (!userCanApproveEditMutations(req.user)) {
      return res.status(403).json({ ok: false, error: 'You cannot review edit approvals.' });
    }
    try {
      res.json({ ok: true, items: listPendingEditApprovals(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/edit-approvals/:id', requireAuth, (req, res) => {
    try {
      const row = getEditApprovalDetail(db, req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: 'Not found.' });
      const uid = String(req.user?.id || '').trim();
      if (row.requestedByUserId !== uid && !userCanApproveEditMutations(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.' });
      }
      res.json({ ok: true, approval: row });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/edit-approvals/:id/approve', requireAuth, (req, res) => {
    try {
      const r = approveEditApproval(db, { approvalId: req.params.id, actor: req.user });
      if (r.ok) {
        const target = upsertWorkItemBySource(db, {
          actor: req.user,
          sourceKind: 'edit_approval',
          sourceId: String(req.params.id || ''),
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          responsibleOfficeKey: 'branch_manager',
          documentClass: 'approval',
          documentType: 'edit_approval',
          status: 'approved',
          title: `Edit approval ${String(req.params.id || '').trim()}`,
          summary: 'Second-party approval granted.',
          requiresApproval: true,
          data: { routePath: '/manager', routeState: { inbox: 'edit_approvals' } },
        });
        if (target.ok) {
          appendWorkItemDecision(db, {
            workItemId: target.item.id,
            actor: req.user,
            actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
            decisionKey: 'approve',
            outcomeStatus: 'approved',
            nextStatus: 'approved',
            note: 'Edit approval granted.',
            keyDecisionSummary: 'Edit approval granted.',
          });
        }
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/edit-approvals/:id/reject', requireAuth, (req, res) => {
    try {
      const reason = String(req.body?.reason ?? req.body?.note ?? '').trim();
      const r = rejectEditApproval(db, { approvalId: req.params.id, actor: req.user, reason });
      if (r.ok) {
        upsertWorkItemBySource(
          db,
          {
            sourceKind: 'edit_approval',
            sourceId: String(req.params.id || ''),
            status: 'rejected',
            updatedAtIso: new Date().toISOString(),
          },
          { actor: req.user }
        );
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/office/summary', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const out = getOfficeSummary(db, scope, req.user);
      res.json(out);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load Office summary.' });
    }
  });

  app.get('/api/work-items', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      if (userHasPermission(req.user, 'office.use')) {
        ensureWorkItemsForVisibleOfficeThreads(db, scope, req.user);
      }
      if (shouldSyncDerivedWorkItemsNow(req.user?.id, scope.branchId)) {
        syncDerivedWorkItems(db, scope, req.user);
      }
      const items = listUnifiedWorkItems(db, scope, req.user, {
        q: req.query.q,
        status: req.query.status,
        priority: req.query.priority,
        category: req.query.category,
        branchId: req.query.branchId,
        officeKey: req.query.officeKey,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        assignedToMe: req.query.assignedToMe,
        createdByMe: req.query.createdByMe,
        overdue: req.query.overdue,
        view: req.query.view,
        limit: req.query.limit,
      });
      res.json({ ok: true, items });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load work items.' });
    }
  });

  app.get('/api/work-items/:workItemId', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      const r = getUnifiedWorkItem(db, scope, req.user, String(req.params.workItemId || ''));
      if (!r.ok) {
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.error === 'Work item not found.') return res.status(404).json(r);
        return res.status(400).json(r);
      }
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load work item.' });
    }
  });

  app.post('/api/work-items', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      const officeKey = req.body?.officeKey || req.body?.responsibleOfficeKey || 'office_admin';
      const r = createWorkItem(db, {
        actor: req.user,
        branchId,
        officeKey,
        responsibleOfficeKey: req.body?.responsibleOfficeKey || officeKey,
        documentClass: req.body?.documentClass,
        documentType: req.body?.documentType,
        status: req.body?.status,
        priority: req.body?.priority,
        confidentiality: req.body?.confidentiality,
        title: req.body?.title,
        summary: req.body?.summary,
        body: req.body?.body,
        senderUserId: req.user?.id,
        senderDisplayName: req.user?.displayName || req.user?.username || '',
        senderRoleKey: req.user?.roleKey || '',
        senderOfficeKey: officeKeyForUser(req.user),
        senderBranchId: branchId,
        responsibleUserId: req.body?.responsibleUserId,
        dueAtIso: req.body?.dueAtIso,
        requiresResponse: req.body?.requiresResponse,
        requiresApproval: req.body?.requiresApproval,
        keyDecisionSummary: req.body?.keyDecisionSummary,
        sourceKind: req.body?.sourceKind,
        sourceId: req.body?.sourceId,
        linkedThreadId: req.body?.linkedThreadId,
        links: req.body?.links,
        visibilityEntries: req.body?.visibilityEntries,
        filing: req.body?.filing,
        data: req.body?.data,
      });
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not create work item.' });
    }
  });

  app.post('/api/work-items/:workItemId/decisions', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      const target = getUnifiedWorkItem(db, scope, req.user, String(req.params.workItemId || ''));
      if (!target.ok) return res.status(target.error === 'Forbidden.' ? 403 : 404).json(target);
      const item = target.item;
      if (item.legacy) {
        return res.status(400).json({
          ok: false,
          error: 'Legacy queue items must still be acted on through their current module route until migrated.',
        });
      }
      const outcomeStatus = String(req.body?.outcomeStatus || '').trim();
      if (!userMayDecideWorkItem(req.user, item, { outcomeStatus, decisionKey: req.body?.decisionKey })) {
        return res.status(403).json({
          ok: false,
          error: 'You are not authorized to record this decision on this work item.',
          code: 'FORBIDDEN',
        });
      }
      const r = appendWorkItemDecision(db, {
        workItemId: item.id,
        actor: req.user,
        actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        decisionKey: req.body?.decisionKey,
        outcomeStatus: req.body?.outcomeStatus,
        note: req.body?.note,
        nextStatus: req.body?.nextStatus,
        keyDecisionSummary: req.body?.keyDecisionSummary,
        actedAtIso: req.body?.actedAtIso,
        data: req.body?.data,
      });
      return res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not append work item decision.' });
    }
  });

  app.post('/api/work-items/:workItemId/link-thread/:threadId', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = linkWorkItemToOfficeThread(
        db,
        String(req.params.workItemId || ''),
        String(req.params.threadId || '')
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not link thread.' });
    }
  });

  app.get('/api/office/directory', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      res.json({ ok: true, users: listOfficeDirectory(db, scope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load directory.' });
    }
  });

  app.get('/api/office/threads', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const mineOnly = String(req.query.mine || '').trim() === '1' || String(req.query.mine || '').toLowerCase() === 'true';
      const threads = listOfficeThreads(db, scope, req.user, { mineOnly });
      res.json({ ok: true, threads });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not list threads.' });
    }
  });

  app.post('/api/office/threads', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = createOfficeThread(db, req.user, req.workspaceBranchId || DEFAULT_BRANCH_ID, req.body || {});
      if (r.ok && r.thread?.id) {
        const wr = ensureWorkItemForOfficeThread(db, r.thread.id, req.user);
        if (wr.ok) {
          r.thread.relatedWorkItemId = wr.item.id;
        }
      }
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not create thread.' });
    }
  });

  app.get('/api/office/threads/:threadId', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = getOfficeThread(db, scope, req.user, String(req.params.threadId || ''));
      if (!r.ok) {
        if (r.error === 'Thread not found.') return res.status(404).json(r);
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        return res.status(400).json(r);
      }
      if (r.thread?.id) {
        const wr = ensureWorkItemForOfficeThread(db, r.thread.id, req.user);
        if (wr.ok) {
          r.thread.relatedWorkItemId = wr.item.id;
          r.workItem = wr.item;
        }
      }
      return res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load thread.' });
    }
  });

  app.post('/api/office/threads/:threadId/messages', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = addOfficeMessage(
        db,
        scope,
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID,
        String(req.params.threadId || ''),
        req.body || {}
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not add message.' });
    }
  });

  app.post('/api/office/threads/:threadId/read', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = markOfficeThreadRead(db, req.user?.id, String(req.params.threadId || ''));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not mark read.' });
    }
  });

  app.post('/api/office/ai/polish-memo', requireAuth, requirePermission('office.use'), async (req, res) => {
    try {
      if (!readAiAssistConfig().enabled) {
        return res.status(503).json({ ok: false, error: 'AI assistant is not configured on this server.' });
      }
      const { subject = '', body = '', style = 'improve' } = req.body || {};
      const result = await runOfficeMemoPolish({ subject, body, style });
      return res.json({ ok: true, subject: result.subject, body: result.body });
    } catch (e) {
      const code = e?.code;
      if (code === 'AI_BAD_REQUEST') {
        return res.status(400).json({ ok: false, error: String(e.message || e) });
      }
      if (code === 'AI_DISABLED') {
        return res.status(503).json({ ok: false, error: 'AI assistant is not configured on this server.' });
      }
      console.error('office memo polish', e);
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/office/filing', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const filings = listOfficeThreadFilingForUser(db, scope, req.user);
      res.json({ ok: true, filings });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load filing index.' });
    }
  });

  app.get('/api/office/threads/:threadId/filing', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = getOfficeThreadFiling(db, scope, req.user, String(req.params.threadId || ''));
      if (!r.ok) {
        if (r.error === 'Thread not found.') return res.status(404).json(r);
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        return res.status(400).json(r);
      }
      return res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load filing record.' });
    }
  });

  app.post('/api/office/threads/:threadId/ai-file', requireAuth, requirePermission('office.use'), async (req, res) => {
    try {
      if (!readAiAssistConfig().enabled) {
        return res.status(503).json({ ok: false, error: 'AI assistant is not configured on this server.' });
      }
      const scope = officeScopeFromReq(req);
      const r = await saveOfficeThreadFilingFromAi(db, scope, req.user, String(req.params.threadId || ''));
      if (!r.ok) {
        if (r.error === 'Thread not found.') return res.status(404).json(r);
        if (r.error === 'Forbidden.') return res.status(403).json(r);
        if (r.code === 'AI_DISABLED') return res.status(503).json({ ok: false, error: r.error });
        if (r.code === 'AI_BAD_REQUEST') return res.status(400).json(r);
        return res.status(502).json({ ok: false, error: r.error || 'Filing extract failed.' });
      }
      return res.json(r);
    } catch (e) {
      console.error('office ai-file', e);
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/office/threads/:threadId/convert-payment-request', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = convertOfficeThreadToPaymentRequest(
        db,
        scope,
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID,
        String(req.params.threadId || ''),
        req.body || {}
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not convert to payment request.' });
    }
  });

  app.post('/api/office/threads/:threadId/convert-material-request', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = convertOfficeThreadToMaterialRequest(
        db,
        scope,
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID,
        String(req.params.threadId || ''),
        req.body || {}
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not convert to material request.' });
    }
  });

  app.get('/api/office/compose-templates', requireAuth, requirePermission('office.use'), (_req, res) => {
    res.json({ ok: true, templates: OFFICE_OPERATION_TEMPLATES });
  });

  app.get('/api/office/compose-drafts', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const drafts = listOfficeMemoDrafts(
        db,
        req.user?.id,
        req.workspaceBranchId || DEFAULT_BRANCH_ID
      );
      res.json({ ok: true, drafts });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load drafts.' });
    }
  });

  const saveOfficeComposeDraft = (req, res) => {
    try {
      const body = { ...(req.body || {}), id: req.params.draftId || req.body?.id };
      const r = upsertOfficeMemoDraft(db, req.user?.id, body);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not save draft.' });
    }
  };

  app.put('/api/office/compose-drafts', requireAuth, requirePermission('office.use'), saveOfficeComposeDraft);
  app.put('/api/office/compose-drafts/:draftId', requireAuth, requirePermission('office.use'), saveOfficeComposeDraft);

  app.delete('/api/office/compose-drafts/:draftId', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = deleteOfficeMemoDraft(db, req.user?.id, String(req.params.draftId || ''));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not delete draft.' });
    }
  });

  app.get('/api/office/inter-branch-requests', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = listInterBranchRequestsForUser(db, req.user, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load inter-branch requests.' });
    }
  });

  app.post('/api/office/inter-branch-requests', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = createInterBranchRequest(
        db,
        {
          ...(req.body || {}),
          fromBranchId: String(req.body?.fromBranchId || req.workspaceBranchId || DEFAULT_BRANCH_ID).trim(),
        },
        req.user
      );
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/office/inter-branch-requests/:id/resolve', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = resolveInterBranchRequest(
        db,
        String(req.params.id || ''),
        req.body || {},
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/office/threads/:threadId', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = patchOfficeRecordByBranchManager(db, req.params.threadId, req.user, req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/office/threads/:threadId/versions', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const versions = listOfficeRecordVersions(db, req.params.threadId);
      res.json({ ok: true, versions });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load versions.' });
    }
  });

  app.post('/api/office/threads/:threadId/file', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = fileOfficeThread(db, req.params.threadId, req.user, {
        category: req.body?.category,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/official-notices', requireAuth, (req, res) => {
    try {
      const notices = listOfficialNoticesForUser(db, req.user, {
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      res.json({ ok: true, notices });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not list notices.' });
    }
  });

  app.post('/api/official-notices', requireAuth, (req, res) => {
    try {
      const r = createOfficialNotice(db, req.user, req.body || {});
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/official-notices/:id/acknowledge', requireAuth, (req, res) => {
    try {
      const r = acknowledgeOfficialNotice(db, req.params.id, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/forum/topics', requireAuth, (req, res) => {
    try {
      const scope = String(req.query?.scope || '').trim() || undefined;
      const topics = listForumTopics(db, {
        scope,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      res.json({ ok: true, topics });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not list forum topics.' });
    }
  });

  app.post('/api/forum/topics', requireAuth, (req, res) => {
    try {
      const r = createForumTopic(db, req.user, {
        ...req.body,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/forum/topics/:topicId/posts', requireAuth, (req, res) => {
    try {
      const r = addForumPost(db, req.params.topicId, req.user, req.body || {});
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/org/governance-limits', requireAuth, requirePermission('settings.view'), (req, res) => {
    try {
      res.json({ ok: true, limits: getOrgGovernanceLimits(db) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load governance limits.' });
    }
  });

  app.patch('/api/org/governance-limits', requireAuth, requirePermission('settings.manage'), (req, res) => {
    try {
      const body = req.body || {};
      const r = setOrgGovernanceLimits(
        db,
        {
          expenseExecutiveThresholdNgn: body.expenseExecutiveThresholdNgn,
          refundExecutiveThresholdNgn: body.refundExecutiveThresholdNgn,
          othersMinJustificationLen: body.othersMinJustificationLen,
          othersFinanceReviewThresholdNgn: body.othersFinanceReviewThresholdNgn,
          ap3UnclassifiedAlertThresholdNgn: body.ap3UnclassifiedAlertThresholdNgn,
          othersBranchCoachThresholdPct: body.othersBranchCoachThresholdPct,
        },
        req.user
      );
      if (r.ok) {
        appendAuditLog(db, {
          actor: req.user,
          action: 'org.governance_limits.patch',
          entityKind: 'org_policy',
          entityId: 'governance_limits',
          note: 'Governance approval thresholds updated via API',
          details: { before: r.before, after: r.limits },
        });
      }
      res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, limits: r.limits } : r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/credit-exceptions/policy', requireAuth, (req, res) => {
    try {
      if (!userMayViewCreditExceptions(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden', code: 'FORBIDDEN' });
      }
      return res.json({ ok: true, policy: getCreditPolicyConfig(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load credit policy.' });
    }
  });

  app.get('/api/credit-exceptions', requireAuth, (req, res) => {
    try {
      if (!userMayViewCreditExceptions(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden', code: 'FORBIDDEN' });
      }
      const status = String(req.query?.status || '').trim();
      const quotationRef = String(req.query?.quotationRef || '').trim();
      // Force workspace branch; ignore client branchId unless view-all.
      let branchId = '';
      if (req.workspaceViewAll) {
        branchId = String(req.query?.branchId || req.query?.branch || '').trim();
      } else {
        branchId = String(req.workspaceBranchId || '').trim();
      }
      const rows = listCreditExceptions(db, {
        status: status || undefined,
        quotationRef: quotationRef || undefined,
        branchId: branchId && branchId !== 'ALL' ? branchId : undefined,
        limit: Number(req.query?.limit) || 100,
      });
      return res.json({ ok: true, creditExceptions: rows, policy: getCreditPolicyConfig(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list credit exceptions.' });
    }
  });

  app.post('/api/credit-exceptions', requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const r = createCreditExceptionRequest(db, body, req.user);
      return res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/credit-exceptions/:id/decision', requireAuth, (req, res) => {
    try {
      const decision = String(req.body?.decision || '').trim().toLowerCase();
      const r = decideCreditException(db, req.params.id, decision, req.body || {}, req.user);
      return res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/credit-exceptions/:id/revoke', requireAuth, (req, res) => {
    try {
      const r = revokeCreditException(db, req.params.id, req.body || {}, req.user);
      return res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/quotations/:id/credit-status', requireAuth, (req, res) => {
    try {
      if (!userMayViewCreditExceptions(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden', code: 'FORBIDDEN' });
      }
      const qg = assertQuotationIdInWorkspace(db, req, req.params.id);
      if (!qg.ok) return res.status(qg.status).json({ ok: false, error: qg.error, code: 'FORBIDDEN' });
      const status = getQuotationCreditStatus(db, req.params.id);
      return res.json(status);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load quotation credit status.' });
    }
  });

  app.get('/api/staff-purchase-credits/pending-count', requireAuth, (req, res) => {
    try {
      const canSee =
        userMayApproveStaffPurchaseCredit(req.user) ||
        userMayRejectStaffPurchaseCredit(req.user) ||
        userMayRequestStaffPurchaseCredit(req.user);
      if (!canSee) return res.status(403).json({ ok: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const branchScope = resolveBootstrapBranchScope(req);
      const viewAll =
        branchScope === 'ALL' ||
        canUseAllBranchesRollup(req.user) ||
        userMayApproveStaffPurchaseCredit(req.user);
      const branchId = viewAll
        ? 'ALL'
        : String(branchScope === 'ALL' ? req.workspaceBranchId || DEFAULT_BRANCH_ID : branchScope).trim() ||
          DEFAULT_BRANCH_ID;
      const count = countPendingStaffPurchaseCreditRequests(db, branchId);
      const crossBranch = userMayApproveStaffPurchaseCredit(req.user)
        ? summarizePendingStaffPurchaseCreditByBranch(db, viewAll ? '' : branchId)
        : null;
      return res.json({ ok: true, count, crossBranch });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load pending count.' });
    }
  });

  app.get('/api/staff-purchase-credits/my-quotations', requireAuth, (req, res) => {
    try {
      const uid = String(req.user?.id || '').trim();
      if (!uid) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const items = listStaffQuotationsForPurchaseCredit(db, uid);
      return res.json({ ok: true, items });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list quotations.' });
    }
  });

  app.get('/api/staff-purchase-credits', requireAuth, (req, res) => {
    try {
      const canList =
        userMayRequestStaffPurchaseCredit(req.user) ||
        userMayApproveStaffPurchaseCredit(req.user) ||
        userMayRejectStaffPurchaseCredit(req.user);
      if (!canList) {
        return res.status(403).json({ ok: false, error: 'Forbidden', code: 'FORBIDDEN' });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const viewAll =
        branchScope === 'ALL' ||
        canUseAllBranchesRollup(req.user) ||
        userMayApproveStaffPurchaseCredit(req.user);
      const branchId = viewAll
        ? 'ALL'
        : String(branchScope === 'ALL' ? req.workspaceBranchId || DEFAULT_BRANCH_ID : branchScope).trim() ||
          DEFAULT_BRANCH_ID;
      const rows = listStaffPurchaseCreditQueue(db, {
        status: String(req.query?.status || '').trim() || undefined,
        branchId,
      });
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not list staff purchase credits.' });
    }
  });

  app.post('/api/staff-purchase-credits', requireAuth, (req, res) => {
    try {
      const r = createStaffPurchaseCreditRequest(db, req.user, req.body || {});
      return res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/staff-purchase-credits/:id/decision', requireAuth, (req, res) => {
    try {
      const decision = String(req.body?.decision || '').trim().toLowerCase();
      const r = decideStaffPurchaseCredit(db, req.params.id, decision, req.user, req.body || {});
      return res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/quotations/:id/staff-purchase-status', requireAuth, (req, res) => {
    try {
      const qg = assertQuotationIdInWorkspace(db, req, req.params.id);
      if (!qg.ok) return res.status(qg.status).json({ ok: false, error: qg.error, code: 'FORBIDDEN' });
      const status = getQuotationStaffPurchaseCreditStatus(db, req.params.id);
      return res.json(status);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load staff purchase status.' });
    }
  });

  app.get('/api/reports/md-operations-pack', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, '*') ||
        userHasPermission(req.user, 'hq.view_all_branches') ||
        String(req.user?.roleKey || '').toLowerCase() === 'md' ||
        String(req.user?.roleKey || '').toLowerCase() === 'admin';
      if (!can) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const monthKey = String(req.query?.month || '').trim().slice(0, 7) || new Date().toISOString().slice(0, 7);
      const pack = buildMdOperationsPack(db, {
        monthKey,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        viewAll: Boolean(req.workspaceViewAll),
      });
      res.status(pack.ok ? 200 : 400).json(pack);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/reports/daily-pack', requireAuth, (req, res) => {
    try {
      if (!userMayViewManagementReports(req.user)) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const pack = buildExecutiveDailyPack(db, {
        date: String(req.query?.date || '').trim().slice(0, 10),
        branchScope,
      });
      res.json(pack);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to build daily executive pack.' });
    }
  });

  app.get('/api/reports/weekly-pack', requireAuth, (req, res) => {
    try {
      if (!userMayViewManagementReports(req.user)) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const pack = buildExecutiveWeeklyPack(db, {
        endDate: String(req.query?.endDate || req.query?.date || '').trim().slice(0, 10),
        branchScope,
      });
      res.json(pack);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to build weekly executive pack.' });
    }
  });

  app.patch('/api/management/targets', requireAuth, requirePermission('quotations.manage'), (req, res) => {
    try {
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'manager_targets', 'manager_targets', (stripped) => {
        const { targets } = stripped || {};
        db.prepare('REPLACE INTO app_json_blobs (`key`, payload) VALUES (?, ?)').run(
          'manager_targets',
          JSON.stringify(targets)
        );
        return { ok: true };
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get(
    '/api/management/attention',
    requirePermission(['audit.view', 'refunds.approve', 'sales.manage', 'quotations.manage', 'ot.approve']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        res.json(listMdAttentionInbox(db, branchScope));
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to load management attention inbox.' });
      }
    }
  );

  app.get(
    '/api/management/quotation-audit',
    requirePermission(['audit.view', 'refunds.approve', 'sales.manage', 'quotations.manage']),
    (req, res) => {
      try {
        const base = listManagerQuotationAudit(db, req.query.quotationRef);
        res.json(enrichQuotationAuditPayload(db, base));
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to load quotation audit.' });
      }
    }
  );

  app.get(
    '/api/management/po-audit',
    requirePermission(['audit.view', 'refunds.approve', 'sales.manage', 'quotations.manage', 'procurement.manage', 'purchase_orders.manage']),
    (req, res) => {
      try {
        res.json(listManagerPoAudit(db, req.query.poId || req.query.poID));
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to load purchase order audit.' });
      }
    }
  );

  app.post('/api/management/review', requireAuth, requirePermission('quotations.manage'), (req, res) => {
    try {
      const { quotationId, decision, reason } = req.body || {};
      const qid = String(quotationId ?? '').trim();
      const qg = assertQuotationIdInWorkspace(db, req, qid);
      if (!qg.ok) return res.status(qg.status).json({ ok: false, error: qg.error, code: 'FORBIDDEN' });
      const r = reviewQuotation(
        db,
        qid,
        { decision, note: reason },
        req.user
      );
      if (r.ok) {
        const closedStamp = new Date().toISOString();
        const base = upsertWorkItemBySource(db, {
          actor: req.user,
          sourceKind: decision === 'approve_production' ? 'production_gate' : 'quotation_clearance',
          sourceId: qid,
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          responsibleOfficeKey: 'branch_manager',
          documentClass: 'approval',
          documentType: decision === 'approve_production' ? 'production_gate' : 'quotation_clearance',
          status: 'closed',
          title: decision === 'approve_production' ? `Production gate ${qid}` : `Quotation clearance ${qid}`,
          summary: reason || `Management review: ${decision}`,
          requiresApproval: false,
          requiresResponse: false,
          closedAtIso: closedStamp,
          data: { routePath: '/manager', managerDecision: decision },
        });
        if (base.ok) {
          appendWorkItemDecision(db, {
            workItemId: base.item.id,
            actor: req.user,
            actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
            decisionKey: String(decision || 'review'),
            outcomeStatus: 'closed',
            nextStatus: 'closed',
            note: String(reason || '').trim() || `Management review: ${decision}`,
          });
        }
        if (decision === 'flag') {
          const flagged = upsertWorkItemBySource(db, {
            actor: req.user,
            sourceKind: 'flagged_transaction',
            sourceId: qid,
            branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
            officeKey: 'branch_manager',
            responsibleOfficeKey: 'branch_manager',
            documentClass: 'report',
            documentType: 'flagged_transaction',
            status: 'flagged',
            priority: 'high',
            title: `Flagged quotation ${qid}`,
            summary: String(reason || '').trim() || 'Quotation flagged for audit review.',
            requiresApproval: false,
            requiresResponse: true,
            data: { routePath: '/manager' },
          });
          if (flagged.ok) {
            appendWorkItemDecision(db, {
              workItemId: flagged.item.id,
              actor: req.user,
              actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
              decisionKey: 'flag',
              outcomeStatus: 'flagged',
              nextStatus: 'flagged',
              note: String(reason || '').trim() || 'Quotation flagged for audit review.',
            });
          }
        }
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/dashboard/summary', requirePermission('dashboard.view'), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const payload = dashboardSummary(db, branchScope, { recentLimit: 12 });
      const etag = `W/"${Buffer.from(JSON.stringify(payload)).toString('base64').slice(0, 64)}"`;
      if (String(req.headers['if-none-match'] || '') === etag) {
        return res.status(304).end();
      }
      res.setHeader('ETag', etag);
      return res.json(payload);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Failed' });
    }
  });

  app.get('/api/session', (req, res) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, authenticated: false, user: null, permissions: [] });
    }
    return res.json({ ok: true, ...req.session });
  });

  app.post('/api/session/firebase', (_req, res) => {
    return res.status(404).json({ ok: false, error: 'Endpoint removed.', code: 'NOT_FOUND' });
  });

  app.post('/api/session/login', async (req, res) => {
    try {
      const ip = clientIp(req);
      const userKey = `${ip}:${String(req.body?.username || '').trim().toLowerCase()}`;
      // Peek before bcrypt so attackers cannot burn CPU after the window is full.
      if (isRateLimited(loginAttemptBuckets, userKey, 12, 30 * 60 * 1000)) {
        await loginDelayMs();
        return res.status(429).json({
          ok: false,
          code: 'RATE_LIMITED',
          error: 'Too many sign-in attempts. Wait up to 30 minutes or try another network.',
        });
      }
      const { username, password } = req.body || {};
      const result = loginWithPassword(db, username, password);
      if (!result.ok) {
        if (Array.isArray(result.audits)) {
          for (const audit of result.audits) {
            appendAuditLog(db, audit);
          }
        }
        if (!allowRateLimit(loginAttemptBuckets, userKey, 12, 30 * 60 * 1000)) {
          await loginDelayMs();
          return res.status(429).json({
            ok: false,
            code: 'RATE_LIMITED',
            error: 'Too many sign-in attempts. Wait up to 30 minutes or try another network.',
          });
        }
        await loginDelayMs();
        const status = result.code === 'ACCOUNT_LOCKED' ? 423 : 401;
        return res.status(status).json({
          ok: false,
          code: result.code || 'INVALID_CREDENTIALS',
          error: result.error,
          lockedUntilIso: result.lockedUntilIso,
        });
      }
      setSessionCookie(res, result.sessionToken, req);
      // CSRF cookie used by the SPA to protect cookie-authenticated write requests.
      setCsrfCookie(res, undefined, req);
      appendAuditLog(db, {
        actor: result.session.user,
        action: 'session.login',
        entityKind: 'user',
        entityId: result.session.user?.id ?? '',
        note: 'User signed in',
      });
      return res.json({ ok: true, ...result.session });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Login failed' });
    }
  });

  app.post('/api/session/activity', (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Sign in required.' });
      }
      return res.json({ ok: true, ...req.session });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not refresh session activity.' });
    }
  });

  app.post('/api/session/timeout', (req, res) => {
    try {
      if (req.user) {
        appendAuditLog(db, {
          actor: req.user,
          action: 'session.timeout',
          entityKind: 'user',
          entityId: req.user?.id ?? '',
          note: 'Session ended due to inactivity (client timeout)',
        });
        logoutSession(db, req.sessionToken);
      }
      clearSessionCookie(res, req);
      clearCsrfCookie(res, req);
      return res.json({ ok: true, code: 'SESSION_TIMEOUT' });
    } catch (e) {
      console.error(e);
      clearSessionCookie(res, req);
      clearCsrfCookie(res, req);
      return res.status(500).json({ ok: false, error: 'Could not end session.' });
    }
  });

  app.post('/api/session/forgot-password', async (req, res) => {
    try {
      const ip = clientIp(req);
      if (!allowRateLimit(forgotPasswordBuckets, ip, 6, 60 * 60 * 1000)) {
        await loginDelayMs();
        return res.status(429).json({ ok: false, error: 'Too many reset requests. Try again in an hour.' });
      }
      await loginDelayMs();
      const identifier = req.body?.username ?? req.body?.email ?? req.body?.identifier;
      const result = requestPasswordReset(db, identifier);
      return res.json({
        ok: true,
        message:
          'If a matching new-user account exists, a single-use reset code was created. It expires in one hour. ' +
          'Delivered only through your administrator. Use New user setup on the sign-in screen with the code.',
        ...(process.env.ZAREWA_EXPOSE_DEV_RESET_TOKEN === '1' && result.devResetToken
          ? { devResetToken: result.devResetToken }
          : {}),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not process reset request.' });
    }
  });

  app.post('/api/session/reset-password', async (req, res) => {
    try {
      const ip = clientIp(req);
      if (!allowRateLimit(loginAttemptBuckets, `${ip}:reset`, 10, 30 * 60 * 1000)) {
        await loginDelayMs();
        return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
      }
      await loginDelayMs();
      const { identifier, token, newPassword } = req.body || {};
      const result = completePasswordReset(db, identifier, token, newPassword);
      if (!result.ok) {
        return res.status(400).json(result);
      }
      if (result.userId) clearBootstrapPollCacheForUser(result.userId);
      appendAuditLog(db, {
        actor: { id: null, displayName: 'Password reset', username: String(identifier || '').trim() },
        action: 'session.password_reset_complete',
        entityKind: 'user',
        entityId: String(identifier || '').trim(),
        note: 'Password reset via token',
      });
      return res.json({ ok: true, message: 'Password updated. You can sign in with your new password.' });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not reset password.' });
    }
  });

  app.post('/api/session/logout', requireAuth, (req, res) => {
    try {
      appendAuditLog(db, {
        actor: req.user,
        action: 'session.logout',
        entityKind: 'user',
        entityId: req.user?.id ?? '',
        note: 'User signed out',
      });
      logoutSession(db, req.sessionToken);
      clearSessionCookie(res, req);
      clearCsrfCookie(res, req);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Logout failed' });
    }
  });

  app.patch('/api/session/workspace', requireAuth, (req, res) => {
    try {
      const token = req.sessionToken;
      if (!token) return res.status(401).json({ ok: false, error: 'No session.' });
      const branchCol = db.prepare(`PRAGMA table_info(user_sessions)`).all().some((c) => c.name === 'current_branch_id');
      if (!branchCol) {
        return res.status(500).json({ ok: false, error: 'Workspace columns missing; restart server after migration.' });
      }
      const row = db
        .prepare(`SELECT current_branch_id, view_all_branches FROM user_sessions WHERE session_token = ?`)
        .get(token);
      if (!row) return res.status(401).json({ ok: false, error: 'Session expired.' });

      let nextBranch = String(row.current_branch_id || '').trim() || DEFAULT_BRANCH_ID;
      if (req.body?.currentBranchId != null && String(req.body.currentBranchId).trim()) {
        const id = String(req.body.currentBranchId).trim();
        const br = getBranch(db, id);
        if (!br || !br.active) {
          return res.status(400).json({ ok: false, error: 'Invalid or inactive branch.' });
        }
        if (!userMaySelectSessionWorkspaceBranch(db, req.user, id)) {
          return res.status(403).json({ ok: false, error: 'You cannot switch to this branch.' });
        }
        nextBranch = id;
      }

      let viewAll = Number(row.view_all_branches) === 1 ? 1 : 0;
      if (req.body?.viewAllBranches === true) {
        if (!canUseAllBranchesRollup(req.user)) {
          return res.status(403).json({ ok: false, error: 'Only Admin, MD, or CEO can view all branches.' });
        }
        viewAll = 1;
      } else if (req.body?.viewAllBranches === false) {
        viewAll = 0;
      }

      if (
        req.body?.currentBranchId == null &&
        req.body?.viewAllBranches === undefined
      ) {
        return res.status(400).json({ ok: false, error: 'Send currentBranchId and/or viewAllBranches.' });
      }

      db.prepare(
        `UPDATE user_sessions SET current_branch_id = ?, view_all_branches = ? WHERE session_token = ?`
      ).run(nextBranch, viewAll, token);

      appendAuditLog(db, {
        actor: req.user,
        action: 'session.workspace',
        entityKind: 'branch',
        entityId: nextBranch,
        note: viewAll ? 'HQ: all branches' : 'Branch workspace',
      });
      return res.json({
        ok: true,
        currentBranchId: nextBranch,
        viewAllBranches: Boolean(viewAll),
        branches: listBranches(db),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update workspace.' });
    }
  });

  app.post('/api/session/change-password', requireAuth, (req, res) => {
    try {
      const r = changePassword(db, req.user.id, req.body?.currentPassword, req.body?.newPassword);
      if (!r.ok) return res.status(400).json(r);
      clearBootstrapPollCacheForUser(req.user.id);
      appendAuditLog(db, {
        actor: req.user,
        action: 'session.change_password',
        entityKind: 'user',
        entityId: req.user.id,
        note: req.user?.mustChangePassword ? 'First-login password set' : 'Password changed',
      });
      return res.json({ ok: true, user: r.user });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not change password' });
    }
  });

  app.post('/api/session/complete-training', requireAuth, (req, res) => {
    try {
      const r = completeUserTraining(db, req.user.id);
      if (!r.ok) return res.status(400).json(r);
      appendAuditLog(db, {
        actor: req.user,
        action: 'session.training_complete',
        entityKind: 'user',
        entityId: req.user.id,
        note: `Role training completed (${req.user?.roleKey || 'user'})`,
      });
      return res.json({ ok: true, user: r.user });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save training completion.' });
    }
  });

  app.patch('/api/session/profile', requireAuth, (req, res) => {
    try {
      const r = updateUserProfile(db, req.user.id, {
        displayName: req.body?.displayName,
        email: req.body?.email,
        avatarUrl: req.body?.avatarUrl,
        username: req.body?.username,
      });
      if (!r.ok) return res.status(400).json(r);
      appendAuditLog(db, {
        actor: req.user,
        action: 'session.profile_update',
        entityKind: 'user',
        entityId: req.user.id,
        note: 'Profile updated',
      });
      return res.json({ ok: true, user: r.user });
    } catch (e) {
      console.error(e);
      if (String(e?.message || e).toLowerCase().includes('unique')) {
        return res.status(400).json({ ok: false, error: 'That email is already in use.' });
      }
      return res.status(500).json({ ok: false, error: 'Could not update profile.' });
    }
  });

  app.patch('/api/session/dashboard-prefs', requireAuth, (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const prev = getJsonBlob(db, `user_dashboard_prefs:${req.user.id}`) || {};
      const prevMt = prev.managerTargets && typeof prev.managerTargets === 'object' ? prev.managerTargets : {};
      const bodyMt = body.managerTargets && typeof body.managerTargets === 'object' ? body.managerTargets : {};
      const naira = Number(bodyMt.nairaTargetPerMonth);
      const met = Number(bodyMt.meterTargetPerMonth);
      const prevOnb =
        prev.onboardingPlanAG && typeof prev.onboardingPlanAG === 'object' ? prev.onboardingPlanAG : {};
      const bodyOnb =
        body.onboardingPlanAG && typeof body.onboardingPlanAG === 'object' ? body.onboardingPlanAG : null;
      let onboardingPlanAG = prevOnb;
      if (bodyOnb) {
        onboardingPlanAG = {
          dismissed: Boolean(prevOnb.dismissed) || bodyOnb.dismissed === true,
          items: {
            ...(typeof prevOnb.items === 'object' ? prevOnb.items : {}),
            ...(typeof bodyOnb.items === 'object' ? bodyOnb.items : {}),
          },
        };
      } else if (!Object.keys(prevOnb).length) {
        onboardingPlanAG = {
          dismissed: false,
          items: {
            rbacReportsOk: false,
            dailyBankQueue: false,
            glCostCenter: false,
          },
        };
      }
      const next = {
        ...prev,
        showCharts: body.showCharts !== false,
        showReportsStrip: body.showReportsStrip !== false,
        showAlertBanner: body.showAlertBanner !== false,
        managerTargetsPersonalOverride: Object.prototype.hasOwnProperty.call(body, 'managerTargetsPersonalOverride')
          ? body.managerTargetsPersonalOverride === true
          : Boolean(prev.managerTargetsPersonalOverride),
        managerTargets: {
          nairaTargetPerMonth:
            Number.isFinite(naira) && naira > 0
              ? naira
              : Number(prevMt.nairaTargetPerMonth) > 0
                ? Number(prevMt.nairaTargetPerMonth)
                : 50_000_000,
          meterTargetPerMonth:
            Number.isFinite(met) && met > 0
              ? met
              : Number(prevMt.meterTargetPerMonth) > 0
                ? Number(prevMt.meterTargetPerMonth)
                : 250_000,
        },
        onboardingPlanAG,
      };
      setJsonBlob(db, `user_dashboard_prefs:${req.user.id}`, next);
      return res.json({ ok: true, dashboardPrefs: next });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save dashboard preferences.' });
    }
  });

  app.patch('/api/setup/org-manager-targets', requireAuth, requirePermission('settings.manage'), (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (body.clear === true) {
        setJsonBlob(db, 'org.manager_targets.v1', null);
        appendAuditLog(db, {
          actor: req.user,
          action: 'org.manager_targets.clear',
          entityKind: 'settings',
          entityId: 'org.manager_targets.v1',
          note: 'Cleared company manager dashboard targets',
        });
        return res.json({ ok: true, orgManagerTargets: null });
      }
      const prev = getJsonBlob(db, 'org.manager_targets.v1') || {};
      const next = mergeManagerTargetsBlob(prev, body);
      if (Object.keys(next).length === 0) {
        setJsonBlob(db, 'org.manager_targets.v1', null);
        appendAuditLog(db, {
          actor: req.user,
          action: 'org.manager_targets.clear',
          entityKind: 'settings',
          entityId: 'org.manager_targets.v1',
          note: 'Cleared company manager dashboard targets (empty save)',
        });
        return res.json({ ok: true, orgManagerTargets: null });
      }
      setJsonBlob(db, 'org.manager_targets.v1', next);
      appendAuditLog(db, {
        actor: req.user,
        action: 'org.manager_targets.update',
        entityKind: 'settings',
        entityId: 'org.manager_targets.v1',
        note: 'Updated company manager dashboard targets',
        details: next,
      });
      return res.json({ ok: true, orgManagerTargets: next });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save company manager targets.' });
    }
  });

  app.patch('/api/setup/org-store-restock', requireAuth, requirePermission('settings.manage'), (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (body.clear === true) {
        setJsonBlob(db, 'org.store_restock.v1', null);
        appendAuditLog(db, {
          actor: req.user,
          action: 'org.store_restock.clear',
          entityKind: 'settings',
          entityId: 'org.store_restock.v1',
          note: 'Cleared store restock mins (defaults apply)',
        });
        return res.json({ ok: true, orgStoreRestock: normalizeOrgStoreRestock(null) });
      }
      const prev = getJsonBlob(db, 'org.store_restock.v1') || {};
      const next = mergeOrgStoreRestockBlob(prev, body);
      setJsonBlob(db, 'org.store_restock.v1', next);
      appendAuditLog(db, {
        actor: req.user,
        action: 'org.store_restock.update',
        entityKind: 'settings',
        entityId: 'org.store_restock.v1',
        note: 'Updated store restock mins',
        details: next,
      });
      return res.json({ ok: true, orgStoreRestock: next });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not save store restock settings.' });
    }
  });

  registerIntegrationReadApi(app, db);

  app.use('/api', requireAuth, requireActivePassword);

  registerWorkspaceListRoutes(app, db);
  registerHrApi(app, db);
  registerOtApi(app, db);
  registerAiKnowledgeCenterRoutes(app, db, aiKnowledgeBuckets);
  registerAiIntelligenceRouterRoutes(app, db, aiRouterBuckets);
  registerUnifiedAiRoutes(app, db, aiUnifiedBuckets);
  registerAiAutomationRoutes(app, db, aiAutomationBuckets);
  registerAiProviderRoutes(app);

  app.get('/api/workspace/revision', (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const payload = buildWorkspaceRevision(db, branchScope);
      const etag = workspaceRevisionEtag(db, branchScope);
      if (ifNoneMatchHit(req, etag)) {
        return res.status(304).end();
      }
      setWeakEtag(res, etag);
      return res.json(payload);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not compute workspace revision.' });
    }
  });

  for (const [domain, buildSnapshot] of Object.entries(DOMAIN_SNAPSHOT_BUILDERS)) {
    app.get(`/api/workspace/${domain}-snapshot`, (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const payload = buildSnapshot(db, {
          user: req.user,
          branchScope,
        });
        const etag = jsonWeakEtag({ domain, branchScope, payload });
        if (ifNoneMatchHit(req, etag)) {
          return res.status(304).end();
        }
        setWeakEtag(res, etag);
        return res.json(payload);
      } catch (e) {
        console.error(`[workspace/${domain}-snapshot]`, e);
        return res.status(500).json({ ok: false, error: `Could not load ${domain} workspace data.` });
      }
    });
  }

  app.get('/api/bootstrap', (req, res) => {
    try {
      const includeControls =
        userHasPermission(req.user, 'audit.view') ||
        userHasPermission(req.user, 'period.manage') ||
        userHasPermission(req.user, 'finance.approve');
      const includeUsers = userHasPermission(req.user, 'settings.view');
      const includeRegisteredPasswords = includeUsers && canRevealUserPasswords(req.user);
      const branchScope = resolveBootstrapBranchScope(req);
      const mode = String(req.query?.mode ?? '').trim().toLowerCase();
      const limit = parseInt(String(req.query?.limit ?? '600'), 10) || 600;
      const skipSideEffects =
        String(req.query?.poll ?? req.query?.workspacePoll ?? '').trim() === '1';
      const skipWorkItemSync = skipSideEffects || mode === 'dashboard';
      const bootstrapOpts = {
        user: req.user,
        session: req.session,
        includeControls,
        includeUsers,
        includeRegisteredPasswords,
        branchScope,
        skipSideEffects,
        skipWorkItemSync,
      };
      const payload =
        mode === 'dashboard'
          ? buildDashboardBootstrap(db, {
              ...bootstrapOpts,
              limit,
            })
          : buildBootstrap(db, bootstrapOpts);
      const ifNoneMatch = String(req.headers['if-none-match'] || '');
      const useShortLivedBootstrapCache = skipSideEffects || mode === 'dashboard';
      if (useShortLivedBootstrapCache) {
        const cacheKey = bootstrapPollCacheKey(req, {
          branchScope,
          mode,
          includeControls,
          includeUsers,
        });
        const hit = bootstrapPollCache.get(cacheKey);
        if (hit && Date.now() < hit.expires) {
          if (ifNoneMatch && ifNoneMatch === hit.etag) {
            return res.status(304).end();
          }
          res.setHeader('ETag', hit.etag);
          return res.json(hit.payload);
        }
        const etag = bootstrapPayloadEtag(payload);
        if (ifNoneMatch && ifNoneMatch === etag) {
          return res.status(304).end();
        }
        res.setHeader('ETag', etag);
        bootstrapPollCache.set(cacheKey, {
          payload,
          etag,
          expires: Date.now() + BOOTSTRAP_POLL_CACHE_MS,
        });
        return res.json(payload);
      }
      return respondBootstrap(res, payload, ifNoneMatch);
    } catch (e) {
      const detail = String(e?.message || e || 'unknown').slice(0, 500);
      console.error('[bootstrap]', e);
      res.status(500).json({ ok: false, error: 'Bootstrap failed', detail });
    }
  });

  app.get('/api/workspace/delta', requireAuth, (req, res) => {
    try {
      const since = String(req.query.since || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      const workScope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? DEFAULT_BRANCH_ID : branchScope,
      };
      const workItems = sanitizeWorkItemsForClient(
        listUnifiedWorkItems(db, workScope, req.user, { limit: 400 })
      );
      const filtered = since
        ? workItems.filter((w) => String(w.updatedAtISO || w.createdAtISO || '') > since)
        : workItems.slice(0, 40);
      res.json({
        ok: true,
        since: since || null,
        at: new Date().toISOString(),
        workItems: filtered,
        counts: {
          workItems: workItems.length,
          receipts: listSalesReceipts(db, branchScope, { limit: 5 }).length,
        },
      });
    } catch (e) {
      console.error(e);
      apiError(res, { status: 500, code: 'DELTA_FAILED', error: 'Could not load workspace updates.' });
    }
  });

  app.patch('/api/workspace/app-users/:userId/department', requirePermission('settings.manage'), (req, res) => {
    try {
      const uid = req.params.userId;
      const stripped = stripEditApprovalFromBody(req.body || {});
      const r = patchAppUserWorkspaceDepartment(db, req.user, uid, stripped?.department);
      if (!r.ok) return res.status(400).json(r);
      appendAuditLog(db, {
        actor: req.user,
        action: 'user.workspace_department',
        entityKind: 'user',
        entityId: r.user.id,
        note: String(r.user.department || ''),
      });
      return res.json({ ok: true, user: r.user });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update workspace department.' });
    }
  });

  app.patch('/api/workspace/app-users/:userId/workspace-branch', requirePermission('settings.manage'), (req, res) => {
    try {
      const uid = req.params.userId;
      const stripped = stripEditApprovalFromBody(req.body || {});
      const branchId = String(stripped?.branchId ?? '').trim();
      if (!branchId) return res.status(400).json({ ok: false, error: 'branchId is required.' });
      const u = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(uid);
      if (!u) return res.status(400).json({ ok: false, error: 'User not found.' });
      const br = db.prepare(`SELECT id FROM branches WHERE id = ? AND COALESCE(active, 1) = 1`).get(branchId);
      if (!br) return res.status(400).json({ ok: false, error: 'Invalid or inactive branch.' });
      const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
      if (!cols.some((c) => c.name === 'workspace_branch_id')) {
        return res.status(500).json({ ok: false, error: 'Workspace branch column missing — run migrations.' });
      }
      db.prepare(`UPDATE app_users SET workspace_branch_id = ? WHERE id = ?`).run(branchId, uid);
      appendAuditLog(db, {
        actor: req.user,
        action: 'user.workspace_branch',
        entityKind: 'user',
        entityId: uid,
        note: branchId,
      });
      return res.json({ ok: true, branchId });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update workspace branch.' });
    }
  });

  app.get('/api/users', requirePermission('settings.view'), (req, res) => {
    try {
      const revealPasswords = canRevealUserPasswords(req.user);
      const users = listAllAppUsers(db).map((u) => {
        if (revealPasswords) return u;
        const { registeredPassword: _drop, ...rest } = u;
        return rest;
      });
      res.json({ ok: true, users });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not list users.' });
    }
  });

  app.post('/api/users', requirePermission('settings.manage'), (req, res) => {
    try {
      const body = req.body || {};
      const r = createAppUserRecord(db, body);
      if (!r.ok) return res.status(400).json(r);

      const branchId = String(body.branchId ?? body.homeBranchId ?? '').trim();
      if (!branchId) {
        db.prepare(`DELETE FROM app_users WHERE id = ?`).run(r.userId);
        return res.status(400).json({ ok: false, error: 'Home branch is required.' });
      }
      const br = db.prepare(`SELECT id FROM branches WHERE id = ? AND COALESCE(active, 1) = 1`).get(branchId);
      if (!br) {
        db.prepare(`DELETE FROM app_users WHERE id = ?`).run(r.userId);
        return res.status(400).json({ ok: false, error: 'Invalid or inactive branch.' });
      }
      const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
      if (cols.some((c) => c.name === 'workspace_branch_id')) {
        db.prepare(`UPDATE app_users SET workspace_branch_id = ? WHERE id = ?`).run(branchId, r.userId);
      }

      const linked = ensureHrStaffProfileForUser(db, req.user?.id, r.userId, { branchId, skipEnrichedReturn: true });
      if (!linked.ok && linked.code !== 'HR_NOT_READY') {
        try {
          db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(r.userId);
          db.prepare(`DELETE FROM app_users WHERE id = ?`).run(r.userId);
        } catch {
          /* best-effort rollback so a login is never left without an HR file */
        }
        return res.status(400).json(linked);
      }

      appendAuditLog(db, {
        actor: req.user,
        action: 'user.create',
        entityKind: 'user',
        entityId: r.userId,
        note: `Created user ${body.username}`,
      });
      res.status(201).json({ ...r, hrProfileCreated: Boolean(linked.created) });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/users/ensure-hr-profiles', requirePermission('settings.manage'), (req, res) => {
    try {
      const r = ensureHrStaffProfilesForUnlinkedUsers(db, req.user?.id);
      if (!r.ok && r.code === 'HR_NOT_READY') return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not link HR profiles.' });
    }
  });

  app.post('/api/users/:id/ensure-hr-profile', requirePermission('settings.manage'), (req, res) => {
    try {
      const r = ensureHrStaffProfileForUser(db, req.user?.id, req.params.id, { skipEnrichedReturn: true });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not create HR profile.' });
    }
  });

  app.patch('/api/users/:id/role', requirePermission('settings.manage'), (req, res) => {
    try {
      const id = req.params.id;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'user', id, (stripped) => {
        const r = updateAppUserRole(db, id, stripped?.roleKey);
        if (!r.ok) return r;
        appendAuditLog(db, {
          actor: req.user,
          action: 'user.update_role',
          entityKind: 'user',
          entityId: id,
          note: `Role updated to ${stripped?.roleKey}`,
        });
        return { ok: true };
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/users/:id/permissions', requirePermission('settings.manage'), (req, res) => {
    try {
      const id = req.params.id;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'user', id, (stripped) => {
        const r = updateAppUserPermissions(db, id, stripped?.permissions, req.user);
        if (!r.ok) return r;
        appendAuditLog(db, {
          actor: req.user,
          action: 'user.update_permissions',
          entityKind: 'user',
          entityId: id,
          note: 'Granular permissions updated',
        });
        return { ok: true };
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/users/:id/password', requirePermission('settings.manage'), (req, res) => {
    try {
      if (!canRevealUserPasswords(req.user)) {
        return res.status(403).json({ ok: false, error: 'Only Admin, MD, or HR Admin can set user passwords.' });
      }
      const id = String(req.params.id || '').trim();
      const password = String(req.body?.password ?? req.body?.newPassword ?? '').trim();
      if (!password) return res.status(400).json({ ok: false, error: 'Password is required.' });
      const r = adminSetUserPassword(db, req.user, id, password);
      if (!r.ok) return res.status(400).json(r);
      clearBootstrapPollCacheForUser(id);
      appendAuditLog(db, {
        actor: req.user,
        action: 'user.set_password',
        entityKind: 'user',
        entityId: id,
        note: 'Password set from Team & access',
      });
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not set password.' });
    }
  });

  app.post('/api/users/:id/unlock-account', requirePermission('settings.manage'), (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const r = adminUnlockAccount(db, id);
      if (!r.ok) return res.status(400).json(r);
      appendAuditLog(db, {
        actor: req.user,
        action: 'session.account_unlocked',
        entityKind: 'user',
        entityId: id,
        note: `Admin unlocked sign-in lock for ${r.username}`,
      });
      return res.json({ ok: true, username: r.username });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not unlock account.' });
    }
  });

  app.post('/api/users/:id/password-reset-code', requirePermission('settings.manage'), (req, res) => {
    try {
      if (!canIssuePasswordResetCodes(req.user)) {
        return res.status(403).json({ ok: false, error: 'Only Admin, MD, or HR Admin can generate reset codes.' });
      }
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'User id is required.' });
      const r = issuePasswordResetForAdmin(db, id);
      if (!r.ok) return res.status(400).json(r);
      appendAuditLog(db, {
        actor: req.user,
        action: 'session.password_reset_code_issued',
        entityKind: 'user',
        entityId: id,
        note: 'Admin generated one-time reset code from Team & access',
      });
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not generate reset code.' });
    }
  });

  app.get('/api/roles', requirePermission('settings.view'), (_req, res) => {
    try {
      const roles = Object.entries(ROLE_DEFINITIONS).map(([key, v]) => ({
        key,
        label: v.label,
        permissions: [...v.permissions],
      }));
      roles.sort((a, b) => a.key.localeCompare(b.key));
      res.json({
        ok: true,
        roles,
        permissionKeys: allKnownPermissionKeys(),
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load roles.' });
    }
  });

  app.get('/api/admin/security/login-summary', requirePermission('settings.view'), (req, res) => {
    try {
      const hours = parseInt(String(req.query?.hours ?? '24'), 10) || 24;
      const summary = buildLoginSecuritySummary(db, { hours });
      return res.json({ ok: true, ...summary });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load login security summary.' });
    }
  });

  app.get('/api/admin/security/active-sessions', requirePermission('settings.view'), (_req, res) => {
    try {
      return res.json({ ok: true, sessions: listActiveSessions(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load active sessions.' });
    }
  });

  /** Phase 10 — users with custom `permissions_json` overrides and risk classification. */
  app.get('/api/admin/permission-overrides-audit', requirePermission('settings.view'), (_req, res) => {
    try {
      const report = buildCustomPermissionOverrideAudit(db);
      return res.json({ ok: true, ...report });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not build permission override audit.' });
    }
  });

  app.get('/api/admin/data-reset-presets', requireAuth, (req, res) => {
    try {
      if (String(req.user?.roleKey || '').toLowerCase() !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Admin only.' });
      }
      const branchId = String(req.workspaceBranchId || '').trim();
      const branch = branchId ? getBranch(db, branchId) : null;
      const blocked =
        !branchId ||
        branchId === 'ALL' ||
        Boolean(req.workspaceViewAll && canUseAllBranchesRollup(req.user));
      res.json({
        ok: true,
        presets: ADMIN_DATA_RESET_PRESETS.map(({ id, label, warning }) => ({ id, label, warning })),
        confirmPhrase: ADMIN_DATA_RESET_CONFIRM_PHRASE,
        branchId: branchId || null,
        branchName: branch?.name || branchId || null,
        branchResetBlocked: blocked,
        branchResetBlockedReason: blocked
          ? 'Select a single branch in the workspace switcher (not “all branches”) before using data reset.'
          : null,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get(
    '/api/admin/quotations/line-integrity-audit',
    requirePermission(['finance.approve', 'refunds.approve', 'quotations.manage', 'settings.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000);
        const r = auditQuotationLineIntegrity(db, branchScope, { limit, onlyInvalid: true });
        res.json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not run quotation line integrity audit.' });
      }
    }
  );

  app.post('/api/admin/data-reset', requireAuth, requirePermission('settings.manage'), (req, res) => {
    try {
      if (String(req.user?.roleKey || '').toLowerCase() !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Admin only.' });
      }
      const body = req.body || {};
      const presetIds = Array.isArray(body.presetIds) ? body.presetIds : [];
      const branchId = String(req.workspaceBranchId || '').trim();
      const r = applyAdminDataReset(db, presetIds, body.confirmPhrase, {
        actorId: req.user?.id,
        branchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      if (!r.ok) {
        return res.status(400).json(r);
      }
      appendAuditLog(db, {
        actor: req.user,
        action: 'admin.data_reset',
        entityKind: 'system',
        entityId: 'data_reset',
        note: `Admin data reset (${r.branchName || r.branchId}): ${r.presetIds.join(', ')}`,
        details: {
          presetIds: r.presetIds,
          tablesCleared: r.tablesCleared,
          branchId: r.branchId,
          skippedTables: r.skippedTables,
        },
      });
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  /**
   * Rebuild sales_receipt mirrors from ledger RECEIPT rows and recalculate quotations.paid_ngn for all quotes
   * in the current workspace branch scope. Administrator only; does not alter ledger entries.
   */
  app.post('/api/admin/reconcile-sales-derived', requireAuth, requirePermission('settings.manage'), (req, res) => {
    try {
      if (String(req.user?.roleKey || '').toLowerCase() !== 'admin') {
        return res.status(403).json({
          ok: false,
          error: 'Only the administrator role can run this maintenance job.',
        });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          ok: false,
          error:
            'Send JSON body { "confirm": true } to rebuild sales receipt rows from the ledger and recalculate booked paid on every quotation in this branch scope.',
        });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const r = write.reconcileAllSalesDerivedDataForBranchScope(db, branchScope);
      appendAuditLog(db, {
        actor: req.user,
        action: 'admin.reconcile_sales_derived',
        entityKind: 'system',
        entityId: 'sales_derived',
        note: `Sales denormalized data reconcile (${r.quotationIds} quotations, branch scope ${branchScope})`,
        details: {
          branchScope,
          quotationIds: r.quotationIds,
          processed: r.processed,
          failures: r.failures?.length ?? 0,
          totalUpserted: r.totalUpserted,
          totalDeletedMirrors: r.totalDeletedMirrors,
          quotationsPaidChanged: r.quotationsPaidChanged,
        },
      });
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  /**
   * Re-apply finance-confirmed bank amounts to receipt rows, ledger RECEIPT/OVERPAY splits, and quotation paid.
   * Use when reconciled receipts still reflect stale sales-posted totals (e.g. mistaken overpayment entries).
   */
  app.post('/api/admin/reapply-finance-reconciled-receipts', requireAuth, requirePermission('settings.manage'), (req, res) => {
    try {
      if (String(req.user?.roleKey || '').toLowerCase() !== 'admin') {
        return res.status(403).json({
          ok: false,
          error: 'Only the administrator role can run this maintenance job.',
        });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          ok: false,
          error:
            'Send JSON body { "confirm": true } to re-apply finance-confirmed bank amounts on all cleared receipts in this branch scope.',
        });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const quotationRef = String(req.body?.quotationRef || req.body?.quotation_ref || '').trim();
      const r = write.reapplyFinanceReconciledReceiptAmountsForBranchScope(db, branchScope, req.user, {
        quotationRef: quotationRef || undefined,
      });
      appendAuditLog(db, {
        actor: req.user,
        action: 'admin.reapply_finance_reconciled_receipts',
        entityKind: 'system',
        entityId: 'finance_reconciled_receipts',
        note: `Reapplied finance-confirmed receipt amounts (${r.receiptCount} receipts, branch scope ${branchScope})`,
        details: {
          branchScope,
          receiptCount: r.receiptCount,
          changed: r.changed,
          unchanged: r.unchanged,
          quotationsSynced: r.quotationsSynced,
          failures: r.failures?.length ?? 0,
        },
      });
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/users/:id/status', requirePermission('settings.manage'), (req, res) => {
    try {
      const id = req.params.id;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'user', id, (stripped) => {
        const r = updateAppUserStatus(db, id, stripped?.status, { actorUserId: req.user.id });
        if (!r.ok) return r;
        appendAuditLog(db, {
          actor: req.user,
          action: 'user.update_status',
          entityKind: 'user',
          entityId: id,
          note: `Status updated to ${stripped?.status}`,
        });
        return { ok: true };
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete('/api/users/:id', requirePermission('settings.manage'), (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return handlePatchWithEditApproval(res, db, req.user, body, 'user', id, (stripped) => {
        const r = deleteAppUser(db, id, {
          actorUserId: req.user.id,
          confirmUsername: stripped?.confirmUsername,
        });
        if (!r.ok) return r;
        appendAuditLog(db, {
          actor: req.user,
          action: 'user.delete',
          entityKind: 'user',
          entityId: id,
          note: `Deleted user ${String(stripped?.confirmUsername || '').trim()}`,
        });
        return { ok: true };
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/users/zero-audit-candidates', requirePermission('settings.manage'), (req, res) => {
    try {
      const r = listZeroAuditUserCandidates(db, { actorUserId: req.user.id });
      res.json({
        ...r,
        confirmPhrase: ZERO_AUDIT_BULK_DELETE_CONFIRM_PHRASE,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/users/bulk-delete-zero-audit', requirePermission('settings.manage'), (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const dryRun = body.dryRun !== false && body.dryRun !== 0 && body.dryRun !== '0';
      const r = bulkDeleteZeroAuditUsers(db, req.user, {
        confirmPhrase: body.confirmPhrase,
        dryRun,
        userIds: Array.isArray(body.userIds) ? body.userIds : undefined,
      });
      if (!r.ok) {
        res.status(400).json(r);
        return;
      }
      res.json({
        ...r,
        confirmPhrase: ZERO_AUDIT_BULK_DELETE_CONFIRM_PHRASE,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/gl/accounts', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      res.json({ ok: true, accounts: listGlAccounts(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/gl/trial-balance', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    const startDate = String(req.query.startDate || '').slice(0, 10);
    const endDate = String(req.query.endDate || '').slice(0, 10);
    const costCenter = String(req.query.costCenter || '').trim();
    const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
    const r = trialBalanceRows(db, startDate, endDate, { costCenter, branchScope });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.get('/api/gl/journals', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    const startDate = String(req.query.startDate || '').slice(0, 10);
    const endDate = String(req.query.endDate || '').slice(0, 10);
    const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
    const r = listGlJournalEntries(db, startDate, endDate, { branchScope });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.get('/api/gl/journals/:journalId/lines', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    const r = listGlJournalLinesForJournal(db, String(req.params.journalId || ''));
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.get('/api/gl/activity', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    const startDate = String(req.query.startDate || '').slice(0, 10);
    const endDate = String(req.query.endDate || '').slice(0, 10);
    const costCenter = String(req.query.costCenter || '').trim();
    const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
    const r = listGlActivityLines(db, startDate, endDate, { costCenter, branchScope });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.post('/api/gl/journal', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    if (!userHasPermission(req.user, 'finance.post')) {
      return res.status(403).json({ ok: false, error: 'finance.post required.', code: 'FORBIDDEN' });
    }
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'gl.journal.manual')) return;
      const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
      if (lines.length > 20) {
        return res.status(400).json({ ok: false, error: 'Too many journal lines (max 20).', code: 'GL_LINE_CAP' });
      }
      const idemKey = normalizeIdempotencyKey(req.get('Idempotency-Key') || req.get('idempotency-key'));
      const r = postBalancedJournal(db, {
        entryDateISO: req.body?.entryDateISO,
        memo: req.body?.memo,
        sourceKind: 'MANUAL_JOURNAL',
        sourceId: idemKey || undefined,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        createdByUserId: req.user?.id,
        lines,
      });
      if (r.ok) {
        const totalNgn = lines.reduce((sum, l) => {
          const debit = Math.round(Number(l.debitNgn) || 0);
          const credit = Math.round(Number(l.creditNgn) || 0);
          return sum + debit + credit;
        }, 0);
        appendAuditLog(db, {
          actor: req.user,
          action: 'gl.manual_journal',
          entityKind: 'gl_journal',
          entityId: r.journalId,
          amountNgn: totalNgn,
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
          note: String(req.body?.memo || 'Manual journal').slice(0, 240),
          details: { journalId: r.journalId, duplicate: Boolean(r.duplicate), lineCount: lines.length },
        });
        storeIdempotentSuccess(db, req, 'gl.journal.manual', r.duplicate ? 200 : 201, r);
      }
      res.status(r.ok ? (r.duplicate ? 200 : 201) : 400).json(r);
    } catch (e) {
      console.error('[gl.manual_journal]', e);
      res.status(500).json({ ok: false, error: 'Could not post journal.' });
    }
  });

  app.get('/api/finance/reconciliation-pack', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / reconciliation access required.', code: 'FORBIDDEN' });
    }
    try {
      const periodKey = String(req.query.period || req.query.periodKey || '').trim();
      if (!isValidFinancePackPeriodKey(periodKey)) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const pack = getReconciliationPack(db, periodKey, branchScope);
      if (!pack.ok) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const cashFlowSummary = getCashFlowPack(db, periodKey, branchScope);
      if (!cashFlowSummary.ok) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const body = buildFinanceReconciliationPackEnvelope({
        pack,
        cashFlowSummary,
        periodKey,
        branchScope,
      });
      res.json(body);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load finance reconciliation pack.' });
    }
  });

  app.get('/api/finance/statements-pack', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      const periodKey = String(req.query.period || req.query.periodKey || '').trim();
      if (!isValidFinancePackPeriodKey(periodKey)) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const pack = getAccountingStatementsPack(db, periodKey, branchScope);
      if (!pack.ok) return res.status(400).json(pack);
      res.json({
        ...pack,
        status: 'management_draft',
        label: 'Management draft — Profit & Loss and Statement of Financial Position from GL.',
      });
    } catch (e) {
      console.error('[finance-statements-pack]', e);
      res.status(500).json({ ok: false, error: 'Could not load statements pack.' });
    }
  });

  const openingBalanceStatusHandler = (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      ensureArchitecturalGlAccounts(db);
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      return res.json(getOpeningBalanceStatus(db, branchScope));
    } catch (e) {
      console.error('[opening-balance-status]', e);
      return res.status(500).json({ ok: false, error: 'Could not load opening balance status.' });
    }
  };

  app.get('/api/finance/opening-balance/status', requireAuth, openingBalanceStatusHandler);
  app.get('/api/finance/opening-pack/status', requireAuth, openingBalanceStatusHandler);

  app.post('/api/finance/opening-balance', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    if (!userHasPermission(req.user, 'finance.post')) {
      return res.status(403).json({ ok: false, error: 'finance.post required.', code: 'FORBIDDEN' });
    }
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'finance.opening_balance')) return;
      const body = req.body || {};
      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (lines.length > 20) {
        return res.status(400).json({ ok: false, error: 'Too many opening-balance lines (max 20).', code: 'GL_LINE_CAP' });
      }
      const branchId = String(body.branchId || req.workspaceBranchId || '').trim() || null;
      const result = postOpeningBalanceJournal(db, {
        entryDateISO: body.entryDateISO || ACCOUNTING_OPENING_DATE_ISO,
        sourceId: body.sourceId || openingBalanceSourceId(branchId),
        branchId,
        createdByUserId: req.user?.id,
        memo: body.memo || 'Opening balance cutover',
        lines,
      });
      if (!result.ok) return res.status(400).json(result);
      storeIdempotentSuccess(db, req, 'finance.opening_balance', result.duplicate ? 200 : 201, result);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (e) {
      console.error('[opening-balance-post]', e);
      return res.status(500).json({ ok: false, error: 'Could not post opening balance.' });
    }
  });

  app.get('/api/finance/opening-pack', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      ensureArchitecturalGlAccounts(db);
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const inventoryPeriodKey = String(req.query.inventoryPeriod || req.query.inventoryPeriodKey || '').trim() || undefined;
      const payrollPeriodKey = String(req.query.payrollPeriod || req.query.payrollPeriodKey || '').trim() || undefined;
      const capitalRaw = req.query.capitalNgn ?? req.query.capital;
      const capitalNgn = capitalRaw != null && capitalRaw !== '' ? Math.round(Number(capitalRaw)) : 0;
      const pack = buildOpeningPackReport(db, {
        branchScope,
        inventoryPeriodKey,
        payrollPeriodKey,
        capitalNgn: Number.isFinite(capitalNgn) ? capitalNgn : 0,
      });
      if (!pack.ok) return res.status(400).json(pack);
      return res.json(pack);
    } catch (e) {
      console.error('[opening-pack]', e);
      return res.status(500).json({ ok: false, error: 'Could not build opening pack.' });
    }
  });

  app.post('/api/finance/opening-pack/post', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    if (!userHasPermission(req.user, 'finance.post')) {
      return res.status(403).json({ ok: false, error: 'finance.post required.', code: 'FORBIDDEN' });
    }
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'finance.opening_pack.post')) return;
      ensureArchitecturalGlAccounts(db);
      const body = req.body || {};
      const branchScope = resolveExecDashboardBranchScope(req.user, req, body.branchId);
      const result = postOpeningPackJournal(db, {
        branchScope,
        capitalNgn: body.capitalNgn,
        inventoryPeriodKey: body.inventoryPeriodKey,
        createdByUserId: req.user?.id,
      });
      if (!result.ok) return res.status(400).json(result);
      storeIdempotentSuccess(db, req, 'finance.opening_pack.post', result.duplicate ? 200 : 201, result);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (e) {
      console.error('[opening-pack-post]', e);
      return res.status(500).json({ ok: false, error: 'Could not post opening pack.' });
    }
  });

  app.get('/api/finance/control-tie-out', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      ensureArchitecturalGlAccounts(db);
      const periodKey = String(req.query.period || req.query.periodKey || '').trim();
      if (!isValidFinancePackPeriodKey(periodKey)) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const thresholdRaw = req.query.thresholdPct ?? req.query.threshold;
      const thresholdPct = thresholdRaw != null && thresholdRaw !== '' ? Number(thresholdRaw) : undefined;
      const report = buildControlTieOutReport(db, { periodKey, branchScope, thresholdPct });
      if (!report.ok) return res.status(400).json(report);
      return res.json(report);
    } catch (e) {
      console.error('[control-tie-out]', e);
      return res.status(500).json({ ok: false, error: 'Could not build control tie-out.' });
    }
  });

  app.get('/api/finance/cutover-plan', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      ensureArchitecturalGlAccounts(db);
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const plan = buildCutoverActionPlan(db, branchScope);
      return res.json(plan);
    } catch (e) {
      console.error('[cutover-plan]', e);
      return res.status(500).json({ ok: false, error: 'Could not build cutover action plan.' });
    }
  });

  app.get('/api/finance/desk-overview', requireAuth, async (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      ensureArchitecturalGlAccounts(db);
      const periodKey = String(req.query.period || req.query.periodKey || '').trim();
      if (!isValidFinancePackPeriodKey(periodKey)) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const branchId = branchScope === 'ALL' ? null : branchScope;
      const trialExceptions = await buildFinanceTrialExceptionSummary(db, { branchId });
      const overview = buildAccountingDeskOverview(db, periodKey, branchScope, trialExceptions);
      return res.json(overview);
    } catch (e) {
      console.error('[desk-overview]', e);
      return res.status(500).json({ ok: false, error: 'Could not load accounting desk overview.' });
    }
  });

  app.get('/api/finance/month-end-close', requireAuth, async (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      const periodKey = String(req.query.period || req.query.periodKey || '').trim();
      if (!isValidFinancePackPeriodKey(periodKey)) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const branchId = branchScope === 'ALL' ? null : branchScope;
      const trialExceptions = await buildFinanceTrialExceptionSummary(db, { branchId });
      const checklist = buildMonthEndCloseChecklist(db, periodKey, branchScope, { trialExceptions });
      if (!checklist.ok) return res.status(400).json(checklist);
      return res.json(checklist);
    } catch (e) {
      console.error('[month-end-close]', e);
      return res.status(500).json({ ok: false, error: 'Could not build month-end close checklist.' });
    }
  });

  app.get('/api/finance/depreciation/preview', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      const periodKey = String(req.query.period || req.query.periodKey || '').trim();
      if (!isValidFinancePackPeriodKey(periodKey)) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      return res.json(previewDepreciationRun(db, periodKey, branchScope));
    } catch (e) {
      console.error('[depreciation-preview]', e);
      return res.status(500).json({ ok: false, error: 'Could not preview depreciation.' });
    }
  });

  app.post('/api/finance/depreciation/post', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    if (!userHasPermission(req.user, 'finance.post')) {
      return res.status(403).json({ ok: false, error: 'finance.post required.', code: 'FORBIDDEN' });
    }
    try {
      const body = req.body || {};
      const periodKey = String(body.period || body.periodKey || '').trim();
      if (!isValidFinancePackPeriodKey(periodKey)) {
        return res.status(400).json({ ok: false, error: 'Invalid period. Use YYYY-MM.' });
      }
      const branchScope = resolveExecDashboardBranchScope(req.user, req, body.branchId);
      ensureArchitecturalGlAccounts(db);
      const result = postDepreciationRun(db, periodKey, branchScope, req.user, req.workspaceBranchId || null);
      if (!result.ok) return res.status(400).json(result);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (e) {
      console.error('[depreciation-post]', e);
      return res.status(500).json({ ok: false, error: 'Could not post depreciation.' });
    }
  });

  app.get('/api/finance/payroll-runs/:runId/gl-status', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    try {
      return res.json(payrollGlStatusForRun(db, req.params.runId));
    } catch (e) {
      console.error('[payroll-gl-status]', e);
      return res.status(500).json({ ok: false, error: 'Could not load payroll GL status.' });
    }
  });

  app.post('/api/finance/payroll-runs/:runId/accrual-gl', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    if (!userHasPermission(req.user, 'finance.post')) {
      return res.status(403).json({ ok: false, error: 'finance.post required.', code: 'FORBIDDEN' });
    }
    try {
      ensureArchitecturalGlAccounts(db);
      const result = tryPostPayrollAccrualGlTx(db, req.params.runId, {
        createdByUserId: req.user?.id,
        branchId: req.workspaceBranchId || null,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (e) {
      console.error('[payroll-accrual-gl]', e);
      return res.status(500).json({ ok: false, error: 'Could not post payroll accrual.' });
    }
  });

  app.post('/api/finance/payroll-remittance', requireAuth, (req, res) => {
    if (!userMayAccessAccountingGlApis(req.user)) {
      return res.status(403).json({ ok: false, error: 'Accounting / GL access required.', code: 'FORBIDDEN' });
    }
    if (!userHasPermission(req.user, 'finance.post')) {
      return res.status(403).json({ ok: false, error: 'finance.post required.', code: 'FORBIDDEN' });
    }
    try {
      const body = req.body || {};
      ensureArchitecturalGlAccounts(db);
      const result = tryPostPayrollStatutoryRemittanceGlTx(db, {
        entryDateISO: body.entryDateISO || new Date().toISOString().slice(0, 10),
        treasuryAccountId: body.treasuryAccountId,
        payeNgn: body.payeNgn,
        pensionNgn: body.pensionNgn,
        sourceId: body.sourceId || `REMIT-${body.period || body.entryDateISO || 'MANUAL'}`,
        memo: body.memo,
        createdByUserId: req.user?.id,
        branchId: req.workspaceBranchId || null,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (e) {
      console.error('[payroll-remittance]', e);
      return res.status(500).json({ ok: false, error: 'Could not post payroll remittance.' });
    }
  });

  app.get('/api/reports/summary', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const counts = workspaceReportAggregateCounts(db, branchScope);
      res.json({ ok: true, branchScope, counts });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load report summary' });
    }
  });

  /** All entered operational records (not period-filtered). */
  app.get('/api/reports/entered-data.xlsx', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const pack = collectEnteredDataPack(db, branchScope);
      const buf = buildEnteredDataXlsx(pack);
      const filename = enteredDataFilename(branchScope, pack.generatedAtISO);
      appendAuditLog(db, {
        actor: req.user,
        action: 'reports.entered_data_export',
        entityKind: 'reports',
        entityId: 'entered-data.xlsx',
        note: `Entered-data workbook (${pack.recordCount} rows, ${branchScope})`,
        details: { branchScope, recordCount: pack.recordCount, totals: pack.totals },
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buf);
    } catch (e) {
      console.error('[entered-data-export]', e);
      return res.status(500).json({ ok: false, error: 'Could not export entered data.' });
    }
  });

  app.get('/api/reports/pending-approvals', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json(buildPendingApprovalsReport(db, branchScope));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load pending approvals report.' });
    }
  });

  app.get('/api/reports/production-status', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json(buildProductionStatusReport(db, branchScope));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load production status report.' });
    }
  });

  /** Annex D §D.7: automated fraud indicator exceptions (repeat refunds, ghost payroll, stale receipts, Others spend). */
  app.get('/api/reports/fraud-indicators', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const report = buildFraudIndicatorsReport(db, {
        branchScope,
        days: Number(req.query.days) || undefined,
        othersThresholdPct: Number(req.query.othersThresholdPct) || undefined,
        staleReceiptDays: Number(req.query.staleReceiptDays) || undefined,
      });
      res.json({ ok: true, ...report });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build fraud indicators report.' });
    }
  });

  app.get('/api/reports/governance-pack', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const pack = buildGovernancePack(db, branchScope);
      const format = String(req.query.format || 'json').trim().toLowerCase();
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="governance-pack-${branchScope}-${new Date().toISOString().slice(0, 10)}.csv"`
        );
        res.send(governancePackToCsv(pack));
        return;
      }
      res.json(pack);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load governance pack.' });
    }
  });

  app.get('/api/reports/material-transaction', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const report = buildMaterialTransactionReport({
        productionJobs: listProductionJobs(db, branchScope, productionHistoryListOpts()),
        productionJobCoils: listProductionJobCoils(db, branchScope, { limit: 0 }),
        quotations: listQuotations(db, branchScope),
        refunds: listRefunds(db, branchScope),
        coilLots: listCoilLots(db, branchScope),
        products: listProducts(db, branchScope),
        stockMovements: listStockMovementsForBranchPeriod(db, branchScope, startDate, endDate),
        stockMovementsThroughEnd: listStockMovementsForBranchThrough(db, branchScope, endDate),
        masterData: listMasterData(db),
        accessoryUsage: listProductionJobAccessoryUsage(db, branchScope),
        startDate,
        endDate,
      });
      res.json({ ok: true, startDate, endDate, branchScope, report });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build material transaction report.' });
    }
  });

  app.get('/api/reports/conversion-summary', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      if (!startDate || !endDate || startDate > endDate) {
        return res.status(400).json({ ok: false, error: 'Valid startDate and endDate are required.' });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const report = buildConversionSummaryReport(db, {
        startDate,
        endDate,
        branchId: branchScope === 'ALL' ? null : branchScope,
      });
      res.json({ ok: true, startDate, endDate, branchScope, report });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build conversion summary report.' });
    }
  });

  /** @deprecated Use GET /api/reports/material-transaction */
  app.get('/api/reports/production-transaction', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const report = buildMaterialTransactionReport({
        productionJobs: listProductionJobs(db, branchScope, productionHistoryListOpts()),
        productionJobCoils: listProductionJobCoils(db, branchScope, { limit: 0 }),
        quotations: listQuotations(db, branchScope),
        refunds: listRefunds(db, branchScope),
        coilLots: listCoilLots(db, branchScope),
        startDate,
        endDate,
      });
      const flat = [];
      for (const fam of ['aluminium', 'aluzinc']) {
        for (const g of report[fam]?.groups || []) {
          for (const r of g.rows) {
            flat.push({
              qtNoDisplay: r.qtNoDisplay,
              prodDate: r.txnDate,
              customer: r.customerProject,
              color: r.colour,
              gauge: r.gauge,
              materialType: r.materialType,
              coilNoDisplay: r.coilNoDisplay,
              beforeKg: r.beforeKg,
              afterKg: r.afterKg,
              kgUsed: r.kgUsed,
              meters: r.meters,
              conversionKgM: r.conversionKgM,
              design: r.design,
              offcutKg: r.offcutKg,
              paidNgn: r.amountNetNgn,
              materialCostNgn: 0,
              jobId: r.jobId,
            });
          }
        }
      }
      res.json({ ok: true, startDate, endDate, branchScope, rows: flat });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build production transaction report.' });
    }
  });

  app.get('/api/reports/receipts-register', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const raw = listSalesReceipts(db, branchScope);
      const ledger = listLedgerEntries(db, branchScope);
      const enriched = enrichSalesReceiptRowsWithCashFromLedger(raw, ledger);
      const tm = listTreasuryMovements(db, branchScope, financeHistoryListOpts());
      const rows = receiptsRegisterReportRows(enriched, ledger, tm, startDate, endDate);
      res.json({ ok: true, startDate, endDate, branchScope, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build receipts register.' });
    }
  });

  app.get('/api/reports/revenue-production', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const quotations = listQuotations(db, branchScope);
      const jobs = listProductionJobs(db, branchScope, productionHistoryListOpts());
      const rows = revenueProductionReportRows(quotations, jobs, startDate, endDate);
      res.json({ ok: true, startDate, endDate, branchScope, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build revenue (production) report.' });
    }
  });

  app.get('/api/reports/ar-as-at', requireManagementReportsView, (req, res) => {
    try {
      const asAtDate = String(req.query.asAtDate || req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const quotations = listQuotations(db, branchScope);
      const ledger = listLedgerEntries(db, branchScope);
      const productionJobs = listProductionJobs(db, branchScope, productionHistoryListOpts());
      const rows = arAsAtReportRows(quotations, ledger, productionJobs);
      res.json({
        ok: true,
        asAtDate: asAtDate || null,
        branchScope,
        arBasis: 'production_completed_pending_balance',
        rows,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build AR as-at report.' });
    }
  });

  app.get('/api/reports/sales-bridge', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const asAtDate = String(req.query.asAtDate || endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const raw = listSalesReceipts(db, branchScope);
      const ledger = listLedgerEntries(db, branchScope);
      const enriched = enrichSalesReceiptRowsWithCashFromLedger(raw, ledger);
      const jobs = listProductionJobs(db, branchScope, productionHistoryListOpts());
      const rows = salesBridgeReportRows(enriched, jobs, startDate, endDate, asAtDate);
      res.json({ ok: true, startDate, endDate, asAtDate: asAtDate || null, branchScope, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build sales bridge report.' });
    }
  });

  app.get('/api/reports/expenses-pack', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const expenses = listExpenses(db, branchScope, financeHistoryListOpts());
      const { detail, summaryByCategory } = expensesPackReport(expenses, startDate, endDate);
      res.json({ ok: true, startDate, endDate, branchScope, detail, summaryByCategory });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build expenses pack.' });
    }
  });

  app.get('/api/reports/refunds-pack', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const refunds = listRefunds(db, branchScope);
      const pack = refundsPackReport(refunds, startDate, endDate);
      res.json({ ok: true, startDate, endDate, branchScope, ...pack });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build refunds pack.' });
    }
  });

  app.get('/api/reports/purchase-register', requireManagementReportsView, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      const report = buildPurchaseReport({
        purchaseOrders: listPurchaseOrders(db, branchScope),
        coilLots: listCoilLots(db, branchScope),
        stockMovements: listStockMovementsForBranchPeriod(db, branchScope, startDate, endDate),
        treasuryMovements: listTreasuryMovements(db, branchScope, financeHistoryListOpts()),
        products: listProducts(db, branchScope),
        masterData: listMasterData(db),
        startDate,
        endDate,
      });
      res.json({ ok: true, startDate, endDate, branchScope, report });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build purchase register report.' });
    }
  });

  app.get('/api/reports/purchases', requireManagementReportsView, (req, res) => {
    try {
      const cut = String(req.query.cut || 'received').toLowerCase();
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      if (cut === 'ordered') {
        const pos = listPurchaseOrders(db, branchScope);
        const rows = purchasesOrderedRows(pos, startDate, endDate);
        return res.json({ ok: true, cut: 'ordered', startDate, endDate, branchScope, rows });
      }
      if (cut === 'paid') {
        const tm = listTreasuryMovements(db, branchScope, financeHistoryListOpts());
        const rows = purchasesPaidRows(tm, startDate, endDate);
        return res.json({ ok: true, cut: 'paid', startDate, endDate, branchScope, rows });
      }
      const lots = listCoilLots(db, branchScope);
      const rows = purchasesReceivedRows(lots, startDate, endDate);
      return res.json({ ok: true, cut: 'received', startDate, endDate, branchScope, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build purchases report.' });
    }
  });

  app.get('/api/reports/stock-coil-as-at', requireManagementReportsView, (req, res) => {
    try {
      const asAtDate = String(req.query.asAtDate || req.query.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      if (!asAtDate) {
        return res.status(400).json({ ok: false, error: 'asAtDate (or endDate) required' });
      }
      const snap = listInventoryCoilSnapshots(db, asAtDate, branchScope);
      if (snap.length > 0) {
        const rows = stockCoilAsAtRows(snap);
        return res.json({
          ok: true,
          asAtDate,
          branchScope,
          asAtMode: 'snapshot',
          snapshotRowCount: snap.length,
          rows,
        });
      }
      const live = listCoilLots(db, branchScope);
      const rows = stockCoilAsAtRows(live);
      return res.json({
        ok: true,
        asAtDate,
        branchScope,
        asAtMode: 'live',
        snapshotRowCount: 0,
        disclaimer:
          'No snapshot for this date — rows show current coil balances. Capture a month-end snapshot (POST /api/reports/coil-snapshot-capture) for historical closing.',
        rows,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build stock report.' });
    }
  });

  app.post('/api/reports/coil-snapshot-capture', requireAuth, requireCoilSnapshotCapture, (req, res) => {
    try {
      const asAtISO = String(req.body?.asAtISO || req.body?.asAtDate || '').slice(0, 10);
      if (!asAtISO) {
        return res.status(400).json({ ok: false, error: 'asAtISO required (YYYY-MM-DD)' });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const r = write.replaceInventoryCoilSnapshots(db, asAtISO, branchScope);
      if (!r.ok) {
        return res.status(400).json(r);
      }
      res.json({ ok: true, ...r, branchScope });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not capture coil snapshot.' });
    }
  });

  const stockRegisterReadPerms = ['reports.view', 'operations.manage', 'production.manage', 'inventory.adjust', 'procurement.manage'];
  /** Store may print/confirm; managers may also print. */
  const stockRegisterStorePerms = ['operations.manage', 'production.manage', 'inventory.adjust'];
  /** BM / MD only — store has operations.manage but must not write BM register fields. */
  const stockRegisterManagerPerms = ['material_incidents.approve', 'sales.manage'];
  const stockRegisterProcurementPerms = ['procurement.manage', 'operations.manage'];

  app.get('/api/stock-register', requirePermission(stockRegisterReadPerms), (req, res) => {
    try {
      const periodEnd = String(req.query.periodEnd || req.query.endDate || req.query.asAtDate || '').slice(0, 10);
      const viewMode = String(req.query.viewMode || 'store').toLowerCase();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodEnd) {
        return res.status(400).json({ ok: false, error: 'periodEnd (YYYY-MM-DD) required' });
      }
      if (branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'Select a branch workspace (not HQ roll-up).' });
      }
      const r = buildStockRegisterForBranch(db, branchScope, periodEnd, { viewMode });
      if (!r.ok) return res.status(400).json(r);
      res.json({ ok: true, branchScope, viewMode, ...r });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not build stock register.' });
    }
  });

  app.get('/api/stock-register/inbox', requirePermission(stockRegisterReadPerms), (req, res) => {
    try {
      const queue = String(req.query.queue || 'manager').toLowerCase();
      const branchScope = resolveBootstrapBranchScope(req);
      if (branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'Select a branch workspace (not HQ roll-up).' });
      }
      res.json(listStockRegisterInbox(db, branchScope, queue));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load stock register inbox.' });
    }
  });

  app.get('/api/stock-register/workflow', requirePermission(stockRegisterReadPerms), (req, res) => {
    try {
      const periodKey = String(req.query.periodKey || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodKey || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodKey and branch workspace required.' });
      }
      res.json(getStockRegisterWorkflow(db, branchScope, periodKey));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load workflow.' });
    }
  });

  app.post('/api/stock-register/print-snapshot', requireAuth, requirePermission([...stockRegisterStorePerms, ...stockRegisterManagerPerms]), (req, res) => {
    try {
      const periodEnd = String(req.body?.periodEnd || req.body?.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodEnd || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodEnd and branch workspace required.' });
      }
      const r = saveStockRegisterPrintSnapshot(db, branchScope, periodEnd, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not save print snapshot.' });
    }
  });

  app.post('/api/stock-register/workflow', requireAuth, (req, res) => {
    try {
      const action = String(req.body?.action || '').trim();
      const rk = String(req.user?.roleKey || '').trim().toLowerCase();
      const mdApproveAction = action === 'md_approve';
      const executiveMd =
        mdApproveAction && ['md', 'admin', 'ceo', 'chairman'].includes(rk);
      if (!executiveMd) {
        const allowed = [
          ...stockRegisterStorePerms,
          ...stockRegisterManagerPerms,
          ...stockRegisterProcurementPerms,
        ];
        const hasPerm = allowed.some((p) => userHasPermission(req.user, p));
        if (!hasPerm) {
          return res.status(403).json({ ok: false, error: 'Forbidden.' });
        }
      }
      const periodKey = String(req.body?.periodKey || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!action || !periodKey || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'action, periodKey, and branch workspace required.' });
      }
      const r = advanceStockRegisterWorkflow(db, branchScope, periodKey, action, req.body || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Workflow action failed.' });
    }
  });

  app.post('/api/stock-register/bm-adjustments', requireAuth, requirePermission(stockRegisterManagerPerms), (req, res) => {
    try {
      const periodKey = String(req.body?.periodKey || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodKey || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodKey and branch workspace required.' });
      }
      const r = saveStockRegisterBmAdjustments(db, branchScope, periodKey, req.body?.adjustments || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not save adjustments.' });
    }
  });

  app.post('/api/stock-register/line-clearance', requireAuth, requirePermission(stockRegisterManagerPerms), (req, res) => {
    try {
      const periodKey = String(req.body?.periodKey || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodKey || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodKey and branch workspace required.' });
      }
      const r = saveStockRegisterLineClearance(db, branchScope, periodKey, req.body?.lineClearance, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not save line clearance.' });
    }
  });

  app.post('/api/stock-register/store-checklist', requireAuth, requirePermission(stockRegisterStorePerms), (req, res) => {
    try {
      const periodKey = String(req.body?.periodKey || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodKey || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodKey and branch workspace required.' });
      }
      const r = saveStockRegisterStoreChecklist(db, branchScope, periodKey, req.body?.checklist, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not save store checklist.' });
    }
  });

  app.get('/api/stock-register/line-detail', requirePermission(stockRegisterReadPerms), (req, res) => {
    try {
      const periodKey = String(req.query.periodKey || '').trim();
      const lineKey = String(req.query.lineKey || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodKey || !lineKey || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodKey, lineKey, and branch workspace required.' });
      }
      const r = getStockRegisterLineDetail(db, branchScope, periodKey, lineKey);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load line detail.' });
    }
  });

  app.post('/api/stock-register/capture-closing', requireAuth, requirePermission(stockRegisterProcurementPerms), (req, res) => {
    try {
      const periodEnd = String(req.body?.periodEnd || req.body?.endDate || '').slice(0, 10);
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodEnd || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodEnd and branch workspace required.' });
      }
      const r = captureStockRegisterClosing(db, branchScope, periodEnd, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not capture closing stock.' });
    }
  });

  app.post('/api/stock-register/reopen', requireAuth, (req, res) => {
    try {
      const periodEnd = String(req.body?.periodEnd || req.body?.endDate || '').slice(0, 10);
      const reason = String(req.body?.reason || '').trim();
      const branchScope = resolveBootstrapBranchScope(req);
      if (!periodEnd || branchScope === 'ALL') {
        return res.status(400).json({ ok: false, error: 'periodEnd and branch workspace required.' });
      }
      const r = reopenStockRegisterClosing(db, branchScope, periodEnd, req.user, reason);
      const status = r.ok ? 200 : String(r.error || '').includes('Only MD') ? 403 : 400;
      res.status(status).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not reopen stock register.' });
    }
  });

  app.patch('/api/coil-lots/:coilNo/stock-form', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = patchCoilStockForm(db, req.params.coilNo, req.body?.stockForm ?? req.body?.stock_form, {
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update coil stock form.' });
    }
  });

  app.get('/api/exec/summary', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      res.json(execOrgSummary(db));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load executive summary.' });
    }
  });

  app.get('/api/exec/dashboard', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const payload = buildExecutiveDashboard(db, req.user, {
        branchScope,
        periodKey: req.query.periodKey,
        startISO: req.query.startISO,
        endISO: req.query.endISO,
      });
      res.json(payload);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load executive dashboard.' });
    }
  });

  app.get('/api/exec/customers', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const period = resolveExecDashboardPeriod({
        periodKey: req.query.periodKey,
        startISO: req.query.startISO,
        endISO: req.query.endISO,
      });
      res.json(
        buildMdCustomerIntelPack(db, {
          branchScope,
          startISO: period.startISO,
          endISO: period.endISO,
          limit: req.query.limit,
        })
      );
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load MD customer intelligence.' });
    }
  });

  app.get('/api/exec/customers/:customerId/brief', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const result = buildExecCustomerBrief(db, req.params.customerId, branchScope);
      if (!result.ok) {
        const status = result.error === 'Customer not found' ? 404 : 400;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load customer brief.' });
    }
  });

  app.get('/api/exec/trace', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      const branchScope = resolveExecDashboardBranchScope(req.user, req, req.query.branchId);
      const dateISO = String(req.query.date || req.query.dateISO || new Date().toISOString().slice(0, 10)).slice(
        0,
        10
      );
      const shuffle = String(req.query.shuffle || '').trim() === '1';
      const shuffleNonce = shuffle ? String(Date.now()) : '';
      if (shuffle) {
        appendAuditLog(db, {
          actor: req.user,
          action: 'md.trace.shuffle',
          entityKind: 'md_trace',
          entityId: dateISO,
          note: `branchScope=${branchScope}`,
        });
      }
      res.json(
        buildMdTracePack(db, {
          branchScope,
          dateISO,
          shuffleNonce,
        })
      );
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load MD trace samples.' });
    }
  });

  app.get('/api/exec/review-note', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      const monthKey =
        String(req.query.monthKey || req.query.month || '').trim().slice(0, 7) ||
        new Date().toISOString().slice(0, 7);
      res.json(getMdReviewNote(db, monthKey));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load review note.' });
    }
  });

  app.put('/api/exec/review-note', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      const rk = String(req.user?.roleKey || '').toLowerCase();
      if (rk !== 'md' && rk !== 'admin' && !userHasPermission(req.user, '*')) {
        return res.status(403).json({ ok: false, error: 'Only MD may save chairman review notes.' });
      }
      const monthKey =
        String(req.body?.monthKey || req.query?.monthKey || '').trim().slice(0, 7) ||
        new Date().toISOString().slice(0, 7);
      const result = saveMdReviewNote(db, req.user, monthKey, req.body?.narrative ?? '');
      if (!result.ok) return res.status(400).json(result);
      appendAuditLog(db, {
        actor: req.user,
        action: 'md.review_note.put',
        entityKind: 'md_review_note',
        entityId: monthKey,
        note: `Chairman review narrative updated for ${monthKey}`,
      });
      return res.json(result);
    } catch (e) {
      console.error(e);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/exec/reserve-policy', requirePermission('exec.dashboard.view'), (req, res) => {
    try {
      res.json(getExecReservePolicyResponse(db));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load reserve policy.' });
    }
  });

  app.put('/api/exec/reserve-policy', requirePermission(RESERVE_POLICY_MANAGE_PERMISSION), (req, res) => {
    try {
      const result = setExecReservePolicy(db, req.body || {}, req.user);
      if (result.ok) {
        appendAuditLog(db, {
          actor: req.user,
          action: 'treasury.reserve_policy.put',
          entityKind: 'org_policy',
          entityId: 'treasury_reserve_policy',
          note: 'Executive reserve policy updated via /api/exec/reserve-policy',
          details: {
            configured: result.configured,
            completionPct: result.completionPct,
          },
        });
        return res.json(result);
      }
      return res.status(400).json(result);
    } catch (e) {
      console.error(e);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/pricing/price-list', requirePermission(['pricing.manage', 'md.price_exception.approve']), (req, res) => {
    try {
      const asAtIso = String(req.query?.asAtIso || req.query?.asOf || '').trim().slice(0, 10) || undefined;
      const pricingAsAtIso = asAtIso || normalizePricingAsAtIso(null);
      res.json({ ok: true, items: listPriceListItems(db, asAtIso), pricingAsAtIso });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load price list.' });
    }
  });

  app.get(
    '/api/pricing/price-list/export.csv',
    requirePermission(['pricing.manage', 'md.price_exception.approve']),
    (req, res) => {
      try {
        const asAtIso = String(req.query?.asAtIso || req.query?.asOf || '').trim().slice(0, 10) || undefined;
        const csv = priceListItemsToCsv(listPriceListItems(db, asAtIso));
        const label = asAtIso || new Date().toISOString().slice(0, 10);
        const name = `price-list-items-${label}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send(`\uFEFF${csv}`);
      } catch (e) {
        console.error(e);
        res.status(500).send('Could not export price list.');
      }
    }
  );

  app.post('/api/pricing/price-list', requirePermission('pricing.manage'), (req, res) => {
    try {
      const r = upsertPriceListItem(db, req.body || {}, req.user);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not save price list row.' });
    }
  });

  app.delete('/api/pricing/price-list/:id', requirePermission('pricing.manage'), (req, res) => {
    try {
      const r = deletePriceListItem(db, String(req.params.id || ''), req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not delete price list row.' });
    }
  });

  app.get('/api/pricing/material-sheet', requirePermission(['pricing.manage', 'md.price_exception.approve']), (req, res) => {
    try {
      const materialKey = String(req.query.materialKey || '').trim();
      const branchId = String(req.query.branchId || '').trim();
      const asAtIso = String(req.query?.asAtIso || req.query?.asOf || '').trim().slice(0, 10) || undefined;
      const r = listMaterialPricingSheet(db, materialKey, branchId, asAtIso);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load material pricing sheet.' });
    }
  });

  app.get(
    '/api/pricing/material-workbook-print-extras',
    requirePermission(['pricing.manage', 'md.price_exception.approve']),
    (_req, res) => {
      try {
        const md = listMasterData(db);
        const accessories = (md.quoteItems || []).filter(
          (q) => String(q.itemType || '').toLowerCase() === 'accessory' && q.active !== false
        );
        res.json({ ok: true, accessories });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load workbook print extras.' });
      }
    }
  );

  app.get(
    '/api/pricing/material-workbook-all.html',
    requirePermission(['pricing.manage', 'md.price_exception.approve']),
    (req, res) => {
      try {
        const branchId = String(req.query.branchId || '').trim();
        if (!branchId) {
          res.status(400).setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.send('branchId query parameter is required.');
          return;
        }
        const branchLabel = String(req.query.branchName || req.query.branchLabel || '').trim();
        const asAtIso = String(req.query?.asAtIso || req.query?.asOf || '').trim().slice(0, 10) || undefined;
        const html = buildMaterialWorkbookAllHtml(db, branchId, {
          branchLabel: branchLabel || undefined,
          asAtIso,
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (e) {
        console.error(e);
        res.status(500).send('Could not build workbook printout.');
      }
    }
  );

  app.get(
    '/api/pricing/material-sheet/events',
    requirePermission(['pricing.manage', 'md.price_exception.approve']),
    (req, res) => {
      try {
        const materialKey = String(req.query.materialKey || '').trim();
        const branchId = String(req.query.branchId || '').trim() || undefined;
        const limit = req.query.limit;
        const r = listMaterialPricingEvents(db, { materialKey, branchId, limit });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load pricing change log.' });
      }
    }
  );

  app.post(
    '/api/pricing/material-sheet/rows',
    requirePermission(['pricing.manage', 'md.price_exception.approve']),
    (req, res) => {
      try {
        const r = upsertMaterialPricingSheetRow(db, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not save material pricing row.' });
      }
    }
  );

  app.post(
    '/api/pricing/material-sheet/rows/bulk',
    requirePermission(['pricing.manage', 'md.price_exception.approve']),
    (req, res) => {
      try {
        const r = upsertMaterialPricingSheetRowsBulk(db, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not save material pricing rows.' });
      }
    }
  );

  app.delete(
    '/api/pricing/material-sheet/rows/:id',
    requirePermission(['pricing.manage', 'md.price_exception.approve']),
    (req, res) => {
      try {
        const id = String(req.params.id || '').trim();
        const r = deleteMaterialPricingSheetRow(db, id, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not delete material pricing row.' });
      }
    }
  );

  app.post(
    '/api/pricing/material-sheet/publish',
    requirePermission('pricing.manage'),
    (req, res) => {
      try {
        const r = publishMaterialPricingSheet(db, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not publish material pricing sheet.' });
      }
    }
  );

  app.patch(
    '/api/quotations/:quotationId/md-price-exception-approve',
    requirePermission('md.price_exception.approve'),
    (req, res) => {
      try {
        const qid = String(req.params.quotationId || '');
        const r = approveMdPriceExceptionForQuotation(db, qid, req.user);
        if (!r.ok) return res.status(400).json(r);
        const quotation = getQuotation(db, qid);
        const rawPv = db.prepare(`SELECT id, lines_json, branch_id, date_iso FROM quotations WHERE id = ?`).get(qid);
        const pv = quotationPriceViolations(db, rawPv);
        return res.json({
          ok: true,
          quotation: {
            ...quotation,
            pricingViolations: pv.violations,
            pricingHasFloorRows: pv.hasFloorRows,
          },
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not record MD price exception approval.' });
      }
    }
  );

  /** @deprecated Branch managers may no longer approve below-floor pricing. */
  app.patch(
    '/api/quotations/:quotationId/bm-price-exception',
    requirePermission('refunds.approve'),
    (req, res) => {
      try {
        const qid = String(req.params.quotationId || '');
        const r = approveBranchManagerPriceExceptionForQuotation(db, qid, req.user);
        return res.status(403).json({ ...r, deprecated: true });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not record price exception approval.' });
      }
    }
  );

  /** @deprecated Use PATCH /api/quotations/:id/md-price-exception-approve */
  app.patch(
    '/api/quotations/:quotationId/md-price-exception-confirm',
    requirePermission('md.price_exception.approve'),
    (req, res) => {
      try {
        const qid = String(req.params.quotationId || '');
        const r = approveMdPriceExceptionForQuotation(db, qid, req.user);
        if (!r.ok) return res.status(400).json(r);
        const quotation = getQuotation(db, qid);
        const rawPv = db.prepare(`SELECT id, lines_json, branch_id, date_iso FROM quotations WHERE id = ?`).get(qid);
        const pv = quotationPriceViolations(db, rawPv);
        return res.json({
          ok: true,
          quotation: {
            ...quotation,
            pricingViolations: pv.violations,
            pricingHasFloorRows: pv.hasFloorRows,
          },
          deprecated: true,
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not record MD price review confirmation.' });
      }
    }
  );

  /** @deprecated Use PATCH /api/quotations/:id/md-price-exception-approve */
  app.patch(
    '/api/quotations/:quotationId/md-price-exception',
    requirePermission('md.price_exception.approve'),
    (req, res) => {
      try {
        const qid = String(req.params.quotationId || '');
        const r = approveMdPriceExceptionForQuotation(db, qid, req.user);
        if (!r.ok) return res.status(400).json(r);
        const quotation = getQuotation(db, qid);
        return res.json({ ok: true, quotation, deprecated: true });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not record price exception approval.' });
      }
    }
  );

  app.get('/api/pricing/policy', requirePermission(['pricing.manage', 'md.price_exception.approve', 'pricing.policy.manage']), (req, res) => {
    try {
      res.json({ ok: true, ...getPricingPolicyBundle(db) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load pricing policy.' });
    }
  });

  app.patch('/api/pricing/policy', requirePermission('pricing.policy.manage'), (req, res) => {
    try {
      const r = patchPricingPolicyBundle(db, req.body || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not save pricing policy.' });
    }
  });

  app.get(
    '/api/pricing/customer-price-book.html',
    requirePermission(['pricing.manage', 'md.price_exception.approve', 'pricing.policy.manage']),
    (req, res) => {
      try {
        const asAtIso = String(req.query?.asAtIso || req.query?.asOf || '').trim().slice(0, 10) || undefined;
        const html = buildCustomerPriceBookHtml(db, asAtIso);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (e) {
        console.error(e);
        res.status(500).send('Could not build price book.');
      }
    }
  );

  app.get('/api/quotations/:id/pricing-violations', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const qid = String(req.params.id || '').trim();
      const raw = db.prepare(`SELECT id, lines_json, branch_id, date_iso, md_price_exception_approved_at_iso FROM quotations WHERE id = ?`).get(qid);
      if (!raw) return res.status(404).json({ ok: false, error: 'Quotation not found' });
      const v = quotationPriceViolations(db, raw);
      res.json({
        ok: true,
        ...v,
        mdPriceExceptionApprovedAtISO: raw.md_price_exception_approved_at_iso ?? null,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not compute pricing violations.' });
    }
  });

  app.patch(
    '/api/sales-receipts/:receiptId/bank-confirmation',
    requirePermission(['finance.pay', 'receipts.post']),
    (req, res) => {
      try {
        const rid = String(req.params.receiptId || '');
        const rg = assertSalesReceiptIdInWorkspace(db, req, rid);
        if (!rg.ok) return res.status(rg.status).json({ ok: false, error: rg.error });
        return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'sales_receipt', rid, (stripped) => {
          const confirmed = Boolean(stripped?.confirmed);
          return write.patchSalesReceiptBankConfirmation(db, rid, confirmed, req.user);
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not update bank confirmation.' });
      }
    }
  );

  app.post(
    '/api/sales-receipts/reset-clearance',
    requirePermission('finance.approve'),
    (req, res) => {
      try {
        const r = write.resetAllSalesReceiptFinanceClearance(
          db,
          req.workspaceBranchId || DEFAULT_BRANCH_ID,
          req.user,
          req.body || {}
        );
        if (!r.ok) return res.status(400).json(r);
        return res.json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.patch(
    '/api/sales-receipts/:receiptId/finance-settlement',
    requirePermission(['finance.pay', 'finance.post']),
    (req, res) => {
      try {
        const rid = String(req.params.receiptId || '');
        const rg = assertSalesReceiptIdInWorkspace(db, req, rid);
        if (!rg.ok) return res.status(rg.status).json({ ok: false, error: rg.error });
        return handlePatchWithEditApproval(
          res,
          db,
          req.user,
          req.body || {},
          'sales_receipt',
          rid,
          (stripped) => write.patchSalesReceiptFinanceSettlement(db, rid, stripped || {}, req.user),
          {
            requiresEditApproval: (database, user, receiptId) =>
              receiptFinanceSettlementRequiresEditApproval(database, user, receiptId),
          }
        );
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.patch(
    '/api/treasury/movements/:movementId/ledger-receipt-correction',
    requirePermission(['finance.pay', 'finance.post']),
    (req, res) => {
      try {
        const movementId = String(req.params.movementId || '').trim();
        if (!movementId) {
          return res.status(400).json({ ok: false, error: 'movementId is required.' });
        }
        return handlePatchWithEditApproval(
          res,
          db,
          req.user,
          req.body || {},
          'treasury_movement',
          movementId,
          (stripped) => write.patchLedgerReceiptTreasuryMovement(db, movementId, stripped || {}, req.user),
          {
            requiresEditApproval: (database, user, mid) =>
              ledgerReceiptMovementRevisionRequiresEditApproval(database, user, mid),
          }
        );
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.patch(
    '/api/treasury/movements/:movementId/expense-out-correction',
    requirePermission(['finance.pay', 'finance.post']),
    (req, res) => {
      try {
        const movementId = String(req.params.movementId || '').trim();
        if (!movementId) {
          return res.status(400).json({ ok: false, error: 'movementId is required.' });
        }
        return handlePatchWithEditApproval(
          res,
          db,
          req.user,
          req.body || {},
          'treasury_movement',
          movementId,
          (stripped) =>
            write.patchExpenseOutflowTreasuryMovement(
              db,
              movementId,
              {
                ...(stripped || {}),
                workspaceBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
                workspaceViewAll: Boolean(req.workspaceViewAll),
              },
              req.user
            ),
          {
            requiresEditApproval: (database, user, mid) =>
              expenseOutflowCorrectionRequiresEditApproval(database, user, mid),
          }
        );
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  /**
   * Permission-aware quick search (FTS5 when indexed, SQL fallback): CRM, sales, procurement, ops, finance.
   */
  app.get('/api/workspace/search', requireAuth, (req, res) => {
    try {
      const raw = String(req.query.q ?? '').trim();
      const limit = Math.min(40, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
      const ctx = String(req.query.ctx ?? '').trim();
      if (raw.length < 2) {
        return res.json({ ok: true, results: [], indexReady: workspaceSearchFtsReady(db) });
      }
      const results = workspaceQuickSearch(db, req, raw, limit, { contextPath: ctx });
      if (!results.length) {
        logWorkspaceSearchMiss(db, {
          query: raw,
          contextPath: ctx,
          userId: req.user?.id,
          branchId: req.workspaceBranchId,
        });
      }
      return res.json({ ok: true, results, indexReady: workspaceSearchFtsReady(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Search failed' });
    }
  });

  app.post('/api/workspace/search/rebuild', requireAuth, requirePermission('settings.view'), (req, res) => {
    try {
      const n = rebuildWorkspaceSearchFts(db);
      return res.json({ ok: true, indexed: n });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not rebuild workspace search index.' });
    }
  });

  app.get('/api/workspace/counts', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      res.json(getWorkspaceCounts(db, scope, req.user));
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load workspace counts.' });
    }
  });

  app.get('/api/workspace/monitoring', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      const r = getWorkspaceMonitoring(db, scope, req.user);
      res.status(r.ok ? 200 : 403).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load monitoring data.' });
    }
  });

  /** Workspace V3 — rooms / activity / presence / SSE */
  app.get('/api/workspace/rooms', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = listWorkspaceRooms(db, scope, req.user);
      res.status(r.ok ? 200 : 503).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not list rooms.', rooms: [] });
    }
  });

  app.get('/api/workspace/rooms/:roomId/messages', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.post('/api/workspace/rooms/:roomId/read', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.post('/api/workspace/rooms/:roomId/mute', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.post('/api/workspace/rooms/:roomId/archive', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.post('/api/workspace/rooms/:roomId/messages', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.patch(
    '/api/workspace/rooms/:roomId/messages/:messageId',
    requireAuth,
    requirePermission('office.use'),
    (req, res) => {
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
    }
  );

  app.delete(
    '/api/workspace/rooms/:roomId/messages/:messageId',
    requireAuth,
    requirePermission('office.use'),
    (req, res) => {
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
    }
  );

  app.post('/api/workspace/rooms/:roomId/pin', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.post('/api/workspace/rooms/:roomId/promote', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.post('/api/workspace/rooms/dm', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.get('/api/workspace/activity', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = listActivityEvents(db, scope, req.user, { limit: Number(req.query.limit) || 50 });
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load activity.', events: [] });
    }
  });

  app.post('/api/workspace/activity/read', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const r = markActivityRead(db, req.user?.id);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not mark activity read.' });
    }
  });

  app.get('/api/workspace/presence', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = listPresence(db, scope);
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load presence.', presence: [] });
    }
  });

  app.post('/api/workspace/presence/heartbeat', requireAuth, requirePermission('office.use'), (req, res) => {
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

  app.get('/api/workspace/realtime', requireAuth, requirePermission('office.use'), (req, res) => {
    // Cookie/session auth via requireAuth; EventSource clients must set withCredentials: true.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    // Reconnect hint for EventSource, then handshake event.
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

  app.get('/api/work-items/:workItemId/timeline', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      const r = getWorkItemTimeline(db, scope, req.user, String(req.params.workItemId || ''));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load timeline.' });
    }
  });

  app.get('/api/work-items/:workItemId/related', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      const r = getWorkItemRelatedRecords(db, scope, req.user, String(req.params.workItemId || ''));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load related records.' });
    }
  });

  app.get('/api/office/threads/:threadId/timeline', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const scope = officeScopeFromReq(req);
      const r = getOfficeThreadTimeline(db, scope, req.user, String(req.params.threadId || ''));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load thread timeline.' });
    }
  });

  app.post('/api/work-items/bulk/read', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const r = bulkMarkWorkItemsRead(db, scope, req.user, ids);
      res.status(r.ok ? 200 : 400).json({ ...r, updated: r.succeeded ?? 0 });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Bulk read failed.' });
    }
  });

  app.post('/api/work-items/bulk/archive', requireAuth, requirePermission('office.use'), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const r = bulkArchiveWorkItems(db, scope, req.user, ids);
      res.status(r.ok ? 200 : 400).json({ ...r, updated: r.succeeded ?? 0 });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Bulk archive failed.' });
    }
  });

  app.get('/api/suppliers', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, suppliers: listSuppliers(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load suppliers' });
    }
  });

  app.get('/api/procurement/dashboard/summary', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const { from, to } = req.query || {};
      return res.json(procurementDashboardSummary(db, branchScope, { from, to }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load procurement dashboard summary.' });
    }
  });

  app.get('/api/procurement/dashboard/spend-trend', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const { from, to } = req.query || {};
      return res.json(procurementSpendTrend(db, branchScope, { from, to }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load procurement spend trend.' });
    }
  });

  app.get('/api/procurement/dashboard/supplier-scorecard', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(procurementSupplierScorecard(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load supplier scorecard.' });
    }
  });

  app.get('/api/procurement/dashboard/payables-aging', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(procurementPayablesAging(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load payables aging.' });
    }
  });

  app.get('/api/procurement/dashboard/coil-risk', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(procurementCoilRisk(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load coil risk.' });
    }
  });

  app.get('/api/procurement/dashboard/alerts', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(procurementAlerts(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load procurement alerts.' });
    }
  });

  app.get('/api/sales/dashboard/summary', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const { from, to } = req.query || {};
      return res.json(salesDashboardSummary(db, branchScope, { from, to }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load sales dashboard summary.' });
    }
  });

  app.get('/api/sales/dashboard/revenue-trend', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const { from, to } = req.query || {};
      return res.json(salesDashboardRevenueTrend(db, branchScope, { from, to }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load sales revenue trend.' });
    }
  });

  app.get('/api/sales/dashboard/receivables-aging', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(salesDashboardReceivablesAging(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load sales receivables aging.' });
    }
  });

  app.get('/api/sales/dashboard/top-customers', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(salesDashboardTopCustomers(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load sales top customers.' });
    }
  });

  app.get('/api/sales/dashboard/demand-mix', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(salesDashboardDemandMix(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load sales demand mix.' });
    }
  });

  app.get('/api/sales/dashboard/alerts', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      return res.json(salesDashboardAlerts(db, branchScope));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load sales alerts.' });
    }
  });

  app.get('/api/analytics/business-intelligence', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = req.query?.branchId
        ? resolveExecDashboardBranchScope(req.user, req, req.query.branchId)
        : resolveBootstrapBranchScope(req);
      const periodKey = String(req.query?.period || req.query?.periodKey || 'month').trim();
      const asOfISO = String(req.query?.asOfISO || req.query?.asOf || '').slice(0, 10) || undefined;
      const pack = loadBusinessIntelligencePack(db, branchScope, { periodKey, asOfISO });
      return res.json(pack);
    } catch (e) {
      console.error('[business-intelligence]', e);
      const detail = String(e?.message || e || '').trim();
      return res.status(500).json({
        ok: false,
        error: detail
          ? `Could not load business intelligence: ${detail}`
          : 'Could not load business intelligence.',
        code: 'BI_LOAD_FAILED',
      });
    }
  });

  function mayViewOpsHealth(req) {
    return (
      userMayViewAp3CostingReadiness(req.user) ||
      userHasPermission(req.user, 'reports.view') ||
      userHasPermission(req.user, 'operations.view')
    );
  }

  function opsHealthPackForRequest(req) {
    const branchScope = resolveBootstrapBranchScope(req);
    const branchId =
      branchScope === 'ALL'
        ? String(req.query?.branchId || req.workspaceBranchId || '').trim()
        : String(branchScope || '').trim();
    return buildOpsHealthAnalyticsPack(db, {
      branchId: branchId || 'ALL',
      dayIso: req.query?.dayIso,
      from: req.query?.from,
      to: req.query?.to,
    });
  }

  app.get('/api/analytics/ops-health', requireAuth, (req, res) => {
    try {
      if (!mayViewOpsHealth(req)) return res.status(403).json({ ok: false, error: 'You do not have permission to view operations health.', code: 'FORBIDDEN' });
      return res.json(opsHealthPackForRequest(req));
    } catch (e) {
      console.error('[ops-health]', e);
      return res.status(500).json({ ok: false, error: 'Could not load operations health.' });
    }
  });

  app.get('/api/analytics/ops-health.csv', requireAuth, (req, res) => {
    try {
      if (!mayViewOpsHealth(req)) return res.status(403).json({ ok: false, error: 'You do not have permission to view operations health.', code: 'FORBIDDEN' });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ops-health-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(opsHealthAnalyticsToCsv(opsHealthPackForRequest(req)));
    } catch (e) {
      console.error('[ops-health-csv]', e);
      return res.status(500).send('Could not export operations health.');
    }
  });

  app.get('/api/analytics/business-intelligence/export', requireManagementReportsView, (req, res) => {
    try {
      const branchScope = req.query?.branchId
        ? resolveExecDashboardBranchScope(req.user, req, req.query.branchId)
        : resolveBootstrapBranchScope(req);
      const periodKey = String(req.query?.period || req.query?.periodKey || 'month').trim();
      const asOfISO = String(req.query?.asOfISO || req.query?.asOf || '').slice(0, 10) || undefined;
      const pack = loadBusinessIntelligencePack(db, branchScope, { periodKey, asOfISO });
      const buf = buildBusinessIntelligenceXlsx(pack);
      const safePeriod = periodKey.replace(/[^a-z0-9_-]/gi, '') || 'month';
      const filename = `zarewa-business-intelligence-${safePeriod}-${pack.asOfISO || 'export'}.xlsx`;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buf);
    } catch (e) {
      console.error('[business-intelligence-export]', e);
      const detail = String(e?.message || e || '').trim();
      return res.status(500).json({
        ok: false,
        error: detail
          ? `Could not export business intelligence: ${detail}`
          : 'Could not export business intelligence.',
        code: 'BI_EXPORT_FAILED',
      });
    }
  });

  app.get(
    '/api/suppliers/:supplierId/agreements/:attachmentId/file',
    requirePermission(PROCUREMENT_DOMAIN_PERMS),
    (req, res) => {
      try {
        const sid = String(req.params.supplierId || '').trim();
        const aid = String(req.params.attachmentId || '').trim();
        if (!sid || !aid) return res.status(400).json({ ok: false, error: 'supplierId and attachmentId are required.' });
        const row = db
          .prepare(`SELECT supplier_id, supplier_profile_json, branch_id FROM suppliers WHERE supplier_id = ?`)
          .get(sid);
        if (!row) return res.status(404).json({ ok: false, error: 'Supplier not found.' });
        const profile = parseSupplierProfileJson(row.supplier_profile_json);
        const agreements = Array.isArray(profile.agreements) ? profile.agreements : [];
        const hit = agreements.find((a) => a && String(a.id) === aid);
        const b64 = hit?.dataBase64 != null ? String(hit.dataBase64).trim() : '';
        if (!b64) return res.status(404).json({ ok: false, error: 'Attachment not found or empty.' });
        let buf;
        try {
          buf = Buffer.from(b64, 'base64');
        } catch {
          return res.status(500).json({ ok: false, error: 'Invalid attachment encoding.' });
        }
        const mime = String(hit.mimeType || 'application/octet-stream').split(';')[0].trim();
        const name = String(hit.fileName || 'agreement').replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 200);
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send(buf);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to download attachment.' });
      }
    }
  );

  app.get('/api/transport-agents', requirePermission(PROCUREMENT_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, transportAgents: listTransportAgents(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load agents' });
    }
  });

  app.get('/api/associated-staff', requirePermission(ASSOCIATED_STAFF_READ_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, associatedStaff: listAssociatedStaff(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load associated staff' });
    }
  });

  app.post('/api/suppliers', requirePermission('suppliers.manage'), (req, res) => {
    try {
      const id = write.insertSupplier(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.status(201).json({ ok: true, supplierID: id });
    } catch (e) {
      if (e?.code === 'DUPLICATE_SUPPLIER_REGISTRATION') {
        return res.status(409).json({
          ok: false,
          error: String(e.message || e),
          code: e.code,
          existingSupplierId: e.existingSupplierId,
          conflictField: e.conflictField,
        });
      }
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/suppliers/:supplierId', requirePermission('suppliers.manage'), (req, res) => {
    const sid = req.params.supplierId;
    return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'supplier', sid, (stripped) =>
      write.updateSupplier(db, sid, stripped, req.workspaceBranchId || DEFAULT_BRANCH_ID)
    );
  });

  app.delete('/api/suppliers/:supplierId', requirePermission('suppliers.manage'), (req, res) => {
    const r = write.deleteSupplier(db, req.params.supplierId, req.workspaceBranchId || DEFAULT_BRANCH_ID);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post(
    '/api/transport-agents',
    requirePermission(['suppliers.manage', 'purchase_orders.manage']),
    (req, res) => {
      try {
        const id = write.insertTransportAgent(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID);
        res.status(201).json({ ok: true, id });
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.patch(
    '/api/transport-agents/:id',
    requirePermission(['suppliers.manage', 'purchase_orders.manage']),
    (req, res) => {
      const tid = req.params.id;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'transport_agent', tid, (stripped) =>
        write.updateTransportAgent(db, tid, stripped, req.workspaceBranchId || DEFAULT_BRANCH_ID)
      );
    }
  );

  app.delete(
    '/api/transport-agents/:id',
    requirePermission(['suppliers.manage', 'purchase_orders.manage']),
    (req, res) => {
    const r = write.deleteTransportAgent(db, req.params.id, req.workspaceBranchId || DEFAULT_BRANCH_ID);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post(
    '/api/associated-staff',
    requirePermission(ASSOCIATED_STAFF_MANAGE_PERMS),
    (req, res) => {
      try {
        const id = write.insertAssociatedStaff(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID);
        res.status(201).json({ ok: true, id });
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.patch(
    '/api/associated-staff/:id',
    requirePermission(ASSOCIATED_STAFF_MANAGE_PERMS),
    (req, res) => {
      const aid = req.params.id;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'associated_staff', aid, (stripped) =>
        write.updateAssociatedStaff(db, aid, stripped, req.workspaceBranchId || DEFAULT_BRANCH_ID)
      );
    }
  );

  app.delete(
    '/api/associated-staff/:id',
    requirePermission(ASSOCIATED_STAFF_MANAGE_PERMS),
    (req, res) => {
      const r = write.deleteAssociatedStaff(db, req.params.id, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.status(r.ok ? 200 : 400).json(r);
    }
  );

  app.get('/api/inventory/snapshot', requireAuth, (req, res) => {
    try {
      const includeControls =
        userHasPermission(req.user, 'audit.view') || userHasPermission(req.user, 'period.manage');
      const branchScope = resolveBootstrapBranchScope(req);
      res.json(
        buildBootstrap(db, {
          user: req.user,
          session: req.session,
          includeControls,
          includeUsers: userHasPermission(req.user, 'settings.view'),
          includeRegisteredPasswords:
            userHasPermission(req.user, 'settings.view') && canRevealUserPasswords(req.user),
          branchScope,
        })
      );
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed' });
    }
  });

  app.post('/api/customers', requirePermission('customers.manage'), (req, res) => {
    try {
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return res.status(403).json({ ok: false, error: createGate.error });
      const body = req.body || {};
      const linkedStaffUserId = String(body.linkedStaffUserId || body.staffUserId || '').trim();
      const id = write.insertCustomer(db, body, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      if (linkedStaffUserId) {
        if (!userMayLinkStaffSalesCustomer(req.user)) {
          return res.status(403).json({ ok: false, error: 'You cannot link staff to customers.', customerID: id });
        }
        const link = linkSalesCustomerToStaff(db, id, linkedStaffUserId, req.user);
        if (!link.ok) {
          return res.status(400).json({ ok: false, error: link.error, customerID: id, code: link.code });
        }
        return res.status(201).json({
          ok: true,
          customerID: id,
          staffLink: {
            staffUserId: link.staffUserId,
            staffDisplayName: link.staffDisplayName,
            staffEmployeeNo: link.staffEmployeeNo,
            customerName: link.customerName,
          },
        });
      }
      res.status(201).json({ ok: true, customerID: id });
    } catch (e) {
      if (e?.code === 'DUPLICATE_CUSTOMER_REGISTRATION') {
        return res.status(409).json({
          ok: false,
          error: String(e.message || e),
          code: e.code,
          existingCustomerId: e.existingCustomerId,
          conflictField: e.conflictField,
        });
      }
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/purchase-orders', requirePermission('purchase_orders.manage'), (req, res) => {
    try {
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return res.status(403).json({ ok: false, error: createGate.error });
      const body = req.body || {};
      const poID = body.poID || write.nextPoIdFromDb(db, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      const r = write.insertPurchaseOrder(db, { ...body, poID }, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.status(201).json({ ok: true, ...r });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/purchase-orders/:poId', requirePermission('purchase_orders.manage'), (req, res) => {
    try {
      const poId = req.params.poId;
      const poGate = assertPurchaseOrderIdInWorkspace(db, req, poId);
      if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'purchase_order', poId, (stripped) =>
        write.updatePurchaseOrderCoilDraft(db, poId, stripped, req.workspaceBranchId || DEFAULT_BRANCH_ID)
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/purchase-orders/:poId/link-transport', requirePermission('purchase_orders.manage'), (req, res) => {
    const poId = req.params.poId;
    const poGate = assertPurchaseOrderIdInWorkspace(db, req, poId);
    if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
    const body = req.body || {};
    const amt = Math.round(Number(body.transportAmountNgn) || 0);
    const acct = Number(body.treasuryAccountId);
    const needsTreasury = acct > 0 && amt > 0;
    if (needsTreasury && !userHasPermission(req.user, 'finance.pay')) {
      return res.status(403).json({
        ok: false,
        error: 'Recording haulage against treasury requires finance.pay permission.',
      });
    }
    return handlePatchWithEditApproval(res, db, req.user, body, 'purchase_order', poId, (stripped, ctx) => {
      const inOuter = Boolean(ctx?.withinEditApprovalTransaction);
      const syncOpts = inOuter ? { outerTransaction: true } : {};
      const {
        transportAgentId,
        transportAgentName,
        transportReference,
        transportNote,
        transportFinanceAdvice,
        transportAmountNgn,
        transportAdvanceNgn,
        treasuryAccountId,
        dateISO,
        postedAtISO,
        note,
        createdBy,
      } = stripped || {};
      const r = write.linkTransport(db, poId, transportAgentId, transportAgentName, {
        transportReference,
        transportNote,
        transportFinanceAdvice,
        transportAmountNgn: Math.round(Number(transportAmountNgn) || 0),
        transportAdvanceNgn: Math.round(Number(transportAdvanceNgn) || 0),
        treasuryAccountId,
        dateISO,
        postedAtISO,
        note,
        createdBy: createdBy || req.user.displayName,
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
        skipInnerTransaction: inOuter,
      });
      if (r.ok) {
        syncFinancePoTransportWorkItem(db, poId, req.user, syncOpts);
        syncInTransitLoadFromPoLink(db, poId, req.user, syncOpts);
        const st = db.prepare(`SELECT status FROM purchase_orders WHERE po_id = ?`).get(poId);
        if (st?.status === 'In Transit') syncInTransitLoadFromTransportPost(db, poId, req.user, syncOpts);
      }
      return r;
    });
  });

  app.post(
    '/api/purchase-orders/:poId/post-transport',
    requirePermission(['purchase_orders.manage', 'finance.pay']),
    (req, res) => {
    try {
      const poId = req.params.poId;
      const poGate = assertPurchaseOrderIdInWorkspace(db, req, poId);
      if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
      const body = req.body || {};
      const amt = Number(body.amountNgn);
      const acct = Number(body.treasuryAccountId);
      const needsTreasury = acct > 0 && !Number.isNaN(amt) && amt > 0;
      if (needsTreasury && !userHasPermission(req.user, 'finance.pay')) {
        return res.status(403).json({
          ok: false,
          error: 'Recording haulage against treasury requires finance.pay permission.',
        });
      }
      const r = write.postPurchaseOrderTransport(db, poId, {
        treasuryAccountId: body.treasuryAccountId,
        amountNgn: body.amountNgn,
        reference: body.reference,
        dateISO: body.dateISO,
        postedAtISO: body.postedAtISO,
        note: body.note,
        createdBy: body.createdBy || req.user.displayName,
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      if (r.ok) {
        syncFinancePoTransportWorkItem(db, poId, req.user);
        syncInTransitLoadFromTransportPost(db, poId, req.user);
      }
      return res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/purchase-orders/:poId/transport-paid', requirePermission('purchase_orders.manage'), (req, res) => {
    const poId = req.params.poId;
    const poGate = assertPurchaseOrderIdInWorkspace(db, req, poId);
    if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
    return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'purchase_order', poId, () =>
      write.markTransportPaid(db, poId)
    );
  });

  app.post('/api/purchase-orders/:poId/supplier-payment', requirePermission('finance.pay'), (req, res) => {
    const poGate = assertPurchaseOrderIdInWorkspace(db, req, req.params.poId);
    if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
    const { amountNgn, note, treasuryAccountId, reference, dateISO, createdBy } = req.body || {};
    const r = write.recordSupplierPayment(db, req.params.poId, amountNgn, note, {
      treasuryAccountId,
      reference,
      dateISO,
      createdBy: createdBy || req.user.displayName,
      actor: req.user,
      workspaceBranchId: req.workspaceBranchId,
      workspaceViewAll: Boolean(req.workspaceViewAll),
    });
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.patch('/api/purchase-orders/:poId/status', requirePermission('purchase_orders.manage'), (req, res) => {
    const poId = req.params.poId;
    const poGate = assertPurchaseOrderIdInWorkspace(db, req, poId);
    if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
    return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'purchase_order', poId, (stripped) => {
      const { status, acknowledgeTransportGap } = stripped || {};
      return write.setPoStatus(db, poId, status, {
        acknowledgeTransportGap: Boolean(acknowledgeTransportGap),
        actor: req.user,
      });
    });
  });

  app.patch('/api/purchase-orders/:poId/invoice', requirePermission('purchase_orders.manage'), (req, res) => {
    const poId = req.params.poId;
    const poGate = assertPurchaseOrderIdInWorkspace(db, req, poId);
    if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
    return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'purchase_order', poId, (stripped) => {
      const { invoiceNo, invoiceDateISO, deliveryDateISO } = stripped || {};
      return write.attachSupplierInvoice(db, poId, invoiceNo, invoiceDateISO, deliveryDateISO);
    });
  });

  app.post(
    '/api/cutting-lists',
    requirePermission(['sales.manage', 'operations.manage', 'quotations.manage']),
    (req, res) => {
    try {
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return res.status(403).json({ ok: false, error: createGate.error });
      const r = write.insertCuttingList(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      if (!r.ok) return res.status(400).json(r);
      const cuttingList = getCuttingList(db, r.id);
      res.status(201).json({ ok: true, id: r.id, cuttingList });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch(
    '/api/cutting-lists/:id',
    requirePermission(['sales.manage', 'operations.manage', 'quotations.manage']),
    (req, res) => {
    try {
      const cid = req.params.id;
      const cl0 = getCuttingList(db, cid);
      const bg = assertCuttingListRowInWorkspace(req, cl0);
      if (!bg.ok) return res.status(bg.status).json({ ok: false, error: bg.error });
      return handlePatchWithEditApproval(
        res,
        db,
        req.user,
        req.body || {},
        'cutting_list',
        cid,
        (stripped) => {
          const r = write.updateCuttingList(db, cid, stripped || {}, req.user);
          if (!r.ok) return r;
          const cuttingList = getCuttingList(db, cid);
          return { ok: true, cuttingList };
        },
        { requiresEditApproval: cuttingListEditRequiresEditApproval }
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  function productionJobIdForCuttingList(dbConn, cuttingListId) {
    const row = dbConn
      .prepare(
        `SELECT job_id FROM production_jobs WHERE cutting_list_id = ? ORDER BY created_at_iso DESC LIMIT 1`
      )
      .get(cuttingListId);
    return row?.job_id ? String(row.job_id) : null;
  }

  function resolveCuttingListProductionJob(dbConn, cuttingListId) {
    const cl = getCuttingList(dbConn, cuttingListId);
    if (!cl || !cl.productionRegistered) return null;
    return productionJobIdForCuttingList(dbConn, cuttingListId);
  }

  app.post(
    '/api/cutting-lists/:id/record-print',
    requirePermission(['sales.manage', 'operations.manage', 'quotations.manage', 'production.manage']),
    (req, res) => {
      try {
        const clId = req.params.id;
        const hg = assertCuttingListIdInWorkspace(db, req, clId);
        if (!hg.ok) return res.status(hg.status).json({ ok: false, error: hg.error });
        const r = write.recordCuttingListPrint(db, clId, req.user);
        if (!r.ok) return res.status(400).json(r);
        const cuttingList = getCuttingList(db, clId);
        res.json({ ok: true, printCount: r.printCount, cuttingList });
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/cutting-lists/:id/clear-production-hold',
    requirePermission('production.release'),
    (req, res) => {
      try {
        const hg = assertCuttingListIdInWorkspace(db, req, req.params.id);
        if (!hg.ok) return res.status(hg.status).json({ ok: false, error: hg.error });
        const r = write.clearCuttingListProductionHold(db, req.params.id, req.user);
        if (!r.ok) return res.status(400).json(r);
        const cuttingList = getCuttingList(db, req.params.id);
        res.json({ ok: true, cuttingList });
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/cutting-lists/:id/register-production',
    requirePermission(['sales.manage', 'production.manage', 'operations.manage', 'quotations.manage']),
    (req, res) => {
      try {
        const clId = req.params.id;
        const cl = getCuttingList(db, clId);
        if (!cl) return res.status(404).json({ ok: false, error: 'Cutting list not found.' });
        const rg = assertCuttingListRowInWorkspace(req, cl);
        if (!rg.ok) return res.status(rg.status).json({ ok: false, error: rg.error });
        if (cl.productionRegistered) {
          return res.status(400).json({
            ok: false,
            error: 'This cutting list is already on the production queue.',
          });
        }
        const body = req.body || {};
        const r = write.insertProductionJob(
          db,
          {
            cuttingListId: clId,
            productID: cl.productID,
            productName: cl.productName,
            plannedMeters: cl.totalMeters,
            plannedSheets: cl.sheetsToCut,
            machineName: body.machineName || cl.machineName || 'Production line',
            operatorName: body.operatorName || '',
            materialsNote: body.materialsNote,
          },
          req.workspaceBranchId || DEFAULT_BRANCH_ID
        );
        if (!r.ok) return res.status(400).json(r);
        const cuttingList = getCuttingList(db, clId);
        res.status(201).json({ ok: true, jobID: r.jobID, cuttingList });
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.get('/api/cutting-lists/:id/production/coil-allocations', requirePermission('production.manage'), (req, res) => {
    try {
      const wg = assertCuttingListIdInWorkspace(db, req, req.params.id);
      if (!wg.ok) return res.status(wg.status).json({ ok: false, error: wg.error });
      const jobId = resolveCuttingListProductionJob(db, req.params.id);
      if (!jobId) {
        return res.status(404).json({ ok: false, error: 'No production run for this cutting list.' });
      }
      const allocations = listProductionJobCoilsForJob(db, jobId);
      res.json({ ok: true, cuttingListId: req.params.id, jobID: jobId, allocations });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/cutting-lists/:id/production/allocations', requirePermission('production.manage'), (req, res) => {
    try {
      const wg = assertCuttingListIdInWorkspace(db, req, req.params.id);
      if (!wg.ok) return res.status(wg.status).json({ ok: false, error: wg.error });
      let jobId = resolveCuttingListProductionJob(db, req.params.id);
      if (!jobId) jobId = productionJobIdForCuttingList(db, req.params.id);
      if (!jobId) {
        return res.status(404).json({ ok: false, error: 'No production run for this cutting list.' });
      }
      const r = saveProductionJobAllocations(db, jobId, req.body?.allocations || [], {
        actor: req.user,
        append: Boolean(req.body?.append),
        workspaceBranchId: req.workspaceBranchId,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/cutting-lists/:id/production/start', requirePermission('production.manage'), (req, res) => {
    try {
      const wg = assertCuttingListIdInWorkspace(db, req, req.params.id);
      if (!wg.ok) return res.status(wg.status).json({ ok: false, error: wg.error });
      const jobId = resolveCuttingListProductionJob(db, req.params.id);
      if (!jobId) {
        return res.status(404).json({ ok: false, error: 'No production run for this cutting list.' });
      }
      const r = startProductionJob(db, jobId, req.body || {}, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/cutting-lists/:id/production/complete', requirePermission('production.manage'), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'production.complete')) return;
      const wg = assertCuttingListIdInWorkspace(db, req, req.params.id);
      if (!wg.ok) return res.status(wg.status).json({ ok: false, error: wg.error });
      const jobId = resolveCuttingListProductionJob(db, req.params.id);
      if (!jobId) {
        return res.status(404).json({ ok: false, error: 'No production run for this cutting list.' });
      }
      const existing = db.prepare(`SELECT status FROM production_jobs WHERE job_id = ? LIMIT 1`).get(jobId);
      if (String(existing?.status || '') === 'Completed') {
        const payload = { ok: true, idempotent: true, jobId, status: 'Completed' };
        storeIdempotentSuccess(db, req, 'production.complete', 200, payload);
        return res.status(200).json(payload);
      }
      const r = completeProductionJob(db, jobId, req.body || {}, { actor: req.user });
      if (r.ok) storeIdempotentSuccess(db, req, 'production.complete', 200, r);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/production/conversion-reason-options', requirePermission('production.manage'), (req, res) => {
    try {
      const band = String(req.query.band || '').trim();
      if (!band) {
        return res.status(400).json({ ok: false, error: 'band query param is required (High or Low).' });
      }
      res.json({ ok: true, band, options: conversionReasonOptionsForBand(band) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load conversion reason options.' });
    }
  });

  app.post('/api/cutting-lists/:id/production/conversion-preview', requirePermission('production.manage'), (req, res) => {
    try {
      const wg = assertCuttingListIdInWorkspace(db, req, req.params.id);
      if (!wg.ok) return res.status(wg.status).json({ ok: false, error: wg.error });
      const jobId = resolveCuttingListProductionJob(db, req.params.id);
      if (!jobId) {
        return res.status(404).json({ ok: false, error: 'No production run for this cutting list.' });
      }
      const r = previewProductionConversion(db, jobId, req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs', requirePermission('production.manage'), (req, res) => {
    try {
      const clId = String((req.body || {}).cuttingListId ?? '').trim();
      if (!clId) {
        return res.status(400).json({ ok: false, error: 'cuttingListId is required to create a production job.' });
      }
      const cg = assertCuttingListIdInWorkspace(db, req, clId);
      if (!cg.ok) return res.status(cg.status).json({ ok: false, error: cg.error });
      const r = write.insertProductionJob(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/production-jobs/:jobId/status', requirePermission('production.manage'), (req, res) => {
    try {
      const jid = req.params.jobId;
      const jg = assertProductionJobIdInWorkspace(db, req, jid);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'production_job', jid, (stripped) =>
        write.setProductionJobStatus(db, jid, stripped?.status)
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/production-jobs/:jobId/intel', requirePermission(['production.manage', 'operations.view']), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = getProductionJobIntel(db, req.params.jobId);
      res.status(r.ok ? 200 : 404).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load production job intelligence.' });
    }
  });

  app.get('/api/production-jobs/:jobId/coil-allocations', requirePermission('production.manage'), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const job = db.prepare(`SELECT job_id FROM production_jobs WHERE job_id = ?`).get(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, error: 'Production job not found.' });
      const allocations = listProductionJobCoilsForJob(db, req.params.jobId);
      res.json({ ok: true, jobID: req.params.jobId, allocations });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs/:jobId/allocations', requirePermission('production.manage'), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = saveProductionJobAllocations(db, req.params.jobId, req.body?.allocations || [], {
        actor: req.user,
        append: Boolean(req.body?.append),
        workspaceBranchId: req.workspaceBranchId,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs/:jobId/coil-run-log', requirePermission('production.manage'), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = saveProductionCoilRunLogDraft(db, req.params.jobId, req.body || {}, {
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs/:jobId/recalculate-stock', requirePermission('production.manage'), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = recalculateProductionJobCoilStock(db, req.params.jobId, {
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        extraCoilNos: Array.isArray(req.body?.extraCoilNos) ? req.body.extraCoilNos : [],
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs/:jobId/start', requirePermission('production.manage'), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = startProductionJob(db, req.params.jobId, req.body || {}, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs/:jobId/complete', requirePermission('production.manage'), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'production.complete')) return;
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return apiError(res, { status: jg.status, code: 'FORBIDDEN', error: jg.error });
      const existing = db
        .prepare(`SELECT status FROM production_jobs WHERE job_id = ? LIMIT 1`)
        .get(req.params.jobId);
      if (String(existing?.status || '') === 'Completed') {
        const payload = { ok: true, idempotent: true, jobId: req.params.jobId, status: 'Completed' };
        storeIdempotentSuccess(db, req, 'production.complete', 200, payload);
        return res.status(200).json(payload);
      }
      const r = completeProductionJob(db, req.params.jobId, req.body || {}, { actor: req.user });
      if (r.ok) storeIdempotentSuccess(db, req, 'production.complete', 200, r);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      apiError(res, {
        status: 400,
        code: 'COMPLETE_FAILED',
        error: safeErrorMessage(e, 'Production completion failed.'),
      });
    }
  });

  app.get('/api/deliveries', requirePermission(OPERATIONS_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, deliveries: listDeliveries(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load deliveries' });
    }
  });

  app.get('/api/deliveries/:id/payment-release-check', requirePermission(OPERATIONS_DOMAIN_PERMS), (req, res) => {
    try {
      const dg = assertDeliveryIdInWorkspace(db, req, req.params.id);
      if (!dg.ok) return res.status(dg.status).json({ ok: false, error: dg.error });
      const gate = evaluateDeliveryPaymentRelease(db, {
        deliveryId: req.params.id,
        actor: req.user,
      });
      res.json({ ok: true, deliveryGate: gate });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Delivery payment release check failed' });
    }
  });

  app.post('/api/deliveries', requirePermission('deliveries.manage'), (req, res) => {
    try {
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return res.status(403).json({ ok: false, error: createGate.error });
      const clId = String(req.body?.cuttingListId ?? '').trim();
      if (clId) {
        const clg = assertCuttingListIdInWorkspace(db, req, clId);
        if (!clg.ok) return res.status(clg.status).json({ ok: false, error: clg.error });
      }
      const r = write.insertDelivery(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/deliveries/:id/confirm', requirePermission('deliveries.manage'), (req, res) => {
    try {
      const dg = assertDeliveryIdInWorkspace(db, req, req.params.id);
      if (!dg.ok) return res.status(dg.status).json({ ok: false, error: dg.error });
      const r = write.confirmDelivery(db, req.params.id, req.body || {}, { actor: req.user });
      if (!r.ok) {
        const status = r.code === 'DELIVERY_PAYMENT_GATE_BLOCKED' ? 403 : 400;
        return res.status(status).json(r);
      }
      res.status(200).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs/:jobId/cancel', requirePermission('production.manage'), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = cancelProductionJob(db, req.params.jobId, req.body || {}, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/production-jobs/:jobId/conversion-preview', requirePermission('production.manage'), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = previewProductionConversion(db, req.params.jobId, req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  const managerReviewSignoffPerms = ['production.release'];
  /**
   * Who may post completion corrections (coil / accessories / stone flatsheet FG restatements).
   * Matches LiveProductionMonitor: BM/MD via production.release, store floor via operations.manage.
   */
  const productionCorrectionPerms = ['production.release', 'operations.manage'];
  const returnToPlannedPerms = ['production.release'];

  app.post('/api/production-jobs/:jobId/return-to-planned', requirePermission(returnToPlannedPerms), (req, res) => {
    try {
      const jg = assertProductionJobIdInWorkspace(db, req, req.params.jobId);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      const r = returnProductionJobToPlanned(db, req.params.jobId, req.body || {}, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/production-jobs/:jobId/completion-adjustments',
    requirePermission(productionCorrectionPerms),
    (req, res) => {
      try {
        const jid = req.params.jobId;
        const jg = assertProductionJobIdInWorkspace(db, req, jid);
        if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
        return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'production_job', jid, (stripped) =>
          applyProductionCompletionAdjustment(db, jid, stripped || {}, { actor: req.user })
        );
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/production-jobs/:jobId/completion-coil-corrections',
    requirePermission(productionCorrectionPerms),
    (req, res) => {
      try {
        const jid = req.params.jobId;
        const jg = assertProductionJobIdInWorkspace(db, req, jid);
        if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
        return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'production_job', jid, (stripped) =>
          applyCompletedProductionCoilCorrections(db, jid, stripped || {}, { actor: req.user })
        );
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/production-jobs/:jobId/completion-accessory-corrections',
    requirePermission(productionCorrectionPerms),
    (req, res) => {
      try {
        const jid = req.params.jobId;
        const jg = assertProductionJobIdInWorkspace(db, req, jid);
        if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
        return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'production_job', jid, (stripped, ctx) =>
          applyCompletedProductionAccessoryCorrections(db, jid, stripped || {}, {
            actor: req.user,
            outerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
          })
        );
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/production-jobs/:jobId/completion-stone-flatsheet-corrections',
    requirePermission(productionCorrectionPerms),
    (req, res) => {
      try {
        const jid = req.params.jobId;
        const jg = assertProductionJobIdInWorkspace(db, req, jid);
        if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
        return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'production_job', jid, (stripped, ctx) =>
          applyCompletedProductionStoneFlatsheetCorrections(db, jid, stripped || {}, {
            actor: req.user,
            outerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
          })
        );
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/production-jobs/:jobId/completion-stone-metres-corrections',
    requirePermission(productionCorrectionPerms),
    (req, res) => {
      try {
        const jid = req.params.jobId;
        const jg = assertProductionJobIdInWorkspace(db, req, jid);
        if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
        return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'production_job', jid, (stripped, ctx) =>
          applyCompletedProductionStoneMetresCorrections(db, jid, stripped || {}, {
            actor: req.user,
            outerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
          })
        );
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.patch('/api/production-jobs/:jobId/manager-review-signoff', requirePermission(managerReviewSignoffPerms), (req, res) => {
    try {
      const jid = req.params.jobId;
      const jg = assertProductionJobIdInWorkspace(db, req, jid);
      if (!jg.ok) return res.status(jg.status).json({ ok: false, error: jg.error });
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'production_job', jid, (stripped, ctx) => {
        const r = signOffProductionManagerReview(db, jid, stripped || {}, { actor: req.user });
        if (r.ok) {
          const inOuter = Boolean(ctx?.withinEditApprovalTransaction);
          const wiOpts = inOuter ? { outerTransaction: true } : {};
          const target = upsertWorkItemBySource(
            db,
            {
              actor: req.user,
              sourceKind: 'conversion_review',
              sourceId: jid,
              branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
              officeKey: 'branch_manager',
              responsibleOfficeKey: 'branch_manager',
              documentClass: 'approval',
              documentType: 'conversion_review',
              status: 'approved',
              title: `Conversion review ${jid}`,
              summary: String(stripped?.remark || '').trim() || 'Conversion review signed off.',
              requiresApproval: true,
              data: { routePath: '/manager' },
            },
            wiOpts
          );
          if (target.ok) {
            appendWorkItemDecision(
              db,
              {
                workItemId: target.item.id,
                actor: req.user,
                actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
                decisionKey: 'manager_review_signoff',
                outcomeStatus: 'approved',
                nextStatus: 'approved',
                note: String(stripped?.remark || '').trim() || 'Conversion review signed off.',
              },
              wiOpts
            );
          }
        }
        return r;
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/cutting-lists/:id/production/manager-review-signoff', requirePermission(managerReviewSignoffPerms), (req, res) => {
    try {
      const clid = req.params.id;
      const wg = assertCuttingListIdInWorkspace(db, req, clid);
      if (!wg.ok) return res.status(wg.status).json({ ok: false, error: wg.error });
      let jobId = resolveCuttingListProductionJob(db, clid);
      if (!jobId) jobId = productionJobIdForCuttingList(db, clid);
      if (!jobId) {
        return res.status(404).json({ ok: false, error: 'No production run for this cutting list.' });
      }
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'cutting_list', clid, (stripped) =>
        signOffProductionManagerReview(db, jobId, stripped || {}, { actor: req.user })
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });


  app.post('/api/purchase-orders/:poId/grn', requirePermission('inventory.receive'), (req, res) => {
    const poGate = assertPurchaseOrderIdInWorkspace(db, req, req.params.poId);
    if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
    const { entries, supplierID, supplierName, allowConversionMismatch } = req.body || {};
    const allowMismatch =
      Boolean(allowConversionMismatch) && userHasPermission(req.user, 'purchase_orders.manage');
    const r = write.confirmGrn(
      db,
      req.params.poId,
      entries || [],
      supplierID,
      supplierName,
      req.workspaceBranchId || DEFAULT_BRANCH_ID,
      { allowConversionMismatch: allowMismatch, actor: req.user }
    );
    if (r.ok && allowMismatch) {
      appendAuditLog(db, {
        actor: req.user,
        action: 'inventory.grn_conversion_override',
        entityKind: 'purchase_order',
        entityId: req.params.poId,
        note: 'GRN posted with conversion alignment override',
      });
    }
    if (r.ok) syncInTransitLoadFromGrn(db, req.params.poId, entries || [], req.user);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/inventory/stone-receipt', requirePermission('inventory.receive'), (req, res) => {
    try {
      const r = write.postStoneInventoryReceipt(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID, {
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/inventory/stone-flatsheet-receipt', requirePermission('inventory.receive'), (req, res) => {
    try {
      const r = write.postStoneFlatsheetInventoryReceipt(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID, {
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/inventory/accessory-receipt', requirePermission('inventory.receive'), (req, res) => {
    try {
      const r = write.postAccessoryInventoryReceipt(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID, {
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/coil-lots/search', requirePermission(OPERATIONS_DOMAIN_PERMS), (req, res) => {
    try {
      const q = String(req.query?.q ?? '').trim();
      const lim = req.query?.limit != null ? Number(req.query.limit) : 80;
      const branchScope = resolveBootstrapBranchScope(req);
      const coilLots = searchCoilLots(db, branchScope, q, lim);
      res.json({ ok: true, coilLots });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/inventory/product-movements/:productId', requirePermission(OPERATIONS_DOMAIN_PERMS), (req, res) => {
    try {
      const lim = req.query?.limit != null ? Number(req.query.limit) : 500;
      const branchScope = resolveBootstrapBranchScope(req);
      let rows = listStockMovementsForProduct(db, req.params.productId, lim, branchScope);
      const inventoryOnly = String(req.query?.inventoryOnly ?? '1') !== '0';
      if (inventoryOnly) {
        rows = (rows || []).filter((r) => isInventoryMovementType(r?.type || r?.Type || ''));
      }
      res.json({ ok: true, movements: rows || [], inventoryOnly });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/inventory/ensure-stone-product', requirePermission('purchase_orders.manage'), (req, res) => {
    try {
      const designLabel = String(req.body?.designLabel ?? '').trim();
      const colourLabel = String(req.body?.colourLabel ?? '').trim();
      const gaugeLabel = String(req.body?.gaugeLabel ?? '').trim();
      if (!designLabel || !colourLabel || !gaugeLabel) {
        return res.status(400).json({ ok: false, error: 'designLabel, colourLabel, and gaugeLabel are required.' });
      }
      const productId = ensureStoneProduct(db, {
        designLabel,
        colourLabel,
        gaugeLabel,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      res.json({ ok: true, productId });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/inventory/ensure-stone-flatsheet-product', requirePermission('purchase_orders.manage'), (req, res) => {
    try {
      const colourLabel = String(req.body?.colourLabel ?? '').trim();
      const lengthM = req.body?.lengthM ?? req.body?.stoneFlatsheetLengthM;
      if (!colourLabel) {
        return res.status(400).json({ ok: false, error: 'colourLabel is required.' });
      }
      const productId = ensureStoneFlatsheetProduct(db, {
        colourLabel,
        lengthM,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      res.json({ ok: true, productId });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/pricing/resolve', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const q = req.query || {};
      const result = resolveQuotedUnitPrice(db, {
        quoteItemId: q.quoteItemId,
        gaugeId: q.gaugeId,
        colourId: q.colourId,
        materialTypeId: q.materialTypeId,
        profileId: q.profileId,
        branchId: q.branchId || req.workspaceBranchId || null,
        gaugeLabel: q.gaugeLabel,
        colourName: q.colourName,
        profileName: q.profileName,
        materialTypeName: q.materialTypeName,
        designLabel: q.designLabel,
        asAtIso: String(q.asAtIso || q.asOf || '').trim().slice(0, 10) || undefined,
      });
      res.json({ ok: true, result });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/inventory/adjust', requirePermission('inventory.adjust'), (req, res) => {
    const {
      productID,
      type,
      qty,
      reasonCode,
      note,
      dateISO,
      acknowledgeCoilSkuDrift,
      acknowledgeLargeAdjust,
    } = req.body || {};
    const pg = assertProductIdInWorkspace(db, req, productID);
    if (!pg.ok) return res.status(pg.status).json({ ok: false, error: pg.error });
    if (!String(reasonCode || '').trim()) {
      return res.status(400).json({ ok: false, error: 'A reason code is required for stock adjustments.' });
    }
    if (!String(dateISO || '').trim()) {
      return res.status(400).json({ ok: false, error: 'Adjustment date is required.' });
    }
    if (String(type) === 'Decrease' && productID && !acknowledgeCoilSkuDrift) {
      const n = write.countCoilLotsForProductInWorkspace(db, productID, req.workspaceBranchId);
      if (n > 0) {
        return res.status(409).json({
          ok: false,
          code: 'COIL_SKU_DRIFT',
          coilLotCount: n,
          error:
            'This SKU has coil lots in your branch. Use Operations → Coil control (scrap, adjustments, returns) to change physical stock. To force a book-only decrease, a branch manager must resend with acknowledgeCoilSkuDrift: true.',
        });
      }
    }
    if (acknowledgeCoilSkuDrift) {
      if (
        !userHasPermission(req.user, 'material_incidents.approve') &&
        !userHasPermission(req.user, '*')
      ) {
        return res.status(403).json({
          ok: false,
          code: 'COIL_SKU_DRIFT_FORBIDDEN',
          error: 'Book-only coil SKU decreases require branch manager (or MD) approval.',
        });
      }
    }
    if (acknowledgeLargeAdjust) {
      if (
        !userHasPermission(req.user, 'material_incidents.approve') &&
        !userHasPermission(req.user, '*')
      ) {
        return res.status(403).json({
          ok: false,
          code: 'LARGE_ADJUST_FORBIDDEN',
          error: 'Large stock adjustments require branch manager (or MD) acknowledgement.',
        });
      }
    }
    const r = write.adjustStock(
      db,
      productID,
      type,
      qty,
      reasonCode,
      note,
      dateISO,
      req.workspaceBranchId || DEFAULT_BRANCH_ID,
      {
        acknowledgeLargeAdjust: Boolean(acknowledgeLargeAdjust),
        actorUserId: req.user?.id || req.user?.userId || null,
      }
    );
    const status = r.ok ? 200 : r.code === 'LARGE_ADJUST_CONFIRM' ? 409 : 400;
    res.status(status).json(r);
  });

  app.post('/api/inventory/transfer-to-production', requirePermission('production.manage'), (req, res) => {
    const { productID, qty, productionOrderId, dateISO } = req.body || {};
    const pg = assertProductIdInWorkspace(db, req, productID);
    if (!pg.ok) return res.status(pg.status).json({ ok: false, error: pg.error });
    const r = write.transferToProduction(
      db,
      productID,
      qty,
      productionOrderId,
      dateISO,
      req.workspaceBranchId || DEFAULT_BRANCH_ID
    );
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/inventory/finished-goods', requirePermission('production.manage'), (req, res) => {
    const { productID, qty, unitPriceNgn, productionOrderId, dateISO, wipRelease, extras } = req.body || {};
    const pg = assertProductIdInWorkspace(db, req, productID);
    if (!pg.ok) return res.status(pg.status).json({ ok: false, error: pg.error });
    const ws = wipRelease?.wipSourceProductID?.trim?.();
    if (ws) {
      const sg = assertProductIdInWorkspace(db, req, ws);
      if (!sg.ok) return res.status(sg.status).json({ ok: false, error: sg.error });
    }
    const r = write.receiveFinishedGoods(
      db,
      productID,
      qty,
      unitPriceNgn,
      productionOrderId,
      dateISO,
      wipRelease,
      extras || {},
      { workspaceBranchId: req.workspaceBranchId, actor: req.user }
    );
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post(
    '/api/coil-lots/import',
    requirePermission([
      'purchase_orders.manage',
      'inventory.receive',
      'operations.manage',
      'production.manage',
    ]),
    (req, res) => {
    try {
      const r = write.importCoilLotsFromSpreadsheet(
        db,
        req.body || {},
        req.workspaceBranchId || DEFAULT_BRANCH_ID,
        req.user
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/coil-control/events', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const rows = listCoilControlEvents(db, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.json({ ok: true, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-control/return-inward', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.postOffcutPoolReturnInward(db, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-control/return-outward', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.postCoilReturnOutward(db, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-control/open-head-trim', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.postCoilOpenHeadTrim(db, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-control/supplier-defect', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.postSupplierCoilDefect(db, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-control/ledger-adjustment', requirePermission(['material_incidents.approve']), (req, res) => {
    try {
      const r = write.postCoilLedgerKgAdjustment(db, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/coil-control/coil-damage/pending', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const rows = listPendingCoilDamageIncidents(db, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.json({ ok: true, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-control/coil-damage', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = createCoilDamageMaterialIncident(db, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-lots/:coilNo/split', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.splitCoilLot(
        db,
        { ...req.body, parentCoilNo: req.params.coilNo },
        { workspaceBranchId: req.workspaceBranchId, actor: req.user }
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });
  app.post('/api/coil-lots/:coilNo/scrap', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.postCoilScrap(
        db,
        { ...req.body, coilNo: req.params.coilNo },
        { workspaceBranchId: req.workspaceBranchId, actor: req.user }
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });
  app.post('/api/coil-lots/:coilNo/finish-roll', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const coilNo = decodeURIComponent(String(req.params.coilNo || '').trim());
      const r = write.postCoilRollFinished(
        db,
        { ...req.body, coilNo },
        { workspaceBranchId: req.workspaceBranchId, actor: req.user }
      );
      if (r.ok) {
        const sync = syncProductionJobCoilConsumedWeightsForCoil(db, coilNo);
        r.consumedWeightSync = sync;
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });
  app.post('/api/coil-lots/:coilNo/undo-finish-roll', (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Sign in required.', code: 'AUTH_REQUIRED' });
    }
    if (!userMayEditCoilLotMasterData(req.user)) {
      return res.status(403).json({
        ok: false,
        error: 'Only a branch manager (or above) can undo finish roll and restore the coil.',
        code: 'FORBIDDEN',
      });
    }
    return next();
  }, (req, res) => {
    try {
      const coilNo = decodeURIComponent(String(req.params.coilNo || '').trim());
      const r = write.postCoilUndoFinishRoll(
        db,
        { ...req.body, coilNo },
        { workspaceBranchId: req.workspaceBranchId, actor: req.user }
      );
      if (r.ok) {
        const sync = syncProductionJobCoilConsumedWeightsForCoil(db, coilNo);
        r.consumedWeightSync = sync;
      }
      const status = r.ok ? 200 : r.code === 'UNDO_FINISH_ROLL_CONFIRM_REQUIRED' ? 400 : 400;
      res.status(status).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });
  app.post('/api/coil-lots/:coilNo/return-material', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.returnCoilMaterialToStock(
        db,
        { ...req.body, coilNo: req.params.coilNo },
        { workspaceBranchId: req.workspaceBranchId, actor: req.user }
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/coil-lots/:coilNo/location', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const r = write.setCoilLotLocation(db, req.params.coilNo, req.body?.location, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/coil-lots/book-reconciliation-issues', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const minGapKg = Number(req.query.minGapKg);
      const issues = listCoilProductionBookReconciliationIssues(db, {
        workspaceBranchId: req.workspaceBranchId,
        minGapKg: Number.isFinite(minGapKg) ? minGapKg : 0.05,
        coilNoLike: String(req.query.search ?? req.query.coilNoLike ?? '').trim(),
        includeOrphanReservation: req.query.includeOrphanReservation !== '0',
      });
      res.json({
        ok: true,
        count: issues.length,
        minGapKg: Number.isFinite(minGapKg) ? minGapKg : 0.05,
        issues,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/coil-lots/:coilNo/production-holders', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const coilNo = decodeURIComponent(String(req.params.coilNo || '').trim());
      const coil = db
        .prepare(
          `SELECT coil_no, branch_id, qty_reserved, qty_remaining, current_weight_kg, weight_kg, qty_received, current_status
           FROM coil_lots WHERE coil_no = ?`
        )
        .get(coilNo);
      if (!coil) return res.status(404).json({ ok: false, error: 'Coil not found.' });
      const br = write.assertCoilInWorkspaceBranch(coil, req.workspaceBranchId);
      if (!br.ok) return res.status(403).json({ ok: false, error: br.error });

      const syncResult = syncProductionJobCoilConsumedWeightsForCoil(db, coilNo);
      let holders = listCoilProductionHolders(db, coilNo);
      const bookSummary = summarizeCoilProductionHoldersBook(db, coilNo, holders);
      const expectedReserved = holders
        .filter((h) => h.jobStatus === 'Planned' || h.jobStatus === 'Running')
        .reduce((s, h) => s + (Number(h.openingWeightKg) || 0), 0);
      const bookedReserved = Math.max(0, Number(coil.qty_reserved) || 0);
      const receivedKg = Math.max(0, Number(coil.weight_kg ?? coil.qty_received) || 0);
      const onHandKg = Math.max(0, Number(coil.qty_remaining ?? coil.current_weight_kg) || 0);
      const bookUsedKg = bookSummary?.bookUsedKg ?? Math.max(0, receivedKg - onHandKg);
      res.json({
        ok: true,
        coilNo,
        receivedKg,
        onHandKg,
        bookUsedKg,
        freeKg: Math.max(0, onHandKg - bookedReserved),
        currentStatus: coil.current_status ?? 'Available',
        bookedReservedKg: bookedReserved,
        expectedReservedKg: expectedReserved,
        orphanReservedKg: Math.max(0, bookedReserved - expectedReserved),
        consumedWeightSync: syncResult,
        jobsConsumedKgSum: bookSummary?.jobsConsumedKgSum ?? null,
        openingClosingKgSum: bookSummary?.openingClosingKgSum ?? null,
        bookUsedFromJobsKg: bookSummary?.bookUsedFromJobsKg ?? null,
        ancillaryNetKg: bookSummary?.ancillaryNetKg ?? null,
        reconciliationGapKg: bookSummary?.reconciliationGapKg ?? null,
        openingClosingGapKg: bookSummary?.openingClosingGapKg ?? null,
        holders,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-lots/:coilNo/reconcile-reservation', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const coilNo = decodeURIComponent(String(req.params.coilNo || '').trim());
      const r = reconcileCoilReservationFromProductionJobs(db, coilNo, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-lots/:coilNo/recalculate-production-stock', requirePermission(coilMaterialPerms), (req, res) => {
    try {
      const coilNo = decodeURIComponent(String(req.params.coilNo || '').trim());
      const r = recalculateAllCoilProductionJobStock(db, coilNo, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  const materialIncidentWritePerms = ['inventory.adjust', 'operations.manage', 'production.manage', 'material_incidents.create'];
  const materialIncidentApprovePerms = [
    'material_incidents.approve',
    'refunds.approve',
    'finance.approve',
  ];
  const materialIncidentReadPerms = [
    ...materialIncidentWritePerms,
    'material_incidents.create',
    'quotations.manage',
    'sales.view',
    'operations.view',
    'reports.view',
  ];

  app.get('/api/material-incidents/pool-summary', requirePermission(materialIncidentReadPerms), (req, res) => {
    try {
      const summary = computePoolSummary(db, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.json({ ok: true, ...summary });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/material-incidents/reports/loss', requirePermission(['reports.view', ...materialIncidentApprovePerms]), (req, res) => {
    try {
      res.json({ ok: true, rows: materialIncidentLossReport(db, req.workspaceBranchId || DEFAULT_BRANCH_ID) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/material-incidents/reports/aging', requirePermission(['reports.view', ...materialIncidentReadPerms]), (req, res) => {
    try {
      res.json({ ok: true, rows: materialIncidentAgingReport(db, req.workspaceBranchId || DEFAULT_BRANCH_ID) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get(
    '/api/material-incidents/reports/reconciliation',
    requirePermission(['reports.view', ...materialIncidentReadPerms]),
    (req, res) => {
      try {
        res.json({
          ok: true,
          ...materialIncidentPoolReconciliationReport(db, req.workspaceBranchId || DEFAULT_BRANCH_ID),
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.get('/api/material-incidents', requirePermission(materialIncidentReadPerms), (req, res) => {
    try {
      const rows = listMaterialIncidents(db, req.workspaceBranchId || DEFAULT_BRANCH_ID, {
        status: req.query.status,
        incidentType: req.query.incidentType || req.query.type,
        gaugeLabel: req.query.gauge,
        colour: req.query.colour,
        minMeters: req.query.minMeters,
      });
      res.json({ ok: true, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/material-incidents/:id', requirePermission(materialIncidentReadPerms), (req, res) => {
    try {
      const incident = getMaterialIncident(db, req.params.id);
      if (!incident) return res.status(404).json({ ok: false, error: 'Incident not found.' });
      res.json({ ok: true, incident });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/material-incidents/:id/print-payload', requirePermission(materialIncidentReadPerms), (req, res) => {
    try {
      const payload = getMaterialIncidentPrintPayload(db, req.params.id);
      if (!payload) return res.status(404).json({ ok: false, error: 'Incident not found.' });
      res.json({ ok: true, payload });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/material-incidents/:id/attachments/:attachmentId', requirePermission(materialIncidentReadPerms), (req, res) => {
    try {
      const att = getMaterialIncidentAttachment(db, req.params.id, req.params.attachmentId);
      if (!att) return res.status(404).json({ ok: false, error: 'Attachment not found.' });
      const buf = Buffer.from(att.dataBase64, 'base64');
      res.setHeader('Content-Type', att.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${String(att.fileName).replace(/[^\w.-]+/g, '_')}"`);
      res.send(buf);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents', requirePermission(materialIncidentWritePerms), (req, res) => {
    try {
      const r = createMaterialIncidentDraft(db, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/material-incidents/:id', requirePermission(materialIncidentWritePerms), (req, res) => {
    try {
      const r = updateMaterialIncidentDraft(db, req.params.id, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents/:id/submit', requirePermission(materialIncidentWritePerms), (req, res) => {
    try {
      const r = submitMaterialIncident(db, req.params.id, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents/:id/approve', requirePermission(materialIncidentApprovePerms), (req, res) => {
    try {
      const r = approveMaterialIncident(db, req.params.id, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents/:id/reject', requirePermission(materialIncidentApprovePerms), (req, res) => {
    try {
      const r = rejectMaterialIncident(db, req.params.id, req.body || {}, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents/:id/unlock-edit', requirePermission(materialIncidentApprovePerms), (req, res) => {
    try {
      const r = unlockMaterialIncidentEdit(db, req.params.id, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents/:id/void', requirePermission(materialIncidentApprovePerms), (req, res) => {
    try {
      const r = voidMaterialIncident(db, req.params.id, req.body || {}, { actor: req.user });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents/:id/issue', requirePermission(materialIncidentWritePerms), (req, res) => {
    try {
      const r = issueMaterialIncidentMeters(db, req.params.id, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/material-incidents/:id/create-refund', requirePermission(['refunds.request', ...materialIncidentWritePerms]), (req, res) => {
    try {
      const r = createRefundFromMaterialIncident(db, req.params.id, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/coil-lots/:coilNo/master-data', (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Sign in required.', code: 'AUTH_REQUIRED' });
    }
    if (!userMayEditCoilLotMasterData(req.user)) {
      return res.status(403).json({
        ok: false,
        error: 'Only an administrator, branch manager, or MD can edit coil master data.',
        code: 'FORBIDDEN',
      });
    }
    return next();
  }, (req, res) => {
    try {
      const coilNo = decodeURIComponent(String(req.params.coilNo || '').trim());
      const r = write.patchCoilLotMasterData(db, coilNo, req.body || {}, {
        workspaceBranchId: req.workspaceBranchId,
        actor: req.user,
      });
      if (!r.ok) {
        res.status(400).json(r);
        return;
      }

      let recalc = null;
      let reservationReconcile = null;
      if (req.body?.recalculate !== false) {
        recalc = write.recalculateCoilLotBook(db, coilNo, {
          workspaceBranchId: req.workspaceBranchId,
        });
        if (!recalc.ok) {
          res.status(400).json(recalc);
          return;
        }
        reservationReconcile = reconcileCoilReservationFromProductionJobs(db, coilNo, {
          workspaceBranchId: req.workspaceBranchId,
          actor: req.user,
        });
        if (!reservationReconcile.ok) {
          res.status(400).json(reservationReconcile);
          return;
        }
        if (!reservationReconcile.unchanged) {
          const post = db.prepare(`SELECT qty_remaining, qty_reserved FROM coil_lots WHERE coil_no = ?`).get(coilNo);
          if (post) {
            const rem = Math.max(0, Number(post.qty_remaining) || 0);
            const resv = Math.max(0, Number(post.qty_reserved) || 0);
            recalc = { ...recalc, qtyRemaining: rem, qtyReserved: resv, freeKg: Math.max(0, rem - resv) };
          }
        }
      }

      res.status(200).json({
        ...r,
        recalc,
        reservationReconcile,
        freeKg: recalc?.freeKg,
        qtyReserved: recalc?.qtyReserved,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/coil-requests', requirePermission(['operations.manage', 'production.manage']), (req, res) => {
    try {
      const payload = {
        ...(req.body || {}),
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        requestedByUserId: req.user?.id,
        requestedByDisplay: req.user?.displayName || req.user?.username || '',
      };
      const r = write.addCoilRequest(db, payload);
      if (r.ok && r.row?.id) {
        const qtyUnit =
          String(payload.unit || r.row.unit || '').toLowerCase() === 'm' ||
          String(payload.materialType || '').toLowerCase().includes('stone')
            ? 'm'
            : 'kg';
        const mr = createMaterialRequest(
          db,
          {
            branchId: payload.branchId,
            requestCategory: 'raw_material',
            urgency: 'normal',
            summary: `Material request ${r.row.id}`,
            note: String(payload.note || '').trim() || null,
            sourceKind: 'coil_request',
            sourceId: r.row.id,
            lines: [
              {
                itemCategory: 'raw_material',
                gauge: payload.gauge,
                colour: payload.colour,
                materialType: payload.materialType,
                unit: qtyUnit,
                qtyRequested: Number(payload.requestedKg) || 0,
                note: String(payload.note || '').trim() || '',
              },
            ],
          },
          req.user,
          payload.branchId
        );
        if (mr.ok) {
          r.materialRequest = mr.request;
        }
      }
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/coil-requests/:id/acknowledge', requirePermission(['operations.manage', 'production.manage', 'sales.manage']), (req, res) => {
    const crid = req.params.id;
    const rk = String(req.user?.roleKey || '').trim().toLowerCase();
    const mayBm =
      rk === 'admin' ||
      rk === 'md' ||
      rk === 'ceo' ||
      rk === 'sales_manager' ||
      rk === 'branch_manager' ||
      userHasPermission(req.user, 'sales.manage') ||
      userHasPermission(req.user, '*');
    if (!mayBm) {
      return res.status(403).json({
        ok: false,
        error: 'Branch manager (or MD) must approve stock requests before procurement buys.',
      });
    }
    return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'coil_request', crid, () =>
      write.approveCoilRequest(db, crid)
    );
  });

  app.patch('/api/coil-requests/:id/approve', requirePermission(['sales.manage', 'operations.manage', 'production.manage']), (req, res) => {
    const crid = req.params.id;
    const rk = String(req.user?.roleKey || '').trim().toLowerCase();
    const mayBm =
      rk === 'admin' ||
      rk === 'md' ||
      rk === 'ceo' ||
      rk === 'sales_manager' ||
      rk === 'branch_manager' ||
      userHasPermission(req.user, 'sales.manage') ||
      userHasPermission(req.user, '*');
    if (!mayBm) {
      return res.status(403).json({
        ok: false,
        error: 'Branch manager (or MD) must approve stock requests before procurement buys.',
      });
    }
    return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'coil_request', crid, () =>
      write.approveCoilRequest(db, crid)
    );
  });

  app.get('/api/material-requests', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
      res.json({ ok: true, requests: listMaterialRequests(db, scope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load material requests.' });
    }
  });

  app.get('/api/in-transit-loads', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, loads: listInTransitLoads(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load in-transit loads.' });
    }
  });

  app.post('/api/material-requests', requireAuth, requirePermission(['operations.manage', 'production.manage']), (req, res) => {
    try {
      const r = createMaterialRequest(db, req.body || {}, req.user, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not create material request.' });
    }
  });

  function mayEditMaintenanceVendors(user) {
    const rk = String(user?.roleKey || user?.role_key || '')
      .trim()
      .toLowerCase();
    return rk === 'admin' || rk === 'md' || rk === 'ceo' || rk === 'sales_manager' || rk === 'branch_manager';
  }

  app.get(
    '/api/maintenance/vendors',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const branchId =
          branchScope === 'ALL' ? String(req.query.branchId || '').trim() : branchScope;
        const vendors = listMaintenanceVendors(db, {
          branchId: branchId || undefined,
          status: String(req.query.status || '').trim() || undefined,
          includeAllBranches: branchScope === 'ALL' && !branchId,
        });
        res.json({ ok: true, vendors, canEdit: mayEditMaintenanceVendors(req.user) });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load maintenance vendors.' });
      }
    }
  );

  app.post('/api/maintenance/vendors', requireAuth, (req, res) => {
    try {
      if (!mayEditMaintenanceVendors(req.user)) {
        return res.status(403).json({ ok: false, error: 'Only Branch Manager or above can edit vendors.' });
      }
      const r = createMaintenanceVendor(
        db,
        req.body || {},
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID
      );
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not create vendor.' });
    }
  });

  app.patch('/api/maintenance/vendors/:vendorId', requireAuth, (req, res) => {
    try {
      if (!mayEditMaintenanceVendors(req.user)) {
        return res.status(403).json({ ok: false, error: 'Only Branch Manager or above can edit vendors.' });
      }
      const r = updateMaintenanceVendor(db, req.params.vendorId, req.body || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update vendor.' });
    }
  });

  app.get(
    '/api/maintenance/technicians',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const branchId =
          branchScope === 'ALL' ? String(req.query.branchId || '').trim() : branchScope;
        const technicians = listMaintenanceTechnicians(db, {
          branchId: branchId || undefined,
          activeOnly: String(req.query.activeOnly || '1') !== '0',
        });
        res.json({ ok: true, technicians, canEdit: mayEditMaintenanceVendors(req.user) });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load technicians.' });
      }
    }
  );

  app.patch('/api/maintenance/technicians/:userId', requireAuth, (req, res) => {
    try {
      if (!mayEditMaintenanceVendors(req.user)) {
        return res
          .status(403)
          .json({ ok: false, error: 'Only Branch Manager or above can edit technician flags.' });
      }
      const r = updateStaffTechnicianFlags(db, req.params.userId, req.body || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update technician flags.' });
    }
  });

  app.get(
    '/api/maintenance/machines',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const scope = {
          viewAll: branchScope === 'ALL',
          branchId: branchScope === 'ALL' ? req.workspaceBranchId || DEFAULT_BRANCH_ID : branchScope,
        };
        res.json({ ok: true, machines: listMachines(db, scope) });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load machines.' });
      }
    }
  );

  app.get(
    '/api/maintenance/work-orders',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const openOnly = String(req.query.openOnly || '') === '1' || String(req.query.inbox || '') === 'issues';
        if (openOnly) {
          const issues = listOpenMaintenanceIssues(db, {
            viewAll: branchScope === 'ALL',
            branchId: branchScope === 'ALL' ? '' : branchScope,
          });
          return res.json({ ok: true, workOrders: issues });
        }
        const scope = {
          viewAll: branchScope === 'ALL',
          branchId: branchScope === 'ALL' ? req.workspaceBranchId || DEFAULT_BRANCH_ID : branchScope,
        };
        res.json({ ok: true, workOrders: listMaintenanceWorkOrders(db, scope) });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load work orders.' });
      }
    }
  );

  app.get(
    '/api/maintenance/plans',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const scope = {
          viewAll: branchScope === 'ALL',
          branchId: branchScope === 'ALL' ? req.workspaceBranchId || DEFAULT_BRANCH_ID : branchScope,
        };
        res.json({ ok: true, plans: listMaintenancePlans(db, scope) });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load maintenance plans.' });
      }
    }
  );

  app.post(
    '/api/maintenance/work-orders',
    requireAuth,
    requirePermission(['operations.manage', 'production.manage']),
    (req, res) => {
      try {
        const body = { ...(req.body || {}) };
        const priorityRaw = String(body.priority || 'normal').trim().toLowerCase();
        const priorityMap = {
          low: 'low',
          high: 'high',
          machine_down: 'machine_down',
          'machine-down': 'machine_down',
          normal: 'normal',
        };
        body.priority = priorityMap[priorityRaw] || priorityRaw || 'normal';
        const kindRaw = String(body.kind || 'corrective').trim().toLowerCase();
        body.kind = ['overhaul', 'preventive', 'corrective'].includes(kindRaw) ? kindRaw : 'corrective';
        body.status = body.status || 'open';
        if (!body.summary) {
          body.summary = String(body.symptom || '').trim().slice(0, 120) || 'Fault report';
        }
        if (body.attachment?.dataBase64) {
          body.data = {
            ...(body.data && typeof body.data === 'object' ? body.data : {}),
            attachment: {
              name: body.attachment.name || 'photo',
              mime: body.attachment.mime || 'image/jpeg',
              dataBase64: body.attachment.dataBase64,
            },
          };
        }
        const r = createMaintenanceWorkOrder(
          db,
          body,
          req.user,
          req.workspaceBranchId || DEFAULT_BRANCH_ID
        );
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not create work order.' });
      }
    }
  );

  app.get(
    '/api/maintenance/work-orders/:workOrderId',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const wo = getMaintenanceWorkOrder(db, req.params.workOrderId);
        if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found.' });
        const pack = attachWorkOrderFinance(db, wo);
        res.json({ ok: true, workOrder: pack, costLines: pack.costLines, envelope: pack.envelope });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load work order.' });
      }
    }
  );

  app.post(
    '/api/maintenance/work-orders/:workOrderId/acknowledge',
    requireAuth,
    (req, res) => {
      try {
        if (!mayEditMaintenanceVendors(req.user) && String(req.user?.roleKey || '') !== 'admin') {
          return res.status(403).json({ ok: false, error: 'Branch Manager or above required.' });
        }
        const r = acknowledgeMaintenanceWorkOrder(db, req.params.workOrderId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not acknowledge work order.' });
      }
    }
  );

  app.post(
    '/api/maintenance/work-orders/:workOrderId/assign',
    requireAuth,
    (req, res) => {
      try {
        if (!mayEditMaintenanceVendors(req.user)) {
          return res.status(403).json({ ok: false, error: 'Branch Manager or above required.' });
        }
        const r = assignMaintenanceWorkOrder(db, req.params.workOrderId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not assign work order.' });
      }
    }
  );

  app.post(
    '/api/maintenance/work-orders/:workOrderId/resolve',
    requireAuth,
    (req, res) => {
      try {
        if (!mayEditMaintenanceVendors(req.user)) {
          return res.status(403).json({ ok: false, error: 'Branch Manager or above required.' });
        }
        const r = resolveMaintenanceWorkOrder(db, req.params.workOrderId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not resolve work order.' });
      }
    }
  );

  app.post(
    '/api/maintenance/work-orders/:workOrderId/link-payment-request',
    requireAuth,
    (req, res) => {
      try {
        if (!mayEditMaintenanceVendors(req.user)) {
          return res.status(403).json({ ok: false, error: 'Branch Manager or above required.' });
        }
        const r = linkWorkOrderPaymentRequest(
          db,
          req.params.workOrderId,
          req.body?.paymentRequestId || req.body?.requestId,
          req.user,
          { costKind: req.body?.costKind || req.body?.cost_kind }
        );
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not link payment request.' });
      }
    }
  );

  app.post(
    '/api/maintenance/work-orders/:workOrderId/cost-lines',
    requireAuth,
    (req, res) => {
      try {
        if (!mayEditMaintenanceVendors(req.user)) {
          return res.status(403).json({ ok: false, error: 'Branch Manager or above required.' });
        }
        const r = createMaintenanceCostLine(db, req.params.workOrderId, req.body || {}, req.user);
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not create cost line.' });
      }
    }
  );

  app.get(
    '/api/maintenance/insights',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const pack = buildMaintenanceInsightsPack(db, {
          viewAll: branchScope === 'ALL',
          branchId:
            branchScope === 'ALL'
              ? String(req.query.branchId || '').trim()
              : branchScope,
        });
        res.json(pack);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load maintenance insights.' });
      }
    }
  );




  app.put('/api/treasury/accounts', requirePermission('treasury.manage'), (req, res) => {
    try {
      const bulkGate = assertSingleBranchWorkspaceForBulkWrite(req);
      if (!bulkGate.ok) return res.status(403).json({ ok: false, error: bulkGate.error });
      const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
      const branchGate = assertTreasuryAccountsBulkForWorkspace(req.user, accounts, req.workspaceBranchId);
      if (!branchGate.ok) return res.status(403).json({ ok: false, error: branchGate.error });
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'treasury_accounts', 'bulk', (stripped) => {
        const reason = String(stripped?.reason ?? '').trim();
        if (!reason) return { ok: false, error: 'Reason is required for bulk treasury updates.' };
        const accounts = stripped?.accounts || [];
        write.replaceTreasuryAccounts(db, accounts);
        appendAuditLog(db, {
          actor: req.user,
          action: 'treasury.bulk_replace',
          entityKind: 'treasury_account',
          entityId: 'bulk',
          note: reason,
          details: { accountCount: Array.isArray(accounts) ? accounts.length : 0 },
        });
        return { ok: true };
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/treasury/accounts', requirePermission('treasury.manage'), (req, res) => {
    try {
      const rawId = req.body?.id;
      const isUpdate =
        rawId != null &&
        String(rawId).trim() !== '' &&
        Number.isFinite(Number(rawId)) &&
        Number(rawId) > 0;
      if (!isUpdate) {
        const createScope = assertSingleBranchWorkspaceForCreate(req);
        if (!createScope.ok) {
          return res.status(400).json(createScope);
        }
      }
      const r = upsertTreasuryAccount(
        db,
        {
          ...(req.body || {}),
          branchId: String(req.body?.branchId || req.workspaceBranchId || '').trim() || undefined,
          workspaceBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        },
        req.user
      );
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete('/api/treasury/accounts/:id', requireAuth, (req, res) => {
    try {
      const rk = String(req.user?.roleKey || '').toLowerCase();
      if (!['admin', 'md', 'ceo'].includes(rk)) {
        return res.status(403).json({ ok: false, error: 'Only Admin, Managing Director, or CEO may delete treasury accounts.' });
      }
      const r = deleteTreasuryAccount(db, req.params.id, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/treasury/bank-charges', requirePermission('finance.pay'), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'bank_charge.create')) return;
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return apiError(res, { status: 403, code: 'FORBIDDEN', error: createGate.error });
      const r = recordBankCharge(
        db,
        {
          ...(req.body || {}),
          createdBy: req.user.displayName,
          actor: req.user,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        },
        req.workspaceBranchId || DEFAULT_BRANCH_ID
      );
      if (r.ok) storeIdempotentSuccess(db, req, 'bank_charge.create', 201, r);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      apiError(res, {
        status: 400,
        code: 'BANK_CHARGE_CREATE_FAILED',
        error: safeErrorMessage(e, 'Could not record bank charge.'),
      });
    }
  });

  app.post('/api/treasury/transfer', requirePermission(['treasury.manage', 'finance.pay']), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'treasury.transfer')) return;
      const r = write.transferTreasuryFunds(db, {
        ...(req.body || {}),
        createdBy: req.user.displayName,
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      if (r.ok) storeIdempotentSuccess(db, req, 'treasury.transfer', 201, r);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/treasury/transfer/:batchId', requirePermission(['treasury.manage', 'finance.pay']), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'treasury.transfer.update')) return;
      const r = write.updateTreasuryTransfer(db, String(req.params.batchId || '').trim(), {
        ...(req.body || {}),
        createdBy: req.user.displayName,
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      if (r.ok) storeIdempotentSuccess(db, req, 'treasury.transfer.update', 200, r);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete('/api/treasury/transfer/:batchId', requireAuth, (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'treasury.transfer.delete')) return;
      const r = write.deleteTreasuryTransfer(db, String(req.params.batchId || '').trim(), req.user, {
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
        note: req.body?.note,
      });
      if (r.ok) storeIdempotentSuccess(db, req, 'treasury.transfer.delete', 200, r);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/inter-branch-loans', requirePermission('finance.view'), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({
        ok: true,
        loans: listInterBranchLoans(db, branchScope),
        balances: interBranchLoanBalances(db, branchScope),
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/inter-branch-loans/:loanId', requirePermission('finance.view'), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const r = getInterBranchLoan(db, String(req.params.loanId || '').trim(), branchScope);
      res.status(r.ok ? 200 : r.error === 'Loan not found.' ? 404 : 403).json(r.ok ? { ok: true, ...r } : r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/inter-branch-loans',
    requirePermission(['treasury.manage', 'finance.post']),
    (req, res) => {
      try {
        const r = createInterBranchLoan(db, req.body || {}, req.user);
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post('/api/inter-branch-loans/:loanId/md-approve', requirePermission('inter_branch_loan.md_approve'), (req, res) => {
    try {
      const r = mdApproveInterBranchLoan(db, String(req.params.loanId || '').trim(), req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/inter-branch-loans/:loanId/md-reject', requirePermission('inter_branch_loan.md_approve'), (req, res) => {
    try {
      const r = mdRejectInterBranchLoan(db, String(req.params.loanId || '').trim(), req.body || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/inter-branch-loans/:loanId/repay',
    requirePermission(['treasury.manage', 'finance.pay']),
    (req, res) => {
      try {
        const r = recordInterBranchLoanRepayment(
          db,
          String(req.params.loanId || '').trim(),
          req.body || {},
          req.user
        );
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post('/api/expenses', requirePermission(['finance.post', 'expenses.create']), (req, res) => {
    try {
      const allowDirect =
        process.env.NODE_ENV === 'test' ||
        String(process.env.ZAREWA_ALLOW_DIRECT_EXPENSE_POST || '').trim() === '1' ||
        Boolean(req.body?.allowDirectTreasuryPost);
      if (!allowDirect) {
        return res.status(400).json({
          ok: false,
          error:
            'Direct expense posting is disabled. Submit an expense request for Branch Manager approval, then record treasury payout after approval.',
        });
      }
      if (sendIdempotentReplayIfAny(db, req, res, 'expense.create')) return;
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return apiError(res, { status: 403, code: 'FORBIDDEN', error: createGate.error });
      const r = write.insertExpenseEntry(
        db,
        {
          ...(req.body || {}),
          createdBy: req.user.displayName,
          actor: req.user,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        },
        req.workspaceBranchId || DEFAULT_BRANCH_ID
      );
      if (r.ok) storeIdempotentSuccess(db, req, 'expense.create', 201, r);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      apiError(res, {
        status: 400,
        code: 'EXPENSE_CREATE_FAILED',
        error: safeErrorMessage(e, 'Could not create expense.'),
      });
    }
  });

  /** Bulk historical expense import — template, preview (editable), commit. Requires finance.post. */
  app.get('/api/expenses/import/template', requirePermission(['finance.post', 'expenses.create']), (_req, res) => {
    try {
      const buf = buildExpenseImportTemplateXlsx();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="Expenses import.xlsx"');
      return res.send(buf);
    } catch (e) {
      console.error(e);
      return apiError(res, {
        status: 500,
        code: 'EXPENSE_IMPORT_TEMPLATE_FAILED',
        error: safeErrorMessage(e, 'Could not build expense import template.'),
      });
    }
  });

  app.get('/api/expenses/import/categories', requirePermission(['finance.post', 'expenses.create']), (_req, res) => {
    return res.json({ ok: true, categories: [...EXPENSE_CATEGORY_OPTIONS] });
  });

  app.post('/api/expenses/import/preview', requirePermission(['finance.post', 'expenses.create']), (req, res) => {
    try {
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return apiError(res, { status: 403, code: 'FORBIDDEN', error: createGate.error });
      const requireTreasury = req.body?.requireTreasury !== false;
      const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      let rows = normalizeExpenseImportRows(req.body?.rows);
      if (!rows.length) {
        const b64 = req.body?.fileBase64 || req.body?.data;
        if (!b64) {
          return res.status(400).json({ ok: false, error: 'Upload a file (fileBase64) or send edited rows.' });
        }
        const parsed = parseExpenseImportWorkbook(Buffer.from(String(b64), 'base64'));
        if (!parsed.ok) return res.status(400).json(parsed);
        rows = parsed.rows;
      }
      const r = previewExpenseBulkImport(db, rows, req.user, { requireTreasury, branchId });
      return res.json(r);
    } catch (e) {
      console.error(e);
      return apiError(res, {
        status: 400,
        code: 'EXPENSE_IMPORT_PREVIEW_FAILED',
        error: safeErrorMessage(e, 'Could not preview expense import.'),
      });
    }
  });

  app.post('/api/expenses/import/commit', requirePermission(['finance.post', 'expenses.create']), (req, res) => {
    try {
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return apiError(res, { status: 403, code: 'FORBIDDEN', error: createGate.error });
      const requireTreasury = req.body?.requireTreasury !== false;
      const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      let rows = normalizeExpenseImportRows(req.body?.rows);
      if (!rows.length) {
        const b64 = req.body?.fileBase64 || req.body?.data;
        if (!b64) {
          return res.status(400).json({ ok: false, error: 'Send edited preview rows (or fileBase64).' });
        }
        const parsed = parseExpenseImportWorkbook(Buffer.from(String(b64), 'base64'));
        if (!parsed.ok) return res.status(400).json(parsed);
        rows = parsed.rows;
      }
      const r = commitExpenseBulkImport(db, req.user, rows, branchId, {
        workspaceViewAll: Boolean(req.workspaceViewAll),
        requireTreasury,
      });
      return res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      return apiError(res, {
        status: 400,
        code: 'EXPENSE_IMPORT_COMMIT_FAILED',
        error: safeErrorMessage(e, 'Could not import expenses.'),
      });
    }
  });

  /** Rollout duplicate cleanup: unpaid expense + linked requests only (requires finance approval + KPI for officers). */
  app.delete('/api/expenses/:expenseId', requirePermission('finance.approve'), (req, res) => {
    try {
      const expenseId = String(req.params.expenseId || '').trim();
      if (!expenseId) return res.status(400).json({ ok: false, error: 'Expense ID is required.' });
      const row = db.prepare(`SELECT branch_id FROM expenses WHERE expense_id = ?`).get(expenseId);
      if (!row) return res.status(404).json({ ok: false, error: 'Expense not found.' });
      const bid = String(row.branch_id || '').trim();
      const wb = String(req.workspaceBranchId || DEFAULT_BRANCH_ID).trim();
      if (
        bid &&
        bid !== wb &&
        !(Boolean(req.workspaceViewAll) && canUseAllBranchesRollup(req.user))
      ) {
        return res.status(403).json({ ok: false, error: 'Switch workspace branch to delete this expense.' });
      }
      return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'expense', expenseId, (_stripped, ctx) =>
        write.deleteExpenseRolloutDup(db, expenseId, req.user, {
          skipInnerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
        })
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/expenses/:expenseId/rollout-delete', requirePermission('finance.approve'), (req, res) => {
    try {
      const expenseId = String(req.params.expenseId || '').trim();
      if (!expenseId) return res.status(400).json({ ok: false, error: 'Expense ID is required.' });
      const row = db.prepare(`SELECT branch_id FROM expenses WHERE expense_id = ?`).get(expenseId);
      if (!row) return res.status(404).json({ ok: false, error: 'Expense not found.' });
      const bid = String(row.branch_id || '').trim();
      const wb = String(req.workspaceBranchId || DEFAULT_BRANCH_ID).trim();
      if (
        bid &&
        bid !== wb &&
        !(Boolean(req.workspaceViewAll) && canUseAllBranchesRollup(req.user))
      ) {
        return res.status(403).json({ ok: false, error: 'Switch workspace branch to delete this expense.' });
      }
      return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'expense', expenseId, (_stripped, ctx) =>
        write.deleteExpenseRolloutDup(db, expenseId, req.user, {
          skipInnerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
        })
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.put('/api/refunds', requirePermission('settings.manage'), (req, res) => {
    try {
      if (req.workspaceViewAll) {
        return res.status(403).json({
          ok: false,
          error: 'Bulk refund replace is not allowed in all-branches view. Select a single branch workspace.',
        });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      if (branchScope === 'ALL') {
        return res.status(403).json({
          ok: false,
          error: 'Bulk refund replace requires a single branch workspace.',
        });
      }
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'refunds_bulk', 'bulk', (stripped) => {
        const reason = String(stripped?.reason ?? '').trim();
        if (!reason) return { ok: false, error: 'Reason is required for bulk refund updates.' };
        const refunds = stripped?.refunds || [];
        const r = write.replaceRefunds(db, refunds, branchScope);
        if (!r.ok) return r;
        appendAuditLog(db, {
          actor: req.user,
          action: 'refund.bulk_replace',
          entityKind: 'refund',
          entityId: 'bulk',
          note: reason,
          details: { refundCount: Array.isArray(refunds) ? refunds.length : 0 },
        });
        return { ok: true };
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/refunds/preview', requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']), (req, res) => {
    try {
      const r = previewRefundRequest(db, req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/refunds/eligible-quotations', requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']), (req, res) => {
    try {
      // Default 50. The pick list uses cheap overpay / unproduced / cancelled hints — not full preview.
      const requestedLimit = Math.floor(Number(req.query.limit) || 50);
      const resultLimit = Math.max(1, Math.min(100, requestedLimit));
      const candidateLimit = Math.min(250, Math.max(resultLimit * 4, 80));
      const rows = getEligibleRefundQuotations(db, { candidateLimit, resultLimit });
      res.json({ ok: true, quotations: rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to fetch eligible quotations' });
    }
  });

  /** Why a quotation is missing from the refund pick list (backend rules + preview categories + UI floor). */
  app.get('/api/refunds/eligibility-check', requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']), (req, res) => {
    try {
      const quotationRef = String(req.query.quotationRef || '').trim();
      if (!quotationRef) {
        return res.status(400).json({ ok: false, error: 'quotationRef query parameter is required (exact quotation id, e.g. QT-…).' });
      }
      const meets = quotationMeetsRefundEligibility(db, quotationRef);
      const preview = meets.ok
        ? previewRefundRequest(db, { quotationRef })
        : { ok: false, preview: null, error: meets.error };
      const categories =
        preview?.ok && Array.isArray(preview?.preview?.eligibleRefundCategories)
          ? preview.preview.eligibleRefundCategories
          : [];
      const suggestedPreviewAmountNgn =
        preview?.ok && preview.preview?.suggestedAmountNgn != null
          ? Math.round(Number(preview.preview.suggestedAmountNgn) || 0)
          : 0;
      const remainingNgn = meets.ok ? meets.remainingNgn : 0;
      const qRow = db
        .prepare(
          `SELECT id, paid_ngn, total_ngn, status, refunds_blocked_at_iso, refunds_blocked_reason, refunds_blocked_by_name
           FROM quotations WHERE id = ?`
        )
        .get(quotationRef);
      const paidBooked = qRow != null ? Math.round(Number(qRow.paid_ngn) || 0) : null;
      const totalBooked = qRow != null ? Math.round(Number(qRow.total_ngn) || 0) : null;
      const orderOutstandingNgn =
        qRow != null && totalBooked != null && totalBooked > 0
          ? amountDueOnQuotationFromEntries([], { id: quotationRef, totalNgn: totalBooked, paidNgn: paidBooked })
          : null;
      const isOrderFullySettledForPicker =
        qRow == null ? null : totalBooked <= 0 ? true : isEffectivelyFullyPaid(paidBooked || 0, totalBooked);
      const productionJobs = db
        .prepare(
          `SELECT job_id, status FROM production_jobs WHERE quotation_ref = ? ORDER BY job_id ASC`
        )
        .all(quotationRef);
      const refundsOnFile = db
        .prepare(
          `SELECT refund_id, status, amount_ngn, paid_amount_ngn FROM customer_refunds WHERE quotation_ref = ? ORDER BY requested_at_iso DESC`
        )
        .all(quotationRef);

      const blockingReasons = [];
      if (!meets.ok) {
        blockingReasons.push(meets.error || 'Does not meet refund listing rules.');
      }
      if (meets.ok && categories.length === 0) {
        blockingReasons.push(
          'Refund preview returned no eligible refund categories (use Use quotation id when manual entry is allowed).'
        );
      }
      if (
        meets.ok &&
        categories.length > 0 &&
        suggestedPreviewAmountNgn < MIN_REFUND_QUOTATION_REMAINING_NGN
      ) {
        blockingReasons.push(
          `Automatic refund preview total is ₦${suggestedPreviewAmountNgn.toLocaleString('en-NG')} — refunds below ₦${MIN_REFUND_QUOTATION_REMAINING_NGN.toLocaleString('en-NG')} are not accepted.`
        );
      }
      if (meets.ok && totalBooked > 0 && !isOrderFullySettledForPicker) {
        blockingReasons.push(
          `Order still has ₦${(orderOutstandingNgn ?? 0).toLocaleString('en-NG')} outstanding (picker only lists fully paid quotations; residuals under 0.01% are ignored).`
        );
      }
      if (meets.ok && remainingNgn > 0 && remainingNgn < MIN_REFUND_QUOTATION_REMAINING_NGN) {
        blockingReasons.push(
          `Remaining refundable amount ₦${remainingNgn.toLocaleString('en-NG')} must be at least ₦${MIN_REFUND_QUOTATION_REMAINING_NGN.toLocaleString('en-NG')} for the dropdown.`
        );
      }
      const wouldAppearInPicklist =
        meets.ok &&
        categories.length > 0 &&
        suggestedPreviewAmountNgn >= MIN_REFUND_QUOTATION_REMAINING_NGN &&
        remainingNgn >= MIN_REFUND_QUOTATION_REMAINING_NGN &&
        isOrderFullySettledForPicker === true;
      /** Below-floor automatic previews are not eligible — do not allow paste/manual bypass. */
      const manualEntryRefundAllowed = false;
      if (
        meets.ok &&
        categories.length > 0 &&
        suggestedPreviewAmountNgn < MIN_REFUND_QUOTATION_REMAINING_NGN &&
        !blockingReasons.some((r) => String(r).includes('Automatic refund preview total'))
      ) {
        blockingReasons.push(
          `Automatic refund preview total is ₦${suggestedPreviewAmountNgn.toLocaleString('en-NG')} — refunds below ₦${MIN_REFUND_QUOTATION_REMAINING_NGN.toLocaleString('en-NG')} are not accepted.`
        );
      }
      res.json({
        ok: true,
        quotationRef,
        meetsBackendRules: meets.ok,
        backendDetail: meets.ok
          ? {
              paidNgn: meets.paidNgn,
              cashInNgn: meets.cashInNgn,
              quoteTotalNgn: meets.quoteTotalNgn,
              overpaymentExcessNgn: meets.overpaymentExcessNgn,
              totalRefundedNgn: meets.totalRefundedNgn,
              remainingNgn: meets.remainingNgn,
            }
          : { error: meets.error, refundsBlocked: Boolean(meets.refundsBlocked) },
        eligibleRefundCategories: categories,
        wouldAppearInRefundQuotationDropdown: wouldAppearInPicklist,
        manualEntryRefundAllowed,
        blockingReasons,
        previewOk: Boolean(preview?.ok),
        previewError: preview?.ok ? null : preview?.error || null,
        diagnostics: {
          quotationId: qRow?.id ?? null,
          quotationStatus: qRow?.status ?? null,
          bookedPaidNgn: paidBooked,
          orderTotalNgn: totalBooked,
          orderOutstandingNgn,
          isOrderFullyPaidForDropdown: isOrderFullySettledForPicker,
          remainingRefundableNgn: meets.ok ? meets.remainingNgn : null,
          minRemainingRequiredNgn: MIN_REFUND_QUOTATION_REMAINING_NGN,
          minSuggestedPreviewAmountNgn: MIN_REFUND_QUOTATION_REMAINING_NGN,
          suggestedPreviewAmountNgn,
          productionJobs: productionJobs.map((j) => ({
            jobId: j.job_id,
            status: j.status,
          })),
          refundsOnFile: refundsOnFile.map((r) => ({
            refundId: r.refund_id,
            status: r.status,
            amountNgn: r.amount_ngn,
            paidOutNgn: r.paid_amount_ngn,
          })),
          refundsBlockedAtISO: qRow?.refunds_blocked_at_iso ?? null,
          refundsBlockedReason: qRow?.refunds_blocked_reason ?? null,
          refundsBlockedByName: qRow?.refunds_blocked_by_name ?? null,
        },
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to check refund eligibility.' });
    }
  });

  app.get('/api/refunds/intelligence', requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']), (req, res) => {
    try {
      const quotationRef = String(req.query.quotationRef || '').trim();
      if (!quotationRef) {
        return res.status(400).json({ ok: false, error: 'quotationRef is required' });
      }
      const excludeRefundId =
        String(req.query.excludeRefundId || req.query.refundId || '').trim() || null;
      const branchScope = resolveBootstrapBranchScope(req);
      const { receipts, cuttingLists, summary } = getRefundIntelligenceForQuotation(db, quotationRef, branchScope);
      const dataQualityIssues = dedupeRefundDataQualityIssues([
        ...refundSubstitutionDataQualityIssues(db, quotationRef),
        ...refundPaymentIntegrityIssues(db, quotationRef),
        ...refundCuttingListQuotationMetreIssues(db, quotationRef),
        ...refundProductionAlignmentWarnings(db, quotationRef, undefined, { excludeRefundId }),
      ]);
      const productionSuggestedCategories = suggestRefundCategoriesFromProduction(db, quotationRef);
      const quote = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quotationRef);
      const productionJobs = db
        .prepare(
          `SELECT * FROM production_jobs WHERE quotation_ref = ?
           AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')`
        )
        .all(quotationRef);
      let stoneMeterQuote = false;
      try {
        stoneMeterQuote = quote?.lines_json
          ? isStoneMeterQuotationLinesJson(db, JSON.parse(String(quote.lines_json)))
          : false;
      } catch {
        stoneMeterQuote = false;
      }
      const productionFulfillment = buildRefundProductionFulfillmentSummary(db, quote, productionJobs, {
        isStoneMeterQuote: stoneMeterQuote,
      });
      const cashBreakdown = quotationPaymentCashBreakdown(db, quotationRef);
      const priorRefundedNgn = quotationActiveRefundedTotalNgn(db, quotationRef, excludeRefundId);
      const economicFloor = buildRefundEconomicFloorSummary(db, quote, productionJobs, {
        cashInNgn: cashBreakdown.cashInNgn,
        priorRefundedNgn,
        pricingAsAtIso: quotationPricingAsAtIso(quote),
      });
      const staleRefundWarnings = listStaleOpenRefundsForQuotation(
        db,
        quotationRef,
        economicFloor
      );
      res.json({
        ok: true,
        receipts,
        cuttingLists,
        summary,
        dataQualityIssues,
        productionSuggestedCategories,
        productionFulfillment,
        economicFloor,
        staleRefundWarnings,
        excludeRefundId,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load refund intelligence' });
    }
  });

  app.post('/api/refunds', requirePermission('refunds.request'), (req, res) => {
    try {
      const r = insertRefundRequest(
        db,
        req.body || {},
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID
      );
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/refunds/production-alignment-check', requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']), (req, res) => {
    try {
      const body = req.body || {};
      const quotationRef = String(body.quotationRef ?? '').trim();
      const reasonCategory = body.reasonCategory ?? body.reason_category ?? [];
      if (!quotationRef) {
        res.status(400).json({ ok: false, error: 'quotationRef is required.' });
        return;
      }
      const result = validateRefundProductionAlignmentAtSubmit(db, quotationRef, reasonCategory, {
        actor: req.user,
        acknowledgedCodes: body.productionAlignmentAcknowledgedCodes ?? body.productionAlignmentAcknowledged ?? [],
        overrideNote: body.productionAlignmentOverrideNote ?? body.productionAlignmentOverride ?? '',
        excludeRefundId: body.excludeRefundId ?? body.refundId ?? null,
      });
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/refunds/:refundId', requireAuth, (req, res) => {
    try {
      const canSee =
        userHasPermission(req.user, 'refunds.approve') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'refunds.request');
      if (!canSee) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const refund = getCustomerRefundDetail(db, String(req.params.refundId || ''));
      if (!refund) {
        res.status(404).json({ ok: false, error: 'Refund not found.' });
        return;
      }
      res.json({ ok: true, refund });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/refunds/:refundId/decision', requirePermission(['refunds.approve', 'finance.approve']), (req, res) => {
    try {
      const r = decideRefundRequest(db, req.params.refundId, req.body || {}, req.user);
      if (r.ok) {
        const outcome = String(req.body?.status || '').trim() || 'reviewed';
        const target = upsertWorkItemBySource(db, {
          actor: req.user,
          sourceKind: 'refund_request',
          sourceId: String(req.params.refundId || ''),
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          responsibleOfficeKey: 'branch_manager',
          documentClass: 'approval',
          documentType: 'refund_request',
          status: outcome.toLowerCase(),
          title: `Refund request ${String(req.params.refundId || '').trim()}`,
          summary: String(req.body?.note || req.body?.managerComments || '').trim() || `Refund ${outcome.toLowerCase()}`,
          requiresApproval: true,
          data: { routePath: '/manager' },
        });
        if (target.ok) {
          appendWorkItemDecision(db, {
            workItemId: target.item.id,
            actor: req.user,
            actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
            decisionKey: 'refund_review',
            outcomeStatus: outcome.toLowerCase(),
            nextStatus: outcome.toLowerCase(),
            note: String(req.body?.note || req.body?.managerComments || '').trim() || `Refund ${outcome.toLowerCase()}`,
          });
          if (String(outcome).toLowerCase() === 'approved') {
            try {
              const wid = String(target.item?.id || '').trim();
              if (wid) {
                const ref = issueZarewaFilingReference(db, {
                  branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
                  domain: 'REF',
                });
                const tiso = new Date().toISOString();
                db.prepare(
                  `INSERT OR REPLACE INTO work_item_filing (
                    work_item_id, filing_reference, filing_class, retention_label, archive_state, print_summary, updated_at_iso
                  ) VALUES (?,?,?,?,?,?,?)`
                ).run(wid, ref, 'refund_request', null, 'open', null, tiso);
              }
            } catch (e) {
              console.error('refund_request filing ref', e);
            }
          }
        }
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/refunds/:refundId/pay', requirePermission('finance.pay'), (req, res) => {
    try {
      const refundGate = assertRefundIdInWorkspace(db, req, req.params.refundId);
      if (!refundGate.ok) return res.status(refundGate.status).json({ ok: false, error: refundGate.error });
      const treasuryLines = normalizeTreasuryLines(req.body || {});
      const r = write.payRefundEntry(db, req.params.refundId, {
        ...(req.body || {}),
        paymentLines: treasuryLines,
        paidBy: req.user.displayName,
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/refunds/:refundId/cancel-before-pay',
    requirePermission(['refunds.approve', 'finance.approve', 'finance.pay']),
    (req, res) => {
      try {
        const r = cancelApprovedRefundBeforePay(db, req.params.refundId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  /** Undo recorded REFUND_PAYOUT treasury debits and reset paid_amount (requires finance.reverse + KPI for officers). */
  app.post(
    '/api/refunds/:refundId/reverse-treasury-payout',
    requirePermission('finance.reverse'),
    (req, res) => {
      try {
        const refundId = String(req.params.refundId || '').trim();
        if (!refundId) return res.status(400).json({ ok: false, error: 'Refund ID is required.' });
        return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'refund', refundId, (_stripped, ctx) =>
          write.reverseRefundTreasuryPayouts(db, refundId, {
            ...(_stripped || {}),
            workspaceBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
            workspaceViewAll: Boolean(req.workspaceViewAll),
            skipInnerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
          }, req.user)
        );
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.get('/api/setup', requirePermission('settings.view'), (_req, res) => {
    try {
      res.json({ ok: true, masterData: listMasterData(db) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load setup data' });
    }
  });

  app.get('/api/branches/strict-audit', requirePermission('settings.view'), (_req, res) => {
    try {
      const branchIds = new Set(listBranches(db).map((b) => String(b.id || '').trim()).filter(Boolean));
      const rows = [];
      for (const t of STRICT_BRANCH_AUDIT_TABLES) {
        if (!tableHasColumn(db, t.table, 'branch_id') || !tableHasColumn(db, t.table, t.idColumn)) continue;
        const missing = Number(
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM ${t.table}
               WHERE branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = ''`
            )
            .get()?.c ?? 0
        );
        const invalid = Number(
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM ${t.table}
               WHERE NOT (branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '')
                 AND branch_id NOT IN (SELECT id FROM branches)`
            )
            .get()?.c ?? 0
        );
        const sampleIds = db
          .prepare(
            `SELECT ${t.idColumn} AS id FROM ${t.table}
             WHERE branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = ''
                OR branch_id NOT IN (SELECT id FROM branches)
             LIMIT 10`
          )
          .all()
          .map((r) => String(r.id || ''));
        rows.push({
          table: t.table,
          missingBranchIdRows: missing,
          invalidBranchIdRows: invalid,
          sampleIds,
        });
      }
      const totals = rows.reduce(
        (acc, r) => {
          acc.missingBranchIdRows += r.missingBranchIdRows;
          acc.invalidBranchIdRows += r.invalidBranchIdRows;
          return acc;
        },
        { missingBranchIdRows: 0, invalidBranchIdRows: 0 }
      );
      res.json({
        ok: true,
        strictBranchIsolationOk: totals.missingBranchIdRows === 0 && totals.invalidBranchIdRows === 0,
        knownBranches: Array.from(branchIds),
        totals,
        tables: rows,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not run strict branch audit.' });
    }
  });

  app.patch('/api/branches/:branchId/cutting-threshold', requirePermission('settings.manage'), (req, res) => {
    try {
      const raw = req.body?.cuttingListMinPaidFraction ?? req.body?.fraction;
      const r = setBranchCuttingListMinPaidFraction(db, req.params.branchId, raw);
      if (!r.ok) return res.status(400).json(r);
      appendAuditLog(db, {
        actor: req.user,
        action: 'branch.cutting_threshold',
        entityKind: 'branch',
        entityId: r.branchId,
        note: `Cutting list minimum paid fraction set to ${r.cuttingListMinPaidFraction}`,
        details: { cuttingListMinPaidFraction: r.cuttingListMinPaidFraction },
      });
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update cutting threshold.' });
    }
  });

  app.post('/api/setup/:kind', requirePermission('settings.manage'), (req, res) => {
    try {
      const r = upsertMasterDataRecord(db, req.params.kind, req.body || {}, req.user);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/setup/:kind/:id', requirePermission('settings.manage'), (req, res) => {
    try {
      const kind = req.params.kind;
      const id = req.params.id;
      const entityId = `${kind}:${id}`;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'setup_record', entityId, (stripped) =>
        upsertMasterDataRecord(db, kind, { ...(stripped || {}), id }, req.user)
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete('/api/setup/:kind/:id', requirePermission('settings.manage'), (req, res) => {
    try {
      const r = deleteMasterDataRecord(db, req.params.kind, req.params.id, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/accounts-payable/:apId/pay', requirePermission('finance.pay'), (req, res) => {
    try {
      const apRow = db.prepare(`SELECT po_ref FROM accounts_payable WHERE ap_id = ?`).get(req.params.apId);
      if (apRow?.po_ref) {
        const poGate = assertPurchaseOrderIdInWorkspace(db, req, apRow.po_ref);
        if (!poGate.ok) return res.status(poGate.status).json({ ok: false, error: poGate.error });
      }
      const r = write.payAccountsPayable(db, req.params.apId, {
        ...(req.body || {}),
        createdBy: req.user.displayName,
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/payment-requests', requirePermission(['finance.post', 'expenses.create']), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'payment_request.create')) return;
      const r = insertPaymentRequest(db, { ...(req.body || {}), workspaceBranchId: req.workspaceBranchId }, req.user);
      if (r.ok) {
        const woId = String(req.body?.workOrderId || req.body?.maintenanceWorkOrderId || '').trim();
        if (woId && r.requestID) {
          const linked = linkWorkOrderPaymentRequest(db, woId, r.requestID, req.user, {
            costKind: req.body?.costKind || req.body?.maintenanceCostKind,
          });
          if (!linked.ok) {
            r.workOrderLinkError = linked.error;
          } else {
            r.workOrderId = woId;
            r.costLineId = linked.costLineId || null;
          }
        }
        storeIdempotentSuccess(db, req, 'payment_request.create', 201, r);
      }
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      apiError(res, {
        status: 400,
        code: 'PAYMENT_REQUEST_FAILED',
        error: safeErrorMessage(e, 'Could not create payment request.'),
      });
    }
  });

  app.get('/api/expense-categories', requireAuth, (req, res) => {
    try {
      const meta = buildExpenseCategoryMetaForActor(
        req.user,
        (p) => userHasPermission(req.user, p),
        getOrgGovernanceLimits(db)
      );
      res.json({ ok: true, ...meta });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/expense-categories/suggest', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const suggestion = suggestExpenseCategoryForActor(
        {
          subject: body.subject,
          body: body.body,
          description: body.description,
          reference: body.reference,
          amountNgn: body.amountNgn ?? body.amount,
        },
        req.user,
        (p) => userHasPermission(req.user, p)
      );
      const enriched = await enrichExpenseSuggest(db, req.user, body, suggestion);
      const withAutomation = await processExpenseAutomationHook(db, req.user, body, enriched);
      res.json(withAutomation);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/payment-requests/:requestId/attachment', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'finance.pay') ||
        userHasPermission(req.user, 'expenses.create') ||
        userHasPermission(req.user, 'cashier.desk.view');
      if (!can) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const requestId = String(req.params.requestId || '').trim();
      const row = db
        .prepare(
          `SELECT attachment_name, attachment_mime, attachment_data_b64 FROM payment_requests WHERE request_id = ?`
        )
        .get(requestId);
      const b64 = row?.attachment_data_b64;
      if (!row || !b64 || !String(b64).trim()) {
        res.status(404).json({ ok: false, error: 'No attachment on this request.' });
        return;
      }
      const buf = Buffer.from(String(b64).trim(), 'base64');
      const mime = String(row.attachment_mime || 'application/octet-stream').split(';')[0].trim();
      const name = String(row.attachment_name || 'attachment').replace(/[^\w.-]+/g, '_');
      res.setHeader('Content-Type', mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      res.send(buf);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/payment-requests/:requestId', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'finance.pay') ||
        userHasPermission(req.user, 'expenses.create') ||
        userHasPermission(req.user, 'cashier.desk.view');
      if (!can) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const request = getPaymentRequestDetail(db, String(req.params.requestId || ''));
      if (!request) {
        res.status(404).json({ ok: false, error: 'Payment request not found.' });
        return;
      }
      const prGate = assertPaymentRequestIdInWorkspace(db, req, req.params.requestId);
      if (!prGate.ok) return res.status(prGate.status).json({ ok: false, error: prGate.error });
      res.json({ ok: true, request });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/payment-requests/:requestId/gl-preview', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'finance.pay');
      if (!can) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const preview = getPaymentRequestGlPreview(db, String(req.params.requestId || ''));
      res.status(preview.ok ? 200 : 404).json(preview);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/payment-requests/:requestId/reclassify-category', requireAuth, (req, res) => {
    try {
      const requestId = String(req.params.requestId || '');
      const row = db.prepare(`SELECT paid_amount_ngn FROM payment_requests WHERE request_id = ?`).get(requestId);
      if (!row) {
        res.status(404).json({ ok: false, error: 'Payment request not found.' });
        return;
      }
      const paidNgn = Math.round(Number(row.paid_amount_ngn) || 0);
      if (paidNgn > 0) {
        if (!userHasPermission(req.user, 'finance.post') && !userHasPermission(req.user, '*')) {
          res.status(403).json({ ok: false, error: 'finance.post is required to reclassify after payout.' });
          return;
        }
        const r = reclassifyPaidPaymentRequestCategory(db, requestId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
        return;
      }
      if (!userHasPermission(req.user, 'finance.approve') && !userHasPermission(req.user, '*')) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const r = reclassifyPaymentRequestCategory(db, requestId, req.body || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/payment-requests/:requestId/category-reclass-preview', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve');
      if (!can && !userHasPermission(req.user, '*')) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const preview = getPaidExpenseCategoryReclassPreview(db, {
        requestId: String(req.params.requestId || ''),
        expenseCategory: req.query.expenseCategory || req.query.category || '',
      });
      res.status(preview.ok ? 200 : 400).json(preview);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/expenses/:expenseId/reclassify-category', requirePermission('finance.post'), (req, res) => {
    try {
      const r = reclassifyPaidExpenseCategory(
        db,
        String(req.params.expenseId || ''),
        req.body || {},
        req.user
      );
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/expenses/:expenseId/category-reclass-preview', requireAuth, (req, res) => {
    try {
      if (!userHasPermission(req.user, 'finance.post') && !userHasPermission(req.user, '*')) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const preview = getPaidExpenseCategoryReclassPreview(db, {
        expenseId: String(req.params.expenseId || ''),
        expenseCategory: req.query.expenseCategory || req.query.category || '',
      });
      res.status(preview.ok ? 200 : 400).json(preview);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/reports/expense-category-monthly-alert', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'reports.view');
      if (!can) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const alert = buildExpenseCategoryMonthlyAlert(db, {
        branchScope: req.query.branchScope || req.workspaceBranchId,
        startISO: req.query.startDate || req.query.startISO,
        endISO: req.query.endDate || req.query.endISO,
        orgLimits: getOrgGovernanceLimits(db),
      });
      res.json(alert);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/reports/expense-category-exceptions', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'reports.view');
      if (!can) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const report = buildExpenseCategoryExceptionReport(db, {
        startISO: req.query.startDate || req.query.startISO,
        endISO: req.query.endDate || req.query.endISO,
        branchScope: req.query.branchScope || req.workspaceBranchId,
      });
      if (String(req.query.format || '').toLowerCase() === 'csv') {
        const csv = buildExpenseCategoryExceptionCsv(report);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="expense-category-exceptions-${stamp}.csv"`);
        res.send(csv);
        return;
      }
      res.json(report);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/reports/expense-category-others-trend', requireAuth, (req, res) => {
    try {
      const can =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'reports.view') ||
        userHasPermission(req.user, '*');
      if (!can) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const report = buildExpenseCategoryOthersTrendReport(db, {
        months: req.query.months,
        endISO: req.query.endISO || req.query.endDate,
        branchScope: req.query.branchScope || req.workspaceBranchId || 'ALL',
      });
      res.json(report);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/payment-requests/:requestId', requireAuth, (req, res) => {
    try {
      const canEdit =
        userHasPermission(req.user, 'finance.post') ||
        userHasPermission(req.user, 'finance.approve') ||
        userHasPermission(req.user, 'expenses.create');
      if (!canEdit) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const r = updatePaymentRequest(db, req.params.requestId, req.body || {}, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/payment-requests/:requestId/decision', requireAuth, (req, res) => {
    try {
      if (!userMayReviewPaymentRequests(req.user, (perm) => userHasPermission(req.user, perm))) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }
      const r = decidePaymentRequest(db, req.params.requestId, req.body || {}, req.user);
      if (r.ok) {
        const outcome = String(req.body?.status || '').trim() || 'reviewed';
        const target = upsertWorkItemBySource(db, {
          actor: req.user,
          sourceKind: 'payment_request',
          sourceId: String(req.params.requestId || ''),
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
          officeKey: 'finance',
          responsibleOfficeKey: 'finance',
          documentClass: 'approval',
          documentType: 'payment_request',
          status: outcome.toLowerCase(),
          title: `Payment request ${String(req.params.requestId || '').trim()}`,
          summary: String(req.body?.note || '').trim() || `Payment request ${outcome.toLowerCase()}`,
          requiresApproval: true,
          data: { routePath: '/accounts', routeState: { accountsTab: 'requests' } },
        });
        if (target.ok) {
          appendWorkItemDecision(db, {
            workItemId: target.item.id,
            actor: req.user,
            actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
            decisionKey: 'payment_request_review',
            outcomeStatus: outcome.toLowerCase(),
            nextStatus: outcome.toLowerCase(),
            note: String(req.body?.note || '').trim() || `Payment request ${outcome.toLowerCase()}`,
          });
          if (String(outcome).toLowerCase() === 'approved') {
            try {
              const wid = String(target.item?.id || '').trim();
              if (wid) {
                const ref = issueZarewaFilingReference(db, {
                  branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
                  domain: 'PREQ',
                });
                const tiso = new Date().toISOString();
                db.prepare(
                  `INSERT OR REPLACE INTO work_item_filing (
                    work_item_id, filing_reference, filing_class, retention_label, archive_state, print_summary, updated_at_iso
                  ) VALUES (?,?,?,?,?,?,?)`
                ).run(wid, ref, 'payment_request', null, 'open', null, tiso);
              }
            } catch (e) {
              console.error('payment_request filing ref', e);
            }
          }
        }
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/payment-requests/:requestId/pay', requirePermission('finance.pay'), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'payment_request.pay')) return;
      const treasuryLines = normalizeTreasuryLines(req.body || {});
      const r = write.payPaymentRequest(db, req.params.requestId, {
        ...(req.body || {}),
        paymentLines: treasuryLines,
        createdBy: req.user.displayName,
        paidBy: req.user.displayName,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
        actor: req.user,
      });
      if (r.ok) storeIdempotentSuccess(db, req, 'payment_request.pay', 201, r);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/payment-requests/:requestId/cancel-before-pay',
    requirePermission(['finance.approve', 'finance.pay']),
    (req, res) => {
      try {
        const r = cancelApprovedPaymentRequestBeforePay(db, req.params.requestId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  /** Undo recorded treasury debits for a payment request and reset paid_amount (requires finance.reverse + KPI for officers). */
  app.post(
    '/api/payment-requests/:requestId/reverse-treasury-payout',
    requirePermission('finance.reverse'),
    (req, res) => {
      try {
        const requestId = String(req.params.requestId || '').trim();
        if (!requestId) return res.status(400).json({ ok: false, error: 'Request ID is required.' });
        return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'payment_request', requestId, (stripped, ctx) =>
          write.reversePaymentRequestTreasuryPayouts(
            db,
            requestId,
            {
              ...(stripped || {}),
              workspaceBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
              workspaceViewAll: Boolean(req.workspaceViewAll),
              skipInnerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
            },
            req.user
          )
        );
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  /** Rollout duplicate cleanup: unpaid payment request and orphan placeholder expense (requires finance approval + KPI for officers). */
  app.delete('/api/payment-requests/:requestId/rollout-dup', requirePermission('finance.approve'), (req, res) => {
    try {
      const requestId = String(req.params.requestId || '').trim();
      if (!requestId) return res.status(400).json({ ok: false, error: 'Request ID is required.' });
      const row = db
        .prepare(
          `SELECT COALESCE(e.branch_id, '') AS branch_id
           FROM payment_requests pr
           LEFT JOIN expenses e ON e.expense_id = pr.expense_id
           WHERE pr.request_id = ?`
        )
        .get(requestId);
      if (!row) return res.status(404).json({ ok: false, error: 'Payment request not found.' });
      const bid = String(row.branch_id || '').trim();
      const wb = String(req.workspaceBranchId || DEFAULT_BRANCH_ID).trim();
      if (
        bid &&
        bid !== wb &&
        !(Boolean(req.workspaceViewAll) && canUseAllBranchesRollup(req.user))
      ) {
        return res.status(403).json({ ok: false, error: 'Switch workspace branch to delete this request.' });
      }
      return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'payment_request', requestId, (_stripped, ctx) =>
        write.deletePaymentRequestRolloutDup(db, requestId, req.user, {
          skipInnerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
        })
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/payment-requests/:requestId/rollout-delete', requirePermission('finance.approve'), (req, res) => {
    try {
      const requestId = String(req.params.requestId || '').trim();
      if (!requestId) return res.status(400).json({ ok: false, error: 'Request ID is required.' });
      const row = db
        .prepare(
          `SELECT COALESCE(e.branch_id, '') AS branch_id
           FROM payment_requests pr
           LEFT JOIN expenses e ON e.expense_id = pr.expense_id
           WHERE pr.request_id = ?`
        )
        .get(requestId);
      if (!row) return res.status(404).json({ ok: false, error: 'Payment request not found.' });
      const bid = String(row.branch_id || '').trim();
      const wb = String(req.workspaceBranchId || DEFAULT_BRANCH_ID).trim();
      if (
        bid &&
        bid !== wb &&
        !(Boolean(req.workspaceViewAll) && canUseAllBranchesRollup(req.user))
      ) {
        return res.status(403).json({ ok: false, error: 'Switch workspace branch to delete this request.' });
      }
      return handleWriteWithEditApproval(res, db, req.user, req.body || {}, 'payment_request', requestId, (_stripped, ctx) =>
        write.deletePaymentRequestRolloutDup(db, requestId, req.user, {
          skipInnerTransaction: Boolean(ctx?.withinEditApprovalTransaction),
        })
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.put('/api/finance/core', requirePermission('settings.manage'), (req, res) => {
    try {
      if (!userHasPermission(req.user, '*')) {
        return res.status(403).json({
          ok: false,
          error: 'Bulk finance data replace requires administrator access.',
        });
      }
      const bulkGate = assertSingleBranchWorkspaceForBulkWrite(req);
      if (!bulkGate.ok) return res.status(403).json({ ok: false, error: bulkGate.error });
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'finance_core', 'bulk', (stripped) => {
        const reason = String(stripped?.reason ?? '').trim();
        if (!reason) return { ok: false, error: 'Reason is required for bulk finance updates.' };
        const b = stripped || {};
        if (Array.isArray(b.expenses)) write.replaceExpenses(db, b.expenses);
        if (Array.isArray(b.paymentRequests)) write.replacePaymentRequests(db, b.paymentRequests);
        if (Array.isArray(b.accountsPayable)) write.replaceAccountsPayable(db, b.accountsPayable);
        if (Array.isArray(b.bankReconciliation)) write.replaceBankReconciliation(db, b.bankReconciliation);
        appendAuditLog(db, {
          actor: req.user,
          action: 'finance.bulk_replace',
          entityKind: 'finance_core',
          entityId: 'bulk',
          note: reason,
          details: {
            expenses: Array.isArray(b.expenses) ? b.expenses.length : 0,
            paymentRequests: Array.isArray(b.paymentRequests) ? b.paymentRequests.length : 0,
            accountsPayable: Array.isArray(b.accountsPayable) ? b.accountsPayable.length : 0,
            bankReconciliation: Array.isArray(b.bankReconciliation) ? b.bankReconciliation.length : 0,
          },
        });
        return { ok: true };
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/controls/period-locks', requirePermission('period.manage'), async (req, res) => {
    try {
      const body = req.body || {};
      const periodKey = String(body.periodKey || body.dateISO || '').trim().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(periodKey)) {
        return res.status(400).json({ ok: false, error: 'periodKey must be YYYY-MM.' });
      }
      const force = Boolean(body.force);
      const reason = String(body.reason ?? '').trim();
      if (force) {
        if (reason.length < 12) {
          return res.status(400).json({
            ok: false,
            error: 'Force lock requires a written reason of at least 12 characters (MD/HoA override).',
            code: 'FORCE_REASON_REQUIRED',
          });
        }
      } else {
        const branchScope = resolveExecDashboardBranchScope(req.user, req, body.branchId);
        const branchId = branchScope === 'ALL' ? null : branchScope;
        const trialExceptions = await buildFinanceTrialExceptionSummary(db, { branchId });
        const checklist = buildMonthEndCloseChecklist(db, periodKey, branchScope, { trialExceptions });
        if (!checklist.ok) {
          return res.status(400).json(checklist);
        }
        if (!checklist.readyToLock) {
          return res.status(400).json({
            ok: false,
            error: checklist.summary || 'Month-end close checklist is not clear.',
            code: 'CLOSE_CHECKLIST_BLOCKED',
            blockers: checklist.blockers,
            warnings: checklist.warnings,
            steps: checklist.steps.filter((s) => s.status !== 'ok' && s.id !== 'period_lock'),
          });
        }
      }
      const lockPayload = force ? { ...body, reason } : body;
      const r = lockAccountingPeriod(db, lockPayload, req.user);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/controls/period-locks', requirePermission(['period.manage', 'finance.view', 'treasury.manage']), (_req, res) => {
    try {
      res.json({ ok: true, periodLocks: listPeriodLocks(db) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load period locks' });
    }
  });

  app.delete('/api/controls/period-locks/:periodKey', requirePermission('period.manage'), (req, res) => {
    try {
      const r = unlockAccountingPeriod(db, req.params.periodKey, req.user, req.body?.reason || '');
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get(
    '/api/audit-log',
    requirePermission(['audit.view', 'sales.manage', 'reports.view', 'quotations.manage']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const limit = Math.min(300, Math.max(20, Number(req.query.limit) || 120));
        const auditLog = listAuditLog(db, limit);
        const approvalActions = listApprovalActions(db, limit);
        const branchId = branchScope === 'ALL' ? '' : String(branchScope || '').trim();
        const fullAccess = userHasPermission(req.user, 'audit.view') || userHasPermission(req.user, '*');
        const filterAudit = (row) => {
          if (!branchId || fullAccess) return true;
          const d = row.details || {};
          const bid = String(d.branchId || d.branch_id || '').trim();
          if (bid) return bid === branchId;
          const action = String(row.action || '').toLowerCase();
          return /^(quotation|customer_complaint|maintenance|refund|payment_request|expense|credit_exception|edit_approval)/.test(
            action
          );
        };
        const scopedAudit = !branchId || fullAccess ? auditLog : auditLog.filter(filterAudit);
        res.json({
          ok: true,
          auditLog: scopedAudit,
          approvalActions,
          meta: { branchScoped: Boolean(branchId) && !fullAccess, branchId: branchId || 'ALL' },
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load audit log' });
      }
    }
  );

  app.get(
    '/api/management/branch-benchmark',
    requireManagementReportsView,
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const branchId =
          branchScope === 'ALL'
            ? String(req.query.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID).trim()
            : String(branchScope).trim();
        const pack = buildManagerBranchBenchmark(db, {
          branchId,
          periodKey: String(req.query.period || req.query.periodKey || 'month').trim() || 'month',
        });
        res.status(pack.ok ? 200 : 400).json(pack);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load branch benchmark.' });
      }
    }
  );

  app.get(
    '/api/branch-shift-notes',
    requireAuth,
    requirePermission(['sales.manage', 'sales.view', 'operations.view', 'operations.manage']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const branchId =
          branchScope === 'ALL'
            ? String(req.query.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID).trim()
            : String(branchScope).trim();
        const shiftDate = String(req.query.shiftDate || req.query.dayIso || '').trim().slice(0, 10);
        res.json({
          ok: true,
          notes: listBranchShiftNotes(db, {
            branchId,
            shiftDate: shiftDate || undefined,
            limit: Number(req.query.limit) || 30,
          }),
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load shift notes.' });
      }
    }
  );

  app.post(
    '/api/branch-shift-notes',
    requireAuth,
    requirePermission(['sales.manage', 'operations.manage', 'operations.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const body = { ...(req.body || {}) };
        if (branchScope !== 'ALL') body.branchId = branchScope;
        const r = createBranchShiftNote(db, body, req.user, req.workspaceBranchId || DEFAULT_BRANCH_ID);
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not save shift note.' });
      }
    }
  );

  app.get(
    '/api/branch-checklist-events',
    requireAuth,
    requirePermission(['sales.manage', 'sales.view', 'operations.view', 'operations.manage']),
    (req, res) => {
      try {
        const scope = resolveBootstrapBranchScope(req);
        const branchId = scope === 'ALL' ? String(req.query.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID).trim() : String(scope).trim();
        return res.json({
          ok: true,
          events: listChecklistEvents(db, { branchId, dayIso: req.query.dayIso, limit: Number(req.query.limit) || 100 }),
        });
      } catch (e) {
        console.error('[branch-checklist-events]', e);
        return res.status(500).json({ ok: false, error: 'Could not load checklist events.' });
      }
    }
  );

  app.post(
    '/api/branch-checklist-events',
    requireAuth,
    requirePermission(['sales.manage', 'operations.manage']),
    (req, res) => {
      try {
        const scope = resolveBootstrapBranchScope(req);
        const body = { ...(req.body || {}) };
        if (scope !== 'ALL') body.branchId = scope;
        const result = createChecklistEvent(db, body, req.user, req.workspaceBranchId || DEFAULT_BRANCH_ID);
        return res.status(result.ok ? 201 : 400).json(result);
      } catch (e) {
        console.error('[branch-checklist-events]', e);
        return res.status(500).json({ ok: false, error: 'Could not save checklist event.' });
      }
    }
  );

  app.get(
    '/api/hr/ot-board',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    (req, res) => {
      try {
        const scope = resolveBootstrapBranchScope(req);
        const branchId = scope === 'ALL' ? String(req.query.branchId || '').trim() : String(scope).trim();
        return res.json({ ok: true, rows: listOtBoard(db, { branchId, dayIso: req.query.dayIso, from: req.query.from, to: req.query.to }) });
      } catch (e) {
        console.error('[hr-ot-board]', e);
        return res.status(500).json({ ok: false, error: 'Could not load OT board.' });
      }
    }
  );

  /**
   * Annex D §D.5.4: full export is admin-only (`audit.export` is not in any role bundle;
   * only `admin` (`*`) or an explicit custom grant passes). The export itself is audited
   * so downloading the trail always leaves a trace.
   */
  app.get('/api/audit/export.ndjson', requirePermission('audit.export'), (req, res) => {
    try {
      const rows = listAuditLogNdjsonRows(db);
      appendAuditLog(db, {
        actor: req.user,
        action: 'audit.export',
        entityKind: 'audit_log',
        entityId: 'export.ndjson',
        note: `Full audit log export (${rows.length} rows)`,
        details: { rowCount: rows.length },
      });
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="zarewa-audit-export.ndjson"');
      for (const row of rows) {
        res.write(`${JSON.stringify(row)}\n`);
      }
      res.end();
    } catch (e) {
      console.error(e);
      apiError(res, { status: 500, code: 'EXPORT_FAILED', error: 'Could not export audit log.' });
    }
  });

  /** Annex D §D.5: tamper-evidence check — recomputes the audit log hash chain. */
  app.get('/api/audit/verify-chain', requirePermission('audit.view'), (_req, res) => {
    try {
      res.json({ ok: true, ...verifyAuditLogChain(db) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not verify audit log chain' });
    }
  });

  app.get('/api/customers/staff-link-options', requirePermission('customers.manage'), (req, res) => {
    try {
      if (!userMayLinkStaffSalesCustomer(req.user)) {
        return res.json({ ok: true, items: [] });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const items = listStaffForSalesCustomerLink(db, branchScope, req.query.q || req.query.query || '');
      return res.json({ ok: true, items });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load staff link options.' });
    }
  });

  app.get(
    '/api/customers/master-quality',
    requirePermission(['customers.manage', 'settings.view', 'reports.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        return res.json(listCustomerMasterQualityIssues(db, branchScope));
      } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'Could not scan customer master quality.' });
      }
    }
  );

  app.put('/api/customers/:customerId/staff-link', requirePermission('customers.manage'), (req, res) => {
    try {
      if (!userMayLinkStaffSalesCustomer(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.' });
      }
      const cid = String(req.params.customerId || '').trim();
      const staffUserId = String(req.body?.staffUserId ?? req.body?.linkedStaffUserId ?? '').trim();
      if (!staffUserId) {
        const r = unlinkSalesCustomerFromStaff(db, cid, req.user);
        if (!r.ok) return res.status(400).json(r);
        return res.json(r);
      }
      const r = linkSalesCustomerToStaff(db, cid, staffUserId, req.user);
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not update staff link.' });
    }
  });

  app.get('/api/customers/:customerId', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const row = getCustomer(db, req.params.customerId, branchScope);
      if (!row) return res.status(404).json({ ok: false, error: 'Customer not found' });
      res.json({ ok: true, customer: row });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load customer' });
    }
  });

  app.get('/api/customers/:customerId/interactions', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const row = getCustomer(db, req.params.customerId, branchScope);
      if (!row) return res.status(404).json({ ok: false, error: 'Customer not found' });
      res.json({
        ok: true,
        interactions: listCustomerCrmInteractions(db, req.params.customerId, branchScope),
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load CRM interactions' });
    }
  });

  app.post('/api/customers/:customerId/interactions', requirePermission('customers.manage'), (req, res) => {
    try {
      const r = write.insertCustomerCrmInteraction(
        db,
        req.params.customerId,
        req.body || {},
        req.user,
        req.workspaceBranchId || DEFAULT_BRANCH_ID
      );
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get(
    '/api/customer-complaints',
    requireAuth,
    requirePermission(SALES_DOMAIN_PERMS),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const openOnly = String(req.query.openOnly || '') === '1';
        const customerId = String(req.query.customerId || '').trim();
        const pack = listCustomerComplaints(db, {
          viewAll: branchScope === 'ALL',
          branchId:
            branchScope === 'ALL'
              ? String(req.query.branchId || '').trim()
              : branchScope,
          openOnly,
          customerId: customerId || undefined,
        });
        res.json({
          ok: true,
          complaints: pack,
          meta: {
            channels: COMPLAINT_CHANNELS,
            categories: COMPLAINT_CATEGORIES,
            severities: COMPLAINT_SEVERITIES,
          },
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load complaints.' });
      }
    }
  );

  app.get(
    '/api/customer-complaints/:complaintId',
    requireAuth,
    requirePermission(SALES_DOMAIN_PERMS),
    (req, res) => {
      try {
        const complaint = getCustomerComplaint(db, req.params.complaintId);
        if (!complaint) return res.status(404).json({ ok: false, error: 'Complaint not found.' });
        const branchScope = resolveBootstrapBranchScope(req);
        if (branchScope !== 'ALL' && String(complaint.branchId) !== String(branchScope)) {
          return res.status(404).json({ ok: false, error: 'Complaint not found.' });
        }
        res.json({ ok: true, complaint });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not load complaint.' });
      }
    }
  );

  app.post(
    '/api/customer-complaints',
    requireAuth,
    requirePermission(['customers.manage', 'sales.manage']),
    (req, res) => {
      try {
        const body = { ...(req.body || {}) };
        if (!body.customerId && req.body?.customerID) body.customerId = req.body.customerID;
        const r = createCustomerComplaint(db, body, req.user, req.workspaceBranchId || DEFAULT_BRANCH_ID);
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not create complaint.' });
      }
    }
  );

  app.post(
    '/api/customers/:customerId/complaints',
    requireAuth,
    requirePermission(['customers.manage', 'sales.manage']),
    (req, res) => {
      try {
        const r = createCustomerComplaint(
          db,
          { ...(req.body || {}), customerId: req.params.customerId },
          req.user,
          req.workspaceBranchId || DEFAULT_BRANCH_ID
        );
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not create complaint.' });
      }
    }
  );

  app.patch(
    '/api/customer-complaints/:complaintId',
    requireAuth,
    requirePermission(['customers.manage', 'sales.manage', 'sales.view']),
    (req, res) => {
      try {
        const existing = getCustomerComplaint(db, req.params.complaintId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Complaint not found.' });
        const rk = String(req.user?.roleKey || '').toLowerCase();
        const mayManage =
          ['admin', 'md', 'ceo', 'chairman', 'sales_manager', 'branch_manager'].includes(rk) ||
          userHasPermission(req.user, 'customers.manage');
        if (!mayManage) {
          return res.status(403).json({ ok: false, error: 'Branch Manager or customers.manage required.' });
        }
        const r = updateCustomerComplaint(db, req.params.complaintId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not update complaint.' });
      }
    }
  );

  app.get('/api/bank-reconciliation', requirePermission('finance.view'), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, lines: listBankReconciliation(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load bank reconciliation lines.' });
    }
  });

  app.post('/api/bank-reconciliation', requirePermission('finance.post'), (req, res) => {
    try {
      let branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      if (req.workspaceViewAll && canUseAllBranchesRollup(req.user)) {
        const requested = String(req.body?.branchId ?? '').trim();
        if (requested && getBranch(db, requested)) branchId = requested;
      }
      const r = write.insertBankReconciliationLine(
        db,
        { ...(req.body || {}), actor: req.user },
        branchId
      );
      if (r.ok) {
        try {
          syncFinanceBankReconExceptionWorkItem(db, branchId, req.user);
        } catch (syncErr) {
          console.error(syncErr);
        }
      }
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/bank-reconciliation/import-csv',
    requirePermission('finance.post'),
    rateLimitAuthedUser(bankFinanceImportBuckets, 'bank-import', 20, 60_000),
    (req, res) => {
    try {
      const csvText = String(req.body?.csvText ?? '').trim();
      if (!csvText) {
        return res.status(400).json({ ok: false, error: 'Body.csvText is required.' });
      }
      const parsed = write.parseBankReconciliationCsvText(csvText);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error, parseErrors: parsed.parseErrors });
      }
      const rows = parsed.lines || [];
      if (rows.length > 500) {
        return res.status(400).json({ ok: false, error: 'Maximum 500 data rows per import.' });
      }
      let branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      if (req.workspaceViewAll && canUseAllBranchesRollup(req.user)) {
        const requested = String(req.body?.branchId ?? '').trim();
        if (requested && getBranch(db, requested)) branchId = requested;
      }
      const existingLines = listBankReconciliation(db, branchId);
      const fpSet = buildBankReconFingerprintSetForBranch(existingLines, branchId);
      const { toInsert, skippedDuplicates } = partitionBankReconImportRows(rows, branchId, fpSet);
      const created = [];
      const errors = [];
      for (let i = 0; i < toInsert.length; i += 1) {
        const r = write.insertBankReconciliationLine(
          db,
          { ...toInsert[i], actor: req.user },
          branchId
        );
        if (r.ok) created.push(r.id);
        else errors.push({ index: i, error: r.error || 'Insert failed.' });
      }
      try {
        syncFinanceBankReconExceptionWorkItem(db, branchId, req.user);
      } catch (syncErr) {
        console.error(syncErr);
      }
      res.status(200).json({
        ok: errors.length === 0,
        createdIds: created,
        createdCount: created.length,
        skippedDuplicateCount: skippedDuplicates.length,
        skippedDuplicates: skippedDuplicates.length ? skippedDuplicates : undefined,
        errorCount: errors.length,
        errors,
        parseWarnings: parsed.parseErrors?.length ? parsed.parseErrors : undefined,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }
  );

  app.post(
    '/api/bank-reconciliation/import',
    requirePermission('finance.post'),
    rateLimitAuthedUser(bankFinanceImportBuckets, 'bank-import', 20, 60_000),
    (req, res) => {
    try {
      const lines = req.body?.lines;
      if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ ok: false, error: 'Body.lines must be a non-empty array.' });
      }
      if (lines.length > 500) {
        return res.status(400).json({ ok: false, error: 'Maximum 500 lines per import.' });
      }
      let branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      if (req.workspaceViewAll && canUseAllBranchesRollup(req.user)) {
        const requested = String(req.body?.branchId ?? '').trim();
        if (requested && getBranch(db, requested)) branchId = requested;
      }
      const normalized = lines.map((line) => ({
        bankDateISO: String(line?.bankDateISO ?? '').trim(),
        description: String(line?.description ?? '').trim(),
        amountNgn: line?.amountNgn,
      }));
      const existingLines = listBankReconciliation(db, branchId);
      const fpSet = buildBankReconFingerprintSetForBranch(existingLines, branchId);
      const { toInsert, skippedDuplicates } = partitionBankReconImportRows(normalized, branchId, fpSet);
      const created = [];
      const errors = [];
      for (let i = 0; i < toInsert.length; i += 1) {
        const r = write.insertBankReconciliationLine(
          db,
          { ...toInsert[i], actor: req.user },
          branchId
        );
        if (r.ok) created.push(r.id);
        else errors.push({ index: i, error: r.error || 'Insert failed.' });
      }
      try {
        syncFinanceBankReconExceptionWorkItem(db, branchId, req.user);
      } catch (syncErr) {
        console.error(syncErr);
      }
      res.status(200).json({
        ok: errors.length === 0,
        createdIds: created,
        createdCount: created.length,
        skippedDuplicateCount: skippedDuplicates.length,
        skippedDuplicates: skippedDuplicates.length ? skippedDuplicates : undefined,
        errorCount: errors.length,
        errors,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }
  );

  app.patch('/api/bank-reconciliation/:lineId', requirePermission('finance.post'), (req, res) => {
    try {
      const lid = req.params.lineId;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'bank_reconciliation_line', lid, (stripped) => {
        const r = write.updateBankReconciliationLine(db, lid, {
          ...(stripped || {}),
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        }, req.user);
        if (r.ok) {
          try {
            const row = db.prepare(`SELECT branch_id FROM bank_reconciliation_lines WHERE id = ?`).get(lid);
            const bid = String(row?.branch_id || req.workspaceBranchId || DEFAULT_BRANCH_ID).trim();
            syncFinanceBankReconExceptionWorkItem(db, bid, req.user);
          } catch (syncErr) {
            console.error(syncErr);
          }
        }
        return r;
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/bank-reconciliation/:lineId/approve-variance',
    requirePermission('finance.approve'),
    (req, res) => {
      try {
        const lid = String(req.params.lineId || '').trim();
        const row = db.prepare(`SELECT branch_id FROM bank_reconciliation_lines WHERE id = ?`).get(lid);
        if (row) {
          const gate = assertEntityBranchForWorkspaceWrite(
            req.user,
            row.branch_id,
            req.workspaceBranchId,
            Boolean(req.workspaceViewAll)
          );
          if (!gate.ok) return res.status(403).json({ ok: false, error: gate.error });
        }
        const r = write.approveBankReconciliationVariance(db, lid, req.user, {
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        });
        if (r.ok) {
          try {
            const row = db.prepare(`SELECT branch_id FROM bank_reconciliation_lines WHERE id = ?`).get(lid);
            const bid = String(row?.branch_id || req.workspaceBranchId || DEFAULT_BRANCH_ID).trim();
            syncFinanceBankReconExceptionWorkItem(db, bid, req.user);
          } catch (syncErr) {
            console.error(syncErr);
          }
        }
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.get('/api/bank-deposits', requirePermission([...LEDGER_RELATED_PERMS, 'finance.view']), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const openOnly = String(req.query?.openOnly ?? req.query?.open_only ?? '') === '1';
      const deposits = listBankDeposits(db, branchScope, { openOnly });
      res.json({ ok: true, deposits });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to list bank deposits.' });
    }
  });

  app.get(
    '/api/bank-deposits/exceptions/duplicates',
    requirePermission([...LEDGER_RELATED_PERMS, 'finance.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const exceptions = listBankDepositDuplicateExceptions(db, branchScope);
        res.json({ ok: true, exceptions });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to load duplicate bank deposit exceptions.' });
      }
    }
  );

  app.get(
    '/api/bank-deposits/:depositId',
    requirePermission([...LEDGER_RELATED_PERMS, 'finance.view']),
    (req, res) => {
      try {
        const deposit = getBankDepositById(db, req.params.depositId);
        if (!deposit) return res.status(404).json({ ok: false, error: 'Bank deposit not found.' });
        const allocations = listBankDepositAllocationsForDeposit(db, deposit.id);
        res.json({ ok: true, deposit, allocations });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to load bank deposit.' });
      }
    }
  );

  app.post('/api/bank-deposits', requirePermission('finance.post'), (req, res) => {
    try {
      if (req.workspaceViewAll) {
        return res.status(403).json({ ok: false, error: 'Select a single branch workspace to register bank payments.' });
      }
      const r = registerBankDeposit(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID, req.user);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/bank-deposits/:depositId/reserve', requirePermission('receipts.post'), (req, res) => {
    try {
      const r = reserveBankDeposit(db, req.params.depositId, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/bank-deposits/:depositId/release-reservation', requirePermission('receipts.post'), (req, res) => {
    try {
      const r = releaseBankDepositReservation(db, req.params.depositId, req.user);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/bank-deposits/:depositId/merge', requirePermission('finance.post'), (req, res) => {
    try {
      if (req.workspaceViewAll) {
        return res.status(403).json({ ok: false, error: 'Select a single branch workspace to merge bank deposits.' });
      }
      const ledgerEntryId = String(req.body?.ledgerEntryId ?? req.body?.ledger_entry_id ?? '').trim();
      const r = mergeBankDepositDuplicate(db, {
        depositId: req.params.depositId,
        ledgerEntryId,
        actor: req.user,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/bank-deposits/:depositId/reverse', requirePermission('finance.post'), (req, res) => {
    try {
      if (req.workspaceViewAll) {
        return res.status(403).json({ ok: false, error: 'Select a single branch workspace to reverse bank deposits.' });
      }
      const note = String(req.body?.note ?? '').trim();
      const r = reverseBankDeposit(db, req.params.depositId, req.user, note);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/bank-deposits/:depositId/reclass', requirePermission('finance.post'), (req, res) => {
    try {
      if (req.workspaceViewAll) {
        return res.status(403).json({ ok: false, error: 'Select a single branch workspace to reclass bank deposits.' });
      }
      const r = reclassBankDeposit(db, req.params.depositId, req.user, {
        reclassKind: req.body?.reclassKind ?? req.body?.reclass_kind,
        note: req.body?.note,
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/customers/:customerId', requirePermission('customers.manage'), (req, res) => {
    try {
      const cid = req.params.customerId;
      return handlePatchWithEditApproval(res, db, req.user, req.body || {}, 'customer', cid, (stripped) =>
        write.updateCustomer(db, cid, stripped || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID)
      );
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete('/api/customers/:customerId', requirePermission('sales.manage'), (req, res) => {
    try {
      const r = write.deleteCustomerIfAllowed(db, req.params.customerId, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/customers/:customerId/summary', requirePermission(CUSTOMER_AND_AR_READ_PERMS), (req, res) => {
    try {
      const id = req.params.customerId;
      const branchScope = resolveBootstrapBranchScope(req);
      const customer = getCustomer(db, id, branchScope);
      if (!customer) return res.status(404).json({ ok: false, error: 'Customer not found' });
      const entries = listLedgerEntriesForCustomer(db, id, branchScope);
      const advanceNgn = advanceBalanceFromEntries(entries, id);
      const overpayCreditNgn = overpayCreditBalanceFromEntries(entries, id);
      const receiptTotalNgn = ledgerReceiptTotalFromEntries(entries, id);

      const quotations = listQuotationsForCustomer(db, id, branchScope);
      const productionJobs = listProductionJobsForQuotationRefs(
        db,
        quotations.map((q) => q.id),
        branchScope
      );
      const policyFlags = readFinanceFeatureFlags();
      const outstandingByQuotation = quotations.map((q) => {
        const paymentPolicy = quotationPaymentPolicySnapshot(q, productionJobs);
        const legacyDue = amountDueOnQuotationFromEntries(entries, q);
        return {
          quotationId: q.id,
          totalNgn: q.totalNgn,
          paidNgn: q.paidNgn,
          amountDueNgn: policyFlags.accountingPolicyV1Labels ? paymentPolicy.amountDueNgn : legacyDue,
          paymentPolicy: policyFlags.accountingPolicyV1Labels ? paymentPolicy : undefined,
        };
      });

      res.json({
        ok: true,
        customerId: id,
        advanceNgn,
        overpayCreditNgn,
        receiptTotalNgn,
        entries,
        outstandingByQuotation,
        accountingPolicyV1Labels: policyFlags.accountingPolicyV1Labels,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to build summary' });
    }
  });

  app.get(
    '/api/customers/:customerId/payment-integrity',
    requirePermission([...CUSTOMER_AND_AR_READ_PERMS, 'refunds.request', 'refunds.approve']),
    (req, res) => {
      try {
        const id = String(req.params.customerId || '').trim();
        const branchScope = resolveBootstrapBranchScope(req);
        const customer = getCustomer(db, id, branchScope);
        if (!customer) return res.status(404).json({ ok: false, error: 'Customer not found' });
        const issues = collectCustomerPaymentIntegrityIssues(db, id, branchScope);
        const summary = customerPaymentIntegritySummary(issues);
        res.json({ ok: true, customerId: id, ...summary });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to check payment integrity' });
      }
    }
  );

  app.get('/api/quotations', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, quotations: listQuotations(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load quotations' });
    }
  });

  app.get('/api/quotations/:id/lifecycle-timeline', requirePermission(['quotations.manage', 'refunds.approve', 'sales.view', 'operations.view']), (req, res) => {
    try {
      const qg = assertQuotationIdInWorkspace(db, req, req.params.id);
      if (!qg.ok) return res.status(qg.status).json({ ok: false, error: qg.error });
      const r = buildQuotationLifecycleTimeline(db, req.params.id);
      res.status(r.ok ? 200 : 404).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not load quotation lifecycle timeline.' });
    }
  });

  app.get('/api/quotations/:id', requireAuth, (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const qid = String(req.params.id || '').trim();
      const salesReader = canReadSalesDomain(req.user);
      const opsProductionReader =
        canReadOperationsDomain(req.user) &&
        userHasPermission(req.user, 'production.manage') &&
        quotationLinkedToProductionContext(db, qid, branchScope);
      if (!salesReader && !opsProductionReader) {
        return apiForbidden(
          res,
          permissionGuidanceMessage(['sales.view', 'operations.view', 'production.manage'])
        );
      }
      const row = getQuotation(db, qid);
      if (!row) return apiError(res, { status: 404, code: 'NOT_FOUND', error: 'Quotation not found.' });
      const qg = assertQuotationIdInWorkspace(db, req, qid);
      if (!qg.ok) return apiError(res, { status: qg.status, code: 'FORBIDDEN', error: qg.error });
      const quoteLedger = listLedgerEntriesForQuotation(db, qid, branchScope);
      const productionJobs = listProductionJobs(db, branchScope, productionHistoryListOpts()).filter(
        (j) => String(j.quotationRef || '').trim() === qid
      );
      const policyFlags = readFinanceFeatureFlags();
      const paymentPolicy = quotationPaymentPolicySnapshot(row, productionJobs);
      const amountDueNgn = policyFlags.accountingPolicyV1Labels
        ? paymentPolicy.amountDueNgn
        : amountDueOnQuotationFromEntries(quoteLedger, row);
      const rawPv = db.prepare(`SELECT id, lines_json, branch_id, date_iso FROM quotations WHERE id = ?`).get(req.params.id);
      const pv = quotationPriceViolations(db, rawPv);
      res.json({
        ok: true,
        quotation: { ...row, pricingViolations: pv.violations, pricingHasFloorRows: pv.hasFloorRows },
        amountDueNgn,
        paymentPolicy: policyFlags.accountingPolicyV1Labels ? paymentPolicy : undefined,
        accountingPolicyV1Labels: policyFlags.accountingPolicyV1Labels,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to load quotation' });
    }
  });

  app.post('/api/quotations', requirePermission('quotations.manage'), (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'quotation.create')) return;
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) return apiError(res, { status: 403, code: 'FORBIDDEN', error: createGate.error });
      const duplicateWarnings = duplicateQuotationCreateSignals(db, {
        customerID: req.body?.customerID,
        totalNgn: req.body?.totalNgn,
        dateISO: req.body?.dateISO,
        branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
      });
      if (duplicateWarnings.length && !req.body?.forceDuplicateCreate) {
        return apiError(res, {
          status: 409,
          code: 'DUPLICATE_QUOTATION',
          error: 'A similar quotation may already exist. Review before saving again.',
          detail: duplicateWarnings,
        });
      }
      const id = write.insertQuotation(db, req.body || {}, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      syncQuotationStaffPurchaseFlag(db, id);
      ensureQuotationHandlerSalesCustomer(db, id);
      const quotation = getQuotation(db, id);
      const rawPv = db.prepare(`SELECT id, lines_json, branch_id, date_iso FROM quotations WHERE id = ?`).get(id);
      const pv = quotationPriceViolations(db, rawPv);
      const payload = {
        ok: true,
        quotationId: id,
        quotation: { ...quotation, pricingViolations: pv.violations, pricingHasFloorRows: pv.hasFloorRows },
      };
      storeIdempotentSuccess(db, req, 'quotation.create', 201, payload);
      res.status(201).json(payload);
    } catch (e) {
      console.error(e);
      if (e?.statusCode === 422 && e?.code) {
        return apiError(res, {
          status: 422,
          code: e.code,
          error: humanizeValidationMessage(String(e.message || '')),
          detail: e.details,
        });
      }
      apiError(res, {
        status: 400,
        code: 'QUOTATION_CREATE_FAILED',
        error: safeErrorMessage(e, 'Could not create quotation.'),
      });
    }
  });

  /**
   * Bulk-recalculate quotations.paid_ngn from sales_receipts + ADVANCE_APPLIED (current workspace branch).
   * Requires explicit { confirm: true } in JSON body.
   */
  app.post('/api/quotations/recalculate-paid-all', requirePermission('finance.approve'), (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          ok: false,
          error:
            'Send JSON body { "confirm": true } to recalculate booked paid for all quotations in this branch.',
        });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const ids = listQuotationIds(db, branchScope);
      const failures = [];
      let paidChangedCount = 0;
      const changedSample = [];
      for (const qid of ids) {
        try {
          const beforeRow = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(qid);
          const before = Math.round(Number(beforeRow?.paid_ngn) || 0);
          const r = write.syncQuotationPaidFromLedger(db, qid);
          if (!r.ok) {
            failures.push({ id: qid, error: r.error || 'Sync failed' });
            continue;
          }
          const after = Math.round(Number(r.paidNgn) || 0);
          if (before !== after) {
            paidChangedCount += 1;
            if (changedSample.length < 25) {
              changedSample.push({ id: qid, before, after });
            }
          }
        } catch (e) {
          failures.push({ id: qid, error: String(e.message || e) });
        }
      }
      appendAuditLog(db, {
        actor: req.user,
        action: 'quotation.bulk_sync_paid',
        entityKind: 'quotation',
        entityId: '*',
        note: `Recalculated booked paid for ${ids.length} quotations (${paidChangedCount} amounts changed).`,
        details: {
          branchScope,
          processed: ids.length,
          paidChangedCount,
          failureCount: failures.length,
        },
      });
      res.json({
        ok: true,
        branchScope,
        processed: ids.length,
        paidChangedCount,
        failures,
        changedSample,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.patch('/api/quotations/:id', requirePermission('quotations.manage'), (req, res) => {
    try {
      const qid = req.params.id;
      const qGate = assertQuotationIdInWorkspace(db, req, qid);
      if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
      if (!getQuotation(db, qid)) {
        return res.status(404).json({ ok: false, error: 'Quotation not found' });
      }
      return handlePatchWithEditApprovalQuotation(res, db, req.user, req.body, qid, (stripped) => {
        const { autoOverpayAppliedNgn } = write.updateQuotation(db, qid, stripped || {}, req.user);
        syncQuotationStaffPurchaseFlag(db, qid);
        ensureQuotationHandlerSalesCustomer(db, qid);
        const quotation = getQuotation(db, qid);
        const rawPv = db.prepare(`SELECT id, lines_json, branch_id, date_iso FROM quotations WHERE id = ?`).get(qid);
        const pv = quotationPriceViolations(db, rawPv);
        return {
          quotation: {
            ...quotation,
            pricingViolations: pv.violations,
            pricingHasFloorRows: pv.hasFloorRows,
          },
          autoOverpayAppliedNgn: autoOverpayAppliedNgn ?? 0,
        };
      });
    } catch (e) {
      console.error(e);
      if (e?.statusCode === 422 && e?.code) {
        return res.status(422).json({
          ok: false,
          error: String(e.message || ''),
          code: e.code,
          details: e.details,
        });
      }
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete('/api/quotations/:id', requirePermission('quotations.manage'), (req, res) => {
    try {
      const qGate = assertQuotationIdInWorkspace(db, req, req.params.id);
      if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
      const rk = String(req.user?.roleKey || '').toLowerCase();
      if (!['admin', 'md', 'sales_manager', 'branch_manager'].includes(rk)) {
        return res.status(403).json({
          ok: false,
          error: 'Only Admin, MD, or Branch Manager can delete quotations.',
        });
      }
      const r = write.deleteQuotationIfAllowed(db, req.params.id);
      if (r.ok) {
        appendAuditLog(db, {
          actor: req.user,
          action: 'quotation.delete',
          entityKind: 'quotation',
          entityId: String(req.params.id || ''),
          note: 'Quotation deleted with linked receipts and cutting lists from sales screen',
          details: {
            deletedReceipts: r.deletedReceipts ?? 0,
            deletedCuttingLists: r.deletedCuttingLists ?? 0,
            deletedLedgerEntries: r.deletedLedgerEntries ?? 0,
          },
        });
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/quotations/:id/revive', requirePermission('quotations.manage'), (req, res) => {
    try {
      const qid = req.params.id;
      const qGate = assertQuotationIdInWorkspace(db, req, qid);
      if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
      if (!getQuotation(db, qid)) {
        return res.status(404).json({ ok: false, error: 'Quotation not found' });
      }
      write.reviveQuotation(db, qid);
      const quotation = getQuotation(db, qid);
      res.json({ ok: true, quotation });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/quotations/:id/sync-paid-from-ledger',
    requirePermission([
      'quotations.manage',
      'refunds.request',
      'refunds.approve',
      'finance.post',
      'finance.approve',
    ]),
    (req, res) => {
      try {
        const qGate = assertQuotationIdInWorkspace(db, req, req.params.id);
        if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
        const r = write.syncQuotationPaidFromLedger(db, req.params.id);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.patch('/api/quotations/:id/refunds-blocked', requireAuth, (req, res) => {
    try {
      const qid = String(req.params.id ?? '').trim();
      const qg = assertQuotationIdInWorkspace(db, req, qid);
      if (!qg.ok) return res.status(qg.status).json({ ok: false, error: qg.error, code: 'FORBIDDEN' });
      const r = setQuotationRefundsBlocked(db, qid, req.body || {}, req.user);
      if (!r.ok && r.code === 'FORBIDDEN') {
        return res.status(403).json(r);
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Could not update refund block on quotation.' });
    }
  });

  app.post(
    '/api/quotations/:id/reconcile-receipt-mirrors',
    requirePermission([
      'quotations.manage',
      'finance.post',
      'finance.approve',
    ]),
    (req, res) => {
      try {
        const qGate = assertQuotationIdInWorkspace(db, req, req.params.id);
        if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
        const r = write.reconcileSalesReceiptMirrorsForQuotation(db, req.params.id);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/quotations/:id/recalculate-integrity',
    requirePermission(['finance.approve', 'refunds.approve', 'quotations.manage']),
    (req, res) => {
      try {
        const qid = String(req.params.id ?? '').trim();
        const qGate = assertQuotationIdInWorkspace(db, req, qid);
        if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
        const r = recalculateQuotationIntegrity(db, qid, {
          actor: req.user,
          excludeRefundId: String(req.body?.excludeRefundId || req.body?.refundId || '').trim() || null,
        });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Could not recalculate quotation integrity.' });
      }
    }
  );

  app.get('/api/advance-deposits', requirePermission(LEDGER_RELATED_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      res.json({ ok: true, advances: listAdvanceInEvents(db, branchScope) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to list advance deposits' });
    }
  });

  app.get('/api/ledger', requirePermission(LEDGER_RELATED_PERMS), (req, res) => {
    try {
      const customerId = req.query.customerId;
      const branchScope = resolveBootstrapBranchScope(req);
      const { limit, offset, unlimited } = parseListQuery(req, { defaultLimit: 500, maxLimit: 5000 });
      if (customerId) {
        const cid = String(customerId);
        const total = countLedgerEntriesForCustomer(db, cid, branchScope);
        const entries = listLedgerEntriesForCustomer(
          db,
          cid,
          branchScope,
          unlimited ? { unlimited: true } : { limit, offset }
        );
        return sendPaginatedList(res, {
          items: entries,
          total,
          limit: unlimited ? 0 : limit,
          offset,
          key: 'entries',
        });
      }
      const total = countLedgerEntries(db, branchScope);
      const entries = listLedgerEntries(
        db,
        branchScope,
        unlimited ? { unlimited: true } : { limit, offset }
      );
      return sendPaginatedList(res, {
        items: entries,
        total,
        limit: unlimited ? 0 : limit,
        offset,
        key: 'entries',
      });
    } catch (e) {
      console.error(e);
      apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load ledger.' });
    }
  });

  app.get('/api/refunds', requirePermission(REFUNDS_VISIBLE_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const { limit, offset, unlimited } = parseListQuery(req);
      const all = listRefunds(db, branchScope, unlimited ? { unlimited: true } : { limit: 0, useDefaultLimit: false });
      const items = slicePage(all, offset, limit);
      return sendPaginatedList(res, {
        items,
        total: all.length,
        limit: unlimited ? 0 : limit,
        offset,
        key: 'refunds',
      });
    } catch (e) {
      console.error(e);
      apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load refunds.' });
    }
  });

  app.post(
    '/api/ledger/advance',
    requirePermission('receipts.post'),
    ledgerPostRateLimit(),
    (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'ledger.advance')) return;
      const { customerID, customerName, amountNgn, paymentMethod, bankReference, purpose, dateISO } =
        req.body || {};
      if (!customerID) return res.status(400).json({ ok: false, error: 'customerID is required' });
      const branchScope = resolveBootstrapBranchScope(req);
      const cust = getCustomer(db, customerID, branchScope);
      if (!cust) return res.status(404).json({ ok: false, error: 'Customer not found' });
      const postingBr = assertCustomerLedgerPostingBranch(cust, req);
      if (!postingBr.ok) return res.status(400).json({ ok: false, error: postingBr.error });

      const treasuryLinesEarly = normalizeTreasuryLines(req.body || {});
      const advancePostDays = new Set(
        [
          String(dateISO || '').trim().slice(0, 10),
          ...treasuryLinesEarly.map((line) => String(line.dateISO || '').trim().slice(0, 10)),
        ].filter(Boolean)
      );
      try {
        for (const day of advancePostDays) {
          assertPeriodOpen(db, day, 'Advance date');
        }
      } catch (pe) {
        return res.status(400).json({
          ok: false,
          error: String(pe?.message || pe),
          code: 'PERIOD_LOCKED',
        });
      }

      const {
        forceDuplicatePost,
        duplicateOverrideReason,
      } = req.body || {};
      const duplicateSignals = recentAdvanceDuplicateSignals(db, {
        customerID,
        amountNgn,
        bankReference,
        dateISO,
      });
      if (duplicateSignals.length > 0 && !forceDuplicatePost) {
        return res.status(409).json({
          ok: false,
          error: 'Possible duplicate advance detected.',
          code: 'POSSIBLE_DUPLICATE_ADVANCE',
          duplicateSignals,
        });
      }
      if (duplicateSignals.length > 0 && forceDuplicatePost && !String(duplicateOverrideReason || '').trim()) {
        return res.status(400).json({
          ok: false,
          error: 'Duplicate override reason is required when forcing a duplicate-like advance.',
          code: 'DUPLICATE_OVERRIDE_REASON_REQUIRED',
        });
      }

      const plan = planAdvanceIn({
        customerID,
        customerName: customerName || cust.name,
        amountNgn,
        paymentMethod,
        bankReference,
        purpose,
        dateISO,
      });
      if (!plan.ok) return res.status(400).json(plan);

      const postAmountNgn = Math.round(Number(amountNgn) || 0);
      const treasuryLines = normalizeTreasuryLines(req.body || {});
      const bankDepositId = String(req.body?.bankDepositId ?? req.body?.bank_deposit_id ?? '').trim();
      let depositCoverNgn = 0;
      if (bankDepositId) {
        const dep = getBankDepositById(db, bankDepositId);
        if (!dep) {
          return res.status(404).json({ ok: false, error: 'Linked bank deposit not found.', code: 'BANK_DEPOSIT_NOT_FOUND' });
        }
        if (String(dep.branchId || '') !== String(req.workspaceBranchId || DEFAULT_BRANCH_ID).trim()) {
          return res.status(400).json({ ok: false, error: 'Bank deposit belongs to a different branch.' });
        }
        depositCoverNgn = Math.min(postAmountNgn, Math.round(Number(dep.remainingNgn) || 0));
        if (depositCoverNgn <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'This bank deposit has no remaining balance to link.',
            code: 'BANK_DEPOSIT_EXHAUSTED',
          });
        }
      }
      const treasuryCashRequired = postAmountNgn - depositCoverNgn;
      if (treasuryCashRequired > 0) {
        if (treasuryLines.length === 0) {
          return res.status(400).json({
            ok: false,
            error: `Enter treasury payment lines for the remaining ₦${treasuryCashRequired.toLocaleString('en-NG')} not covered by the linked bank deposit.`,
            code: 'TREASURY_REMAINDER_REQUIRED',
          });
        }
        if (totalTreasuryLines(treasuryLines) !== treasuryCashRequired) {
          return res.status(400).json({
            ok: false,
            error: `Treasury lines must equal ₦${treasuryCashRequired.toLocaleString('en-NG')} (advance total minus linked deposit).`,
          });
        }
      } else if (treasuryLines.length > 0 && totalTreasuryLines(treasuryLines) !== 0) {
        return res.status(400).json({
          ok: false,
          error: 'When the full advance is covered by a linked bank deposit, omit treasury payment lines.',
        });
      } else if (!bankDepositId && treasuryLines.length > 0 && totalTreasuryLines(treasuryLines) !== postAmountNgn) {
        return res.status(400).json({ ok: false, error: 'Treasury lines must equal the advance amount.' });
      }

      const { saved, bankDepositAllocation } = db.transaction(() => {
        const wb = req.workspaceBranchId || DEFAULT_BRANCH_ID;
        const saved = insertLedgerRows(
          db,
          plan.rows.map((row) => ({
            ...row,
            createdByUserId: req.user.id,
            createdByName: req.user.displayName,
          })),
          wb
        );
        for (const row of saved) {
          write.insertAdvanceInEvent(db, row);
        }
        const [created] = saved;
        let bankDepositAllocation = null;
        if (created?.id && bankDepositId && depositCoverNgn > 0) {
          const alloc = allocateBankDepositTx(db, {
            depositId: bankDepositId,
            ledgerEntryId: created.id,
            kind: BANK_DEPOSIT_ALLOC_KIND_ADVANCE,
            amountNgn: depositCoverNgn,
            actor: req.user,
            branchId: wb,
          });
          if (!alloc.ok) throw new Error(alloc.error || 'Could not link bank deposit.');
          bankDepositAllocation = alloc;
        }
        if (created && treasuryLines.length > 0) {
          write.recordCustomerAdvanceCash(db, {
            sourceId: created.id,
            customerID,
            customerName: customerName || cust.name,
            dateISO,
            reference: bankReference,
            note: purpose,
            paymentLines: treasuryLines,
            createdBy: req.user.displayName,
            workspaceBranchId: req.workspaceBranchId,
            workspaceViewAll: Boolean(req.workspaceViewAll),
            actor: req.user,
          });
        }
        if (created && (treasuryLines.length > 0 || bankDepositId)) {
          const glA = tryPostCustomerAdvanceGl(db, {
            ledgerEntryId: created.id,
            amountNgn: created.amountNgn,
            entryDateISO: dateISO,
            branchId: wb,
            createdByUserId: req.user.id,
          });
          if (!glA.ok && !glA.skipped && !glA.duplicate) {
            throw new Error(glA.error || 'Could not post advance to general ledger.');
          }
        }
        appendAuditLog(db, {
          actor: req.user,
          action: 'ledger.advance',
          entityKind: 'ledger_entry',
          entityId: created?.id ?? '',
          note: purpose || 'Customer advance posted',
          details: { customerID, amountNgn: Math.round(Number(amountNgn) || 0) },
        });
        return { saved, bankDepositAllocation };
      })();
      const [entry] = saved;
      const similarUnlinkedDeposits =
        !bankDepositId && postAmountNgn > 0
          ? findSimilarOpenBankDeposits(db, {
              branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
              amountNgn: postAmountNgn,
              bankDateISO: dateISO,
              bankReference,
            })
          : [];
      const payload = { ok: true, entry, bankDepositAllocation: bankDepositAllocation ?? null, similarUnlinkedDeposits };
      storeIdempotentSuccess(db, req, 'ledger.advance', 201, payload);
      res.status(201).json(payload);
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || e);
      if (/falls in locked period|locked period/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'PERIOD_LOCKED' });
      }
      if (/flagged|refund request|cleared by manager/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'LEDGER_POST_BLOCKED' });
      }
      res.status(500).json({ ok: false, error: 'Failed to record advance' });
    }
  }
  );

  app.post(
    '/api/ledger/apply-advance',
    requirePermission('receipts.post'),
    ledgerPostRateLimit(),
    (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'ledger.apply_advance')) return;
      const { customerID, customerName, quotationRef, amountNgn, dateISO } = req.body || {};
      if (!customerID || !quotationRef) {
        return res.status(400).json({ ok: false, error: 'customerID and quotationRef are required' });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const cust = getCustomer(db, customerID, branchScope);
      if (!cust) return res.status(404).json({ ok: false, error: 'Customer not found' });
      const postingBr = assertCustomerLedgerPostingBranch(cust, req);
      if (!postingBr.ok) return res.status(400).json({ ok: false, error: postingBr.error });
      const qt = getQuotation(db, quotationRef);
      if (!qt) return res.status(404).json({ ok: false, error: 'Quotation not found' });
      const qGate = assertQuotationIdInWorkspace(db, req, quotationRef);
      if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
      if (qt.customerID !== customerID) {
        return res.status(400).json({ ok: false, error: 'Quotation does not belong to this customer' });
      }

      try {
        assertPeriodOpen(db, dateISO || new Date().toISOString().slice(0, 10), 'Advance application date');
      } catch (pe) {
        return res.status(400).json({
          ok: false,
          error: String(pe?.message || pe),
          code: 'PERIOD_LOCKED',
        });
      }

      const entries = listLedgerEntries(db, branchScope);
      const plan = planAdvanceApplied(entries, {
        customerID,
        customerName: customerName || cust.name,
        quotationRef,
        amountNgn,
      });
      if (!plan.ok) return res.status(400).json(plan);

      const [entry] = db.transaction(() => {
        const saved = insertLedgerRows(
          db,
          plan.rows.map((row) => ({
            ...row,
            createdByUserId: req.user.id,
            createdByName: req.user.displayName,
          })),
          req.workspaceBranchId || DEFAULT_BRANCH_ID
        );
        write.syncQuotationPaidFromLedger(db, quotationRef);
        appendAuditLog(db, {
          actor: req.user,
          action: 'ledger.apply_advance',
          entityKind: 'ledger_entry',
          entityId: saved[0]?.id ?? '',
          note: `Advance applied to ${quotationRef}`,
          details: { customerID, quotationRef, amountNgn: Math.round(Number(amountNgn) || 0) },
        });
        return saved;
      })();
      const payload = { ok: true, entry };
      storeIdempotentSuccess(db, req, 'ledger.apply_advance', 201, payload);
      res.status(201).json(payload);
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || e);
      if (/falls in locked period|locked period/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'PERIOD_LOCKED' });
      }
      if (/flagged|refund request|cleared by manager/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'LEDGER_POST_BLOCKED' });
      }
      res.status(500).json({
        ok: false,
        error: msg || 'Failed to apply advance',
        code: 'LEDGER_APPLY_ADVANCE_FAILED',
      });
    }
  }
  );

  app.get(
    '/api/ledger/refund-credit-eligible',
    requirePermission('receipts.post'),
    (req, res) => {
      try {
        const customerID = String(req.query.customerID || '').trim();
        const targetQuotationRef = String(
          req.query.targetQuotationRef || req.query.quotationRef || ''
        ).trim();
        if (!customerID || !targetQuotationRef) {
          return res.status(400).json({
            ok: false,
            error: 'customerID and targetQuotationRef are required',
          });
        }
        const branchScope = resolveBootstrapBranchScope(req);
        const cust = getCustomer(db, customerID, branchScope);
        if (!cust) return res.status(404).json({ ok: false, error: 'Customer not found' });
        const qGate = assertQuotationIdInWorkspace(db, req, targetQuotationRef);
        if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
        const listed = refundCreditApplyOps.listEligibleRefundCredits(db, customerID, targetQuotationRef, {
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        });
        if (!listed.ok) return res.status(400).json(listed);
        res.json(listed);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to load refund fund' });
      }
    }
  );

  app.post(
    '/api/ledger/apply-refund-credit',
    requirePermission('receipts.post'),
    ledgerPostRateLimit(),
    (req, res) => {
      try {
        if (sendIdempotentReplayIfAny(db, req, res, 'ledger.apply_refund_credit')) return;
        const {
          customerID,
          targetQuotationRef,
          quotationRef,
          amountNgn,
          sourceIds,
          dateISO,
        } = req.body || {};
        const target = String(targetQuotationRef || quotationRef || '').trim();
        const cid = String(customerID || '').trim();
        if (!cid || !target) {
          return res.status(400).json({
            ok: false,
            error: 'customerID and targetQuotationRef are required',
          });
        }
        const branchScope = resolveBootstrapBranchScope(req);
        const cust = getCustomer(db, cid, branchScope);
        if (!cust) return res.status(404).json({ ok: false, error: 'Customer not found' });
        const postingBr = assertCustomerLedgerPostingBranch(cust, req);
        if (!postingBr.ok) return res.status(400).json({ ok: false, error: postingBr.error });
        const qGate = assertQuotationIdInWorkspace(db, req, target);
        if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
        const qt = getQuotation(db, target);
        if (!qt) return res.status(404).json({ ok: false, error: 'Quotation not found' });
        if (qt.customerID !== cid) {
          return res.status(400).json({ ok: false, error: 'Quotation does not belong to this customer' });
        }

        const applied = refundCreditApplyOps.applyRefundCreditToQuotation(db, {
          customerID: cid,
          targetQuotationRef: target,
          amountNgn,
          sourceIds,
          dateISO,
          actor: req.user,
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        });
        if (!applied.ok) {
          const status = applied.code === 'PERIOD_LOCKED' ? 400 : 400;
          return res.status(status).json(applied);
        }
        const payload = { ok: true, ...applied };
        storeIdempotentSuccess(db, req, 'ledger.apply_refund_credit', 201, payload);
        res.status(201).json(payload);
      } catch (e) {
        console.error(e);
        const msg = String(e?.message || e);
        if (/falls in locked period|locked period/i.test(msg)) {
          return res.status(400).json({ ok: false, error: msg, code: 'PERIOD_LOCKED' });
        }
        if (/flagged|refund request|cleared by manager/i.test(msg)) {
          return res.status(400).json({ ok: false, error: msg, code: 'LEDGER_POST_BLOCKED' });
        }
        res.status(500).json({
          ok: false,
          error: msg || 'Failed to apply refund credit',
          code: 'LEDGER_APPLY_REFUND_CREDIT_FAILED',
        });
      }
    }
  );

  app.post(
    '/api/ledger/reverse-refund-credit',
    requirePermission('finance.reverse'),
    ledgerPostRateLimit(),
    (req, res) => {
      try {
        if (sendIdempotentReplayIfAny(db, req, res, 'ledger.reverse_refund_credit')) return;
        const applicationId = String(req.body?.applicationId || req.body?.application_id || '').trim();
        if (!applicationId) {
          return res.status(400).json({ ok: false, error: 'applicationId is required' });
        }
        const reversed = refundCreditApplyOps.reverseRefundCreditApplication(db, applicationId, {
          actor: req.user,
          note: String(req.body?.note || '').trim(),
          dateISO: req.body?.dateISO,
        });
        if (!reversed.ok) {
          const status = reversed.code === 'PERIOD_LOCKED' ? 400 : 400;
          return res.status(status).json(reversed);
        }
        const payload = { ok: true, ...reversed };
        storeIdempotentSuccess(db, req, 'ledger.reverse_refund_credit', 200, payload);
        res.json(payload);
      } catch (e) {
        console.error(e);
        const msg = String(e?.message || e);
        if (/falls in locked period|locked period/i.test(msg)) {
          return res.status(400).json({ ok: false, error: msg, code: 'PERIOD_LOCKED' });
        }
        res.status(500).json({ ok: false, error: msg || 'Failed to reverse refund fund apply' });
      }
    }
  );

  app.get(
    '/api/ledger/refund-credit-applications',
    requirePermission('receipts.post'),
    (req, res) => {
      try {
        const customerID = String(req.query.customerID || '').trim();
        const targetQuotationRef = String(req.query.targetQuotationRef || req.query.quotationRef || '').trim();
        const branchScope = resolveBootstrapBranchScope(req);
        const rows = refundCreditApplyOps.listRefundCreditApplications(
          db,
          customerID,
          branchScope === 'ALL' ? 'ALL' : branchScope,
          { targetQuotationRef }
        );
        res.json({ ok: true, applications: rows });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Failed to list refund fund applications' });
      }
    }
  );

  app.post(
    '/api/ledger/receipt',
    requirePermission('receipts.post'),
    ledgerPostRateLimit(),
    (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'ledger.receipt')) return;
      const {
        customerID,
        customerName,
        quotationId,
        amountNgn,
        paymentMethod,
        dateISO,
        forceDuplicatePost,
        duplicateOverrideReason,
      } = req.body || {};
      const fullAmountAsReceipt = true;
      const resolvedBankReference = effectiveReceiptBankReference(req.body || {});
      if (!customerID || !quotationId) {
        return res.status(400).json({ ok: false, error: 'customerID and quotationId are required' });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const cust = getCustomer(db, customerID, branchScope);
      if (!cust) return res.status(404).json({ ok: false, error: 'Customer not found' });
      const postingBr = assertCustomerLedgerPostingBranch(cust, req);
      if (!postingBr.ok) return res.status(400).json({ ok: false, error: postingBr.error });
      const qt = getQuotation(db, quotationId);
      if (!qt) return res.status(404).json({ ok: false, error: 'Quotation not found' });
      const qGate = assertQuotationIdInWorkspace(db, req, quotationId);
      if (!qGate.ok) return res.status(qGate.status).json({ ok: false, error: qGate.error });
      if (qt.customerID !== customerID) {
        return res.status(400).json({ ok: false, error: 'Quotation does not belong to this customer' });
      }
      if (!resolvedBankReference) {
        return res.status(400).json({
          ok: false,
          error: 'Reference / remarks is required for receipt posting (voucher reference or each payment line reference).',
          code: 'MISSING_REFERENCE',
        });
      }
      const duplicateSignals = recentReceiptDuplicateSignals(db, {
        customerID,
        quotationId,
        amountNgn,
        bankReference: resolvedBankReference,
        dateISO,
      });
      if (duplicateSignals.length > 0 && !forceDuplicatePost) {
        return res.status(409).json({
          ok: false,
          error: 'Possible duplicate receipt detected.',
          code: 'POSSIBLE_DUPLICATE_RECEIPT',
          duplicateSignals,
        });
      }
      if (duplicateSignals.length > 0 && forceDuplicatePost && !String(duplicateOverrideReason || '').trim()) {
        return res.status(400).json({
          ok: false,
          error: 'Duplicate override reason is required when forcing a duplicate-like post.',
          code: 'DUPLICATE_OVERRIDE_REASON_REQUIRED',
        });
      }

      const treasuryLinesEarly = normalizeTreasuryLines(req.body || {});
      const receiptPostDays = new Set(
        [
          String(dateISO || '').trim().slice(0, 10),
          ...treasuryLinesEarly.map((line) => String(line.dateISO || '').trim().slice(0, 10)),
        ].filter(Boolean)
      );
      try {
        for (const day of receiptPostDays) {
          assertPeriodOpen(db, day, 'Receipt date');
        }
      } catch (pe) {
        return res.status(400).json({
          ok: false,
          error: String(pe?.message || pe),
          code: 'PERIOD_LOCKED',
        });
      }

      // Recompute quotations.paid_ngn from sales_receipts + ADVANCE_APPLIED before planning
      // RECEIPT vs OVERPAY_ADVANCE split. Otherwise a stale paid_ngn (manual patch, import drift,
      // or missed sync) shrinks "balance due" and posts a smaller RECEIPT leg than operators expect.
      write.syncQuotationPaidFromLedger(db, quotationId);
      const qtSynced = getQuotation(db, quotationId);
      if (!qtSynced) return res.status(404).json({ ok: false, error: 'Quotation not found' });
      if (qtSynced.customerID !== customerID) {
        return res.status(400).json({ ok: false, error: 'Quotation does not belong to this customer' });
      }

      const postAmountNgn = Math.round(Number(amountNgn) || 0);

      const entries = listLedgerEntries(db, branchScope);
      const plan = planReceiptWithQuotation(entries, {
        customerID,
        customerName: customerName || cust.name,
        quotationRow: qtSynced,
        amountNgn,
        paymentMethod,
        bankReference: resolvedBankReference,
        dateISO,
        fullAmountAsReceipt,
      });
      if (!plan.ok) return res.status(400).json(plan);

      const treasuryLines = normalizeTreasuryLines(req.body || {});
      const bankDepositId = String(req.body?.bankDepositId ?? req.body?.bank_deposit_id ?? '').trim();
      let depositCoverNgn = 0;
      if (bankDepositId) {
        const dep = getBankDepositById(db, bankDepositId);
        if (!dep) {
          return res.status(404).json({ ok: false, error: 'Linked bank deposit not found.', code: 'BANK_DEPOSIT_NOT_FOUND' });
        }
        if (String(dep.branchId || '') !== String(req.workspaceBranchId || DEFAULT_BRANCH_ID).trim()) {
          return res.status(400).json({ ok: false, error: 'Bank deposit belongs to a different branch.' });
        }
        depositCoverNgn = Math.min(postAmountNgn, Math.round(Number(dep.remainingNgn) || 0));
        if (depositCoverNgn <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'This bank deposit has no remaining balance to link.',
            code: 'BANK_DEPOSIT_EXHAUSTED',
          });
        }
      }
      const treasuryCashRequired = postAmountNgn - depositCoverNgn;
      if (treasuryCashRequired > 0) {
        if (treasuryLines.length === 0) {
          return res.status(400).json({
            ok: false,
            error: `Enter treasury payment lines for the remaining ₦${treasuryCashRequired.toLocaleString('en-NG')} not covered by the linked bank deposit.`,
            code: 'TREASURY_REMAINDER_REQUIRED',
          });
        }
        if (totalTreasuryLines(treasuryLines) !== treasuryCashRequired) {
          return res.status(400).json({
            ok: false,
            error: `Treasury lines must equal ₦${treasuryCashRequired.toLocaleString('en-NG')} (receipt total minus linked deposit).`,
          });
        }
      } else if (treasuryLines.length > 0 && totalTreasuryLines(treasuryLines) !== 0) {
        return res.status(400).json({
          ok: false,
          error: 'When the full receipt is covered by a linked bank deposit, omit treasury payment lines.',
        });
      } else if (!bankDepositId && treasuryLines.length > 0 && totalTreasuryLines(treasuryLines) !== Math.round(Number(amountNgn) || 0)) {
        return res.status(400).json({ ok: false, error: 'Treasury lines must equal the receipt amount.' });
      } else if (!bankDepositId && treasuryLines.length === 0 && postAmountNgn > 0) {
        return res.status(400).json({ ok: false, error: 'Treasury payment lines are required for this receipt.' });
      }

      const amendSalesReceiptId = String(
        req.body?.amendSalesReceiptId ?? req.body?.amend_sales_receipt_id ?? ''
      ).trim();
      if (amendSalesReceiptId) {
        return res.status(400).json({
          ok: false,
          code: 'RECEIPT_AMEND_NOT_ALLOWED',
          error:
            'Receipts cannot be corrected by re-posting. Ask Finance to reverse the mistaken receipt on Finance & accounts, then post a new receipt with the correct amount.',
        });
      }

      const confirmAmountNgn = Math.round(Number(req.body?.confirmAmountNgn ?? req.body?.confirm_amount_ngn) || 0);
      if (
        postAmountNgn >= 100_000 &&
        (!Number.isFinite(confirmAmountNgn) || confirmAmountNgn !== postAmountNgn)
      ) {
        return res.status(400).json({
          ok: false,
          code: 'RECEIPT_AMOUNT_CONFIRM_REQUIRED',
          error: `For amounts of ₦${postAmountNgn.toLocaleString('en-NG')} and above, re-enter the same amount in "Confirm amount" before posting.`,
        });
      }

      const { saved, receipt, overpay, bankDepositAllocation } = db.transaction(() => {
        const wb = req.workspaceBranchId || DEFAULT_BRANCH_ID;
        const posted = insertLedgerRows(
          db,
          plan.rows.map((row) => ({
            ...row,
            createdByUserId: req.user.id,
            createdByName: req.user.displayName,
          })),
          wb
        );
        for (const row of posted) {
          if (row.type === 'RECEIPT') {
            write.upsertSalesReceiptForLedgerEntry(db, row, qtSynced, wb);
          }
        }
        const parsed = receiptResultFromSavedRows(posted);
        let bankDepositAllocation = null;
        if (parsed.receipt?.id && bankDepositId && depositCoverNgn > 0) {
          const alloc = allocateBankDepositTx(db, {
            depositId: bankDepositId,
            ledgerEntryId: parsed.receipt.id,
            kind: BANK_DEPOSIT_ALLOC_KIND_RECEIPT,
            amountNgn: depositCoverNgn,
            actor: req.user,
            branchId: wb,
          });
          if (!alloc.ok) throw new Error(alloc.error || 'Could not link bank deposit.');
          bankDepositAllocation = alloc;
        }
        if ((parsed.receipt || parsed.overpay) && treasuryLines.length > 0) {
          write.recordCustomerReceiptCash(db, {
            sourceId: parsed.receipt?.id || parsed.overpay?.id,
            customerID,
            customerName: customerName || cust.name,
            dateISO,
            reference: resolvedBankReference,
            note: parsed.overpay ? `Receipt ${qtSynced.id} with overpayment credit (not deposit advance)` : `Receipt ${qtSynced.id}`,
            paymentLines: treasuryLines,
            createdBy: req.user.displayName,
            workspaceBranchId: req.workspaceBranchId,
            workspaceViewAll: Boolean(req.workspaceViewAll),
            actor: req.user,
          });
        }
        if (parsed.receipt?.id && (treasuryLines.length > 0 || bankDepositId)) {
          const glR = tryPostCustomerReceiptGl(db, {
            ledgerEntryId: parsed.receipt.id,
            amountNgn: parsed.receipt.amountNgn,
            entryDateISO: dateISO,
            branchId: wb,
            createdByUserId: req.user.id,
            quotationRef: quotationId,
            customerId: customerID,
            receiptAtISO: dateISO,
          });
          if (!glR.ok && !glR.skipped && !glR.duplicate) {
            throw new Error(glR.error || 'Could not post receipt to general ledger.');
          }
        }
        appendAuditLog(db, {
          actor: req.user,
          action: 'ledger.receipt',
          entityKind: 'quotation',
          entityId: quotationId,
          note: `Receipt posted against ${quotationId}`,
          details: {
            receiptEntryId: parsed.receipt?.id ?? '',
            overpayEntryId: parsed.overpay?.id ?? '',
            amountNgn: Math.round(Number(amountNgn) || 0),
            fullAmountAsReceipt,
            duplicateOverride:
              duplicateSignals.length > 0
                ? {
                    forced: Boolean(forceDuplicatePost),
                    reason: String(duplicateOverrideReason || '').trim(),
                    signals: duplicateSignals,
                  }
                : null,
          },
        });
        write.syncQuotationPaidFromLedger(db, quotationId);
        return { saved: posted, receipt: parsed.receipt, overpay: parsed.overpay, bankDepositAllocation };
      })();
      const similarUnlinkedDeposits =
        !bankDepositId && postAmountNgn > 0
          ? findSimilarOpenBankDeposits(db, {
              branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
              amountNgn: postAmountNgn,
              bankDateISO: dateISO,
              bankReference: resolvedBankReference,
            })
          : [];
      const payload = {
        ok: true,
        receipt,
        overpay,
        entries: saved,
        bankDepositAllocation: bankDepositAllocation ?? null,
        similarUnlinkedDeposits,
      };
      storeIdempotentSuccess(db, req, 'ledger.receipt', 201, payload);
      res.status(201).json(payload);
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || e);
      if (/falls in locked period|locked period/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'PERIOD_LOCKED' });
      }
      if (/flagged|refund request|cleared by manager/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'LEDGER_POST_BLOCKED' });
      }
      res.status(500).json({
        ok: false,
        error: msg || 'Failed to record receipt',
        code: 'LEDGER_RECEIPT_FAILED',
      });
    }
  }
  );

  app.delete('/api/receipts/:id', requirePermission('receipts.post'), (req, res) => {
    try {
      const rk = String(req.user?.roleKey || '').toLowerCase();
      if (!['admin', 'md', 'sales_manager', 'branch_manager'].includes(rk)) {
        return res.status(403).json({
          ok: false,
          error: 'Only Admin, MD, or Branch Manager can delete payments.',
        });
      }
      const rg = assertSalesReceiptIdInWorkspace(db, req, req.params.id);
      if (!rg.ok) return res.status(rg.status).json({ ok: false, error: rg.error });
      const r = write.deleteSalesReceiptIfAllowed(db, req.params.id);
      if (r.ok) {
        appendAuditLog(db, {
          actor: req.user,
          action: 'receipt.delete',
          entityKind: 'sales_receipt',
          entityId: String(r.receiptId || req.params.id || ''),
          note: 'Payment deleted with linked cutting lists from sales screen',
          details: {
            ledgerEntryId: r.ledgerEntryId || null,
            deletedCuttingLists: r.deletedCuttingLists ?? 0,
          },
        });
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete(
    '/api/cutting-lists/:id',
    requirePermission(['sales.manage', 'operations.manage', 'quotations.manage']),
    (req, res) => {
      try {
        const rk = String(req.user?.roleKey || '').toLowerCase();
        if (!['admin', 'md', 'sales_manager', 'branch_manager'].includes(rk)) {
          return res.status(403).json({
            ok: false,
            error: 'Only Admin, MD, or Branch Manager can delete cutting lists.',
          });
        }
        const clg = assertCuttingListIdInWorkspace(db, req, req.params.id);
        if (!clg.ok) return res.status(clg.status).json({ ok: false, error: clg.error });
        const r = write.deleteCuttingListIfAllowed(db, req.params.id);
        if (r.ok) {
          appendAuditLog(db, {
            actor: req.user,
            action: 'cutting_list.delete',
            entityKind: 'cutting_list',
            entityId: String(r.cuttingListId || req.params.id || ''),
            note: 'Cutting list deleted from sales screen',
          });
        }
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/ledger/refund-advance',
    requirePermission('finance.pay'),
    ledgerPostRateLimit(),
    (req, res) => {
    try {
      if (sendIdempotentReplayIfAny(db, req, res, 'ledger.refund_advance')) return;
      const { customerID, customerName, amountNgn, note, dateISO } = req.body || {};
      if (!customerID) return res.status(400).json({ ok: false, error: 'customerID is required' });
      const branchScope = resolveBootstrapBranchScope(req);
      const cust = getCustomer(db, customerID, branchScope);
      if (!cust) return res.status(404).json({ ok: false, error: 'Customer not found' });
      const postingBr = assertCustomerLedgerPostingBranch(cust, req);
      if (!postingBr.ok) return res.status(400).json({ ok: false, error: postingBr.error });

      try {
        assertPeriodOpen(db, dateISO || new Date().toISOString().slice(0, 10), 'Refund date');
      } catch (pe) {
        return res.status(400).json({
          ok: false,
          error: String(pe?.message || pe),
          code: 'PERIOD_LOCKED',
        });
      }

      const entries = listLedgerEntries(db, branchScope);
      const plan = planRefundAdvance(entries, {
        customerID,
        customerName: customerName || cust.name,
        amountNgn,
        note,
      });
      if (!plan.ok) return res.status(400).json(plan);

      const treasuryLines = normalizeTreasuryLines(req.body || {});
      if (treasuryLines.length > 0 && totalTreasuryLines(treasuryLines) !== Math.round(Number(amountNgn) || 0)) {
        return res.status(400).json({ ok: false, error: 'Treasury lines must equal the refund amount.' });
      }

      const [entry] = db.transaction(() => {
        const wb = req.workspaceBranchId || DEFAULT_BRANCH_ID;
        const saved = insertLedgerRows(
          db,
          plan.rows.map((row) => ({
            ...row,
            createdByUserId: req.user.id,
            createdByName: req.user.displayName,
          })),
          wb
        );
        const [created] = saved;
        if (created && treasuryLines.length > 0) {
          write.recordCustomerAdvanceRefundCash(db, {
            sourceId: created.id,
            customerID,
            customerName: customerName || cust.name,
            dateISO,
            reference: note,
            note,
            paymentLines: treasuryLines,
            createdBy: req.user.displayName,
            workspaceBranchId: req.workspaceBranchId,
            workspaceViewAll: Boolean(req.workspaceViewAll),
            actor: req.user,
          });
        }
        appendAuditLog(db, {
          actor: req.user,
          action: 'ledger.refund_advance',
          entityKind: 'ledger_entry',
          entityId: created?.id ?? '',
          note: note || 'Advance refund posted',
          details: { customerID, amountNgn: Math.round(Number(amountNgn) || 0) },
        });
        return saved;
      })();
      const payload = { ok: true, entry };
      storeIdempotentSuccess(db, req, 'ledger.refund_advance', 201, payload);
      res.status(201).json(payload);
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || e);
      if (/falls in locked period|locked period/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'PERIOD_LOCKED' });
      }
      if (/flagged|refund request|cleared by manager/i.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, code: 'LEDGER_POST_BLOCKED' });
      }
      res.status(500).json({ ok: false, error: 'Failed to record refund' });
    }
  }
  );

  app.post(
    '/api/ledger/reverse-receipt',
    requirePermission(['finance.reverse', 'finance.pay']),
    (req, res) => {
    try {
      const { entryId, note } = req.body || {};
      if (!entryId) return res.status(400).json({ ok: false, error: 'entryId is required' });
      const r = write.reverseReceiptEntry(db, String(entryId), String(note ?? '').trim(), req.user);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to reverse receipt' });
    }
  });

  /**
   * Finance: fix RECEIPT vs OVERPAY_ADVANCE split for one till posting (total cash unchanged).
   * Example: move receipt from ₦2,662,800 to ₦3,336,000 and overpay from ₦2,337,200 to ₦1,664,000 on a ₦5M bundle.
   */
  app.post(
    '/api/ledger/correct-receipt-split',
    requirePermission(['finance.reverse', 'finance.approve']),
    (req, res) => {
      try {
        if (req.body?.confirm !== true) {
          return res.status(400).json({
            ok: false,
            error:
              'Send JSON { "confirm": true, "receiptLedgerId": "LE-…", "newReceiptAmountNgn": 3336000 } (optional overpayLedgerId if multiple siblings).',
          });
        }
        const { receiptLedgerId, newReceiptAmountNgn, overpayLedgerId } = req.body || {};
        const r = write.correctReceiptOverpaySplit(db, {
          receiptLedgerId: String(receiptLedgerId || '').trim(),
          overpayLedgerId: overpayLedgerId != null ? String(overpayLedgerId).trim() : null,
          newReceiptAmountNgn: Math.round(Number(newReceiptAmountNgn) || 0),
          actor: req.user,
        });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    }
  );

  app.post('/api/ledger/reverse-advance', requirePermission('receipts.post'), (req, res) => {
    try {
      const rk = String(req.user?.roleKey || '').toLowerCase();
      const salesPrivileged = ['admin', 'md', 'sales_manager', 'branch_manager'].includes(rk);
      if (!userHasPermission(req.user, 'finance.reverse') && !salesPrivileged) {
        return res.status(403).json({
          ok: false,
          error: 'Only finance staff or Admin / MD / Branch Manager can reverse advance deposits.',
        });
      }
      const { entryId, note } = req.body || {};
      if (!entryId) return res.status(400).json({ ok: false, error: 'entryId is required' });
      const r = write.reverseAdvanceEntry(db, String(entryId), String(note ?? '').trim(), req.user);
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to reverse advance' });
    }
  });

  app.post('/api/finance/collections-follow-up', requirePermission('finance.post'), (req, res) => {
    try {
      const customerId = String(req.body?.customerId || '').trim();
      const customerName = String(req.body?.customerName || '').trim();
      const note = String(req.body?.note || '').trim();
      if (!customerId) return res.status(400).json({ ok: false, error: 'customerId is required.' });
      const branchId = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      const r = createCollectionsFollowUpWorkItem(db, { actor: req.user, branchId, customerId, customerName, note });
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/settings/integration-api-keys', requirePermission('settings.manage'), (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, name, secret_suffix AS secretSuffix, created_at_iso AS createdAtISO,
                  last_used_at_iso AS lastUsedAtISO, revoked_at_iso AS revokedAtISO
           FROM integration_api_keys ORDER BY created_at_iso DESC`
        )
        .all();
      return res.json({ ok: true, keys: rows });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/settings/integration-api-keys', requirePermission('settings.manage'), (req, res) => {
    try {
      const name = String(req.body?.name || 'API key').trim().slice(0, 120);
      const id = `IKEY-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      const token = crypto.randomBytes(32).toString('base64url');
      const secretHash = hashIntegrationToken(token);
      const secretSuffix = token.slice(-6);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO integration_api_keys (id, name, secret_hash, secret_suffix, created_at_iso, created_by_user_id)
         VALUES (?,?,?,?,?,?)`
      ).run(id, name, secretHash, secretSuffix, now, req.user?.id || null);
      appendAuditLog(db, {
        actor: req.user,
        action: 'integration_api_key.create',
        entityKind: 'integration_api_key',
        entityId: id,
        note: name,
        status: 'success',
      });
      return res.status(201).json({
        ok: true,
        id,
        name,
        token,
        secretSuffix,
        warning: 'Store the token now; it cannot be retrieved again.',
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.patch('/api/settings/integration-api-keys/:id/revoke', requirePermission('settings.manage'), (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const now = new Date().toISOString();
      const info = db.prepare(`UPDATE integration_api_keys SET revoked_at_iso = ? WHERE id = ? AND revoked_at_iso IS NULL`).run(now, id);
      if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Key not found or already revoked.' });
      appendAuditLog(db, {
        actor: req.user,
        action: 'integration_api_key.revoke',
        entityKind: 'integration_api_key',
        entityId: id,
        status: 'success',
      });
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

}
