/**
 * 500 SOP matrix clicks — FAQ catalog entries 500–999 (distinct from workspace/smoke packs).
 * Cases: e2e/generated/sop-matrix-500.json (npm run test:e2e:generate-matrix)
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = path.join(root, 'e2e', 'generated', 'sop-matrix-500.json');

/** @type {{ cases: { id: string; title: string; path: string; keyword: string; module: string }[] }} */
const { cases } = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

test.describe.configure({ mode: 'parallel', timeout: 45_000 });

test.use({ storageState: path.join(root, 'e2e', '.auth', 'admin.json') });

test.describe('Operational SOP matrix (500)', () => {
  for (const c of cases) {
    test(`[${c.id}] ${c.title}`, async ({ request }) => {
      const target = c.path.startsWith('/') ? c.path : `/${c.path}`;
      const res = await request.get(target);
      expect(res.status(), `${c.id} ${target}`).toBe(200);
      const body = await res.text();
      expect(body.length, `${c.id} empty body`).toBeGreaterThan(100);
      expect(body.toLowerCase()).not.toMatch(/application error|failed to fetch/i);
    });
  }
});
