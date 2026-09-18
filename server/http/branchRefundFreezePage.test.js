import { describe, expect, it } from 'vitest';
import { renderRefundLockPage } from './branchRefundFreezePage.js';

describe('refund lock HTML page', () => {
  it('asks unsigned visitors to sign in', () => {
    const html = renderRefundLockPage({ user: null });
    expect(html).toMatch(/Sign in to Zarewa as <strong>Administrator<\/strong>/);
    expect(html).not.toMatch(/name="fromISO"/);
  });

  it('shows date pickers for an administrator', () => {
    const html = renderRefundLockPage({
      user: { displayName: 'Admin User', roleKey: 'admin' },
      canLock: true,
      csrf: 'token-1',
      branches: [{ id: 'BR-YL', name: 'Yola Factory', code: 'YL' }],
      fromDay: '2026-09-01',
      toDay: '2026-09-16',
    });
    expect(html).toMatch(/type="date"/);
    expect(html).toMatch(/name="fromISO"/);
    expect(html).toMatch(/name="toISO"/);
    expect(html).toMatch(/Lock these dates/);
    expect(html).toMatch(/value="token-1"/);
    expect(html).toMatch(/Yola Factory/);
  });
});
