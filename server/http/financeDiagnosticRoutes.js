/**
 * First finance HTTP extract from httpApi.js: AP1c / AP2 / AP3 diagnostics
 * plus trial exceptions. Permission gates stay on the handler; mutations
 * (AP rebuild, AP1c reclass, workbook cost refresh) go through ops modules.
 *
 * @param {import('express').Express} app
 * @param {object} db
 */
import { requireAuth, userHasPermission } from '../auth.js';
import { readFinanceFeatureFlags } from '../financeFeatureFlags.js';
import {
  userMayViewFinanceTrialExceptions,
  userMayViewAp1cDryRun,
  userMayViewAp2SupplierDiagnostics,
  userMayViewAp2ApRebuildPreview,
  userMayApplyAp2ApRebuild,
  userMayViewAp3CostingReadiness,
} from '../financeDeskAccess.js';
import { buildAp2SupplierDiagnosticsReport } from '../ap2SupplierDiagnosticsOps.js';
import { applyAp2ReceivedBasisRebuild, buildAp2ApRebuildPreview, logAp2RebuildPreviewed } from '../ap2ApRebuildOps.js';
import { buildSupplierAdvanceReport } from '../ap2SupplierAdvanceOps.js';
import { buildInventoryValuationReport } from '../ap2InventoryValuationOps.js';
import { buildApInventoryGlAlignmentReport } from '../ap2GlAlignmentOps.js';
import { buildAp3CostingReadinessReport } from '../ap3CostingReadinessOps.js';
import { buildAp3BranchPlReport } from '../ap3BranchPlOps.js';
import { buildPricingGovernancePack, proposeWorkbookCostRefresh } from '../pricingGovernanceOps.js';
import { buildAp3MaterialCostReport } from '../ap3MaterialCostOps.js';
import { buildFinanceTrialExceptionSummary } from '../financeTrialExceptions.js';
import { buildAp1cDryRunReport } from '../ap1cDryRunOps.js';
import { buildAp1cReclassPreview, postAp1cReclassBatch } from '../ap1cReclassOps.js';

function queryBranchId(req) {
  const branchRaw = String(req.query?.branchId || req.query?.branch || '').trim();
  return branchRaw && branchRaw !== 'ALL' ? branchRaw : null;
}

