#!/usr/bin/env node
/**
 * READ-ONLY: Find coils where stock-check scrap/adjust used theoretical kg/m
 * (or ERP on-hand diverges from last completed job closing kg).
 *
 * Flags:
 *  A) COIL_SCRAP / adjust_remove with "stock check" / "metres ×" / "kg/m" wording
 *  B) Available coils with completed jobs where |onHand − lastClose| > threshold
 *     and net scrap (COIL_SCRAP+COIL_RETURN+…) explains most of the gap
 */
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
process.env.ZAREWA_MYSQL_HOST = env.ZAREWA_MYSQL_HOST;
process.env.ZAREWA_MYSQL_PORT = env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = env.ZAREWA_MYSQL_USER;
process.env.ZAREWA_MYSQL_PASSWORD = env.ZAREWA_MYSQL_PASSWORD || '';
process.env.ZAREWA_MYSQL_DATABASE = env.ZAREWA_MYSQL_DATABASE;
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);

const BRANCH = process.argv[2] || 'BR-KD';
const GAP_KG = Number(process.argv[3] || 20); // material gaps only

function roundKg3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

const cfg = mysqlConfigFromEnv();
console.log(`[scan] READ-ONLY ${databaseLabel(cfg)} branch=${BRANCH} gap>=${GAP_KG}kg`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  // A) Theoretical / stock-check scrap language
  const scrapMoves = db
    .prepare(
      `SELECT id, type, qty, detail, ref, date_iso, at_iso, branch_id
       FROM stock_movements
       WHERE type IN ('COIL_SCRAP', 'COIL_RETURN', 'ADJUSTMENT', 'COIL_COUNT_VARIANCE')
         AND (
           detail LIKE '%stock check%'
           OR detail LIKE '%Stock check%'
           OR detail LIKE '%metres ×%'
           OR detail LIKE '%metres x%'
           OR detail LIKE '%kg/m%'
           OR detail LIKE '%ERP above%'
           OR detail LIKE '%ERP below%'
         )
       ORDER BY at_iso DESC
       LIMIT 500`
    )
    .all();

  const scrapByCoil = new Map();
  for (const m of scrapMoves) {
    const coilNo = String(m.ref || '').trim();
    if (!coilNo.startsWith('CL-') && !coilNo.startsWith('CL')) continue;
    // Prefer coil_no from detail when ref is not a coil
    let cn = coilNo;
    if (!/^CL/i.test(cn)) {
      const mm = String(m.detail || '').match(/\b(CL-[A-Z0-9-]+)\b/i);
      if (mm) cn = mm[1];
      else continue;
    }
    if (!scrapByCoil.has(cn)) scrapByCoil.set(cn, []);
    scrapByCoil.get(cn).push(m);
  }

  // Control events with same language
  let controlEvents = [];
  try {
    controlEvents = db
      .prepare(
        `SELECT id, coil_no, event_kind, kg_coil_delta, scrap_reason, note, created_at_iso, branch_id, actor_display
         FROM coil_control_events
         WHERE (
           scrap_reason LIKE '%stock check%' OR note LIKE '%stock check%'
           OR scrap_reason LIKE '%kg/m%' OR note LIKE '%kg/m%'
           OR scrap_reason LIKE '%ERP above%' OR note LIKE '%ERP above%'
           OR scrap_reason LIKE '%metres%' OR note LIKE '%metres%'
         )
         ORDER BY created_at_iso DESC
         LIMIT 500`
      )
      .all();
  } catch (e) {
    console.log('control_events skip', e.message);
  }

  for (const e of controlEvents) {
    const cn = String(e.coil_no || '').trim();
    if (!cn) continue;
    if (!scrapByCoil.has(cn)) scrapByCoil.set(cn, []);
    scrapByCoil.get(cn).push({
      id: e.id,
      type: `CCR:${e.event_kind}`,
      qty: e.kg_coil_delta,
      detail: e.note || e.scrap_reason,
      ref: cn,
      date_iso: String(e.created_at_iso || '').slice(0, 10),
      at_iso: e.created_at_iso,
      branch_id: e.branch_id,
      actor: e.actor_display,
      source: 'coil_control_events',
    });
  }

  // B) Last job closing vs on-hand for Available coils in branch
  const coils = db
    .prepare(
      `SELECT coil_no, colour, gauge_label, branch_id, product_id,
              qty_remaining, current_weight_kg, qty_reserved, qty_received, weight_kg, current_status
       FROM coil_lots
       WHERE branch_id = ?
         AND LOWER(TRIM(COALESCE(current_status,''))) IN ('available','partial','in use','in_use','reserved')
       ORDER BY coil_no`
    )
    .all(BRANCH);

  // production_job_coils schema
  const pjcCols = db.prepare(`PRAGMA table_info(production_job_coils)`).all().map((c) => c.name);
  const hasCompletedAt = db
    .prepare(`PRAGMA table_info(production_jobs)`)
    .all()
    .some((c) => c.name === 'completed_at_iso');

  const lastCloseStmt = db.prepare(
    `SELECT pjc.coil_no, pjc.job_id, pjc.opening_weight_kg, pjc.closing_weight_kg,
            pjc.consumed_weight_kg, pjc.meters_produced, pj.status AS job_status
            ${hasCompletedAt ? ', pj.completed_at_iso' : ''}
     FROM production_job_coils pjc
     JOIN production_jobs pj ON pj.job_id = pjc.job_id
     WHERE pjc.coil_no = ?
       AND LOWER(TRIM(COALESCE(pj.status,''))) IN ('completed','complete','done')
       AND pjc.closing_weight_kg IS NOT NULL
     ORDER BY ${hasCompletedAt ? 'pj.completed_at_iso DESC,' : ''} pjc.id DESC
     LIMIT 1`
  );

  const jobSumStmt = db.prepare(
    `SELECT COALESCE(SUM(pjc.consumed_weight_kg), 0) AS prod_used,
            COALESCE(SUM(pjc.meters_produced), 0) AS metres
     FROM production_job_coils pjc
     JOIN production_jobs pj ON pj.job_id = pjc.job_id
     WHERE pjc.coil_no = ?
       AND LOWER(TRIM(COALESCE(pj.status,''))) IN ('completed','complete','done')`
  );

  const ancillaryStmt = db.prepare(
    `SELECT type, COALESCE(SUM(qty),0) AS kg
     FROM stock_movements
     WHERE ref = ?
       AND type IN ('COIL_SCRAP','COIL_RETURN','COIL_COUNT_VARIANCE','COIL_TO_STAINED','ADJUSTMENT')
     GROUP BY type`
  );

  const candidates = [];

  for (const coil of coils) {
    const coilNo = coil.coil_no;
    const onHand = roundKg3(Math.max(0, Number(coil.qty_remaining) || Number(coil.current_weight_kg) || 0));
    const received = roundKg3(Math.max(0, Number(coil.qty_received) || Number(coil.weight_kg) || 0));
    if (received <= 0) continue;

    const last = lastCloseStmt.get(coilNo);
    if (!last) continue;
    const lastClose = roundKg3(Number(last.closing_weight_kg) || 0);
    const gap = roundKg3(lastClose - onHand);
    if (Math.abs(gap) < GAP_KG) continue;

    const sums = jobSumStmt.get(coilNo);
    const prodUsed = roundKg3(Number(sums?.prod_used) || 0);
    const metres = roundKg3(Number(sums?.metres) || 0);
    const expectedFromJobs = roundKg3(received - prodUsed);

    const ancRows = ancillaryStmt.all(coilNo);
    const anc = {};
    let ancNet = 0;
    for (const a of ancRows) {
      const q = roundKg3(Number(a.kg) || 0);
      anc[a.type] = q;
      ancNet += q;
    }
    ancNet = roundKg3(ancNet);

    const stockCheckHits = scrapByCoil.get(coilNo) || [];
    const theoreticalScrap = stockCheckHits.filter((m) => {
      const d = String(m.detail || '');
      return (
        /stock check/i.test(d) ||
        /ERP above|ERP below/i.test(d) ||
        /metres\s*[×x]/i.test(d) ||
        /\d+(\.\d+)?\s*kg\/m/i.test(d)
      );
    });

    // Gap explained by scrap? lastClose - onHand ≈ -ancNet when anc is scrap-heavy
    const explainedByAnc = Math.abs(gap + ancNet) < Math.max(5, Math.abs(gap) * 0.15);

    candidates.push({
      coilNo,
      colour: coil.colour,
      gauge: coil.gauge_label,
      status: coil.current_status,
      received,
      onHand,
      lastClose,
      gapToLastClose: gap,
      expectedFromJobs,
      gapToJobMath: roundKg3(expectedFromJobs - onHand),
      prodUsed,
      metres,
      lastJobId: last.job_id,
      lastJobClose: lastClose,
      ancillaryNetKg: ancNet,
      ancillaryByType: anc,
      explainedByAncillary: explainedByAnc,
      stockCheckEventCount: theoreticalScrap.length,
      stockCheckEvents: theoreticalScrap.slice(0, 5).map((m) => ({
        id: m.id,
        type: m.type,
        qty: m.qty,
        date: m.date_iso,
        detail: String(m.detail || '').slice(0, 180),
      })),
      likelySameIssue:
        gap > GAP_KG &&
        (theoreticalScrap.some((m) => Number(m.qty) < 0) ||
          (explainedByAnc && Number(anc.COIL_SCRAP || 0) < -GAP_KG)),
      suggestedRestoreKg: gap > 0 ? gap : 0,
    });
  }

  candidates.sort((a, b) => Math.abs(b.gapToLastClose) - Math.abs(a.gapToLastClose));

  // Also list stock-check language hits on coils not in Available set / no jobs
  const languageOnly = [];
  for (const [coilNo, moves] of scrapByCoil) {
    if (candidates.some((c) => c.coilNo === coilNo)) continue;
    const coil = db
      .prepare(
        `SELECT coil_no, branch_id, colour, gauge_label, qty_remaining, current_weight_kg, current_status
         FROM coil_lots WHERE coil_no = ?`
      )
      .get(coilNo);
    if (coil && BRANCH && String(coil.branch_id) !== BRANCH) continue;
    const neg = moves.filter((m) => Number(m.qty) < 0);
    if (!neg.length) continue;
    languageOnly.push({
      coilNo,
      branchId: coil?.branch_id,
      status: coil?.current_status,
      onHand: roundKg3(Number(coil?.qty_remaining) || Number(coil?.current_weight_kg) || 0),
      events: neg.slice(0, 5).map((m) => ({
        id: m.id,
        type: m.type,
        qty: m.qty,
        date: m.date_iso,
        detail: String(m.detail || '').slice(0, 180),
      })),
    });
  }

  const sameIssue = candidates.filter((c) => c.likelySameIssue);
  const out = {
    ok: true,
    readOnly: true,
    branch: BRANCH,
    gapThresholdKg: GAP_KG,
    scannedAvailableCoilsWithJobs: coils.length,
    candidateCount: candidates.length,
    likelySameIssueCount: sameIssue.length,
    likelySameIssue: sameIssue,
    otherGaps: candidates.filter((c) => !c.likelySameIssue).slice(0, 40),
    stockCheckLanguageOnly: languageOnly.slice(0, 40),
    pjcCols,
  };

  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `KD-coil-stockcheck-vs-jobclose-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('\n=== LIKELY SAME ISSUE (onHand < last job close, scrap/stock-check) ===');
  for (const c of sameIssue) {
    console.log(
      `${c.coilNo}  onHand=${c.onHand}  lastClose=${c.lastClose}  restore=+${c.suggestedRestoreKg}  scrapNet=${c.ancillaryNetKg}  events=${c.stockCheckEventCount}`
    );
  }
  console.log(`\nlikelySameIssue=${sameIssue.length} otherGaps=${out.otherGaps.length} languageOnly=${languageOnly.length}`);
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[scan] FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
