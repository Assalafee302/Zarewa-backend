import { DEFAULT_BRANCH_ID } from './branches.js';
import { assertSingleBranchWorkspaceForCreate } from './branchScope.js';
import { appendAuditLog } from './controlOps.js';
import { requireAuth, userHasPermission } from './auth.js';
import { listMasterData } from './masterData.js';
import { allowRateLimit, clientIp } from './rateLimit.js';
import { getQuotation, listCustomers, listQuotations } from './readModel.js';
import { assertQuotationIdInWorkspace } from './workspaceBranchGuards.js';
import * as write from './writeOps.js';
import {
  appendWorkItemDecision,
  createWorkItem,
  findPersistedWorkItemBySource,
  getUnifiedWorkItem,
  listUnifiedWorkItems,
  officeKeyForUser,
  userMayDecideWorkItem,
  workRegistryTablesReady,
} from './workItems.js';
import {
  attachMobileAuthContext,
  loginMobileWithPassword,
  logoutMobileSession,
  refreshMobileSession,
  registerMobileDeviceToken,
} from './mobileAuth.js';

const MOBILE_TRANSFER_PREFIX = 'MOBILE_SITE_TRANSFER|';

const mobileLoginAttemptBuckets = new Map();
const loginDelayMs = () =>
  new Promise((resolve) => setTimeout(resolve, Number(process.env.ZAREWA_LOGIN_DELAY_MS || 0) || 0));

function resolveBootstrapBranchScope(req) {
  if (req.workspaceViewAll) return 'ALL';
  return req.workspaceBranchId || DEFAULT_BRANCH_ID;
}

function mobileBranchScope(req) {
  const branchScope = resolveBootstrapBranchScope(req);
  return {
    viewAll: branchScope === 'ALL',
    branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
    branchScope,
  };
}

function canReadMobileQuotes(user) {
  return (
    userHasPermission(user, 'quotations.manage') ||
    userHasPermission(user, 'sales.view') ||
    userHasPermission(user, 'sales.manage') ||
    userHasPermission(user, '*')
  );
}

function canManageMobileQuotes(user) {
  return userHasPermission(user, 'quotations.manage') || userHasPermission(user, '*');
}

function parseMobileTransferMeta(lifecycleNote) {
  const raw = String(lifecycleNote || '');
  if (!raw.startsWith(MOBILE_TRANSFER_PREFIX)) return null;
  const parts = raw.split('|');
  return {
    transferredToSiteAtIso: parts[1] || '',
    transferredByUserId: parts[2] || '',
    transferNote: parts.slice(3).join('|') || '',
  };
}

function buildMobileTransferNote(actor, note, atIso) {
  const safeNote = String(note || '')
    .trim()
    .replace(/\|/g, '/')
    .slice(0, 200);
  return `${MOBILE_TRANSFER_PREFIX}${atIso}|${String(actor?.id || '').trim()}|${safeNote}`;
}

function quotationWriteError(res, e, fallback) {
  if (e?.statusCode === 422 && e?.code) {
    return res.status(422).json({
      ok: false,
      code: e.code,
      error: String(e.message || fallback),
      detail: e.details,
    });
  }
  return res.status(400).json({
    ok: false,
    code: e?.code || 'QUOTATION_WRITE_FAILED',
    error: String(e?.message || fallback),
  });
}

function toMobileApprovalSummary(item, user) {
  const outcomeProbe = 'approved';
  return {
    id: item.id,
    title: item.title || item.referenceNo || item.id,
    summary: item.summary || '',
    status: item.status || '',
    priority: item.priority || 'normal',
    category: item.category || '',
    documentType: item.documentType || '',
    senderDisplayName: item.senderDisplayName || '',
    createdAtIso: item.createdAtIso || '',
    updatedAtIso: item.updatedAtIso || '',
    dueAtIso: item.dueAtIso || '',
    requiresApproval: Boolean(item.requiresApproval),
    legacy: Boolean(item.legacy),
    canDecide:
      !item.legacy &&
      userMayDecideWorkItem(user, item, { outcomeStatus: outcomeProbe, decisionKey: 'mobile_approve' }),
  };
}

