// Yola (BR-YL) 12 Oct 2026 count – RESUME (16 Oct 2026). Runs ON THE SERVER, from the backend folder:
//   cd <backend> && node ~/yl-resume.mjs            → PREVIEW (read-only session, writes nothing to the DB)
//   cd <backend> && node ~/yl-resume.mjs --go       → POST (pre-approved by OM 16 Oct; STOP-rule coils are skipped and listed)
// Method: app physical count (COIL_COUNT_VARIANCE), dated today, one transaction per coil.
// SET target = weighed kg − kg consumed by jobs completed after the count (12 Oct 08:00 WAT = 07:00Z).
// REMOVE target = 0, except 8414/8415 (held, PRO-YL-26-0245). 6170 and 7263 were posted on 14 Oct → skipped.
// Resumable: every posted coil is appended to PROGRESS; a re-run skips coils in PROGRESS or already marked in the DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GO = process.argv.includes('--go');
const ROOT = process.cwd();
if (!fs.existsSync(path.join(ROOT, 'server', 'operations', 'coilPhysicalCountOps.js'))) {
  console.error(`Run this from the backend folder (server/operations/coilPhysicalCountOps.js not found under ${ROOT}).`);
  process.exit(3);
}
const S = (p) => pathToFileURL(path.join(ROOT, 'server', p)).href;
const { loadProjectEnv } = await import(S('loadProjectEnv.js'));
loadProjectEnv();
// --prod-from-local-env: use the commented ZAREWA_MYSQL_* lines in .env.local (live DB, as run 3 did). Values are never printed.
if (process.argv.includes('--prod-from-local-env')) {
  const m = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
    const x = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))\s*=\s*(.*)$/);
    if (!x) continue;
    let v = x[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    m[x[1]] = v;
  }
  if (!m.ZAREWA_MYSQL_HOST || !m.ZAREWA_MYSQL_DATABASE) { console.error('No commented ZAREWA_MYSQL_* block in .env.local'); process.exit(3); }
  for (const k of ['HOST', 'USER', 'PASSWORD', 'DATABASE']) process.env[`ZAREWA_MYSQL_${k}`] = m[`ZAREWA_MYSQL_${k}`] || '';
  process.env.ZAREWA_MYSQL_PORT = m.ZAREWA_MYSQL_PORT || '3306';
}
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';
const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(S('mysqlDatabase.js'));
const { postCoilPhysicalCount } = await import(S('operations/coilPhysicalCountOps.js'));

const B = 'BR-YL';
const TODAY = '2026-10-16';
const COUNT_AT = '2026-10-12T07:00:00'; // 12 Oct 08:00 WAT
const EXPORT_AT = '2026-10-12T14:26:00'; // ERP export behind the file's ERP kg (12 Oct 15:26 WAT)
const COUNTED_BY = 'Yola factory count 12 Oct 2026';
const SET_REASON = 'Yola recalibrated-scale count 12 Oct 2026';
const REM_REASON = 'Not in Yola factory – 12 Oct 2026 count';
const HOLD = 'Stained – second grade';
const MARK = '12 Oct 2026 count (posted 16 Oct)';
const HELD = new Set(['8414', '8415']);
const DONE_14OCT = new Set(['6170', '7263']);
const CONFIRMED = { 'CL-26-8437': 1816, '8409': 2894 };
const OUTDIR = path.join(os.homedir(), 'yl-count-2026-10-16');
const PROGRESS = path.join(OUTDIR, 'progress.jsonl');
const LOG = path.join(OUTDIR, GO ? 'post.log' : 'preview.log');
const num = (v) => (v == null || v === '' ? 0 : Number(v));
const r0 = (n) => Math.round(num(n) * 1000) / 1000;
fs.mkdirSync(OUTDIR, { recursive: true });
const log = (m) => { const l = `${new Date().toISOString()} ${m}`; fs.appendFileSync(LOG, l + '\n'); console.log(l); };

