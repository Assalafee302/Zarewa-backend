/**
 * Correct a coil number that was typed wrong at receipt.
 *
 * Invariant: kg, cost, and reservations do not change. Only the identifier moves,
 * and only after a branch manager (not the requester) approves.
 * coil_no is a global primary key, so the rename updates every coil_no reference
 * in one transaction.
 */
import { userHasPermission } from '../auth.js';
import { appendAuditLog } from '../controlOps.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { upsertWorkItemBySource, workRegistryTablesReady } from '../workItems.js';
import { isBranchManagerApprovalAuthority, isExecutiveRoleKey } from '../../shared/workspaceGovernance.js';

const SOURCE_KIND = 'coil_number_correction';

const COIL_NO_TABLES = [
  ['production_job_coils', 'coil_no'],
  ['production_conversion_checks', 'coil_no'],
  ['inventory_coil_snapshots', 'coil_no'],
  ['coil_control_events', 'coil_no'],
  ['material_incidents', 'coil_no'],
  ['coil_requests', 'coil_no'],
  ['yard_coils', 'id'],
];

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function actorId(actor) {
  return String(actor?.id ?? '').trim();
}

function actorName(actor) {
  return String(actor?.displayName ?? actor?.username ?? '').trim();
}

export function userMayApproveCoilNumberCorrection(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || '').trim().toLowerCase();
  if (rk === 'admin' || isExecutiveRoleKey(rk)) return true;
  return isBranchManagerApprovalAuthority(rk);
}

function tableReady(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().length > 0;
  } catch {
    return false;
  }
}

export function ensureCoilNumberCorrectionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coil_number_corrections (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      from_coil_no TEXT NOT NULL,
      to_coil_no TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by_user_id TEXT,
      requested_by_display TEXT,
      requested_at_iso TEXT NOT NULL,
      decided_by_user_id TEXT,
      decided_by_display TEXT,
      decided_at_iso TEXT,
      decision_note TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_coil_number_corrections_branch_status
     ON coil_number_corrections(branch_id, status, requested_at_iso DESC)`
  );
}

function cleanCoilNo(raw) {
  const s = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 64) return '';
  const serial = s.match(/^cl-(\d{2})-(\d+)$/i);
  if (serial) return `CL-${serial[1]}-${serial[2]}`;
  return s.toUpperCase();
}

function findCoil(db, coilNo) {
  const wanted = cleanCoilNo(coilNo);
  if (!wanted) return null;
  const exact = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ? LIMIT 1`).get(wanted);
  if (exact) return exact;
  return db.prepare(`SELECT * FROM coil_lots WHERE LOWER(coil_no) = LOWER(?) LIMIT 1`).get(wanted) || null;
}

function coilExists(db, coilNo) {
  return Boolean(findCoil(db, coilNo));
}

function countWhere(db, table, column, coilNo) {
  if (!tableReady(db, table) || !hasColumn(db, table, column)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` = ?`).get(coilNo);
  return Number(row?.n) || 0;
}

function correctionImpact(db, coilNo) {
  const lot = findCoil(db, coilNo);
  const key = String(lot?.coil_no || coilNo || '').trim();
  const onHand = lot ? Number(lot.qty_remaining ?? lot.current_weight_kg) || 0 : 0;
  return {
    onHandKg: onHand,
    status: lot ? String(lot.current_status || 'Available') : '',
    gaugeLabel: lot?.gauge_label || '',
    colour: lot?.colour || '',
    receivedAtISO: lot?.received_at_iso ? String(lot.received_at_iso).slice(0, 10) : '',
    jobCount: countWhere(db, 'production_job_coils', 'coil_no', key),
    movementCount: countWhere(db, 'stock_movements', 'ref', key),
    controlEventCount: countWhere(db, 'coil_control_events', 'coil_no', key),
  };
}

