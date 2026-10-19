/**
 * One print layout for every management report (Reports round 2, rules L1–L7, F2, F7, L10).
 * Pure: report payload in → complete HTML document out. Used by the app's print window and by the
 * read-only dry-run script that prints PDFs.
 *
 * - Landscape A4, column headers repeat on every page, footer "branch · period · page x of y" (L3).
 * - No truncation (L1): cells never wrap or cut; a table that is too wide first drops the font in
 *   0.5 pt steps (to 6.5 pt), then moves the columns marked `secondLine` onto a second line under the row
 *   (values are moved, never hidden).
 * - Remarks (L2): one column at the far right, cut at 60 characters with "…", full text on hover.
 * - Money (L4): right-aligned, thousands separators, no kobo unless the value has kobo, negatives in brackets.
 *   Dates DD/MM/YYYY.
 * - Page 1 = summary box (+ optional comparison columns, F3) + "What this report counts" note (F7)
 *   + exceptions (L5). Exceptions red, under review amber (L6).
 * - Small items (L10): rows flagged `_small` are counted in one line, listed only when `showSmallItems`.
 * - Sign-off block at the foot (F2).
 */

export const REMARKS_MAX_CHARS = 60;

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 1234567 → "1,234,567"; −5 → "(5)"; 12.5 → "12.50"; '' / null → ''. */
export function printMoney(v) {
  if (v === '' || v == null) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  const hasKobo = Math.round(abs * 100) % 100 !== 0;
  const text = abs.toLocaleString('en-NG', {
    minimumFractionDigits: hasKobo ? 2 : 0,
    maximumFractionDigits: hasKobo ? 2 : 0,
  });
  return n < 0 ? `(${text})` : text;
}

/** ISO date or date-time → DD/MM/YYYY; anything else passes through. */
export function printDate(v) {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v ?? '');
}

export function printDateTime(v) {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : printDate(v);
}

export function cutRemarks(text, max = REMARKS_MAX_CHARS) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cell(col, row) {
  const raw = row[col.key];
  if (col.kind === 'money') return { html: esc(printMoney(raw)), title: '' };
  if (col.kind === 'date') return { html: esc(printDate(raw)), title: '' };
  if (col.kind === 'remarks') {
    const full = String(raw ?? '').replace(/\s+/g, ' ').trim();
    return { html: esc(cutRemarks(full)), title: full.length > REMARKS_MAX_CHARS ? full : '' };
  }
  return { html: esc(raw), title: '' };
}

function sevClass(sev) {
  if (sev === 'exception') return ' class="sev-exception"';
  if (sev === 'review') return ' class="sev-review"';
  return '';
}

/**
 * @param {object} section
 * @param {string} section.title
 * @param {{key:string,label:string,kind?:'money'|'date'|'id'|'text'|'remarks',secondLine?:boolean}[]} section.columns
 * @param {object[]} section.rows — `_severity`, `_small`, `_href` (record link, L7) optional per row
 * @param {object[]} [section.totalRows]
 * @param {string} [section.band] — repeats with the column headers on every page (e.g. account name)
 * @param {string} [section.emptyText]
 * @param {boolean} [section.pageBreakBefore]
 */
