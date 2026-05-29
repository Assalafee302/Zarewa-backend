import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authDir = path.join(root, 'e2e', '.auth');

export default async function globalSetup() {
  fs.mkdirSync(authDir, { recursive: true });
  const baseURL = `http://127.0.0.1:${process.env.E2E_UI_PORT || 5180}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto('/');
  await page.getByRole('heading', { name: /open your workspace/i }).waitFor({ timeout: 60_000 });
  const loginRes = await page.request.post('/api/session/login', {
    data: { username: 'admin', password: 'Admin@123' },
  });
  if (!loginRes.ok()) {
    throw new Error(`Admin login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Modules' }).waitFor({ timeout: 60_000 });

  await context.storageState({ path: path.join(authDir, 'admin.json') });
  await browser.close();
}