function mapRow(row, extras = {}) {
  if (!row) return null;
  return {
    id: row.id,
    branchId: row.branch_id,
    fromCoilNo: row.from_coil_no,
    toCoilNo: row.to_coil_no,
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requested_by_user_id || '',
    requestedByDisplay: row.requested_by_display || '',
    requestedAtISO: row.requested_at_iso,
    decidedByUserId: row.decided_by_user_id || '',
    decidedByDisplay: row.decided_by_display || '',
    decidedAtISO: row.decided_at_iso || '',
    decisionNote: row.decision_note || '',
    ...extras,
  };
}

function newCorrectionId(db) {
  const yy = String(new Date().getFullYear()).slice(-2);
  const taken = db.prepare(`SELECT 1 FROM coil_number_corrections WHERE id = ?`);
  for (let i = 0; i < 8; i += 1) {
    const id = `CNC-${yy}-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!taken.get(id)) return id;
  }
  return `CNC-${yy}-${Date.now()}`;
}

function notifyBranchManager(db, row, actor) {
  if (!workRegistryTablesReady(db)) return;
  const item = mapRow(row);
  upsertWorkItemBySource(db, {
    actor,
    sourceKind: SOURCE_KIND,
    sourceId: item.id,
    branchId: item.branchId,
    officeKey: 'branch_manager',
    responsibleOfficeKey: 'branch_manager',
    documentClass: 'request',
    documentType: SOURCE_KIND,
    status: 'open',
    priority: 'high',
    title: `Correct coil number — ${item.fromCoilNo}`,
    summary: `${item.requestedByDisplay || 'Store'} asked to change ${item.fromCoilNo} to ${item.toCoilNo}.`,
    body: item.reason,
    requiresResponse: true,
    requiresApproval: true,
    senderUserId: item.requestedByUserId || null,
    senderDisplayName: item.requestedByDisplay || null,
    senderRoleKey: String(actor?.roleKey || '').trim() || null,
    senderOfficeKey: 'operations',
    senderBranchId: item.branchId,
    visibilityEntries: [
      { visibilityKind: 'role_key', visibilityValue: 'branch_manager' },
      { visibilityKind: 'role_key', visibilityValue: 'sales_manager' },
      { visibilityKind: 'role_key', visibilityValue: 'admin' },
      { visibilityKind: 'role_key', visibilityValue: 'md' },
    ],
    data: {
      routePath: `/operations/coils/${encodeURIComponent(item.fromCoilNo)}`,
      fromCoilNo: item.fromCoilNo,
      toCoilNo: item.toCoilNo,
      correctionId: item.id,
    },
    links: [{ entityKind: 'coil_lot', entityId: item.fromCoilNo }],
  });
}

function closeNotice(db, row, actor, status, note) {
  if (!workRegistryTablesReady(db)) return;
  const item = mapRow(row);
  const approved = status === 'approved';
  upsertWorkItemBySource(db, {
    actor,
    sourceKind: SOURCE_KIND,
    sourceId: item.id,
    branchId: item.branchId,
    officeKey: 'branch_manager',
    responsibleOfficeKey: 'branch_manager',
    documentClass: 'request',
    documentType: SOURCE_KIND,
    status: approved ? 'closed' : 'rejected',
    priority: 'normal',
    title: `Correct coil number — ${item.fromCoilNo}`,
    summary: approved
      ? `Approved. ${item.fromCoilNo} is now ${item.toCoilNo}.`
      : `Rejected. ${item.fromCoilNo} was left unchanged.`,
    body: note || item.reason,
    requiresResponse: false,
    requiresApproval: false,
    senderUserId: item.requestedByUserId || null,
    senderDisplayName: item.requestedByDisplay || null,
    senderBranchId: item.branchId,
    data: {
      routePath: `/operations/coils/${encodeURIComponent(approved ? item.toCoilNo : item.fromCoilNo)}`,
      fromCoilNo: item.fromCoilNo,
      toCoilNo: item.toCoilNo,
      correctionId: item.id,
    },
    links: [{ entityKind: 'coil_lot', entityId: approved ? item.toCoilNo : item.fromCoilNo }],
  });
}

function replaceDetailPrefix(detail, fromCoilNo, toCoilNo) {
  const text = String(detail || '');
  const prefix = `${fromCoilNo} ·`;
  if (!text.startsWith(prefix)) return text;
  return `${toCoilNo} ·${text.slice(prefix.length)}`;
}

/**
 * Move every stored reference from the old coil number to the new one.
 * Caller must already be inside a transaction. The new number must not exist yet.
 */
function renameCoilNumberTx(db, fromCoilNo, toCoilNo) {
  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(fromCoilNo);
  if (!row) throw new Error('Coil not found.');
  if (coilExists(db, toCoilNo)) throw new Error(`Coil number ${toCoilNo} is already registered.`);

  if (tableReady(db, 'gl_journal_entries') && hasColumn(db, 'gl_journal_entries', 'source_id')) {
    const clash = db.prepare(`SELECT id FROM gl_journal_entries WHERE source_id = ? LIMIT 1`).get(toCoilNo);
    if (clash) {
      throw new Error(`Coil number ${toCoilNo} is already used on a ledger entry.`);
    }
  }

  const cols = Object.keys(row);
  const values = cols.map((col) => (col === 'coil_no' ? toCoilNo : row[col]));
  db.prepare(
    `INSERT INTO coil_lots (${cols.map((col) => `\`${col}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...values);

  for (const [table, column] of COIL_NO_TABLES) {
    if (!tableReady(db, table) || !hasColumn(db, table, column)) continue;
    db.prepare(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`).run(toCoilNo, fromCoilNo);
  }

  if (hasColumn(db, 'coil_lots', 'parent_coil_no')) {
    db.prepare(`UPDATE coil_lots SET parent_coil_no = ? WHERE parent_coil_no = ?`).run(toCoilNo, fromCoilNo);
  }

  if (tableReady(db, 'stock_movements')) {
    if (hasColumn(db, 'stock_movements', 'ref')) {
      db.prepare(`UPDATE stock_movements SET ref = ? WHERE ref = ?`).run(toCoilNo, fromCoilNo);
    }
    if (hasColumn(db, 'stock_movements', 'detail')) {
      const prefix = `${fromCoilNo} ·`;
      const movements = db
        .prepare(`SELECT id, detail FROM stock_movements WHERE INSTR(detail, ?) = 1`)
        .all(prefix);
      const upd = db.prepare(`UPDATE stock_movements SET detail = ? WHERE id = ?`);
      for (const movement of movements) {
        upd.run(replaceDetailPrefix(movement.detail, fromCoilNo, toCoilNo), movement.id);
      }
    }
  }

  if (tableReady(db, 'gl_journal_entries') && hasColumn(db, 'gl_journal_entries', 'source_id')) {
    const journals = db
      .prepare(
        `SELECT id, memo FROM gl_journal_entries WHERE source_id = ?`
      )
      .all(fromCoilNo);
    const updJournal = hasColumn(db, 'gl_journal_entries', 'memo')
      ? db.prepare(`UPDATE gl_journal_entries SET source_id = ?, memo = ? WHERE id = ?`)
      : null;
    if (updJournal) {
      for (const journal of journals) {
        const memo = String(journal.memo || '').split(fromCoilNo).join(toCoilNo);
        updJournal.run(toCoilNo, memo, journal.id);
      }
    } else {
      db.prepare(`UPDATE gl_journal_entries SET source_id = ? WHERE source_id = ?`).run(toCoilNo, fromCoilNo);
    }
  }

  if (tableReady(db, 'work_item_links')) {
    db.prepare(
      `UPDATE work_item_links SET entity_id = ? WHERE entity_kind = 'coil_lot' AND entity_id = ?`
    ).run(toCoilNo, fromCoilNo);
  }

  db.prepare(`DELETE FROM coil_lots WHERE coil_no = ?`).run(fromCoilNo);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function requestCoilNumberCorrection(db, fromCoilNo, body = {}, opts = {}) {
  ensureCoilNumberCorrectionTable(db);
  const from = cleanCoilNo(fromCoilNo);
  const to = cleanCoilNo(body.toCoilNo ?? body.to_coil_no ?? body.newCoilNo);
  const reason = String(body.reason ?? '').trim();
  if (!from) return { ok: false, error: 'Coil number is required.' };
  if (!to) return { ok: false, error: 'Enter the correct coil number.' };
  if (from.toLowerCase() === to.toLowerCase()) {
    return { ok: false, error: 'The correct number must be different from the one on the coil.' };
  }
  if (reason.length < 3) return { ok: false, error: 'Say why this coil number is wrong.' };

  const lot = findCoil(db, from);
  if (!lot) return { ok: false, error: 'Coil not found.' };
  const storedFrom = String(lot.coil_no);
  const workspaceBranchId = String(opts.workspaceBranchId || '').trim();
  const coilBranch = String(lot.branch_id || '').trim();
  if (!workspaceBranchId || !coilBranch || coilBranch !== workspaceBranchId) {
    return { ok: false, error: 'Coil is not in your current workspace branch.' };
  }
  if (storedFrom.toLowerCase() === to.toLowerCase()) {
    return { ok: false, error: 'The correct number must be different from the one on the coil.' };
  }
  if (coilExists(db, to)) {
    return { ok: false, error: `Coil number ${to} is already registered. Use a number that is not in the register.` };
  }

  const pendingFrom = db
    .prepare(
      `SELECT id FROM coil_number_corrections WHERE LOWER(from_coil_no) = LOWER(?) AND status = 'pending' LIMIT 1`
    )
    .get(storedFrom);
  if (pendingFrom) {
    return {
      ok: false,
      error: 'A correction for this coil is already waiting for the branch manager.',
      correctionId: pendingFrom.id,
    };
  }
  const pendingTo = db
    .prepare(
      `SELECT id, from_coil_no FROM coil_number_corrections WHERE LOWER(to_coil_no) = LOWER(?) AND status = 'pending' LIMIT 1`
    )
    .get(to);
  if (pendingTo) {
    return { ok: false, error: `Coil number ${to} is already requested on another correction.` };
  }

  const id = newCorrectionId(db);
  const actor = opts.actor || null;
  db.prepare(
    `INSERT INTO coil_number_corrections (
      id, branch_id, from_coil_no, to_coil_no, reason, status,
      requested_by_user_id, requested_by_display, requested_at_iso
    ) VALUES (?,?,?,?,?,'pending',?,?,?)`
  ).run(id, coilBranch, storedFrom, to, reason, actorId(actor) || null, actorName(actor) || null, nowIso());

  const saved = db.prepare(`SELECT * FROM coil_number_corrections WHERE id = ?`).get(id);
  try {
    notifyBranchManager(db, saved, actor);
  } catch (e) {
    console.error(e);
  }
  appendAuditLog(db, {
    actor,
    action: 'coil_number_correction.requested',
    entityKind: 'coil_lot',
    entityId: storedFrom,
    note: `${storedFrom} → ${to}`,
    details: { correctionId: id, toCoilNo: to, reason },
  });
  return { ok: true, correction: mapRow(saved, { impact: correctionImpact(db, storedFrom) }) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function listCoilNumberCorrections(db, branchScope = 'ALL', opts = {}) {
  ensureCoilNumberCorrectionTable(db);
  const status = String(opts.status || 'pending').trim() || 'pending';
  const fromCoilNo = cleanCoilNo(opts.fromCoilNo || '');
  const args = [status];
  let sql = `SELECT * FROM coil_number_corrections WHERE status = ?`;
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  if (scope !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(scope);
  }
  if (fromCoilNo) {
    sql += ` AND LOWER(from_coil_no) = LOWER(?)`;
    args.push(fromCoilNo);
  }
  sql += ` ORDER BY requested_at_iso DESC LIMIT 100`;
  const actor = opts.actor || null;
  const uid = actorId(actor);
  const mayApprove = userMayApproveCoilNumberCorrection(actor);
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => {
      const own = Boolean(uid) && uid === String(row.requested_by_user_id || '');
      return mapRow(row, {
        impact: correctionImpact(db, row.from_coil_no),
        canApprove: mayApprove && !own && row.status === 'pending',
        canWithdraw: own && row.status === 'pending',
      });
    });
}

/**
 * Live check while store types the replacement number. Does not write.
 * @param {import('better-sqlite3').Database} db
 */
export function previewCoilNumberChange(db, fromCoilNo, toRaw, opts = {}) {
  ensureCoilNumberCorrectionTable(db);
  const lot = findCoil(db, fromCoilNo);
  if (!lot) return { ok: false, error: 'Coil not found.' };
  const workspaceBranchId = String(opts.workspaceBranchId || '').trim();
  const coilBranch = String(lot.branch_id || '').trim();
  if (!workspaceBranchId || !coilBranch || coilBranch !== workspaceBranchId) {
    return { ok: false, error: 'Coil is not in your current workspace branch.' };
  }
  const storedFrom = String(lot.coil_no);
  const to = cleanCoilNo(toRaw);
  const sameNumber = Boolean(to) && storedFrom.toLowerCase() === to.toLowerCase();
  const taken = Boolean(to) && !sameNumber && coilExists(db, to);
  const pendingOnCoil = db
    .prepare(
      `SELECT id FROM coil_number_corrections WHERE LOWER(from_coil_no) = LOWER(?) AND status = 'pending' LIMIT 1`
    )
    .get(storedFrom);
  const pendingTarget = to
    ? db
        .prepare(
          `SELECT from_coil_no FROM coil_number_corrections WHERE LOWER(to_coil_no) = LOWER(?) AND status = 'pending' LIMIT 1`
        )
        .get(to)
    : null;
  return {
    ok: true,
    fromCoilNo: storedFrom,
    toCoilNo: to,
    sameNumber,
    taken,
    reservedByPending: Boolean(pendingTarget),
    pendingOnCoil: Boolean(pendingOnCoil),
    available: Boolean(to) && !sameNumber && !taken && !pendingTarget && !pendingOnCoil,
    impact: correctionImpact(db, storedFrom),
  };
}

/**
 * Store withdraws their own request before a manager decides.
 * @param {import('better-sqlite3').Database} db
 */
export function withdrawCoilNumberCorrection(db, correctionId, opts = {}) {
  ensureCoilNumberCorrectionTable(db);
  const actor = opts.actor || null;
  const id = String(correctionId || '').trim();
  const row = db.prepare(`SELECT * FROM coil_number_corrections WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Correction request not found.' };
  if (row.status !== 'pending') return { ok: false, error: 'This correction is no longer waiting.' };
  if (!actorId(actor) || actorId(actor) !== String(row.requested_by_user_id || '')) {
    return { ok: false, error: 'Only the person who sent this request can withdraw it.' };
  }
  const workspaceBranchId = String(opts.workspaceBranchId || '').trim();
  if (!workspaceBranchId || String(row.branch_id) !== workspaceBranchId) {
    return { ok: false, error: 'This correction is for another branch.' };
  }
  db.prepare(
    `UPDATE coil_number_corrections
     SET status = 'withdrawn', decided_by_user_id = ?, decided_by_display = ?, decided_at_iso = ?, decision_note = ?
     WHERE id = ? AND status = 'pending'`
  ).run(actorId(actor), actorName(actor) || null, nowIso(), 'Withdrawn by store', id);
  const saved = db.prepare(`SELECT * FROM coil_number_corrections WHERE id = ?`).get(id);
  try {
    closeNotice(db, saved, actor, 'rejected', 'Withdrawn by store');
  } catch (e) {
    console.error(e);
  }
  appendAuditLog(db, {
    actor,
    action: 'coil_number_correction.withdrawn',
    entityKind: 'coil_lot',
    entityId: row.from_coil_no,
    note: `${row.from_coil_no} left unchanged`,
    details: { correctionId: id },
  });
  return { ok: true, correction: mapRow(saved) };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function decideCoilNumberCorrection(db, correctionId, body = {}, opts = {}) {
  ensureCoilNumberCorrectionTable(db);
  const actor = opts.actor || null;
  if (!userMayApproveCoilNumberCorrection(actor)) {
    return { ok: false, error: 'Only a branch manager (or above) can approve a coil number correction.' };
  }
  const id = String(correctionId || '').trim();
  const row = db.prepare(`SELECT * FROM coil_number_corrections WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Correction request not found.' };
  if (row.status !== 'pending') return { ok: false, error: 'This correction is no longer waiting for approval.' };

  const workspaceBranchId = String(opts.workspaceBranchId || '').trim();
  const viewAll = Boolean(opts.workspaceViewAll);
  if (!viewAll && (!workspaceBranchId || String(row.branch_id) !== workspaceBranchId)) {
    return { ok: false, error: 'This correction is for another branch.' };
  }
  if (actorId(actor) && actorId(actor) === String(row.requested_by_user_id || '')) {
    return { ok: false, error: 'You cannot decide your own coil number correction.' };
  }

  const decision = String(body.decision || '').trim().toLowerCase();
  const note = String(body.note ?? body.decisionNote ?? '').trim();
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: 'Choose approve or reject.' };
  }

  if (decision === 'reject' && note.length < 3) {
    return { ok: false, error: 'Write a short reason for rejecting this correction.' };
  }

  if (decision === 'reject') {
    db.prepare(
      `UPDATE coil_number_corrections
       SET status = 'rejected', decided_by_user_id = ?, decided_by_display = ?, decided_at_iso = ?, decision_note = ?
       WHERE id = ? AND status = 'pending'`
    ).run(actorId(actor) || null, actorName(actor) || null, nowIso(), note || null, id);
    const saved = db.prepare(`SELECT * FROM coil_number_corrections WHERE id = ?`).get(id);
    try {
      closeNotice(db, saved, actor, 'rejected', note);
    } catch (e) {
      console.error(e);
    }
    appendAuditLog(db, {
      actor,
      action: 'coil_number_correction.rejected',
      entityKind: 'coil_lot',
      entityId: row.from_coil_no,
      note: note || `${row.from_coil_no} left unchanged`,
      details: { correctionId: id },
    });
    return { ok: true, correction: mapRow(saved) };
  }

  const to = cleanCoilNo(row.to_coil_no);
  const confirm = cleanCoilNo(body.confirmCoilNo ?? body.confirm_coil_no);
  if (!confirm || confirm.toLowerCase() !== to.toLowerCase()) {
    return { ok: false, error: 'Type the new coil number to confirm the approval.' };
  }
  if (coilExists(db, to)) {
    return { ok: false, error: `Coil number ${to} is already registered. Reject this request and ask store to submit a free number.` };
  }

  try {
    db.transaction(() => {
      renameCoilNumberTx(db, row.from_coil_no, to);
      const changed = db
        .prepare(
          `UPDATE coil_number_corrections
           SET status = 'approved', decided_by_user_id = ?, decided_by_display = ?, decided_at_iso = ?, decision_note = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(actorId(actor) || null, actorName(actor) || null, nowIso(), note || null, id);
      if (!changed?.changes) throw new Error('This correction is no longer waiting for approval.');
    })();
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'Could not change the coil number.') };
  }

  const saved = db.prepare(`SELECT * FROM coil_number_corrections WHERE id = ?`).get(id);
  try {
    closeNotice(db, saved, actor, 'approved', note);
  } catch (e) {
    console.error(e);
  }
  appendAuditLog(db, {
    actor,
    action: 'coil_number_correction.approved',
    entityKind: 'coil_lot',
    entityId: to,
    note: `${row.from_coil_no} → ${to}`,
    details: { correctionId: id, fromCoilNo: row.from_coil_no, toCoilNo: to },
  });
  return { ok: true, correction: mapRow(saved), coilNo: to };
}
