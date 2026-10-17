#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) October 2026 statement → bank-recon, owner 17 Oct 2026. Plan only (no DB access).
 * Input: the read-only match file from scripts/_adhoc/mp-oct-recon-match-readonly.mjs (main repo), one row per
 * statement line 1 Oct – 17 Oct 16:00:11 (388 lines, chain 3,411,799.04 → 5,862,096.74). Batches of 50 rows.
 *
 *   node scripts/moniepoint-oct-plan-recon.mjs <match.json>  →  exports/phase2-moniepoint-oct/mp-oct-recon-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const match = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// ERP lines of 1–3 Oct already linked (round 3) to late-September bank lines. The October bank line is the true
// partner (October ties to the bank daily with them in October), so those September links point at the wrong ERP
// line — September is locked, so the October bank line goes in as Review naming both, and no ERP line is linked twice.
const CROSS_MONTH = {
  'TM-KD-26-2946': 'BKR-KD-26-0868 (28 Sep)',
  'TM-KD-26-3014': 'BKR-KD-26-0989 (30 Sep)',
  'TM-KD-26-3042': 'BKR-KD-26-0905 (30 Sep)',
  'TM-KD-26-3044': 'BKR-KD-26-0898 (29 Sep)',
};
const lines = match.lines.map((l) => {
  const hit = l.movementIds.find((id) => CROSS_MONTH[id]);
  if (!hit) return l;
  return { ...l, movementIds: [], status: 'Review', note: [`matches ${hit}`, l.note, `${hit} is linked to September ${CROSS_MONTH[hit]} — September link to check`].filter(Boolean).join('; ') };
});
const SIZE = 50;
const items = [];
for (let i = 0; i < lines.length; i += SIZE) {
  const rows = lines.slice(i, i + SIZE);
  const k = String(items.length + 1).padStart(2, '0');
  items.push({
    id: `R8-recon-${k}`,
    group: 'A',
    record: `Moniepoint statement Oct 2026, lines ${i + 1}–${i + rows.length} (${rows[0].bankDateISO} – ${rows.at(-1).bankDateISO})`,
    field: 'bank_reconciliation_lines (insert)',
    reason: 'Owner 17 Oct: load the October Moniepoint statement into bank-recon (files Moniepoint-Document-2026-10-16T11-04 and -10-17T06-06)',
    ops: [{ kind: 'reconImportBatch', treasuryAccountId: 4, branchId: 'BR-KD', month: '2026-10', rows }],
    expectDeltaNgn: { 4: 0, 2: 0, 3: 0 },
    expectTypes: [],
  });
}
const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-oct-recon-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: `October statement import: ${lines.length} lines, opening ${match.openingNgn}, closing ${match.closingNgn}. --per-item.`, items }, null, 1));
console.log(`wrote ${out} — ${items.length} items, ${lines.length} rows`);
