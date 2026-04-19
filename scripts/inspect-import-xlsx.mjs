/**
 * Summarize Excel files in docs/import (sheet names, headers, row counts, samples).
 * Usage: node scripts/inspect-import-xlsx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dir = path.join(root, 'docs', 'import');

const files = fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

function rowCount(ws) {
  const ref = ws['!ref'];
  if (!ref) return 0;
  const d = XLSX.utils.decode_range(ref);
  return d.e.r - d.s.r + 1;
}

function colCount(ws) {
  const ref = ws['!ref'];
  if (!ref) return 0;
  const d = XLSX.utils.decode_range(ref);
  return d.e.c - d.s.c + 1;
}

function previewRows(ws, maxRows = 4, maxCols = 24) {
  const ref = ws['!ref'];
  if (!ref) return [];
  const d = XLSX.utils.decode_range(ref);
  const endR = Math.min(d.s.r + maxRows - 1, d.e.r);
  const endC = Math.min(d.s.c + maxCols - 1, d.e.c);
  const range = XLSX.utils.encode_range({ s: d.s, e: { r: endR, c: endC } });
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', range });
}

for (const f of files) {
  const fp = path.join(dir, f);
  let wb;
  try {
    wb = XLSX.readFile(fp, { cellDates: true, dense: false });
  } catch (e) {
    console.log(`\n=== ${f} === ERROR: ${e.message}`);
    continue;
  }
  console.log(`\n${'='.repeat(72)}\nFILE: ${f}\n${'='.repeat(72)}`);
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    const rows = rowCount(ws);
    const cols = colCount(ws);
    const prev = previewRows(ws, 5, 28);
    console.log(`\n  Sheet: "${sn}"  (${rows} rows × ${cols} cols used)`);
    for (let i = 0; i < prev.length; i++) {
      const label = i === 0 ? 'header' : `row${i}`;
      const cells = prev[i].map((c) => {
        if (c instanceof Date) return c.toISOString().slice(0, 10);
        const s = String(c ?? '').replace(/\r?\n/g, '↵').trim();
        return s.length > 60 ? `${s.slice(0, 57)}...` : s;
      });
      console.log(`    [${label}] ${cells.join('  |  ')}`);
    }
    if (rows > prev.length) console.log(`    ... ${rows - prev.length} more data rows`);
  }
}

console.log(`\n\nTotal workbooks: ${files.length}\n`);
