#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

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

const env = commentedMysql(path.join(process.cwd(), '.env.local'));
Object.assign(process.env, {
  ZAREWA_MYSQL_HOST: env.ZAREWA_MYSQL_HOST,
  ZAREWA_MYSQL_PORT: env.ZAREWA_MYSQL_PORT || '3306',
  ZAREWA_MYSQL_USER: env.ZAREWA_MYSQL_USER,
  ZAREWA_MYSQL_PASSWORD: env.ZAREWA_MYSQL_PASSWORD || '',
  ZAREWA_MYSQL_DATABASE: env.ZAREWA_MYSQL_DATABASE,
  ZAREWA_ALLOW_PROD_MYSQL_SCRIPT: '1',
});

const { createMysqlDatabase, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const db = createMysqlDatabase(mysqlConfigFromEnv(), { reset: false, bootstrap: false });

const ids = ['RF-KD-26-9737', 'RF-KD-26-9537', 'RF-KD-26-9720', 'RF-KD-26-9680', 'RF-KD-26-9690', 'RF-KD-26-9594'];
try {
  for (const id of ids) {
    const r = db
      .prepare(
        `SELECT refund_id, status, approved_amount_ngn, paid_amount_ngn, payment_note, payee_name,
                split_distributions_json FROM customer_refunds WHERE refund_id = ?`
      )
      .get(id);
    const e = db
      .prepare(
        `SELECT id, amount_ngn, open_ngn, note FROM refund_company_retention_entries WHERE source_id = ?`
      )
      .all(id);
    console.log(
      JSON.stringify(
        {
          refundId: id,
          status: r?.status,
          approved: r?.approved_amount_ngn,
          paid: r?.paid_amount_ngn,
          payee: r?.payee_name,
          note: String(r?.payment_note || '').slice(0, 260),
          split: String(r?.split_distributions_json || '').slice(0, 500),
          ledger: e,
        },
        null,
        2
      )
    );
  }
} finally {
  try {
    db.close?.();
  } catch {
    /* ignore */
  }
}