function toMobileApprovalDetail(item, user) {
  return {
    ...toMobileApprovalSummary(item, user),
    body: item.body || '',
    keyDecisionSummary: item.keyDecisionSummary || '',
    branchId: item.branchId || '',
    officeKey: item.officeKey || '',
    responsibleOfficeKey: item.responsibleOfficeKey || '',
    sourceKind: item.sourceKind || '',
    sourceId: item.sourceId || '',
  };
}

function flattenQuoteLines(quotationLines) {
  if (!quotationLines || typeof quotationLines !== 'object') return [];
  const out = [];
  for (const kind of ['products', 'accessories', 'services']) {
    const rows = Array.isArray(quotationLines[kind]) ? quotationLines[kind] : [];
    for (const line of rows) {
      const qty = Number(line?.qty ?? line?.quantity ?? 0) || 0;
      const unitPrice = Number(String(line?.unitPrice ?? line?.unit_price ?? 0).replace(/,/g, '')) || 0;
      const amountNgn =
        Number(line?.lineTotalNgn ?? line?.totalNgn ?? line?.amountNgn ?? 0) ||
        Math.round(qty * unitPrice);
      out.push({
        kind,
        name: String(line?.name || line?.productName || line?.description || '').trim() || 'Line',
        qty,
        unit: String(line?.unit || '').trim(),
        unitPrice,
        amountNgn,
      });
    }
  }
  return out;
}

function toMobileQuoteSummary(q, user) {
  const transfer = parseMobileTransferMeta(q.lifecycleNote);
  const manage = canManageMobileQuotes(user);
  const status = String(q.status || '').toLowerCase();
  const editable = manage && status !== 'void' && status !== 'expired' && status !== 'rejected';
  return {
    id: q.id,
    customer: q.customer || '',
    customerID: q.customerID || '',
    dateISO: q.dateISO || '',
    status: q.status || '',
    paymentStatus: q.paymentStatus || '',
    totalNgn: Number(q.totalNgn) || 0,
    paidNgn: Number(q.paidNgn) || 0,
    totalDisplay: q.total || '',
    projectName: q.projectName || '',
    branchId: q.branchId || '',
    transferredToSite: Boolean(transfer?.transferredToSiteAtIso),
    transferredToSiteAtIso: transfer?.transferredToSiteAtIso || '',
    canEdit: editable,
    canTransfer: editable && !transfer?.transferredToSiteAtIso,
  };
}

function toMobileQuoteDetail(q, user) {
  const linesObj = q.quotationLines && typeof q.quotationLines === 'object' ? q.quotationLines : {};
  return {
    ...toMobileQuoteSummary(q, user),
    handledBy: q.handledBy || '',
    dueDateISO: q.dueDateISO || '',
    materialTypeId: q.materialTypeId || linesObj.materialTypeId || '',
    materialGauge: q.materialGauge || linesObj.materialGauge || '',
    materialColor: q.materialColor || linesObj.materialColor || '',
    materialDesign: q.materialDesign || linesObj.materialDesign || '',
    lines: flattenQuoteLines(q.quotationLines),
    transferNote: parseMobileTransferMeta(q.lifecycleNote)?.transferNote || '',
  };
}

function normalizeMobileQuoteLines(body) {
  const lines = body?.lines;
  if (lines && typeof lines === 'object' && !Array.isArray(lines)) {
    return {
      products: Array.isArray(lines.products) ? lines.products : [],
      accessories: Array.isArray(lines.accessories) ? lines.accessories : [],
      services: Array.isArray(lines.services) ? lines.services : [],
    };
  }
  if (Array.isArray(lines)) {
    const products = [];
    const accessories = [];
    const services = [];
    for (const row of lines) {
      const kind = String(row?.kind || 'products').toLowerCase();
      const entry = {
        name: String(row?.name || '').trim(),
        qty: String(row?.qty ?? ''),
        unitPrice: String(row?.unitPrice ?? ''),
        unit: String(row?.unit || 'ea').trim() || 'ea',
      };
      if (!entry.name) continue;
      if (kind === 'accessories' || kind === 'accessory') accessories.push(entry);
      else if (kind === 'services' || kind === 'service') services.push(entry);
      else products.push(entry);
    }
    return { products, accessories, services };
  }
  return { products: [], accessories: [], services: [] };
}