export function registerFinanceDiagnosticRoutes(app, db) {
  /**
   * Phase B3a — trial exception counts & role adoption (no PII, SELECT only).
   * Warnings only; strict RBAC flags remain off unless env enables them.
   */
  app.get('/api/finance/trial-exceptions', requireAuth, async (req, res) => {
    try {
      if (!userMayViewFinanceTrialExceptions(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to view finance trial exceptions.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const summary = await buildFinanceTrialExceptionSummary(db, { branchId });
      return res.json(summary);
    } catch (e) {
      console.error('[finance-trial-exceptions]', e);
      return res.status(500).json({ ok: false, error: 'Trial exception summary failed.' });
    }
  });

  /**
   * AP2a — Supplier / GRN / payables diagnostics (read-only; no AP or GL mutations).
   */
  app.get('/api/finance/ap2-supplier-diagnostics', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp2SupplierDiagnostics(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to view supplier payables diagnostics.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const period = String(req.query?.period || '').trim() || null;
      const supplierId = String(req.query?.supplierId || '').trim() || null;
      const status = String(req.query?.status || '').trim() || null;
      const limitSamples = Number(req.query?.limitSamples) || undefined;
      const report = buildAp2SupplierDiagnosticsReport(db, {
        branchId,
        period,
        supplierId,
        status,
        limitSamples,
      });
      return res.json(report);
    } catch (e) {
      console.error('[ap2-supplier-diagnostics]', e);
      return res.status(500).json({ ok: false, error: 'Supplier diagnostics failed.' });
    }
  });

  app.get('/api/finance/ap2-ap-rebuild-preview', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp2ApRebuildPreview(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to preview AP rebuild.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const period = String(req.query?.period || '').trim() || null;
      const supplierId = String(req.query?.supplierId || '').trim() || null;
      const status = String(req.query?.status || '').trim() || null;
      const logPreview = String(req.query?.logPreview || '').trim() === '1';
      const scope = { branchId, period, supplierId, status };
      const report = logPreview
        ? logAp2RebuildPreviewed(db, req.user, scope)
        : buildAp2ApRebuildPreview(db, scope);
      return res.json(report);
    } catch (e) {
      console.error('[ap2-ap-rebuild-preview]', e);
      return res.status(500).json({ ok: false, error: 'AP rebuild preview failed.' });
    }
  });

  app.post('/api/finance/ap2-ap-rebuild', requireAuth, (req, res) => {
    try {
      if (!userMayApplyAp2ApRebuild(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to apply AP rebuild.',
          code: 'FORBIDDEN',
        });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = applyAp2ReceivedBasisRebuild(db, req.user, {
        branchId: body.branchId,
        period: body.period,
        supplierId: body.supplierId,
        status: body.status,
        confirmPreviewHash: body.confirmPreviewHash,
        approvalNote: body.approvalNote,
        dryRunAccepted: body.dryRunAccepted === true,
      });
      if (!result.ok) {
        const status = result.code === 'PREVIEW_STALE' ? 409 : 400;
        return res.status(status).json(result);
      }
      return res.json(result);
    } catch (e) {
      console.error('[ap2-ap-rebuild]', e);
      return res.status(500).json({ ok: false, error: 'AP rebuild failed.' });
    }
  });

  app.get('/api/finance/supplier-advance-report', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp2SupplierDiagnostics(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const branchId = queryBranchId(req);
      const report = buildSupplierAdvanceReport(db, {
        branchId,
        period: String(req.query?.period || '').trim() || null,
        supplierId: String(req.query?.supplierId || '').trim() || null,
        status: String(req.query?.status || '').trim() || null,
      });
      return res.json(report);
    } catch (e) {
      console.error('[supplier-advance-report]', e);
      return res.status(500).json({ ok: false, error: 'Supplier advance report failed.' });
    }
  });

  app.get('/api/finance/inventory-valuation-report', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp2SupplierDiagnostics(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const branchId = queryBranchId(req);
      const report = buildInventoryValuationReport(db, {
        branchId,
        period: String(req.query?.period || '').trim() || null,
        materialFamily: String(req.query?.materialFamily || '').trim() || undefined,
        gauge: String(req.query?.gauge || '').trim() || undefined,
        colour: String(req.query?.colour || '').trim() || undefined,
        valuationBasis: String(req.query?.valuationBasis || '').trim() || undefined,
      });
      return res.json(report);
    } catch (e) {
      console.error('[inventory-valuation-report]', e);
      return res.status(500).json({ ok: false, error: 'Inventory valuation report failed.' });
    }
  });

  app.get('/api/finance/ap-inventory-gl-alignment', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp2SupplierDiagnostics(req.user)) {
        return res.status(403).json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN' });
      }
      const branchId = queryBranchId(req);
      const report = buildApInventoryGlAlignmentReport(db, {
        branchId,
        period: String(req.query?.period || '').trim() || null,
      });
      return res.json(report);
    } catch (e) {
      console.error('[ap-inventory-gl-alignment]', e);
      return res.status(500).json({ ok: false, error: 'AP/GL alignment report failed.' });
    }
  });

  app.get('/api/finance/ap3-material-cost-report', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp3CostingReadiness(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to view material cost reports.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const report = buildAp3MaterialCostReport(db, {
        branchId,
        period: String(req.query?.period || '').trim() || null,
        materialFamily: String(req.query?.materialFamily || '').trim() || null,
        gauge: String(req.query?.gauge || '').trim() || null,
        colour: String(req.query?.colour || '').trim() || null,
        trustFilter: String(req.query?.trustFilter || '').trim() || null,
        limitJobs: Number(req.query?.limitJobs) || undefined,
      });
      return res.json(report);
    } catch (e) {
      console.error('[ap3-material-cost-report]', e);
      return res.status(500).json({ ok: false, error: 'Material cost report failed.' });
    }
  });

  app.get('/api/finance/ap3-costing-readiness', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp3CostingReadiness(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to view costing readiness.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const report = buildAp3CostingReadinessReport(db, {
        branchId,
        period: String(req.query?.period || '').trim() || null,
        materialFamily: String(req.query?.materialFamily || '').trim() || null,
        gauge: String(req.query?.gauge || '').trim() || null,
        colour: String(req.query?.colour || '').trim() || null,
        limitSamples: Number(req.query?.limitSamples) || undefined,
      });
      return res.json(report);
    } catch (e) {
      console.error('[ap3-costing-readiness]', e);
      return res.status(500).json({ ok: false, error: 'Costing readiness report failed.' });
    }
  });

  app.get('/api/finance/ap3-branch-pl', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp3CostingReadiness(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to view branch P&L.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const report = buildAp3BranchPlReport(db, {
        branchId,
        period: String(req.query?.period || '').trim() || null,
      });
      if (!report.ok) return res.status(400).json(report);
      return res.json(report);
    } catch (e) {
      console.error('[ap3-branch-pl]', e);
      return res.status(500).json({ ok: false, error: 'Branch P&L report failed.' });
    }
  });

  /** Phase 3 pricing governance — finance_manager and above (same gate as AP3 costing). */
  app.get('/api/finance/pricing-governance', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp3CostingReadiness(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to view pricing governance.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const pack = buildPricingGovernancePack(db, {
        branchId,
        limit: Number(req.query?.limit) || undefined,
      });
      return res.json(pack);
    } catch (e) {
      console.error('[pricing-governance]', e);
      return res.status(500).json({ ok: false, error: 'Pricing governance pack failed.' });
    }
  });

  app.post('/api/finance/pricing-governance/propose-cost-refresh', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp3CostingReadiness(req.user)) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to refresh workbook cost.', code: 'FORBIDDEN' });
      }
      const result = proposeWorkbookCostRefresh(db, req.body?.rowId, req.user);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      console.error('[pricing-governance-cost-refresh]', e);
      return res.status(500).json({ ok: false, error: 'Could not refresh workbook cost.' });
    }
  });

  app.get('/api/finance/ap1c-dry-run', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp1cDryRun(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission to view AP1c dry-run diagnostics.',
          code: 'FORBIDDEN',
        });
      }
      const branchId = queryBranchId(req);
      const period = String(req.query?.period || '').trim() || null;
      const limitSamples = Number(req.query?.limitSamples) || undefined;
      const report = buildAp1cDryRunReport(db, { branchId, period, limitSamples });
      const flags = readFinanceFeatureFlags();
      return res.json({
        ...report,
        flags: {
          accountingPolicyV1Diagnostics: flags.accountingPolicyV1Diagnostics,
          accountingPolicyV1ReceiptGl: flags.accountingPolicyV1ReceiptGl,
          accountingPolicyV1ProductionRelease: flags.accountingPolicyV1ProductionRelease,
          accountingPolicyV1LegacyBridge: flags.accountingPolicyV1LegacyBridge,
          reclassPreProductionReceipts: flags.reclassPreProductionReceipts,
        },
      });
    } catch (e) {
      console.error('[ap1c-dry-run]', e);
      return res.status(500).json({ ok: false, error: 'AP1c dry-run failed.' });
    }
  });

  app.get('/api/finance/ap1c-reclass-preview', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp1cDryRun(req.user)) {
        return res.status(403).json({ ok: false, error: 'AP1c access required.', code: 'FORBIDDEN' });
      }
      const branchId = queryBranchId(req);
      const preview = buildAp1cReclassPreview(db, { branchId, limit: Number(req.query?.limit) || 200 });
      return res.json(preview);
    } catch (e) {
      console.error('[ap1c-reclass-preview]', e);
      return res.status(500).json({ ok: false, error: 'Could not build reclass preview.' });
    }
  });

  app.post('/api/finance/ap1c-reclass', requireAuth, (req, res) => {
    try {
      if (!userMayViewAp1cDryRun(req.user)) {
        return res.status(403).json({ ok: false, error: 'AP1c access required.', code: 'FORBIDDEN' });
      }
      if (!userHasPermission(req.user, 'finance.post')) {
        return res.status(403).json({ ok: false, error: 'finance.post required.', code: 'FORBIDDEN' });
      }
      const body = req.body || {};
      const branchRaw = String(body.branchId || '').trim();
      const branchId = branchRaw && branchRaw !== 'ALL' ? branchRaw : null;
      const result = postAp1cReclassBatch(db, {
        branchId,
        createdByUserId: req.user?.id,
        receiptIds: body.receiptIds,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.status(result.posted ? 201 : 200).json(result);
    } catch (e) {
      console.error('[ap1c-reclass-post]', e);
      return res.status(500).json({ ok: false, error: 'Could not post reclass batch.' });
    }
  });
}
