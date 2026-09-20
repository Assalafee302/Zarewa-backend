/**
 * Workspace product flags.
 *
 * Branch session (`PATCH /api/session/workspace`), domain snapshots, revision/delta,
 * work items, search, and Office filing stay on. This gate only covers the unused
 * Teams-style layer: rooms, DMs, presence, activity fan-out, and SSE realtime.
 *
 * Default off. Set ZAREWA_WORKSPACE_ROOMS_ENABLED=1 to restore chat.
 */
import { apiError } from '../apiError.js';

function envFlag(name, defaultOn, env = process.env) {
  const raw = String(env[name] ?? '').trim().toLowerCase();
  if (raw === '') return defaultOn;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** @param {NodeJS.ProcessEnv} [env] */
export function workspaceRoomsEnabled(env = process.env) {
  return envFlag('ZAREWA_WORKSPACE_ROOMS_ENABLED', false, env);
}

/**
 * First-paint contract for the SPA — hide chat chrome when rooms are off.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function workspaceProductBootstrap(env = process.env) {
  return {
    roomsEnabled: workspaceRoomsEnabled(env),
  };
}

/**
 * Health/deploy capability (boolean). Office Desk routes are a separate flag.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function workspaceRoomsHealthCapability(env = process.env) {
  return workspaceRoomsEnabled(env);
}

/** Express middleware — 404 so the SPA treats chat as absent, not forbidden. */
export function requireWorkspaceRoomsEnabled(req, res, next) {
  if (workspaceRoomsEnabled()) return next();
  return apiError(res, {
    status: 404,
    code: 'WORKSPACE_ROOMS_DISABLED',
    error: 'Workspace chat is disabled. Branch workspace and desk sync are unchanged.',
  });
}
