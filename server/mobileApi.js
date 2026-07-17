import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';
import { requireAuth, userHasPermission } from './auth.js';
import { allowRateLimit, clientIp } from './rateLimit.js';
import { listUnifiedWorkItems } from './workItems.js';
import {
  attachMobileAuthContext,
  loginMobileWithPassword,
  logoutMobileSession,
  refreshMobileSession,
  registerMobileDeviceToken,
} from './mobileAuth.js';

const mobileLoginAttemptBuckets = new Map();
const loginDelayMs = () =>
  new Promise((resolve) => setTimeout(resolve, Number(process.env.ZAREWA_LOGIN_DELAY_MS || 0) || 0));

function resolveBootstrapBranchScope(req) {
  if (req.workspaceViewAll) return 'ALL';
  return req.workspaceBranchId || DEFAULT_BRANCH_ID;
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
      const branchScope = resolveBootstrapBranchScope(req);
      const scope = {
        viewAll: branchScope === 'ALL',
        branchId: branchScope === 'ALL' ? (req.workspaceBranchId || DEFAULT_BRANCH_ID) : branchScope,
      };
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
          visible: userHasPermission(req.user, 'quotations.manage') || userHasPermission(req.user, 'sales.view'),
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
        pendingApprovals: pendingApprovals.slice(0, 8),
        myRequests: myRequests.slice(0, 5),
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
}
