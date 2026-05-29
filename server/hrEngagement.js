/**
 * HR engagement surveys.
 * @module server/hrEngagement
 */

import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

export function hrEngagementTablesReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_engagement_surveys'`).get());
  } catch {
    return false;
  }
}

const SURVEY_STATUSES = new Set(['draft', 'open', 'closed']);

export const DEFAULT_ENGAGEMENT_QUESTIONS = [
  { id: 'q1', text: 'I understand what is expected of me at work.', type: 'rating', scale: 5 },
  { id: 'q2', text: 'I would recommend Zarewa as a place to work.', type: 'rating', scale: 5 },
  { id: 'q3', text: 'My line manager supports my development.', type: 'rating', scale: 5 },
  { id: 'q4', text: 'What should we improve? (optional)', type: 'text' },
];

export function listHrEngagementSurveys(db) {
  if (!hrEngagementTablesReady(db)) return [];
  return db
    .prepare(
      `SELECT id, title, status, questions_json AS questionsJson,
              opens_at_iso AS opensAtIso, closes_at_iso AS closesAtIso,
              created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso
       FROM hr_engagement_surveys ORDER BY created_at_iso DESC LIMIT 50`
    )
    .all()
    .map((r) => ({
      ...r,
      questions: safeJsonParse(r.questionsJson, []),
      questionsJson: undefined,
    }));
}

export function getHrEngagementSurvey(db, surveyId) {
  if (!hrEngagementTablesReady(db)) return null;
  const row = db
    .prepare(
      `SELECT id, title, status, questions_json AS questionsJson,
              opens_at_iso AS opensAtIso, closes_at_iso AS closesAtIso
       FROM hr_engagement_surveys WHERE id = ?`
    )
    .get(String(surveyId || '').trim());
  if (!row) return null;
  return { ...row, questions: safeJsonParse(row.questionsJson, []), questionsJson: undefined };
}

export function createHrEngagementSurvey(db, actor, body = {}) {
  if (!hrEngagementTablesReady(db)) return { ok: false, error: 'Engagement module not initialised.' };
  const title = String(body.title || '').trim();
  if (title.length < 3) return { ok: false, error: 'title is required.' };
  const questions = Array.isArray(body.questions) && body.questions.length ? body.questions : DEFAULT_ENGAGEMENT_QUESTIONS;
  const id = newId('HRSVY');
  const now = nowIso();
  const status = SURVEY_STATUSES.has(String(body.status || '')) ? String(body.status) : 'draft';
  db.prepare(
    `INSERT INTO hr_engagement_surveys (
      id, title, status, questions_json, opens_at_iso, closes_at_iso, created_at_iso, updated_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    title,
    status,
    JSON.stringify(questions),
    String(body.opensAtIso || '').slice(0, 10) || null,
    String(body.closesAtIso || '').slice(0, 10) || null,
    now,
    now,
    actor?.id || null
  );
  return { ok: true, id };
}

export function patchHrEngagementSurvey(db, surveyId, body = {}) {
  if (!hrEngagementTablesReady(db)) return { ok: false, error: 'Engagement module not initialised.' };
  const survey = getHrEngagementSurvey(db, surveyId);
  if (!survey) return { ok: false, error: 'Survey not found.' };
  const status = body.status !== undefined ? String(body.status || '').trim() : survey.status;
  if (!SURVEY_STATUSES.has(status)) return { ok: false, error: 'Invalid status.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_engagement_surveys SET
      title = COALESCE(?, title),
      status = ?,
      questions_json = COALESCE(?, questions_json),
      opens_at_iso = COALESCE(?, opens_at_iso),
      closes_at_iso = COALESCE(?, closes_at_iso),
      updated_at_iso = ?
     WHERE id = ?`
  ).run(
    body.title !== undefined ? String(body.title || '').trim() || survey.title : null,
    status,
    body.questions != null ? JSON.stringify(body.questions) : null,
    body.opensAtIso !== undefined ? String(body.opensAtIso || '').slice(0, 10) || null : null,
    body.closesAtIso !== undefined ? String(body.closesAtIso || '').slice(0, 10) || null : null,
    now,
    survey.id
  );
  return { ok: true, survey: getHrEngagementSurvey(db, surveyId) };
}

export function listOpenSurveysForUser(db, userId) {
  if (!hrEngagementTablesReady(db)) return [];
  const uid = String(userId || '').trim();
  const surveys = db
    .prepare(`SELECT id FROM hr_engagement_surveys WHERE status = 'open' ORDER BY created_at_iso DESC`)
    .all();
  const out = [];
  for (const s of surveys) {
    const full = getHrEngagementSurvey(db, s.id);
    if (!full) continue;
    const answered = db
      .prepare(`SELECT 1 FROM hr_engagement_responses WHERE survey_id = ? AND user_id = ?`)
      .get(full.id, uid);
    out.push({ ...full, answered: Boolean(answered) });
  }
  return out;
}

export function submitHrEngagementResponse(db, userId, body = {}) {
  if (!hrEngagementTablesReady(db)) return { ok: false, error: 'Engagement module not initialised.' };
  const surveyId = String(body.surveyId || '').trim();
  const survey = getHrEngagementSurvey(db, surveyId);
  if (!survey) return { ok: false, error: 'Survey not found.' };
  if (survey.status !== 'open') return { ok: false, error: 'Survey is not open for responses.' };
  const uid = String(userId || '').trim();
  const existing = db.prepare(`SELECT id FROM hr_engagement_responses WHERE survey_id = ? AND user_id = ?`).get(surveyId, uid);
  if (existing) return { ok: false, error: 'You have already responded to this survey.' };
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const id = newId('HRRSP');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_engagement_responses (id, survey_id, user_id, answers_json, submitted_at_iso)
     VALUES (?,?,?,?,?)`
  ).run(id, surveyId, uid, JSON.stringify(answers), now);
  return { ok: true, id };
}

export function getHrEngagementSurveySummary(db, surveyId) {
  if (!hrEngagementTablesReady(db)) return { ok: false, error: 'Engagement module not initialised.' };
  const survey = getHrEngagementSurvey(db, surveyId);
  if (!survey) return { ok: false, error: 'Survey not found.' };
  const rows = db
    .prepare(
      `SELECT answers_json AS answersJson FROM hr_engagement_responses WHERE survey_id = ?`
    )
    .all(survey.id);
  const responseCount = rows.length;
  const aggregates = {};
  for (const q of survey.questions || []) {
    if (q.type === 'rating') aggregates[q.id] = { sum: 0, count: 0, avg: null };
  }
  for (const r of rows) {
    const ans = safeJsonParse(r.answersJson, {});
    for (const q of survey.questions || []) {
      if (q.type !== 'rating') continue;
      const v = Number(ans[q.id]);
      if (!Number.isFinite(v)) continue;
      aggregates[q.id].sum += v;
      aggregates[q.id].count += 1;
    }
  }
  for (const k of Object.keys(aggregates)) {
    const a = aggregates[k];
    a.avg = a.count ? Math.round((a.sum / a.count) * 10) / 10 : null;
  }
  return { ok: true, survey, responseCount, aggregates };
}
