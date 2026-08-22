/**
 * Payment-request history: who requested, who approved, who paid, and how cash moved.
 */
export const HOW_PAYMENT_REQUEST_CREATE =
  'Submitted as a payment request. MD or Finance approve on the Accounts desk; cashier pays from treasury.';

export const HOW_PAYMENT_REQUEST_APPROVE =
  'Approved on the payment-request desk (special lane). This authorises payout — cash has not moved yet.';

export const HOW_PAYMENT_REQUEST_REJECT =
  'Rejected on the payment-request desk. No treasury payout should follow.';

export const HOW_PAYMENT_REQUEST_PAY =
  'Cashier paid from treasury (finance.pay). Cash left the company and GL posted from the request category.';

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  } catch {
    return false;
  }
}

function parseDetails(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw)) || {};
  } catch {
    return {};
  }
}

function inClause(ids) {
  return ids.map(() => '?').join(',');
}

/**
 * Sort oldest first; stable by id.
 * @param {Array<{ atIso?: string; id?: string }>} events
 */
export function sortTimelineEvents(events) {
  return [...(events || [])].sort((a, b) => {
    const t = String(a.atIso || '').localeCompare(String(b.atIso || ''));
    if (t !== 0) return t;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/**
 * Human sentence for a treasury payout.
 * @param {{ accountNames?: string[]; amountNgn?: number; glCode?: string; glLabel?: string }} input
 */
export function describeTreasuryPayHow(input = {}) {
  const names = (input.accountNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  const amt = Math.round(Number(input.amountNgn) || 0);
  const gl = [input.glCode, input.glLabel].filter(Boolean).join(' ');
  const from = names.length ? ` from ${names.join(', ')}` : ' from treasury';
  const money = amt > 0 ? ` ₦${amt.toLocaleString('en-NG')}` : '';
  const posted = gl ? ` Posted to ${gl}.` : '';
  return `Cashier paid${money}${from}.${posted}`.replace('paid from', 'paid from');
}

function mapAuditToEvent(row, accountById, glHint) {
  const action = String(row.action || '');
  const details = parseDetails(row.details_json);
  const atIso = String(row.occurred_at_iso || '');
  const actorName = String(row.actor_name || '').trim() || 'System';
  const actorUserId = String(row.actor_user_id || '').trim();
  const note = String(row.note || '').trim();
  const base = { id: `audit:${row.id}`, atIso, actorName, actorUserId, note };

  if (action === 'payment_request.create') {
    return {
      ...base,
      kind: 'requested',
      title: 'Requested',
      how: HOW_PAYMENT_REQUEST_CREATE,
      amountNgn: Math.round(Number(details.amountRequestedNgn) || 0) || undefined,
    };
  }
  if (action === 'payment_request.review') {
    const status = String(details.status || row.status || '').toLowerCase();
    const rejected = status.includes('reject');
    return {
      ...base,
      kind: rejected ? 'rejected' : 'approved',
      title: rejected ? 'Rejected' : 'Approved',
      how: rejected ? HOW_PAYMENT_REQUEST_REJECT : HOW_PAYMENT_REQUEST_APPROVE,
    };
  }
  if (action === 'payment_request.pay') {
    const ids = Array.isArray(details.treasuryAccountIds) ? details.treasuryAccountIds : [];
    const names = ids.map((id) => accountById.get(String(id)) || '').filter(Boolean);
    const amountNgn = Math.round(Number(details.amountPaidNgn) || 0);
    return {
      ...base,
      kind: 'paid',
      title: 'Paid from treasury',
      how: describeTreasuryPayHow({ ...glHint, accountNames: names, amountNgn }),
      amountNgn,
    };
  }
  if (action.includes('cancel')) {
    return { ...base, kind: 'cancelled', title: 'Cancelled', how: 'Cancelled before payout. Cash was not moved.' };
  }
  if (action.includes('reverse')) {
    return { ...base, kind: 'reversed', title: 'Payout reversed', how: 'Finance reversed the treasury payout.' };
  }
  return {
    ...base,
    kind: 'note',
    title: action.replace(/^payment_request\./, '').replace(/_/g, ' '),
    how: note || 'Recorded on the payment-request audit log.',
  };
}

/**
 * Timeline for one or many payment requests.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} requestIds
 * @param {{ glCode?: string; glLabel?: string }} [glHint]
 * @returns {Map<string, Array<object>>}
 */
export function loadPaymentRequestTimelines(db, requestIds, glHint = {}) {
  const map = new Map();
  const ids = [...new Set((requestIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return map;
  for (const id of ids) map.set(id, []);

  const accountById = new Map();
  if (tableExists(db, 'treasury_accounts')) {
    for (const a of db.prepare(`SELECT id, name, type FROM treasury_accounts`).all()) {
      const label = [a.name, a.type].filter(Boolean).join(' · ');
      accountById.set(String(a.id), label || String(a.id));
    }
  }

  if (tableExists(db, 'audit_log')) {
    const rows = db
      .prepare(
        `SELECT id, occurred_at_iso, actor_user_id, actor_name, action, entity_id, status, note, details_json
         FROM audit_log
         WHERE entity_kind = 'payment_request' AND entity_id IN (${inClause(ids)})
         ORDER BY occurred_at_iso ASC, id ASC`
      )
      .all(...ids);
    for (const row of rows) {
      const rid = String(row.entity_id || '');
      if (!map.has(rid)) continue;
      map.get(rid).push(mapAuditToEvent(row, accountById, glHint));
    }
  }

  if (tableExists(db, 'approval_actions')) {
    const rows = db
      .prepare(
        `SELECT id, entity_id, action, status, note, acted_at_iso, acted_by_user_id, acted_by_name
         FROM approval_actions
         WHERE entity_kind = 'payment_request' AND entity_id IN (${inClause(ids)})
         ORDER BY acted_at_iso ASC, id ASC`
      )
      .all(...ids);
    for (const row of rows) {
      const rid = String(row.entity_id || '');
      const list = map.get(rid);
      if (!list) continue;
      const atIso = String(row.acted_at_iso || '');
      const actorName = String(row.acted_by_name || '').trim();
      const already = list.some(
        (e) =>
          (e.kind === 'approved' || e.kind === 'rejected') &&
          e.atIso === atIso &&
          e.actorName === actorName
      );
      if (already) continue;
      const rejected = String(row.status || '').toLowerCase().includes('reject');
      list.push({
        id: `approval:${row.id}`,
        atIso,
        kind: rejected ? 'rejected' : 'approved',
        title: rejected ? 'Rejected' : 'Approved',
        actorName: actorName || 'Approver',
        actorUserId: String(row.acted_by_user_id || ''),
        how: rejected ? HOW_PAYMENT_REQUEST_REJECT : HOW_PAYMENT_REQUEST_APPROVE,
        note: String(row.note || '').trim(),
      });
    }
  }

  if (tableExists(db, 'treasury_movements')) {
    const rows = db
      .prepare(
        `SELECT tm.id, tm.posted_at_iso, tm.amount_ngn, tm.source_id, tm.note, tm.created_by,
                ta.name AS account_name, ta.type AS account_type
         FROM treasury_movements tm
         LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
         WHERE tm.source_kind = 'PAYMENT_REQUEST' AND tm.source_id IN (${inClause(ids)})
         ORDER BY tm.posted_at_iso ASC, tm.id ASC`
      )
      .all(...ids);
    for (const row of rows) {
      const rid = String(row.source_id || '');
      const list = map.get(rid);
      if (!list) continue;
      const amountNgn = Math.abs(Math.round(Number(row.amount_ngn) || 0));
      const accountLabel = [row.account_name, row.account_type].filter(Boolean).join(' · ');
      const already = list.some((e) => e.kind === 'paid' && e.amountNgn === amountNgn);
      if (already && accountLabel) {
        const hit = list.find((e) => e.kind === 'paid' && e.amountNgn === amountNgn);
        if (hit && !String(hit.how || '').includes(accountLabel)) {
          hit.how = describeTreasuryPayHow({
            ...glHint,
            accountNames: [accountLabel],
            amountNgn,
          });
        }
        continue;
      }
      if (already) continue;
      list.push({
        id: `tm:${row.id}`,
        atIso: String(row.posted_at_iso || ''),
        kind: 'paid',
        title: 'Paid from treasury',
        actorName: String(row.created_by || '').trim() || 'Cashier',
        actorUserId: '',
        how: describeTreasuryPayHow({ ...glHint, accountNames: accountLabel ? [accountLabel] : [], amountNgn }),
        note: String(row.note || '').trim(),
        amountNgn,
      });
    }
  }

  for (const [id, events] of map) {
    map.set(id, sortTimelineEvents(events));
  }
  return map;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 */
export function buildPaymentRequestTimeline(db, requestId, glHint = {}) {
  const rid = String(requestId || '').trim();
  if (!rid) return [];
  return loadPaymentRequestTimelines(db, [rid], glHint).get(rid) || [];
}
