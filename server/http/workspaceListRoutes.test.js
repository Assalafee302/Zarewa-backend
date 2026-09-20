import { describe, expect, it } from 'vitest';
import { registerWorkspaceListRoutes } from './workspaceListRoutes.js';

function collectRoutes() {
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
  registerWorkspaceListRoutes(app, null);
  return routes;
}

describe('workspace list route registration', () => {
  it('registers GET /api/payment-requests collection ahead of any :requestId handler', () => {
    const routes = collectRoutes();
    const collection = routes.findIndex((r) => r.method === 'get' && r.path === '/api/payment-requests');
    expect(collection).toBeGreaterThanOrEqual(0);
    expect(routes.some((r) => r.path.includes(':requestId'))).toBe(false);
  });
});
