#!/usr/bin/env node
/**
 * Yusuf case INV-KD-26-0001 — audited plan. Does not write unless --apply.
 *
 * Dry run (no database):
 *   node scripts/yusuf-inv-kd-26-0001.mjs
 *
 * Read-only check against the database in .env.local (commented ZAREWA_MYSQL_* lines):
 *   node scripts/yusuf-inv-kd-26-0001.mjs --check
 *
 * Apply (you run this; it opens the case and places the hold):
 *   node scripts/yusuf-inv-kd-26-0001.mjs --apply --officer USR-...
 *
 * --officer is the MD's nominee. The Branch Manager is on these records and cannot be the case officer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const plan = JSON.parse(
  fs.readFileSync(path.join(root, 'exports', 'yusuf-inv-kd-26-0001.plan.json'), 'utf8')
);
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check') || apply;
const officerFlag = process.argv.indexOf('--officer');
const officerId = officerFlag >= 0 ? String(process.argv[officerFlag + 1] || '').trim() : '';

console.log(`${apply ? 'APPLY' : 'DRY-RUN'} ${plan.id}`);
console.log(plan.title);
console.log(plan.note);
console.log('Links:');
for (const link of plan.links) console.log(`  ${link.recordKind}  ${link.recordId}`);
console.log(
  `Expected exposure ₦${plan.expectedMoney.exposureNgn.toLocaleString('en-NG')} ` +
    `(goods ₦${plan.expectedMoney.goodsReleasedNgn.toLocaleString('en-NG')} + paid out ₦${plan.expectedMoney.moneyPaidOutNgn.toLocaleString('en-NG')})`
);
console.log(`September write-off ₦${plan.doNotWriteOffNgn.toLocaleString('en-NG')} is NOT posted by this plan.`);

if (!check) {
  console.log('\nNo database was contacted.');
  console.log('Read-only check:  node scripts/yusuf-inv-kd-26-0001.mjs --check');
  console.log('Apply:            node scripts/yusuf-inv-kd-26-0001.mjs --apply --officer USR-...');
  process.exit(0);
}

function commentedMysql(envPath) {
  const map = {};
  if (!fs.existsSync(envPath)) return map;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!map[m[1]]) map[m[1]] = v;
  }
  return map;
}

const env = commentedMysql(path.join(root, '.env.local'));
for (const key of ['ZAREWA_MYSQL_HOST', 'ZAREWA_MYSQL_PORT', 'ZAREWA_MYSQL_USER', 'ZAREWA_MYSQL_PASSWORD', 'ZAREWA_MYSQL_DATABASE']) {
  if (env[key] && !process.env[key]) process.env[key] = env[key];
}
if (apply) process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const cfg = mysqlConfigFromEnv();
console.log(`\nDatabase ${databaseLabel(cfg)} (${apply ? 'apply' : 'read only'})`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

const lookups = {
  customer: ['customers', 'customer_id'],
  quotation: ['quotations', 'id'],
  receipt: ['sales_receipts', 'id'],
  production_job: ['production_jobs', 'job_id'],
  refund: ['customer_refunds', 'refund_id'],
};

const problems = [];
for (const link of plan.links) {
  let row = null;
  if (link.recordKind === 'receipt') {
    row = db
      .prepare(`SELECT id FROM sales_receipts WHERE id = ? OR ledger_entry_id = ?`)
      .get(link.recordId, link.recordId);
  } else {
    const [table, column] = lookups[link.recordKind];
    row = db.prepare(`SELECT ${column} AS id FROM ${table} WHERE ${column} = ?`).get(link.recordId);
  }
  if (!row) problems.push(`missing ${link.recordKind} ${link.recordId}`);
  else console.log(`  found ${link.recordKind} ${link.recordId}`);
}
let existing = null;
try {
  existing = db.prepare(`SELECT id, status FROM investigation_cases WHERE id = ?`).get(plan.id);
} catch {
  existing = null;
}
if (existing) problems.push(`${plan.id} already exists (${existing.status})`);

if (!apply) {
  if (problems.length) {
    console.error('\nCheck failed:');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  console.log('\nCheck passed. Nothing was written.');
  process.exit(0);
}

if (!officerId) {
  console.error('\n--officer USR-... is required. The MD names the case officer.');
  process.exit(1);
}
if (problems.length) {
  console.error('\nApply refused:');
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

const md = db
  .prepare(`SELECT id, display_name, role_key FROM app_users WHERE role_key = 'md' AND status = 'active' ORDER BY id LIMIT 1`)
  .get();
if (!md) {
  console.error('No active MD user found. Apply needs an MD actor.');
  process.exit(1);
}

const { openInvestigationPlatformCase } = await import('../server/office/investigationPlatformOps.js');
const result = openInvestigationPlatformCase(
  db,
  {
    id: plan.id,
    explicitId: true,
    title: plan.title,
    branchId: plan.branchId,
    status: plan.status,
    caseType: plan.caseType,
    caseOfficerUserId: officerId,
    links: plan.links,
    note: plan.note,
  },
  { id: md.id, roleKey: 'md', displayName: md.display_name, permissions: [] }
);

if (!result.ok) {
  console.error(result.error || 'Apply failed.');
  process.exit(1);
}
console.log(`Opened ${result.case.id}. Hold active: ${result.case.holdActive}. Exposure ₦${result.case.money.exposureNgn.toLocaleString('en-NG')}.`);
console.log(`Audit: investigation.platform.create ${result.case.id}`);
