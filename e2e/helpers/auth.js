import { expect } from '@playwright/test';

/** HR shell loaded (lazy chunk + subnav). */
export async function expectHrShell(page, timeout = 45_000) {
  await expect(page.getByText(/preparing live workspace/i)).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible({ timeout });
}

export async function signInViaUi(page, username, password) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/');
    try {
      await expect(page.getByRole('heading', { name: /open your workspace/i })).toBeVisible({
        timeout: 15_000,
      });
      break;
    } catch {
      if (attempt === 2) throw new Error('Login screen did not load (check Vite / module errors).');
      await page.waitForTimeout(400);
    }
  }
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: /enter workspace/i }).click();
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible({ timeout: 30_000 });
  await acceptRequiredHrPoliciesViaApi(page);
  await syncCsrfHeader(page);
}

/** Cookie-authenticated API tests — UI login so session cookies attach to the browser context. */
export async function signInViaApi(page, username, password) {
  await signInViaUi(page, username, password);
}

export async function syncCsrfHeader(page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'zarewa_csrf')?.value;
  if (csrf) await page.context().setExtraHTTPHeaders({ 'x-csrf-token': csrf });
}

/**
 * Same-origin fetch from the browser context (session cookies always included).
 * Use for HR API tests instead of page.request when cookie auth must match the UI session.
 */
export async function pageFetch(page, path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'zarewa_csrf')?.value || '';
  const extraHeaders = { ...(init.headers || {}) };
  if (csrf && method !== 'GET' && method !== 'HEAD') {
    extraHeaders['X-CSRF-Token'] = csrf;
  }
  return page.evaluate(
    async ({ url, method, extraHeaders, body }) => {
      const r = await fetch(url, {
        method,
        credentials: 'include',
        headers: {
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const buf = new Uint8Array(await r.arrayBuffer());
      return {
        status: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        body: Array.from(buf),
        text: new TextDecoder().decode(buf),
      };
    },
    { url: path, method, extraHeaders, body: init.body ?? null }
  );
}

export async function pageFetchJson(page, path, init = {}) {
  const res = await pageFetch(page, path, init);
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { ...res, json };
}

/** Clear session via API + cookie jar (for multi-user flows in one browser context). */
export async function signOutViaApi(page) {
  try {
    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name === 'zarewa_csrf')?.value;
    if (csrf) {
      await page.request.post('/api/session/logout', { headers: { 'X-CSRF-Token': csrf } });
    }
  } catch {
    /* ignore */
  }
  await page.context().setExtraHTTPHeaders({});
  await page.context().clearCookies();
}

export async function csrfHeader(page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'zarewa_csrf')?.value || '';
  expect(csrf, 'Expected zarewa_csrf cookie after login').toBeTruthy();
  return { 'X-CSRF-Token': csrf };
}

/** Acknowledge required HR policies so policy modals do not block the main UI (e.g. Sales navigation). */
export async function acceptRequiredHrPoliciesViaApi(page, signatureName = 'Playwright E2E') {
  const reqs = await page.request.get('/api/hr/policy-requirements');
  if (reqs.status() !== 200) return;
  const json = await reqs.json().catch(() => null);
  const missing = json?.missing || [];
  if (missing.length === 0) return;
  const headers = await csrfHeader(page);
  for (const p of missing) {
    const ack = await page.request.post('/api/hr/policy-acknowledgements', {
      data: {
        policyKey: p.key,
        policyVersion: p.version,
        signatureName,
        context: { channel: 'e2e' },
      },
      headers,
    });
    expect(ack.status(), await ack.text()).toBe(201);
  }
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible({ timeout: 30_000 });
  await syncCsrfHeader(page);
  const boot = await page.request.get('/api/bootstrap');
  expect(boot.status(), await boot.text()).toBe(200);
}
