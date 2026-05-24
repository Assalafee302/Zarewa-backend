/**
 * Guardrails for ERP text-to-SQL — read-only, allowlisted tables, RBAC gates.
 */

/** Tables the help agent may query (SELECT only). */
export const ERP_QUERY_ALLOWLIST = {
  products: {
    permission: ['sales.view', 'operations.view', 'inventory.view', '*'],
    branchColumn: 'branch_id',
  },
  quotations: {
    permission: ['sales.view', 'quotations.view', '*'],
    branchColumn: null,
  },
  sales_receipts: {
    permission: ['sales.view', 'finance.view', '*'],
    branchColumn: null,
  },
  customer_refunds: {
    permission: ['sales.view', 'refunds.view', 'refunds.approve', '*'],
    branchColumn: 'branch_id',
  },
  ledger_entries: {
    permission: ['finance.view', 'accounts.view', '*'],
    branchColumn: null,
  },
  customers: {
    permission: ['sales.view', 'customers.view', '*'],
    branchColumn: 'branch_id',
  },
  purchase_orders: {
    permission: ['procurement.view', 'operations.view', '*'],
    branchColumn: 'branch_id',
  },
  audit_log: {
    permission: ['audit.view', '*'],
    branchColumn: null,
    selfOnlyColumn: 'actor_user_id',
  },
};

const FORBIDDEN_SQL =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|PRAGMA|GRANT|REVOKE|EXEC|EXECUTE|CALL|INTO\s+OUTFILE|LOAD_FILE)\b/i;

/**
 * @param {string} sql
 * @returns {{ ok: true; tables: string[] } | { ok: false; error: string }}
 */
export function validateReadOnlySql(sql) {
  const raw = String(sql || '').trim();
  if (!raw) return { ok: false, error: 'Empty SQL.' };
  if (raw.includes(';')) return { ok: false, error: 'Multiple statements are not allowed.' };
  if (FORBIDDEN_SQL.test(raw)) return { ok: false, error: 'Only read-only SELECT queries are allowed.' };
  if (!/^\s*SELECT\b/i.test(raw)) return { ok: false, error: 'Query must start with SELECT.' };
  if (!/\bLIMIT\s+\d+/i.test(raw)) return { ok: false, error: 'Query must include LIMIT (max 50 rows).' };

  const limitMatch = raw.match(/\bLIMIT\s+(\d+)/i);
  if (limitMatch && Number(limitMatch[1]) > 50) {
    return { ok: false, error: 'LIMIT must be 50 or less.' };
  }

  const tables = extractTableNames(raw);
  if (!tables.length) return { ok: false, error: 'Could not determine table(s).' };

  for (const t of tables) {
    if (!ERP_QUERY_ALLOWLIST[t]) {
      return { ok: false, error: `Table not allowed: ${t}` };
    }
  }

  return { ok: true, tables };
}

/**
 * @param {string} sql
 * @returns {string[]}
 */
export function extractTableNames(sql) {
  const q = String(sql || '');
  /** @type {Set<string>} */
  const found = new Set();
  const re = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(q)) !== null) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

/**
 * @param {{ permissions?: string[]; roleKey?: string } | null | undefined} user
 * @param {string[]} tables
 */
export function userMayQueryTables(user, tables) {
  if (!user) return false;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  if (perms.includes('*')) return true;

  for (const table of tables) {
    const rule = ERP_QUERY_ALLOWLIST[table];
    if (!rule) return false;
    const ok = rule.permission.some((p) => perms.includes(p));
    if (!ok) return false;
  }
  return true;
}

/**
 * @param {string} sql
 * @param {{ branchId?: string; userId?: string; tables: string[]; permissions?: string[] }}
 */
export function applyScopeFilters(sql, scope) {
  let q = String(sql || '').trim();
  const branchId = String(scope.branchId || '').trim();
  const userId = String(scope.userId || '').trim();
  const perms = scope.permissions || [];
  const auditView = perms.includes('*') || perms.includes('audit.view');

  for (const table of scope.tables || []) {
    const rule = ERP_QUERY_ALLOWLIST[table];
    if (!rule) continue;
    if (rule.branchColumn && branchId && !new RegExp(`\\b${table}\\.${rule.branchColumn}\\b`, 'i').test(q)) {
      const esc = branchId.replace(/'/g, "''");
      if (/\bWHERE\b/i.test(q)) {
        q = q.replace(/\bWHERE\b/i, `WHERE ${table}.${rule.branchColumn} = '${esc}' AND`);
      } else {
        q = q.replace(new RegExp(`(FROM\\s+${table}\\b)`, 'i'), `$1 WHERE ${table}.${rule.branchColumn} = '${esc}'`);
      }
    }
    if (rule.selfOnlyColumn && userId && table === 'audit_log' && !auditView) {
      const esc = userId.replace(/'/g, "''");
      if (/\bWHERE\b/i.test(q)) {
        q = q.replace(/\bWHERE\b/i, `WHERE ${table}.${rule.selfOnlyColumn} = '${esc}' AND`);
      } else {
        q = q.replace(/FROM\s+audit_log\b/i, `FROM audit_log WHERE ${rule.selfOnlyColumn} = '${esc}'`);
      }
    }
  }
  return q;
}

/** Schema excerpt for LLM text-to-SQL (allowlisted tables only). */
export const ERP_SCHEMA_EXCERPT = `
Allowlisted read-only tables (always add LIMIT <= 50):
- products(product_id, name, stock_level, unit, branch_id, gauge, colour)
- quotations(id, customer_name, status, total_ngn, paid_ngn, payment_status, date_iso)
- sales_receipts(id, customer_name, quotation_ref, amount_ngn, status, date_iso)
- customer_refunds(refund_id, customer_name, quotation_ref, amount_ngn, status, branch_id, requested_at_iso)
- ledger_entries(id, type, customer_name, amount_ngn, quotation_ref, at_iso, created_by_user_id)
- customers(customer_id, name, branch_id, status, tier)
- purchase_orders(po_id, supplier_id, status, branch_id)
- audit_log(action, entity_kind, entity_id, status, note, occurred_at_iso, actor_user_id)
`.trim();
