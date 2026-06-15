import {
  clearanceTopicForTables,
  formatClearanceMessage,
  inferClearanceTopicFromMessage,
} from '../shared/lib/helpClearance.js';
import { normalizeHelpQueryText } from '../shared/lib/helpTypoTolerance.js';
import { userMayQueryTables } from './helpGuardrails.js';
import { postChatCompletions, readAiAssistConfig, normalizeCompletionContent } from './aiAssist.js';
import {
  applyScopeFilters,
  ERP_SCHEMA_EXCERPT,
  validateReadOnlySql,
} from './helpGuardrails.js';
import { getBranchCodeUpper } from './humanId.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
function quotationsHasBranchId(db) {
  try {
    return db.prepare(`PRAGMA table_info(quotations)`).all().some((c) => c.name === 'branch_id');
  } catch {
    return false;
  }
}

/**
 * @param {string} message
 * @returns {{ kind: 'full' | 'seq'; value: string } | null}
 */
export function parseQuotationRefFromMessage(message) {
  const q = normalizeHelpQueryText(String(message || '').trim());
  const full = q.match(/\b(QT-[A-Z0-9-]+)\b/i);
  if (full) return { kind: 'full', value: full[1].toUpperCase() };

  const whatIn = q.match(
    /\bwhat(?:'s| is)\s+in\s+(?:the\s+)?(?:quotation|quote|qt)\s*#?\s*(\d{1,6})\b/i
  );
  if (whatIn) return { kind: 'seq', value: whatIn[1] };

  const num = q.match(/\b(?:quotation|quote|qt)\s*#?\s*(\d{1,6})\b/i);
  if (num) return { kind: 'seq', value: num[1] };

  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ kind: 'full' | 'seq'; value: string }} ref
 * @param {string} [branchId]
 * @returns {string[]}
 */
export function resolveQuotationIds(db, ref, branchId = '') {
  const branchFilter = quotationsHasBranchId(db) && branchId ? ' AND branch_id = ?' : '';

  if (ref.kind === 'full') {
    const row = db.prepare(`SELECT id FROM quotations WHERE id = ? LIMIT 1`).get(ref.value);
    return row?.id ? [String(row.id)] : [];
  }

  const n = Number(ref.value);
  if (!Number.isFinite(n) || n <= 0) return [];

  const padded4 = String(n).padStart(4, '0');
  /** @type {string[]} */
  const patterns = [`QT-%-${padded4}`, `%-${padded4}`];
  if (String(n) !== padded4) patterns.push(`%-${n}`);
  if (branchId) {
    const code = getBranchCodeUpper(db, branchId);
    patterns.unshift(`QT-${code}-%-${padded4}`);
  }

  /** @type {string[]} */
  const found = [];
  for (const pat of patterns) {
    const args = [pat];
    if (branchFilter) args.push(String(branchId));
    const rows = db
      .prepare(
        `SELECT id FROM quotations WHERE id LIKE ?${branchFilter} ORDER BY date_iso DESC, id DESC LIMIT 5`
      )
      .all(...args);
    for (const row of rows) found.push(String(row.id));
    if (found.length === 1) return found;
  }

  return [...new Set(found)].slice(0, 5);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 */
function loadQuotationLineSummaries(db, quotationId, linesJsonRaw) {
  /** @type {string[]} */
  const out = [];
  try {
    const tableLines = db
      .prepare(
        `SELECT category, name, qty, unit, line_total_ngn FROM quotation_lines
         WHERE quotation_id = ? ORDER BY sort_order LIMIT 25`
      )
      .all(quotationId);
    for (const line of tableLines) {
      const qty =
        line.qty != null
          ? `${line.qty}${line.unit ? ` ${line.unit}` : ''}`
          : '';
      const total = line.line_total_ngn != null ? ` — ₦${line.line_total_ngn}` : '';
      out.push(`• ${line.name}${qty ? ` (${qty})` : ''}${total}`);
    }
  } catch {
    /* optional table */
  }

  if (out.length) return out;

  if (!linesJsonRaw) return out;
  try {
    const j = JSON.parse(String(linesJsonRaw));
    for (const bucket of ['products', 'accessories', 'services']) {
      for (const line of j?.[bucket] || []) {
        const name = line?.name || line?.productName || line?.description || 'Line item';
        const qty = line?.qty ?? line?.quantity ?? '';
        const unit = line?.unit || '';
        out.push(`• ${name}${qty !== '' ? ` (${qty}${unit ? ` ${unit}` : ''})` : ''}`);
      }
    }
  } catch {
    /* ignore */
  }
  return out.slice(0, 25);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 */
function lookupQuotationDetails(db, quotationId) {
  const row = db
    .prepare(
      `SELECT id, customer_name, status, total_ngn, paid_ngn, payment_status, date_iso, project_name, lines_json
       FROM quotations WHERE id = ? LIMIT 1`
    )
    .get(quotationId);
  if (!row) return null;

  const lines = loadQuotationLineSummaries(db, quotationId, row.lines_json);
  const header = [
    `**${row.id}** — ${row.customer_name}`,
    row.project_name ? `Project: ${row.project_name}` : null,
    `Status: **${row.status || 'n/a'}** · Total **₦${row.total_ngn}** · Paid **₦${row.paid_ngn}** (${row.payment_status || 'n/a'})`,
    row.date_iso ? `Date: ${String(row.date_iso).slice(0, 10)}` : null,
  ].filter(Boolean);

  const summaryParts = [header.join('\n')];
  if (lines.length) {
    summaryParts.push('', '**Lines:**', ...lines);
  } else {
    summaryParts.push('', '_No line items stored for this quotation._');
  }

  return {
    row,
    lines,
    summary: summaryParts.join('\n'),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} message
 * @param {{ user?: object; branchId?: string }} ctx
 */
function tryQuotationLookup(db, message, ctx) {
  const user = ctx.user;
  if (!userMayQueryTables(user, ['quotations'])) {
    return clearanceDenied(user, 'quotations', user?.roleKey);
  }

  const ref = parseQuotationRefFromMessage(message);
  if (!ref) return null;

  const ids = resolveQuotationIds(db, ref, String(ctx.branchId || '').trim());
  if (!ids.length) {
    const label = ref.kind === 'full' ? ref.value : `quotation ${ref.value}`;
    return {
      ok: true,
      tool: 'quotation_lookup',
      rows: [],
      summary: `No quotation found for **${label}**. Try the full id (example **QT-KD-26-0036**) or check the branch workspace.`,
    };
  }

  if (ids.length > 1) {
    return {
      ok: true,
      tool: 'quotation_lookup',
      rows: ids.map((id) => ({ id })),
      summary: `Multiple quotations match **${ref.kind === 'seq' ? ref.value : ref.value}**: ${ids.join(', ')}. Ask again with the full **QT-…** id.`,
    };
  }

  const detail = lookupQuotationDetails(db, ids[0]);
  if (!detail) {
    return {
      ok: true,
      tool: 'quotation_lookup',
      rows: [],
      summary: `Quotation ${ids[0]} was not found.`,
    };
  }

  return {
    ok: true,
    tool: 'quotation_lookup',
    rows: [detail.row],
    summary: detail.summary,
  };
}

function clearanceDenied(user, topicKey, roleKey) {
  return {
    ok: false,
    code: 'CLEARANCE_DENIED',
    topicKey,
    error: formatClearanceMessage({ topicKey, roleKey: roleKey || user?.roleKey, mode: 'live_data' }),
  };
}

function deniedForTables(user, tables, roleKey, message) {
  const topicKey =
    clearanceTopicForTables(tables) || inferClearanceTopicFromMessage(message) || 'finance';
  return clearanceDenied(user, topicKey, roleKey);
}

/**
 * Native read-only ERP tools (no LLM) — pattern-matched API calls.
 * @param {import('better-sqlite3').Database} db
 * @param {string} message
 * @param {{ user?: object; branchId?: string; userId?: string }} ctx
 */
export function tryNativeErpTool(db, message, ctx) {
  const q = normalizeHelpQueryText(String(message || '').trim());
  const branchId = String(ctx.branchId || '').trim();
  const userId = String(ctx.userId || '').trim();
  const user = ctx.user;

  if (/\b(inventory|stock)\b/i.test(q)) {
    const productMatch = q.match(/\b(?:for|of)\s+([a-z0-9][a-z0-9\s-]{2,40})/i);
    const term = productMatch ? productMatch[1].trim() : q.replace(/.*\b(stock|inventory)\b/i, '').trim();
    if (!userMayQueryTables(user, ['products'])) {
      return clearanceDenied(user, 'inventory', user?.roleKey);
    }
    let sql = `SELECT product_id, name, stock_level, unit, branch_id FROM products WHERE name LIKE ? LIMIT 20`;
    const args = [`%${term.slice(0, 60)}%`];
    if (branchId) {
      sql = `SELECT product_id, name, stock_level, unit, branch_id FROM products WHERE branch_id = ? AND name LIKE ? LIMIT 20`;
      args.unshift(branchId);
    }
    const rows = db.prepare(sql).all(...args);
    return {
      ok: true,
      tool: 'inventory_lookup',
      rows,
      summary: rows.length
        ? rows.map((r) => `${r.name}: ${r.stock_level} ${r.unit || ''} (${r.product_id})`).join('; ')
        : `No products matched "${term}".`,
    };
  }

  if (/\bopen refund|pending refund|refund count\b/i.test(q)) {
    if (!userMayQueryTables(user, ['customer_refunds'])) {
      return clearanceDenied(user, 'refunds', user?.roleKey);
    }
    let sql = `SELECT status, COUNT(*) AS c FROM customer_refunds WHERE LOWER(status) NOT IN ('paid','void','cancelled') GROUP BY status LIMIT 10`;
    const args = [];
    if (branchId) {
      sql = `SELECT status, COUNT(*) AS c FROM customer_refunds WHERE branch_id = ? AND LOWER(status) NOT IN ('paid','void','cancelled') GROUP BY status LIMIT 10`;
      args.push(branchId);
    }
    const rows = db.prepare(sql).all(...args);
    const total = rows.reduce((s, r) => s + (Number(r.c) || 0), 0);
    return {
      ok: true,
      tool: 'open_refunds',
      rows,
      summary: total ? `${total} open refund(s): ${rows.map((r) => `${r.status} (${r.c})`).join(', ')}` : 'No open refunds in your branch.',
    };
  }

  const qtLookup = tryQuotationLookup(db, message, ctx);
  if (qtLookup) return qtLookup;

  if (userId && /\bmy recent receipt|receipts i posted\b/i.test(q)) {
    if (!userMayQueryTables(user, ['ledger_entries'])) {
      return clearanceDenied(user, 'finance', user?.roleKey);
    }
    const rows = db
      .prepare(
        `SELECT id, type, customer_name, amount_ngn, quotation_ref, at_iso FROM ledger_entries
         WHERE created_by_user_id = ? ORDER BY at_iso DESC LIMIT 10`
      )
      .all(userId);
    return {
      ok: true,
      tool: 'my_receipts',
      rows,
      summary: rows.length
        ? rows.map((r) => `${r.at_iso?.slice(0, 10)} ${r.type} ₦${r.amount_ngn} ${r.customer_name || ''}`).join('; ')
        : 'No recent ledger entries found for you.',
    };
  }

  return null;
}

/**
 * LLM text-to-SQL with guardrails (GPT-4o / Claude via OpenAI-compatible endpoint).
 * @param {import('better-sqlite3').Database} db
 * @param {string} message
 * @param {{ user?: object; branchId?: string; userId?: string }} ctx
 */
export async function runTextToSqlQuery(db, message, ctx) {
  const cfg = readAiAssistConfig();
  if (!cfg.enabled) return { ok: false, error: 'AI not configured for text-to-SQL.' };

  const system = [
    'You are a read-only SQL assistant for Zarewa ERP. Output JSON only:',
    '{"sql":"SELECT ... LIMIT n"}',
    'Rules: SELECT only, allowlisted tables only, always LIMIT <= 50, no semicolons.',
    ERP_SCHEMA_EXCERPT,
    ctx.branchId ? `User branch_id filter when table has branch_id: ${ctx.branchId}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const { ok, json } = await postChatCompletions(cfg, {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(message || '').slice(0, 2000) },
    ],
    max_tokens: 400,
    temperature: 0,
  });

  if (!ok) return { ok: false, error: 'SQL generation failed.' };

  let parsed;
  try {
    const content = normalizeCompletionContent(json?.choices?.[0]?.message);
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'Could not parse SQL from model.' };
  }

  const sql = String(parsed?.sql || '').trim();
  const validated = validateReadOnlySql(sql);
  if (!validated.ok) return { ok: false, error: validated.error };

  if (!userMayQueryTables(ctx.user, validated.tables)) {
    return deniedForTables(ctx.user, validated.tables, ctx.user?.roleKey, message);
  }

  const scoped = applyScopeFilters(sql, {
    branchId: ctx.branchId,
    userId: ctx.userId,
    tables: validated.tables,
    permissions: ctx.user?.permissions,
  });

  try {
    const rows = db.prepare(scoped).all();
    return {
      ok: true,
      tool: 'text_to_sql',
      sql: scoped,
      rows: rows.slice(0, 50),
      summary: rows.length ? `${rows.length} row(s) returned.` : 'Query returned no rows.',
    };
  } catch (e) {
    return { ok: false, error: `Query rejected: ${String(e.message || e).slice(0, 200)}` };
  }
}

/**
 * ERP bridge entry — native tools first, then guarded text-to-SQL.
 */
export async function queryErpData(db, message, ctx) {
  const native = tryNativeErpTool(db, message, ctx);
  if (native) return native;
  return runTextToSqlQuery(db, message, ctx);
}

/**
 * @param {{ summary?: string; rows?: unknown[]; error?: string }} erpResult
 * @param {string} userQuestion
 */
export function synthesizeErpAnswer(erpResult) {
  if (!erpResult?.ok) {
    if (erpResult?.code === 'CLEARANCE_DENIED' && erpResult.error) {
      return erpResult.error;
    }
    return `I couldn't fetch live ERP data: **${erpResult?.error || 'unknown error'}**. You can still ask **how do I…** for the workflow steps, or try a full document id (example **QT-KD-26-0036**).`;
  }
  const lines = ['**From your Zarewa data (read-only):**', '', erpResult.summary || 'No summary.'];
  if (Array.isArray(erpResult.rows) && erpResult.rows.length > 0 && erpResult.rows.length <= 5) {
    lines.push('', '```', JSON.stringify(erpResult.rows, null, 2).slice(0, 1500), '```');
  }
  lines.push('', '_Data respects your role and branch permissions._');
  return lines.join('\n');
}
