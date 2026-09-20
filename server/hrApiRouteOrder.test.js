/**
 * Express matches routes in registration order, so a literal path registered
 * after a same-shaped `:param` path is dead — the param route answers instead.
 * Three live HR endpoints were lost that way, so guard the whole router.
 */
import { describe, it, expect } from 'vitest';
import { registerHrApi } from './hrApi.js';

/** @returns {{ method: string, path: string }[]} routes in registration order */
function collectHrRoutes() {
  const routes = [];
  const record = (method) => (path) => {
    if (typeof path === 'string') routes.push({ method, path });
  };
  const app = {
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {},
  };
  registerHrApi(app, null);
  return routes;
}

/** Would `earlier` swallow a request for `later`? */
function shadows(earlier, later) {
  if (earlier.method !== later.method) return false;
  const a = earlier.path.split('/');
  const b = later.path.split('/');
  if (a.length !== b.length) return false;
  if (!a.some((seg) => seg.startsWith(':'))) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

describe('HR route registration order', () => {
  const routes = collectHrRoutes();

  it('registers the HR router', () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it('never hides a literal path behind an earlier :param path', () => {
    const shadowed = [];
    routes.forEach((later, i) => {
      if (later.path.split('/').some((seg) => seg.startsWith(':'))) return;
      for (const earlier of routes.slice(0, i)) {
        if (shadows(earlier, later)) {
          shadowed.push(`${later.method.toUpperCase()} ${later.path} <- ${earlier.path}`);
        }
      }
    });
    expect(shadowed).toEqual([]);
  });

  it.each([
    ['get', '/api/hr/staff/sales-customer-link-stats', '/api/hr/staff/:userId'],
    ['get', '/api/hr/staff/temporary-alerts', '/api/hr/staff/:userId'],
    ['get', '/api/hr/payroll-runs/drafts', '/api/hr/payroll-runs/:runId'],
  ])('keeps %s %s ahead of %s', (method, literal, param) => {
    const at = (path) => routes.findIndex((r) => r.method === method && r.path === path);
    expect(at(literal)).toBeGreaterThanOrEqual(0);
    expect(at(param)).toBeGreaterThanOrEqual(0);
    expect(at(literal)).toBeLessThan(at(param));
  });

  it('registers no path twice for the same method', () => {
    const seen = new Set();
    const duplicates = [];
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });
});
