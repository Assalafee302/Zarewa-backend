/**
 * Load-balancer and uptime probes. Keep this module tiny and dependency-free
 * so `/health` stays fast even when the rest of the API is busy.
 *
 * Public paths omit capabilities. `/api/health` (and aliases) include a
 * capabilities object so the SPA can detect which finance/office features
 * this process was built with.
 *
 * @param {import('express').Express} app
 * @param {{ livenessCapabilities?: Record<string, unknown> }} [opts]
 */
import { DEPLOYED_COMMIT, PROCESS_STARTED_AT_ISO } from '../deployedCommit.js';

export function registerLivenessRoutes(app, { livenessCapabilities = {} } = {}) {
  const sendPublicLiveness = (_req, res) => {
    res.json({
      ok: true,
      service: 'zarewa-api',
      commit: DEPLOYED_COMMIT,
      startedAt: PROCESS_STARTED_AT_ISO,
      time: new Date().toISOString(),
    });
  };
  const sendApiLiveness = (_req, res) => {
    res.json({
      ok: true,
      service: 'zarewa-api',
      // Deploy check: `commit` says which code is serving, `startedAt` says whether the
      // restart that was meant to pick it up actually happened.
      commit: DEPLOYED_COMMIT,
      startedAt: PROCESS_STARTED_AT_ISO,
      time: new Date().toISOString(),
      capabilities: livenessCapabilities,
    });
  };
  const publicLivenessPaths = ['/health', '/healthz', '/livez', '/readyz', '/status'];
  const apiLivenessPaths = ['/api/health', '/api/readyz', '/api/livez', '/api/status'];
  for (const p of publicLivenessPaths) {
    app.get(p, sendPublicLiveness);
  }
  for (const p of apiLivenessPaths) {
    app.get(p, sendApiLiveness);
  }
}