/** @type {{action:'SET'|'REMOVE', coil:string, tag:string, fileKg:number, weighed:number, stained:boolean, sheetNote:string}[]} */
const WORK = [
  {"action":"SET","coil":"6170","tag":"6170","fileKg":248,"weighed":248,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"7263","tag":"7363","fileKg":126,"weighed":117,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"7391","tag":"7391","fileKg":91,"weighed":91,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"7406","tag":"7406","fileKg":121,"weighed":120,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"7451","tag":"7451","fileKg":94,"weighed":94,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"7528","tag":"7528","fileKg":100,"weighed":100,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"7757","tag":"7757","fileKg":220,"weighed":221,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"7788","tag":"7788","fileKg":273,"weighed":165,"stained":false,"sheetNote":"7788: weighed 165, ERP 273 (−108). Re-weigh."},
  {"action":"SET","coil":"7791","tag":"7791","fileKg":333,"weighed":332,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8039","tag":"8039","fileKg":96,"weighed":96,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8056","tag":"8056","fileKg":92,"weighed":92,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8084","tag":"8084","fileKg":1924,"weighed":1924,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8085","tag":"8085","fileKg":109,"weighed":105,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8100","tag":"8100","fileKg":444,"weighed":444,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8114","tag":"8114","fileKg":166,"weighed":140,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8150","tag":"8361","fileKg":133,"weighed":134,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8152","tag":"8152","fileKg":158,"weighed":165,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8182","tag":"8182","fileKg":132,"weighed":132,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8187","tag":"8187","fileKg":214,"weighed":111,"stained":false,"sheetNote":"8187: weighed 111, ERP 214 (−103). Re-weigh."},
  {"action":"SET","coil":"8207","tag":"8270","fileKg":122,"weighed":122,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8208","tag":"8208","fileKg":397,"weighed":397,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8209","tag":"8209","fileKg":57,"weighed":57,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8220","tag":"8220","fileKg":965,"weighed":949,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8222","tag":"8272","fileKg":237,"weighed":218,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8223","tag":"8223","fileKg":163,"weighed":161,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8226","tag":"8226","fileKg":45,"weighed":41,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8231","tag":"8231","fileKg":81,"weighed":81,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8232","tag":"8232","fileKg":79,"weighed":79,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8233","tag":"8233","fileKg":126,"weighed":126,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8234","tag":"8234","fileKg":126,"weighed":124,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8235","tag":"8235","fileKg":302,"weighed":293,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8244","tag":"8244","fileKg":140,"weighed":134,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8249","tag":"8249","fileKg":111,"weighed":106,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8259","tag":"8259","fileKg":198,"weighed":198,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8267","tag":"8267","fileKg":140,"weighed":140,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8272","tag":"8272","fileKg":2593,"weighed":1547,"stained":false,"sheetNote":"Tag 8272 Gray Beige 0.18 (handwritten confirmation). ERP 8272 was 2,593 kg; weighed 1,547."},
  {"action":"SET","coil":"8273","tag":"8373","fileKg":103,"weighed":103,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8275","tag":"8275","fileKg":358,"weighed":325,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8278","tag":"8278","fileKg":3875,"weighed":3855,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8287","tag":"8287","fileKg":135,"weighed":135,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8297","tag":"8292","fileKg":253,"weighed":240,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8301","tag":"8301","fileKg":131,"weighed":131,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8323","tag":"8323","fileKg":229,"weighed":225,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8332","tag":"8332","fileKg":448,"weighed":411,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8340","tag":"8340","fileKg":161,"weighed":158,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8344","tag":"8344","fileKg":108,"weighed":104,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8346","tag":"8346","fileKg":474,"weighed":460,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8363","tag":"8363","fileKg":1654,"weighed":118,"stained":true,"sheetNote":"8363 (stained list, Gray Beige 0.24, 118 kg): ERP 8363 is Gray Beige 0.20, 1,654 kg. Read the tag and gauge."},
  {"action":"SET","coil":"8364","tag":"8364","fileKg":117,"weighed":117,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8367","tag":"8367","fileKg":165,"weighed":152,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8368","tag":"8421","fileKg":1230,"weighed":1233,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8374","tag":"8354","fileKg":185,"weighed":187,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8375","tag":"8395","fileKg":558,"weighed":537,"stained":false,"sheetNote":"Tag 8395 not in ERP. TC Red 0.28, 537 kg matched to ERP 8375 (TC Red 0.28, 558 kg)."},
  {"action":"SET","coil":"8381","tag":"8381","fileKg":907,"weighed":881,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8382","tag":"8382","fileKg":1373,"weighed":1352,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8385","tag":"8385","fileKg":123,"weighed":124,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8388","tag":"8388","fileKg":96,"weighed":94,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8389","tag":"8389","fileKg":124,"weighed":124,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8392","tag":"8392","fileKg":2160,"weighed":512,"stained":false,"sheetNote":"Tag 8392 Bush Green 0.28. ERP 8392 was 2,160 kg; weighed 512."},
  {"action":"SET","coil":"8394","tag":"8394","fileKg":2645,"weighed":2327,"stained":false,"sheetNote":"8394 Traffic Black 0.24: weighed 2,327, ERP 2,645 (−318). Re-weigh."},
  {"action":"SET","coil":"8399","tag":"8399","fileKg":228,"weighed":216,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8401","tag":"8401","fileKg":897,"weighed":897,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8402","tag":"8402","fileKg":3436,"weighed":3383,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8403","tag":"8307","fileKg":143,"weighed":143,"stained":true,"sheetNote":""},
  {"action":"SET","coil":"8405","tag":"8405","fileKg":1798,"weighed":1749,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8406","tag":"8406","fileKg":3411,"weighed":3349,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8408","tag":"8408","fileKg":2336,"weighed":2295,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8409","tag":"8409","fileKg":2998,"weighed":2933,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8410","tag":"8410","fileKg":3534,"weighed":3477,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8412","tag":"8412","fileKg":3375,"weighed":3326,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8413","tag":"8413","fileKg":3350,"weighed":3293,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8417","tag":"8417","fileKg":165,"weighed":124,"stained":false,"sheetNote":"8417: weighed 124, ERP 165 (−41). Re-weigh."},
  {"action":"SET","coil":"8418","tag":"8418","fileKg":3378,"weighed":3321,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8427","tag":"8427","fileKg":3397,"weighed":3348,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8436","tag":"8436","fileKg":3237,"weighed":3176,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"8444","tag":"8444","fileKg":2460,"weighed":2392,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"CL-26-8424","tag":"8424","fileKg":1097,"weighed":1079,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"CL-26-8426","tag":"8426","fileKg":2700,"weighed":2654,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"CL-26-8428","tag":"8428","fileKg":1207,"weighed":693,"stained":false,"sheetNote":"8428 P Red 0.24: weighed 693, ERP 1,207 (−514). Re-weigh; which jobs ran on it?"},
  {"action":"SET","coil":"CL-26-8429","tag":"8425","fileKg":3237,"weighed":3181,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"CL-26-8431","tag":"8431","fileKg":2885,"weighed":2043,"stained":false,"sheetNote":"Tag 8431 (number unclear). ERP 8431 is Bush Green 0.24; count says 0.28 – confirm gauge."},
  {"action":"SET","coil":"CL-26-8433","tag":"8433","fileKg":205,"weighed":201,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"CL-26-8434","tag":"8434","fileKg":3503,"weighed":3162,"stained":false,"sheetNote":"8434 P Red 0.24: weighed 3,162, ERP 3,503 (−341). Re-weigh."},
  {"action":"SET","coil":"CL-26-8435","tag":"8272","fileKg":3333,"weighed":2483,"stained":false,"sheetNote":"Tag reads \"8272\" but 8272 is the 0.18 coil. Gray Beige 0.24 2,483 kg matched to unweighed ERP 8435 (Gray Beige 0.24, 3,333 kg)."},
  {"action":"SET","coil":"CL-26-8437","tag":"8437","fileKg":1861,"weighed":3266,"stained":false,"sheetNote":"8437 Ivory 0.28: weighed 3,266 = full coil, ERP 1,861. Was 8437 ever opened? Which coil ran the jobs booked on 8437?"},
  {"action":"SET","coil":"CL-26-8438","tag":"8438","fileKg":3298,"weighed":3236,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"CL-26-8439","tag":"8439","fileKg":3152,"weighed":3081,"stained":false,"sheetNote":""},
  {"action":"SET","coil":"CL-26-8443","tag":"8443","fileKg":3247,"weighed":3190,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8362","tag":"","fileKg":6793,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"CL-26-8442","tag":"","fileKg":3574,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"CL-26-8441","tag":"","fileKg":3458,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"CL-26-8421","tag":"","fileKg":2258,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8425","tag":"","fileKg":1999,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8354","tag":"","fileKg":555,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8329","tag":"","fileKg":553,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8415","tag":"","fileKg":364,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8414","tag":"","fileKg":343,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8151","tag":"","fileKg":263,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"CL-26-8440","tag":"","fileKg":251,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"STK-L99-gb-028mm","tag":"","fileKg":219,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8420","tag":"","fileKg":202,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8361","tag":"","fileKg":193,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8373","tag":"","fileKg":177,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8298","tag":"","fileKg":163,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8372","tag":"","fileKg":162,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8358","tag":"","fileKg":156,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8153","tag":"","fileKg":154,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8345","tag":"","fileKg":146,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8347","tag":"","fileKg":144,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8370","tag":"","fileKg":131,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8348","tag":"","fileKg":99,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8335","tag":"","fileKg":99,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8378","tag":"","fileKg":90,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8411","tag":"","fileKg":89,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"CL-26-8430","tag":"","fileKg":89,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8386","tag":"","fileKg":89,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8422","tag":"","fileKg":88,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8045","tag":"","fileKg":88,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8407","tag":"","fileKg":87,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8423","tag":"","fileKg":75,"weighed":0,"stained":false,"sheetNote":""},
  {"action":"REMOVE","coil":"8237","tag":"","fileKg":33,"weighed":0,"stained":false,"sheetNote":""}
];

const cfg = mysqlConfigFromEnv();
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
if (!GO) db.exec('SET SESSION TRANSACTION READ ONLY');
const g = (s, ...a) => db.prepare(s).get(...a);
const q = (s, ...a) => db.prepare(s).all(...a);
log(`=== ${GO ? 'POST' : 'PREVIEW (read-only)'} ${databaseLabel(cfg)} backend=${ROOT}`);

const progressDone = new Set(
  fs.existsSync(PROGRESS)
    ? fs.readFileSync(PROGRESS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).coil)
    : []
);

// ---- Build per-coil plan from live data
const stops = [];
const warns = [];
const rows = [];
for (const w of WORK) {
  const c = g(`SELECT * FROM coil_lots WHERE coil_no = ?`, w.coil);
  const row = { ...w, live: null, reserved: null, used: 0, jobs: '', target: null, variance: null, status: '' };
  rows.push(row);
  if (!c) { stops.push(`${w.coil}: not found`); row.status = 'STOP not found'; continue; }
  if (c.branch_id !== B) { stops.push(`${w.coil}: on ${c.branch_id}`); row.status = 'STOP other branch'; continue; }
  row.live = r0(c.qty_remaining);
  row.reserved = r0(c.qty_reserved);
  row.unitCost = num(c.unit_cost_ngn_per_kg);
  row.holdNow = c.stock_hold || '';
  const jobs = q(
    `SELECT j.job_id, j.status, j.completed_at_iso, pjc.consumed_weight_kg kg
       FROM production_job_coils pjc JOIN production_jobs j ON j.job_id = pjc.job_id
      WHERE pjc.coil_no = ? AND j.status = 'Completed' AND j.completed_at_iso >= ?
      ORDER BY j.completed_at_iso`,
    w.coil, COUNT_AT
  );
  row.used = r0(jobs.reduce((s, j) => s + num(j.kg), 0));
  row.jobs = jobs.map((j) => `${j.job_id} ${String(j.completed_at_iso).slice(0, 16)} ${r0(j.kg)}kg`).join('; ');
  const usedAfterExport = r0(jobs.filter((j) => String(j.completed_at_iso) >= EXPORT_AT).reduce((s, j) => s + num(j.kg), 0));
  row.unexplained = r0(Math.min(Math.abs(row.live - (w.fileKg - row.used)), Math.abs(row.live - (w.fileKg - usedAfterExport))));
  const other = q(
    `SELECT id, type, qty, date_iso FROM stock_movements
      WHERE ref = ? AND at_iso >= ? AND type NOT IN ('COIL_CONSUMPTION')`,
    w.coil, COUNT_AT
  );

  if (DONE_14OCT.has(w.coil)) { row.status = 'SKIP posted 14 Oct'; continue; }
  if (w.action === 'REMOVE' && HELD.has(w.coil)) { row.status = 'SKIP held (PRO-YL-26-0245)'; continue; }
  const marked = String(c.material_origin_note || '').includes(MARK);
  if (progressDone.has(w.coil) || marked) { row.status = 'SKIP already posted (resume)'; row.target = row.live; row.variance = 0; continue; }

  if (w.action === 'SET') {
    row.target = r0(w.weighed - row.used);
    if (row.target < 0) { stops.push(`${w.coil}: weighed ${w.weighed} − used ${row.used} < 0`); row.status = 'STOP negative target'; }
    if (CONFIRMED[w.coil] != null && Math.abs(row.target - CONFIRMED[w.coil]) > 0.5)
      stops.push(`${w.coil}: computed target ${row.target} ≠ confirmed ${CONFIRMED[w.coil]} (check the 08:00 cut-off)`);
  } else {
    row.target = 0;
    if (jobs.length) { stops.push(`${w.coil} (Remove): job(s) completed since the count – ${row.jobs}`); row.status = 'STOP ran since count'; }
  }
  if (row.reserved > row.target + 0.001) {
    stops.push(`${w.coil}: reserved ${row.reserved} kg > target ${row.target} kg`);
    row.status = row.status || 'STOP reserved > target';
  }
  if (row.unexplained > 0.5) {
    stops.push(`${w.coil}: live ${row.live} ≠ file ${w.fileKg} − jobs since count (${row.used}) or since export (${usedAfterExport}); off by ${row.unexplained} kg`);
    row.status = row.status || 'STOP live≠file unexplained';
  }
  if (other.length) warns.push(`${w.coil}: other movements since count – ${other.map((m) => `${m.id} ${m.type} ${m.qty} ${m.date_iso}`).join(', ')}`);
  row.variance = r0(row.target - row.live);
  row.varianceNgn = Math.round(row.variance * row.unitCost);
  row.status = row.status || 'POST';
}

// ---- Releases done earlier (verify only)
for (const cn of ['8362', '8354']) {
  const r = num(g(`SELECT qty_reserved FROM coil_lots WHERE coil_no = ?`, cn)?.qty_reserved);
  if (r > 0.001) {
    stops.push(`${cn}: still reserved ${r} kg – release not in place`);
    const row = rows.find((x) => x.coil === cn);
    if (row && row.status === 'POST') row.status = 'STOP still reserved';
  }
}
const j101 = q(`SELECT coil_no FROM production_job_coils WHERE job_id = 'PRO-YL-26-0101'`);
const j101s = g(`SELECT status FROM production_jobs WHERE job_id = 'PRO-YL-26-0101'`)?.status;
if (j101.length) stops.push(`PRO-YL-26-0101 still allocated: ${j101.map((x) => x.coil_no).join(', ')}`);
if (j101s !== 'Planned') warns.push(`PRO-YL-26-0101 status is ${j101s} (expected Planned)`);
const j245 = g(`SELECT status FROM production_jobs WHERE job_id = 'PRO-YL-26-0245'`)?.status;
warns.push(`PRO-YL-26-0245 status: ${j245}`);

// ---- Totals
const yl = g(`SELECT COUNT(*) coils, SUM(qty_remaining) kg FROM coil_lots WHERE branch_id = ? AND qty_remaining > 0`, B);
const toPost = rows.filter((r) => r.status === 'POST');
const sumVar = r0(toPost.reduce((s, r) => s + r.variance, 0));
const sumNgn = toPost.reduce((s, r) => s + (r.varianceNgn || 0), 0);
const nToZero = toPost.filter((r) => r.target <= 0.0001 && r.live > 0.0001).length;
const stainedHold = toPost.filter((r) => r.stained).length;
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const padL = (s, n) => String(s ?? '').padStart(n).slice(-n);
console.log('\n' + [pad('Action', 6), pad('Coil', 11), padL('Weighed', 8), padL('Used', 7), padL('Target', 8), padL('Live', 8), padL('Var', 8), pad(' St', 4), pad('Status', 28), 'Jobs since count'].join(' '));
for (const r of rows)
  console.log([pad(r.action, 6), pad(r.coil, 11), padL(r.action === 'SET' ? r.weighed : '', 8), padL(r.used || '', 7), padL(r.target, 8), padL(r.live, 8), padL(r.variance, 8), pad(r.stained ? ' Y' : '', 4), pad(r.status, 28), r.jobs].join(' '));
const after = { coils: num(yl.coils) - nToZero, kg: r0(num(yl.kg) + sumVar) };
console.log(`\nRows: ${rows.length} | to post ${toPost.length} (SET ${toPost.filter((r) => r.action === 'SET').length}, REMOVE ${toPost.filter((r) => r.action === 'REMOVE').length}) | skipped ${rows.length - toPost.length - rows.filter((r) => r.status.startsWith('STOP')).length} | stained holds ${stainedHold}`);
console.log(`Variance: ${sumVar} kg, ₦${sumNgn.toLocaleString('en-NG')} (coils with unit cost only)`);
console.log(`Yola now: ${yl.coils} coils, ${r0(yl.kg)} kg → after: ${after.coils} coils, ${after.kg} kg`);
console.log(`\nWARNINGS (${warns.length}):\n  ` + (warns.join('\n  ') || '—'));
console.log(`STOPS (${stops.length}):\n  ` + (stops.join('\n  ') || '—'));
fs.writeFileSync(path.join(OUTDIR, GO ? 'post-plan.json' : 'preview.json'), JSON.stringify({ at: new Date().toISOString(), yl, after, sumVar, sumNgn, warns, stops, rows }, null, 1));

if (!GO) { log(`preview written to ${OUTDIR}. Nothing was posted.`); process.exit(0); }
log(`posting ${toPost.length} coils; ${stops.length} STOP item(s) left out (listed above)`);

// ---- POST, one transaction per coil
let i = 0;
for (const r of toPost) {
  i += 1;
  for (let tries = 0; ; tries += 1) {
    try {
      const res = db.transaction(() => {
        db.exec('SET SESSION innodb_lock_wait_timeout = 120');
        const c = db.prepare(`SELECT qty_remaining, material_origin_note FROM coil_lots WHERE coil_no = ?`).get(r.coil);
        if (String(c?.material_origin_note || '').includes(MARK)) return { skipped: true };
        if (Math.abs(num(c.qty_remaining) - r.live) > 0.001) throw Object.assign(new Error(`${r.coil} live changed ${r.live} → ${c.qty_remaining} since preview`), { fatal: true });
        const pc = postCoilPhysicalCount(
          db,
          { coilNo: r.coil, countedKg: r.target, countedBy: COUNTED_BY, dateISO: TODAY, note: r.action === 'SET' ? `${SET_REASON} (weighed ${r.weighed} − ${r.used} used since count)` : REM_REASON },
          { workspaceBranchId: B, actor: null }
        );
        if (!pc.ok) throw Object.assign(new Error(pc.error), { fatal: true });
        const noteAdd = r.action === 'SET'
          ? `${MARK}: tag ${r.tag || '—'}; weighed ${r.weighed} − ${r.used} used since count${r.sheetNote ? '; ' + r.sheetNote : ''}`
          : `${MARK}: not in Yola factory (pending explanation from Yola)`;
        const note = [c.material_origin_note, noteAdd].filter(Boolean).join(' | ').slice(0, 1000);
        if (r.stained) db.prepare(`UPDATE coil_lots SET material_origin_note = ?, stock_hold = ? WHERE coil_no = ?`).run(note, HOLD, r.coil);
        else db.prepare(`UPDATE coil_lots SET material_origin_note = ? WHERE coil_no = ?`).run(note, r.coil);
        return pc;
      })();
      if (!res.skipped) fs.appendFileSync(PROGRESS, JSON.stringify({ coil: r.coil, at: new Date().toISOString(), book: res.bookKg, counted: res.countedKg, variance: res.varianceKg, mv: res.movementId, je: res.glJournalId, hold: r.stained }) + '\n');
      log(`[${i}/${toPost.length}] ${r.coil} ${res.skipped ? 'SKIP (already marked)' : `OK ${res.bookKg} → ${res.countedKg} (${res.varianceKg}) mv=${res.movementId || '-'} je=${res.glJournalId || '-'}${r.stained ? ' hold' : ''}`}`);
      break;
    } catch (e) {
      const msg = String(e?.message || e);
      if (!e?.fatal && /Lock wait timeout|Deadlock/i.test(msg) && tries < 3) { log(`[${i}] ${r.coil} lock wait – rolled back, retry ${tries + 1}/3`); continue; }
      log(`[${i}] ${r.coil} HALT (rolled back): ${msg.slice(0, 300)}. Re-run with --go to resume; posted coils are skipped.`);
      process.exit(1);
    }
  }
}
const yl2 = g(`SELECT COUNT(*) coils, SUM(qty_remaining) kg FROM coil_lots WHERE branch_id = ? AND qty_remaining > 0`, B);
for (const s of q(`SELECT CASE WHEN COALESCE(stock_hold,'') = '' THEN 'prime' ELSE stock_hold END grade, COUNT(*) coils, SUM(qty_remaining) kg, SUM(qty_reserved) reserved
                     FROM coil_lots WHERE branch_id = ? AND qty_remaining > 0 GROUP BY grade`, B))
  log(`  ${s.grade}: ${s.coils} coils, ${r0(s.kg)} kg (reserved ${r0(s.reserved)})`);
for (const p of q(`SELECT product_id, stock_level FROM products WHERE product_id IN (SELECT DISTINCT product_id FROM coil_lots WHERE branch_id = ?)`, B))
  log(`  product ${p.product_id} stock_level ${p.stock_level} (all branches)`);
log(`=== POST done. Yola now ${yl2.coils} coils, ${r0(yl2.kg)} kg (preview expected ${after.coils} / ${after.kg}).`);
process.exit(0);
