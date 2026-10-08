#!/usr/bin/env node
/**
 * READ-ONLY: list accessory names on quotations since May 2026 across branches,
 * matched to setup_quote_items + inventory_product_id. Prints ambiguous / missing links.
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

function commentedMysql(envPath) {
  const map = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map[m[1]] = v;
  }
  return map;
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const env = commentedMysql(path.join(process.cwd(), '.env.local'));
const host = process.env.ZAREWA_MYSQL_HOST_OVERRIDE || env.ZAREWA_MYSQL_HOST;
const database = env.ZAREWA_MYSQL_DATABASE;
if (!host || !database || !env.ZAREWA_MYSQL_USER) {
  console.error('Missing commented ZAREWA_MYSQL_* in .env.local');
  process.exit(1);
}

const c = await mysql.createConnection({
  host,
  port: Number(env.ZAREWA_MYSQL_PORT || 3306),
  user: env.ZAREWA_MYSQL_USER,
  password: env.ZAREWA_MYSQL_PASSWORD || '',
  database,
  connectTimeout: 30000,
  dateStrings: true,
});

const since = process.env.SINCE || '2026-05-01';
console.log(`[audit] host=${host} db=${database} since=${since}`);

const [setupAcc] = await c.query(
  `SELECT item_id, name, unit, inventory_product_id, active
   FROM setup_quote_items WHERE item_type = 'accessory' ORDER BY name`
);
const byExact = new Map();
const byNorm = new Map();
for (const s of setupAcc) {
  byExact.set(String(s.name).trim().toLowerCase(), s);
  const k = normName(s.name);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push(s);
}

const [quotes] = await c.query(
  `SELECT id, date_iso, branch_id, lines_json
   FROM quotations
   WHERE date_iso >= ?
     AND IFNULL(archived,0) = 0
     AND lines_json IS NOT NULL AND lines_json != ''`,
  [since]
);

const agg = new Map();
for (const q of quotes) {
  let lines;
  try {
    lines = JSON.parse(q.lines_json);
  } catch {
    continue;
  }
  for (const a of Array.isArray(lines?.accessories) ? lines.accessories : []) {
    const name = String(a?.name ?? a?.itemName ?? a?.label ?? '').trim();
    if (!name) continue;
    const itemId = String(a?.setupQuoteItemId || a?.itemId || a?.quoteItemId || a?.id || '').trim();
    let row = agg.get(name);
    if (!row) {
      row = { name, count: 0, branches: new Set(), itemIds: new Set() };
      agg.set(name, row);
    }
    row.count += 1;
    if (q.branch_id) row.branches.add(q.branch_id);
    if (itemId) row.itemIds.add(itemId);
  }
}

const rows = [...agg.values()]
  .map((r) => {
    const exact = byExact.get(r.name.toLowerCase());
    const normHits = byNorm.get(normName(r.name)) || [];
    let status = 'OK';
    let setup = exact || (normHits.length === 1 ? normHits[0] : null);
    if (!setup && normHits.length > 1) status = 'AMBIGUOUS';
    else if (!setup) status = 'MISSING_MASTER';
    else if (!String(setup.inventory_product_id || '').trim()) status = 'NO_STOCK_LINK';
    else if (normHits.length > 1 && !exact) status = 'AMBIGUOUS';
    return {
      accessory_name: r.name,
      quotation_line_count: r.count,
      branches: [...r.branches].sort().join(','),
      quote_item_ids_seen: [...r.itemIds].join('|'),
      setup_item_id: setup?.item_id || '',
      inventory_product_id: setup?.inventory_product_id || '',
      status,
      norm_match_count: normHits.length,
    };
  })
  .sort((a, b) => b.quotation_line_count - a.quotation_line_count || a.accessory_name.localeCompare(b.accessory_name));

console.log('\n=== All accessory names since', since, '===');
console.table(rows);

const problems = rows.filter((r) => r.status !== 'OK');
console.log('\n=== Needs attention ===');
console.table(problems);

const out = path.resolve('exports', 'quote-accessory-audit-since-may.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ since, rows, problems }, null, 2));
console.log(`[audit] wrote ${out}`);

await c.end();