function renderTable(section, { showSmallItems }) {
  const remarksLast = [
    ...section.columns.filter((c) => c.kind !== 'remarks'),
    ...section.columns.filter((c) => c.kind === 'remarks'),
  ];
  const cols = remarksLast;
  const small = section.rows.filter((r) => r._small);
  const listed = showSmallItems ? section.rows : section.rows.filter((r) => !r._small);
  const head = cols
    .map((c) => `<th class="${c.kind === 'money' ? 'num' : ''}${c.secondLine ? ' second-line' : ''}">${esc(c.label)}</th>`)
    .join('');
  const band = section.band ? `<tr class="band"><th colspan="${cols.length}">${esc(section.band)}</th></tr>` : '';
  const secondCols = cols.filter((c) => c.secondLine);
  const bodyRow = (r, kind = '') => {
    const extraClass = kind || (r._strong ? 'total' : '');
    const main = `<tr${sevClass(r._severity)}${extraClass ? ` data-kind="${extraClass}"` : ''}${r._href ? ` data-href="${esc(r._href)}"` : ''}>${cols
      .map((c) => {
        const { html, title } = cell(c, r);
        const cls = [c.kind === 'money' ? 'num' : '', c.secondLine ? 'second-line' : ''].filter(Boolean).join(' ');
        return `<td${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${html}</td>`;
      })
      .join('')}</tr>`;
    if (!secondCols.length) return main;
    // Shown only when the table is still too wide at 6.5 pt: the second-line columns move under the row.
    const text = secondCols
      .map((c) => [c, cell(c, r).html])
      .filter(([, html]) => html)
      .map(([c, html]) => `${esc(c.label)}: ${html}`)
      .join(' · ');
    return `${main}<tr class="second-row${r._severity ? ` sev-${r._severity}` : ''}"><td colspan="${cols.length}">${text}</td></tr>`;
  };
  const body = listed.length
    ? listed.map((r) => bodyRow(r)).join('')
    : `<tr><td colspan="${cols.length}" class="empty">${esc(section.emptyText || 'None.')}</td></tr>`;
  const smallLine =
    !showSmallItems && small.length
      ? `<tr class="small-line"><td colspan="${cols.length}">${small.length} small item(s) under ₦50,000, ₦${esc(
          printMoney(small.reduce((s, r) => s + (Number(r[section.smallAmountKey || 'amountNgn']) || 0), 0))
        )} — not listed (show small items to list them)</td></tr>`
      : '';
  const totals = (section.totalRows || []).map((r) => bodyRow(r, 'total')).join('');
  return `<section class="block${section.pageBreakBefore ? ' page-break' : ''}">
<h2>${esc(section.title)}</h2>
<table class="grid"><thead>${band}<tr>${head}</tr></thead><tbody>${body}${smallLine}${totals}</tbody></table>
</section>`;
}

function renderSummary(summary) {
  if (!summary?.rows?.length) return '';
  const cmp = Boolean(summary.comparison);
  const head = cmp
    ? `<tr><th></th><th class="num">${esc(summary.thisLabel || 'This period')}</th><th class="num">${esc(
        summary.prevLabel || 'Last period'
      )}</th><th class="num">Change</th></tr>`
    : '';
  const rows = summary.rows
    .map((r) => {
      const fmt = (v) => (r.kind === 'text' ? esc(v) : esc(printMoney(v)));
      const change = cmp && r.prev != null && r.kind !== 'text' ? printMoney(Number(r.value) - Number(r.prev)) : '';
      return `<tr${sevClass(r.severity)}${r.strong ? ' data-kind="total"' : ''}><td>${esc(r.label)}</td><td class="num">${fmt(r.value)}</td>${
        cmp ? `<td class="num">${r.prev == null ? '' : fmt(r.prev)}</td><td class="num">${esc(change)}</td>` : ''
      }</tr>`;
    })
    .join('');
  return `<table class="summary">${head}${rows}</table>`;
}

function renderSignOff(signOff) {
  const prepared = signOff?.preparedBy
    ? `${esc(signOff.preparedBy)} · ${esc(printDateTime(signOff.preparedAtISO))}`
    : '';
  return `<section class="signoff">
<div><span>Prepared by</span><b>${prepared || '&nbsp;'}</b></div>
<div><span>Reviewed (Branch Manager)</span><b>${esc(signOff?.reviewedBy || '')}&nbsp;</b><i>Signature / date</i></div>
<div><span>Approved (Operations Manager)</span><b>${esc(signOff?.approvedBy || '')}&nbsp;</b><i>Signature / date</i></div>
</section>`;
}

/**
 * @param {object} doc
 * @param {string} doc.title
 * @param {string} doc.branchName
 * @param {string} doc.startDate
 * @param {string} doc.endDate
 * @param {{rows: object[], comparison?: boolean}} [doc.summary]
 * @param {string} [doc.note] — "What this report counts" (F7)
 * @param {object[]} [doc.exceptionSections] — page 1, after the summary
 * @param {object[]} [doc.sections] — detail, from page 2
 * @param {{preparedBy?: string, preparedAtISO?: string}} [doc.signOff]
 * @param {boolean} [doc.showSmallItems]
 */
export function renderReportDocument(doc) {
  const period = `${printDate(doc.startDate)} – ${printDate(doc.endDate)}`;
  const footer = `${doc.title} · Branch: ${doc.branchName || '—'} · Period: ${period}`;
  const opts = { showSmallItems: Boolean(doc.showSmallItems) };
  const page1 = [
    renderSummary(doc.summary),
    doc.note ? `<p class="note"><b>What this report counts.</b> ${esc(doc.note)}</p>` : '',
    ...(doc.exceptionSections || []).map((s) => renderTable(s, opts)),
  ].join('\n');
  const detail = (doc.sections || []).map((s, i) => renderTable({ ...s, pageBreakBefore: s.pageBreakBefore ?? i === 0 }, opts)).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(doc.title)} — ${esc(doc.branchName || '')} — ${esc(period)}</title>
<style>
@page { size: A4 landscape; margin: 10mm 8mm 12mm 8mm;
  @bottom-left { content: "${footer.replace(/"/g, "'")}"; font: 7pt Arial, sans-serif; color: #555; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7pt Arial, sans-serif; color: #555; } }
:root { --exception: #b00020; --exception-bg: #fde8eb; --review: #8a5a00; --review-bg: #fff4d6; --line: #c9c9c9; }
* { box-sizing: border-box; }
body { margin: 0; font: 8pt Arial, Helvetica, sans-serif; color: #111; background: #fff; }
header.doc { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #111; margin-bottom: 6px; }
header.doc h1 { font-size: 13pt; margin: 0; }
header.doc .meta { font-size: 8pt; text-align: right; }
h2 { font-size: 9.5pt; margin: 10px 0 4px; }
table { border-collapse: collapse; }
table.grid { width: 100%; }
table.grid th, table.grid td { border: 1px solid var(--line); padding: 2px 4px; white-space: nowrap; vertical-align: top; }
table.grid thead { display: table-header-group; }
table.grid thead th { background: #f0f0f0; text-align: left; }
table.grid tr.band th { background: #222; color: #fff; text-align: left; }
tr { page-break-inside: avoid; break-inside: avoid; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.sev-exception td { color: var(--exception); background: var(--exception-bg); }
tr.sev-review td { color: var(--review); background: var(--review-bg); }
tr[data-kind="total"] td { font-weight: bold; border-top: 2px solid #111; }
tr.small-line td { font-style: italic; color: #555; }
td.empty { color: #555; font-style: italic; }
table.summary { min-width: 55%; margin-bottom: 6px; }
table.summary td, table.summary th { border-bottom: 1px solid var(--line); padding: 2px 8px; white-space: nowrap; }
p.note { max-width: 190mm; border-left: 3px solid #555; padding: 3px 8px; margin: 6px 0 8px; background: #f6f6f6; }
.page-break { break-before: page; page-break-before: always; }
section.signoff { display: flex; gap: 12mm; margin-top: 10mm; break-inside: avoid; }
section.signoff div { flex: 1; display: flex; flex-direction: column; gap: 2px; }
section.signoff span { font-weight: bold; }
section.signoff b { border-bottom: 1px solid #111; min-height: 9mm; font-weight: normal; padding-top: 4mm; }
section.signoff i { font-size: 7pt; color: #555; }
tr.second-row { display: none; }
tr.second-row td { padding-left: 16px; color: #333; }
body.fit-second-line .second-line { display: none; }
body.fit-second-line tr.second-row { display: table-row; }
</style></head>
<body>
<header class="doc"><h1>${esc(doc.title)}</h1><div class="meta">Branch: <b>${esc(doc.branchName || '—')}</b><br>Period: <b>${esc(period)}</b></div></header>
${page1}
${detail}
${renderSignOff(doc.signOff)}
<script>
(function fit() {
  var tables = Array.prototype.slice.call(document.querySelectorAll('table.grid'));
  var pageWidth = document.body.clientWidth;
  tables.forEach(function (t) {
    var size = 8;
    while (t.scrollWidth > pageWidth && size > 6.5) { size -= 0.5; t.style.fontSize = size + 'pt'; }
  });
  if (tables.some(function (t) { return t.scrollWidth > pageWidth; })) document.body.classList.add('fit-second-line');
})();
</script>
</body></html>`;
}