function buildQuotationWritePayload(body) {
  const lines = normalizeMobileQuoteLines(body);
  return {
    customerID: body?.customerID,
    projectName: body?.projectName,
    dateISO: body?.dateISO,
    dueDateISO: body?.dueDateISO,
    materialTypeId: body?.materialTypeId,
    materialGauge: body?.materialGauge,
    materialColor: body?.materialColor,
    materialDesign: body?.materialDesign,
    status: body?.status || 'Pending',
    handledBy: body?.handledBy || 'Mobile Sales',
    customerFeedback: body?.customerFeedback,
    forceDuplicateCreate: Boolean(body?.forceDuplicateCreate),
    lines,
  };
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerMobileApi(app, db) {
  app.use(attachMobileAuthContext(db));

  app.get('/api/mobile/health', (_req, res) => {
    res.json({ ok: true, service: 'zarewa-mobile-api', time: new Date().toISOString() });
  });

  app.post('/api/mobile/auth/login', async (req, res) => {
    try {
      const ip = clientIp(req);
      const userKey = `${ip}:${String(req.body?.username || '').trim().toLowerCase()}`;
      const { username, password, deviceId, deviceName, platform } = req.body || {};
      const result = loginMobileWithPassword(db, username, password, { deviceId, deviceName, platform });
      if (!result.ok) {
        if (Array.isArray(result.audits)) {
          for (const audit of result.audits) {
            appendAuditLog(db, audit);
          }
        }
        if (!allowRateLimit(mobileLoginAttemptBuckets, userKey, 12, 30 * 60 * 1000)) {
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
      appendAuditLog(db, {
        actor: result.session.user,
        action: 'mobile.session.login',
        entityKind: 'user',
        entityId: result.session.user?.id ?? '',
        note: `Mobile sign-in (${String(platform || 'android')})`,
      });
      return res.json({
        ok: true,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAtIso: result.expiresAtIso,
        refreshExpiresAtIso: result.refreshExpiresAtIso,
        deviceId: result.deviceId,
        ...result.session,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Mobile login failed.' });
    }
  });

  app.post('/api/mobile/auth/refresh', (req, res) => {
    try {
      const refreshToken = req.body?.refreshToken;
      const result = refreshMobileSession(db, refreshToken);
      if (!result.ok) {
        return res.status(401).json(result);
      }
      return res.json({
        ok: true,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAtIso: result.expiresAtIso,
        refreshExpiresAtIso: result.refreshExpiresAtIso,
        ...result.session,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not refresh session.' });
    }
  });

  app.post('/api/mobile/auth/logout', requireAuth, (req, res) => {
    try {
      if (req.mobileSessionId) {
        logoutMobileSession(db, req.mobileSessionId);
      }
      if (req.user) {
        appendAuditLog(db, {
          actor: req.user,
          action: 'mobile.session.logout',
          entityKind: 'user',
          entityId: req.user?.id ?? '',
          note: 'Mobile sign-out',
        });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not sign out.' });
    }
  });

  app.get('/api/mobile/session', requireAuth, (req, res) => {
    return res.json({ ok: true, ...req.session });
  });

  app.post('/api/mobile/devices/register', requireAuth, (req, res) => {
    try {
      const result = registerMobileDeviceToken(db, req.user?.id, req.body || {});
      if (!result.ok) return res.status(400).json(result);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not register device.' });
    }
  });

  app.get('/api/mobile/home', requireAuth, (req, res) => {
    try {
      const scope = mobileBranchScope(req);
      const pendingApprovals = listUnifiedWorkItems(db, scope, req.user, {
        assignedToMe: '1',
        status: 'open',
        limit: 50,
      });
      const myRequests = listUnifiedWorkItems(db, scope, req.user, {
        createdByMe: '1',
        limit: 20,
      });

      const tabs = [
        { id: 'home', label: 'Home', visible: true },
        {
          id: 'approvals',
          label: 'Approvals',
          visible: pendingApprovals.length > 0 || userHasPermission(req.user, 'office.use'),
        },
        {
          id: 'quotes',
          label: 'Quotes',
          visible: canReadMobileQuotes(req.user),
        },
        { id: 'requests', label: 'Requests', visible: true },
        { id: 'chat', label: 'Chat', visible: userHasPermission(req.user, 'office.use') },
        { id: 'more', label: 'More', visible: true },
      ].filter((t) => t.visible);

      return res.json({
        ok: true,
        user: req.session.user,
        branchId: scope.branchId,
        counts: {
          pendingApprovals: pendingApprovals.length,
          myOpenRequests: myRequests.filter((r) => String(r.status || '').toLowerCase() !== 'done').length,
        },
        pendingApprovals: pendingApprovals.slice(0, 8).map((item) => toMobileApprovalSummary(item, req.user)),
        myRequests: myRequests.slice(0, 5).map((item) => toMobileApprovalSummary(item, req.user)),
        tabs,
        features: {
          otpPcLogin: false,
          offlineQuotes: false,
          pushNotifications: false,
          chat: false,
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load mobile home.' });
    }
  });

  app.get('/api/mobile/approvals', requireAuth, (req, res) => {
    try {
      const scope = mobileBranchScope(req);
      const items = listUnifiedWorkItems(db, scope, req.user, {
        assignedToMe: '1',
        status: 'open',
        limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
      });
      return res.json({
        ok: true,
        items: items.map((item) => toMobileApprovalSummary(item, req.user)),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load approvals.' });
    }
  });

  app.get('/api/mobile/approvals/:id', requireAuth, (req, res) => {
    try {
      const scope = mobileBranchScope(req);
      const result = getUnifiedWorkItem(db, scope, req.user, String(req.params.id || ''));
      if (!result.ok) {
        if (result.error === 'Forbidden.') return res.status(403).json(result);
        if (result.error === 'Work item not found.') return res.status(404).json(result);
        return res.status(400).json(result);
      }
      return res.json({ ok: true, item: toMobileApprovalDetail(result.item, req.user) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load approval.' });
    }
  });

  app.post('/api/mobile/approvals/:id/decide', requireAuth, (req, res) => {
    try {
      const scope = mobileBranchScope(req);
      const workItemId = String(req.params.id || '').trim();
      const target = getUnifiedWorkItem(db, scope, req.user, workItemId);
      if (!target.ok) {
        return res.status(target.error === 'Forbidden.' ? 403 : 404).json(target);
      }
      const item = target.item;
      if (item.legacy) {
        return res.status(400).json({
          ok: false,
          code: 'LEGACY_QUEUE',
          error: 'This item must still be acted on in the web ERP for now.',
        });
      }
      const outcomeStatus = String(req.body?.outcomeStatus || '').trim();
      if (!outcomeStatus) {
        return res.status(400).json({ ok: false, error: 'Decision outcome is required.' });
      }
      const decisionKey = String(req.body?.decisionKey || 'mobile_review').trim() || 'mobile_review';
      if (!userMayDecideWorkItem(req.user, item, { outcomeStatus, decisionKey })) {
        return res.status(403).json({
          ok: false,
          code: 'FORBIDDEN',
          error: 'You are not authorized to record this decision on this work item.',
        });
      }
      const result = appendWorkItemDecision(db, {
        workItemId: item.id,
        actor: req.user,
        actorBranchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        decisionKey,
        outcomeStatus,
        note: req.body?.note,
        nextStatus: req.body?.nextStatus || outcomeStatus,
        keyDecisionSummary: req.body?.keyDecisionSummary,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.json({
        ok: true,
        item: toMobileApprovalDetail(result.item || result, req.user),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not record decision.' });
    }
  });

  app.get('/api/mobile/quotes', requireAuth, (req, res) => {
    try {
      if (!canReadMobileQuotes(req.user)) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to view quotations.' });
      }
      const { branchScope } = mobileBranchScope(req);
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
      const quotations = listQuotations(db, branchScope, { limit }).map((q) =>
        toMobileQuoteSummary(q, req.user)
      );
      return res.json({
        ok: true,
        quotations,
        canCreate: canManageMobileQuotes(req.user),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load quotes.' });
    }
  });

  app.get('/api/mobile/quotes/form-options', requireAuth, (req, res) => {
    try {
      if (!canManageMobileQuotes(req.user)) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to create quotations.' });
      }
      const { branchScope } = mobileBranchScope(req);
      const master = listMasterData(db);
      const active = (rows) => (Array.isArray(rows) ? rows.filter((r) => r.active !== false) : []);
      const customers = listCustomers(db, branchScope, { limit: 200 }).map((c) => ({
        customerID: c.customerID,
        name: c.name,
        phoneNumber: c.phoneNumber || '',
        companyName: c.companyName || '',
      }));
      return res.json({
        ok: true,
        customers,
        materialTypes: active(master.materialTypes).map((m) => ({
          id: m.id,
          name: m.name,
          inventoryModel: m.inventoryModel || '',
        })),
        gauges: active(master.gauges).map((g) => ({
          id: g.id,
          label: g.label || g.name || '',
          gaugeMm: g.gaugeMm,
        })),
        colours: active(master.colours).map((c) => ({
          id: c.id,
          name: c.name,
          abbreviation: c.abbreviation || '',
        })),
        profiles: active(master.profiles).map((p) => ({
          id: p.id,
          name: p.name,
          materialTypeId: p.materialTypeId || '',
        })),
        quoteItems: active(master.quoteItems).map((item) => ({
          id: item.id,
          itemType: item.itemType,
          name: item.name,
          unit: item.unit || 'ea',
          defaultUnitPriceNgn: Number(item.defaultUnitPriceNgn) || 0,
        })),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load quote form options.' });
    }
  });

  app.post('/api/mobile/quotes', requireAuth, (req, res) => {
    try {
      if (!canManageMobileQuotes(req.user)) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to create quotations.' });
      }
      const createGate = assertSingleBranchWorkspaceForCreate(req);
      if (!createGate.ok) {
        return res.status(403).json({ ok: false, error: createGate.error });
      }
      const payload = buildQuotationWritePayload(req.body || {});
      if (!String(payload.customerID || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Customer is required.' });
      }
      if (!String(payload.projectName || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Project / site name is required.' });
      }
      const id = write.insertQuotation(db, payload, req.workspaceBranchId || DEFAULT_BRANCH_ID);
      appendAuditLog(db, {
        actor: req.user,
        action: 'quotation.mobile_create',
        entityKind: 'quotation',
        entityId: id,
        note: 'Created from mobile companion',
      });
      const quotation = getQuotation(db, id);
      return res.status(201).json({
        ok: true,
        quotationId: id,
        quotation: toMobileQuoteDetail(quotation, req.user),
      });
    } catch (e) {
      console.error(e);
      return quotationWriteError(res, e, 'Could not create quotation.');
    }
  });

  app.get('/api/mobile/quotes/:id', requireAuth, (req, res) => {
    try {
      if (!canReadMobileQuotes(req.user)) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to view quotations.' });
      }
      const qid = String(req.params.id || '').trim();
      const gate = assertQuotationIdInWorkspace(db, req, qid);
      if (!gate.ok) return res.status(gate.status || 403).json({ ok: false, error: gate.error });
      const row = getQuotation(db, qid);
      if (!row) return res.status(404).json({ ok: false, error: 'Quotation not found.' });
      return res.json({ ok: true, quotation: toMobileQuoteDetail(row, req.user) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load quote.' });
    }
  });

  app.patch('/api/mobile/quotes/:id', requireAuth, (req, res) => {
    try {
      if (!canManageMobileQuotes(req.user)) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to edit quotations.' });
      }
      const qid = String(req.params.id || '').trim();
      const gate = assertQuotationIdInWorkspace(db, req, qid);
      if (!gate.ok) return res.status(gate.status || 403).json({ ok: false, error: gate.error });
      if (!getQuotation(db, qid)) {
        return res.status(404).json({ ok: false, error: 'Quotation not found.' });
      }
      const payload = buildQuotationWritePayload(req.body || {});
      // Do not force status/handledBy on patch unless provided
      if (req.body?.status === undefined) delete payload.status;
      if (req.body?.handledBy === undefined) delete payload.handledBy;
      write.updateQuotation(db, qid, payload, req.user);
      appendAuditLog(db, {
        actor: req.user,
        action: 'quotation.mobile_update',
        entityKind: 'quotation',
        entityId: qid,
        note: 'Updated from mobile companion',
      });
      const quotation = getQuotation(db, qid);
      return res.json({ ok: true, quotation: toMobileQuoteDetail(quotation, req.user) });
    } catch (e) {
      console.error(e);
      return quotationWriteError(res, e, 'Could not update quotation.');
    }
  });

  app.post('/api/mobile/quotes/:id/transfer', requireAuth, (req, res) => {
    try {
      if (!canManageMobileQuotes(req.user)) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to transfer quotations.' });
      }
      const qid = String(req.params.id || '').trim();
      const gate = assertQuotationIdInWorkspace(db, req, qid);
      if (!gate.ok) return res.status(gate.status || 403).json({ ok: false, error: gate.error });
      const row = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(qid);
      if (!row) return res.status(404).json({ ok: false, error: 'Quotation not found.' });

      const existingTransfer = parseMobileTransferMeta(row.quotation_lifecycle_note);
      if (existingTransfer?.transferredToSiteAtIso) {
        return res.status(409).json({
          ok: false,
          code: 'ALREADY_TRANSFERRED',
          error: 'This quotation was already transferred to site.',
          transferredToSiteAtIso: existingTransfer.transferredToSiteAtIso,
        });
      }

      const atIso = new Date().toISOString();
      const note = String(req.body?.note || '').trim();
      const lifecycleNote = buildMobileTransferNote(req.user, note, atIso);
      db.prepare(`UPDATE quotations SET quotation_lifecycle_note = ? WHERE id = ?`).run(lifecycleNote, qid);

      let workItemId = null;
      if (workRegistryTablesReady(db)) {
        const existingWi = findPersistedWorkItemBySource(db, 'quotation_site_handoff', qid);
        if (existingWi?.id) {
          workItemId = existingWi.id;
        } else {
          const wi = createWorkItem(db, {
            actor: req.user,
            branchId: row.branch_id || req.workspaceBranchId || DEFAULT_BRANCH_ID,
            officeKey: 'operations',
            responsibleOfficeKey: 'operations',
            documentClass: 'request',
            documentType: 'quotation_site_handoff',
            status: 'open',
            priority: 'normal',
            title: `Site handoff ${qid}`,
            summary: `${row.customer_name || 'Customer'} · ${row.project_name || 'project'} · transferred from mobile`,
            body: note || 'Quotation ready for site / office follow-up.',
            senderUserId: req.user?.id,
            senderDisplayName: req.user?.displayName || req.user?.username || '',
            senderRoleKey: req.user?.roleKey || '',
            senderOfficeKey: officeKeyForUser(req.user),
            senderBranchId: row.branch_id || req.workspaceBranchId || DEFAULT_BRANCH_ID,
            requiresResponse: true,
            requiresApproval: false,
            sourceKind: 'quotation_site_handoff',
            sourceId: qid,
            links: [{ entityKind: 'quotation', entityId: qid }],
          });
          if (wi.ok) workItemId = wi.item?.id || null;
        }
      }

      appendAuditLog(db, {
        actor: req.user,
        action: 'quotation.mobile_transfer',
        entityKind: 'quotation',
        entityId: qid,
        note: note || 'Transferred to site from mobile',
        details: { workItemId, atIso },
      });

      const quotation = getQuotation(db, qid);
      return res.json({
        ok: true,
        quotation: toMobileQuoteDetail(quotation, req.user),
        workItemId,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not transfer quotation to site.' });
    }
  });
}
