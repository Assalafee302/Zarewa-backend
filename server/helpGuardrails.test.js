import { describe, expect, it } from 'vitest';
import { validateReadOnlySql, userMayQueryTables } from './helpGuardrails.js';

describe('helpGuardrails', () => {
  it('allows safe SELECT', () => {
    const r = validateReadOnlySql('SELECT name, stock_level FROM products WHERE branch_id = "BR-KD" LIMIT 10');
    expect(r.ok).toBe(true);
  });

  it('blocks UPDATE', () => {
    const r = validateReadOnlySql('UPDATE products SET stock_level = 0 LIMIT 1');
    expect(r.ok).toBe(false);
  });

  it('blocks unknown tables', () => {
    const r = validateReadOnlySql('SELECT * FROM payroll LIMIT 5');
    expect(r.ok).toBe(false);
  });

  it('checks RBAC on tables', () => {
    expect(userMayQueryTables({ permissions: ['sales.view'] }, ['products'])).toBe(true);
    expect(userMayQueryTables({ permissions: ['sales.view'] }, ['payroll'])).toBe(false);
  });
});
