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
      const shell = await request.get(target);
      expect(shell.status(), `${c.id} shell ${target}`).toBe(200);
      const html = await shell.text();
      expect(html, `${c.id} missing SPA root`).toMatch(/id=["']root["']/i);

      const pers = await request.get(
        `/api/help/personalization?pathname=${encodeURIComponent(target)}`
      );
      expect(pers.status(), `${c.id} personalization`).toBe(200);
      const payload = await pers.json();
      expect(payload.ok, `${c.id} personalization ok`).toBe(true);

      if (c.id.endsWith('00') || c.id.endsWith('05')) {
        const help = await request.post('/api/help/chat', {
          data: { message: c.keyword, pathname: target },
        });
        expect(help.status(), `${c.id} help`).toBe(200);
        const chat = await help.json();
        expect(chat.ok, `${c.id} help ok`).toBe(true);
        expect(String(chat.message || '').length, `${c.id} empty help`).toBeGreaterThan(20);
      }
    });
  }
});
