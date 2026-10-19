/**
 * Finance Phase A (A8): how far each bank account's statement has been loaded.
 * Bank card line: "Statement loaded to dd/mm hh:mm", red when older than today (Lagos day).
 */

function clean(v) {
  return String(v ?? '').trim();
}

/** Lagos (UTC+1) calendar day and clock for an ISO instant. */
function lagosParts(iso) {
  const t = Date.parse(clean(iso));
  if (!Number.isFinite(t)) return null;
  const s = new Date(t + 3600 * 1000).toISOString();
  return { day: s.slice(0, 10), hhmm: s.slice(11, 16) };
}

/**
 * Point a statement import covers up to.
 * An explicit statementToISO wins. Otherwise the last statement day: if that day is the import
 * day, the statement runs to the import time; if it is earlier, to the end of that day (no clock shown).
 * @returns {{ statementToISO: string, hasTime: boolean } | null}
 */
export function statementCoveredTo({ statementToISO, lineDays = [], importedAtISO }) {
  const explicit = clean(statementToISO);
  if (explicit) return { statementToISO: explicit, hasTime: /T\d{2}:\d{2}/.test(explicit) };
  const lastDay = (lineDays || []).map((d) => clean(d).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
  if (!lastDay) return null;
  const imported = lagosParts(importedAtISO);
  if (imported && imported.day === lastDay) return { statementToISO: clean(importedAtISO), hasTime: true };
  return { statementToISO: lastDay, hasTime: false };
}

/**
 * @param {{ statementToISO?: string, hasTime?: boolean } | null} entry
 * @param {Date} [now]
 * @returns {{ label: string, stale: boolean, dayISO: string }}
 */
export function statementFreshness(entry, now = new Date()) {
  const today = new Date(now.getTime() + 3600 * 1000).toISOString().slice(0, 10);
  const raw = clean(entry?.statementToISO);
  if (!raw) return { label: 'No statement loaded', stale: true, dayISO: '' };
  let day;
  let hhmm = '';
  if (entry?.hasTime) {
    const p = lagosParts(raw);
    day = p?.day || raw.slice(0, 10);
    hhmm = p?.hhmm || '';
  } else {
    day = raw.slice(0, 10);
  }
  const [, mm, dd] = day.split('-');
  const label = `Statement loaded to ${dd}/${mm}${hhmm ? ` ${hhmm}` : ''}`;
  return { label, stale: day < today, dayISO: day };
}

/**
 * Latest statement point per treasury account: recorded imports first, else the last bank line
 * day already tagged to the account.
 * @param {Array<{ treasuryAccountId: number, statementToISO: string, hasTime?: boolean, importedAtISO?: string }>} imports
 * @param {Array<{ treasuryAccountId: number, lastBankDateISO: string }>} lineMax
 */
export function latestStatementByAccount(imports = [], lineMax = []) {
  const out = new Map();
  const dayOf = (e) => (e.hasTime ? lagosParts(e.statementToISO)?.day || '' : clean(e.statementToISO).slice(0, 10));
  const better = (a, b) => {
    if (!a) return true;
    const da = dayOf(a);
    const db = dayOf(b);
    if (db !== da) return db > da;
    if (b.hasTime && !a.hasTime) return true;
    return b.hasTime && a.hasTime && Date.parse(b.statementToISO) > Date.parse(a.statementToISO);
  };
  for (const imp of imports || []) {
    const id = Number(imp.treasuryAccountId);
    if (!id || !clean(imp.statementToISO)) continue;
    const e = { treasuryAccountId: id, statementToISO: clean(imp.statementToISO), hasTime: Boolean(imp.hasTime), source: 'import', importedAtISO: clean(imp.importedAtISO) };
    if (better(out.get(id), e)) out.set(id, e);
  }
  for (const row of lineMax || []) {
    const id = Number(row.treasuryAccountId);
    const day = clean(row.lastBankDateISO).slice(0, 10);
    if (!id || !day) continue;
    const e = { treasuryAccountId: id, statementToISO: day, hasTime: false, source: 'lines', importedAtISO: '' };
    if (better(out.get(id), e)) out.set(id, e);
  }
  return [...out.values()];
}
