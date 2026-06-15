/**
 * Archive legacy profile JSON disciplinary events into hr_staff_profiles.profile_extra_json
 * under legacyDisciplinaryEventsArchive (read-only). Does not delete source events.
 *
 * Optional: pass --import-cases to create discipline cases for events with kind !== 'query'.
 */
import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from '../server/mysqlDatabase.js';

const cfg = mysqlConfigFromEnv();
const db = createMysqlDatabase(cfg, { reset: false });
db.pragma('foreign_keys = ON');

const importCases = process.argv.includes('--import-cases');

function safeJson(raw, fallback = {}) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const rows = db
  .prepare(`SELECT user_id, profile_extra_json FROM hr_staff_profiles WHERE profile_extra_json IS NOT NULL`)
  .all();

let archived = 0;
let imported = 0;

for (const row of rows) {
  const extra = safeJson(row.profile_extra_json, {});
  const events = Array.isArray(extra.disciplinaryEvents) ? extra.disciplinaryEvents : [];
  if (!events.length) continue;
  if (extra.legacyDisciplinaryEventsArchive?.length) continue;

  extra.legacyDisciplinaryEventsArchive = events.map((ev) => ({ ...ev, archivedAtIso: new Date().toISOString() }));
  delete extra.disciplinaryEvents;

  db.prepare(`UPDATE hr_staff_profiles SET profile_extra_json = ? WHERE user_id = ?`).run(
    JSON.stringify(extra),
    row.user_id
  );
  archived += events.length;

  if (importCases) {
    for (const ev of events) {
      if (String(ev.kind || '').trim() === 'query') continue;
      const summary = String(ev.summary || ev.note || 'Legacy disciplinary event import').trim();
      if (summary.length < 10) continue;
      const id = `HRDIS-legacy-${row.user_id}-${String(ev.dateIso || ev.createdAtIso || '').slice(0, 10)}-${imported}`;
      try {
        db.prepare(
          `INSERT INTO hr_discipline_cases (id, user_id, branch_id, status, offence_category, summary, opened_at_iso, opened_by_user_id, case_type, description)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(
          id,
          row.user_id,
          'KD',
          'closed',
          String(ev.kind || 'warning'),
          summary.slice(0, 500),
          ev.dateIso || new Date().toISOString(),
          null,
          String(ev.kind || 'warning'),
          summary
        );
        imported += 1;
      } catch {
        /* skip duplicates */
      }
    }
  }
}

db.close();
console.log(
  `Legacy discipline migration on ${databaseLabel(cfg)}: archived ${archived} events` +
    (importCases ? `, imported ${imported} cases` : '') +
    '.'
);
