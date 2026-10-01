/**
 * Same-transaction treasury movement insert + cache delta (Phase 2.1).
 *
 * Invariants:
 * - Forward: stored_after = stored_before + delta, checked on every write. Historical
 *   stored ≠ computed is allowed unless the account was switched to strict by Admin/MD.
 * - Strict accounts: stored must equal opening + SUM(movements) before the write.
 * - Dates: real calendar day; future needs Admin/MD + reason; 7-day window rules
 *   (see `assertTreasuryPostingDate`); period lock on the parsed day.
 * - Amounts: non-zero, sign by type, floor + reason on customer/payout types.
 * - Duplicates: same source + amount + account + type within 120 s is blocked unless a
 *   reason is given; same source + amount + account on the same day needs a confirmation.
 * - Every insert stores who (user id + name), when (created_at_iso), the reasons given and
 *   the client request key, and writes an audit row.
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { assertTreasuryAccountForWorkspace } from '../branchScope.js';
import { appendAuditLog, assertPeriodOpen } from '../controlOps.js';
import { nextTreasuryMovementHumanId } from '../humanId.js';
import {
  assertTreasuryPostingDate,
  normalizeIsoTimestampStrict,
  parseIsoTimestamp,
  parseIsoTimestampOrThrow,
} from '../../shared/lib/isoTimestamp.js';
import { assertTreasuryAmount } from '../../shared/lib/treasuryAmountPolicy.js';
import {
  TREASURY_DUPLICATE_HARD_WINDOW_SECONDS,
  getTreasuryPostingPolicy,
  postingOverrideContext,
  treasuryAmountFloorEnabled,
  treasuryDatePolicyEnabled,
  treasuryDuplicatePolicyEnabled,
} from './treasuryPostingPolicy.js';
import { getTreasuryContext, noteTreasuryRefusal } from './treasuryRequestContext.js';

export class TreasuryPostingError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'TreasuryPostingError';
    this.code = code;
    if (details) this.details = details;
  }
}

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function treasuryAccountRow(db, treasuryAccountId) {
  return db.prepare(`SELECT * FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId);
}

const columnCache = new WeakMap();

/** Column names of a table (PRAGMA on SQLite, information_schema on MySQL). */
export function tableColumnSet(db, table) {
  let perDb = columnCache.get(db);
  if (!perDb) {
    perDb = new Map();
    columnCache.set(db, perDb);
  }
  if (perDb.has(table)) return perDb.get(table);
  let cols = new Set();
  try {
    cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)));
  } catch {
    /* MySQL host */
  }
  if (!cols.size) {
    try {
      cols = new Set(
        db
          .prepare(
            `SELECT column_name AS name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ?`
          )
          .all(table)
          .map((c) => String(c.name ?? c.COLUMN_NAME))
      );
    } catch {
      /* unknown dialect */
    }
  }
  if (cols.size) perDb.set(table, cols);
  return cols;
}

/** Drop cached column lists after a migration adds columns. */
export function resetTreasuryColumnCache(db) {
  columnCache.delete(db);
}

/** opening_balance_ngn + SUM(amount_ngn) for one account. */
export function computedTreasuryBalance(db, treasuryAccountId, accountRow = null) {
  const row = accountRow || treasuryAccountRow(db, treasuryAccountId);
  const sum = db
    .prepare(`SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE treasury_account_id = ?`)
    .get(treasuryAccountId);
  return roundMoney(row?.opening_balance_ngn) + roundMoney(sum?.s);
}

function refuse(code, message, details) {
  noteTreasuryRefusal(code, message, details);
  return new TreasuryPostingError(message, code, details);
}

/**
 * Apply a signed delta to the stored cache. Fails the tx if the write did not land as stored_before+delta,
 * or (strict accounts only) if the cache already disagrees with opening + movements.
 * @param {import('better-sqlite3').Database} db
 * @param {number} treasuryAccountId
 * @param {number} deltaNgn
 * @param {{ allowNegativeBalance?: boolean }} [opts]
 */
export function adjustTreasuryBalanceTx(db, treasuryAccountId, deltaNgn, opts = {}) {
  const row = treasuryAccountRow(db, treasuryAccountId);
  if (!row) throw new Error('Treasury account not found.');
  const storedBefore = roundMoney(row.balance);
  const delta = roundMoney(deltaNgn);
  if (delta === 0) {
    return { ...row, balance: storedBefore, storedBefore, storedAfter: storedBefore, deltaNgn: 0 };
  }
  if (Number(row.strict_cache_enabled) === 1) {
    const computed = computedTreasuryBalance(db, treasuryAccountId, row);
    if (computed !== storedBefore) {
      throw refuse(
        'STRICT_CACHE_MISMATCH',
        `${row.name} is on strict balance checking and its stored balance (₦${storedBefore.toLocaleString('en-NG')}) no longer matches opening + movements (₦${computed.toLocaleString('en-NG')}). Ask Finance to check the integrity report.`,
        { treasuryAccountId: Number(treasuryAccountId), storedBefore, computed }
      );
    }
  }
  const nextBalance = storedBefore + delta;
  if (nextBalance < 0 && !opts.allowNegativeBalance) {
    throw new Error(`Insufficient balance in ${row.name}.`);
  }
  db.prepare(`UPDATE treasury_accounts SET balance = ? WHERE id = ?`).run(nextBalance, treasuryAccountId);
  const storedAfter = roundMoney(
    db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId)?.balance
  );
  if (storedAfter !== storedBefore + delta) {
    throw new Error(
      `Treasury cache delta check failed for ${row.name}: stored ${storedBefore} + ${delta} ≠ ${storedAfter}.`
    );
  }
  return { ...row, balance: storedAfter, storedBefore, storedAfter, deltaNgn: delta };
}

const TRANSFER_TYPES = new Set(['INTERNAL_TRANSFER_OUT', 'INTERNAL_TRANSFER_IN']);

/**
 * @returns {{ id: string, created_at_iso?: string, posted_at_iso?: string } | null}
 */
function findDuplicateCandidate(db, m, mode, excludeIds) {
  const isTransfer = TRANSFER_TYPES.has(m.type);
  const where = [
    `treasury_account_id = ?`,
    `amount_ngn = ?`,
    `reverses_movement_id IS NULL`,
    `NOT EXISTS (SELECT 1 FROM treasury_movements r WHERE r.reverses_movement_id = tm.id)`,
  ];
  const args = [m.treasuryAccountId, m.amountNgn];
  if (isTransfer) {
    where.push(`type = ?`, `COALESCE(counterparty_id, '') = ?`);
    args.push(m.type, m.counterpartyId);
  } else {
    where.push(`COALESCE(source_kind, '') = ?`, `COALESCE(source_id, '') = ?`);
    args.push(m.sourceKind, m.sourceId);
    if (mode === 'hard') {
      where.push(`type = ?`);
      args.push(m.type);
    }
  }
  if (m.batchId) {
    where.push(`COALESCE(batch_id, '') <> ?`);
    args.push(m.batchId);
  }
  if (mode === 'hard') {
    where.push(`created_at_iso IS NOT NULL`, `created_at_iso >= ?`);
    args.push(new Date(Date.now() - TREASURY_DUPLICATE_HARD_WINDOW_SECONDS * 1000).toISOString());
  } else {
    where.push(`SUBSTR(posted_at_iso, 1, 10) = ?`);
    args.push(m.day);
  }
  const rows = db
    .prepare(
      `SELECT id, created_at_iso, posted_at_iso FROM treasury_movements tm
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC LIMIT 5`
    )
    .all(...args);
  return rows.find((r) => !excludeIds.has(String(r.id))) || null;
}

function assertNotDuplicate(db, m, overrides, excludeIds, hasCreatedAt) {
  const isTransfer = TRANSFER_TYPES.has(m.type);
  if (!isTransfer && (!m.sourceKind || !m.sourceId)) return null;
  if (isTransfer && !m.counterpartyId) return null;
  if (hasCreatedAt) {
    const hard = findDuplicateCandidate(db, m, 'hard', excludeIds);
    if (hard) {
      if (overrides.duplicateReason) return { kind: 'hard', matchId: String(hard.id) };
      throw refuse(
        'DUPLICATE_BLOCK',
        `This looks like a repeat of ${hard.id} (same ${isTransfer ? 'transfer' : 'source'}, amount and account, posted under ${TREASURY_DUPLICATE_HARD_WINDOW_SECONDS / 60} minutes ago). Give a reason to post it again.`,
        { matchMovementId: String(hard.id), treasuryAccountId: m.treasuryAccountId, amountNgn: m.amountNgn }
      );
    }
  }
  const soft = findDuplicateCandidate(db, m, 'soft', excludeIds);
  if (soft) {
    if (overrides.duplicateSameDayConfirmed) return { kind: 'same_day', matchId: String(soft.id) };
    throw refuse(
      'DUPLICATE_SAME_DAY',
      `${soft.id} already records the same ${isTransfer ? 'transfer' : 'source'}, amount and account on ${m.day}. Confirm to post another one.`,
      { matchMovementId: String(soft.id), treasuryAccountId: m.treasuryAccountId, amountNgn: m.amountNgn, day: m.day }
    );
  }
  return null;
}

function withRefusalNote(fn) {
  try {
    return fn();
  } catch (e) {
    if (e && e.code && !(e instanceof TreasuryPostingError)) noteTreasuryRefusal(e.code, e.message);
    throw e;
  }
}

/**
 * Insert one cash-book line and adjust the account cache in the same caller transaction.
 *
 * Optional payload fields (Phase 2.1): `sourceDocDate` (document day the posting date is
 * measured against), `dateRuleType` (e.g. 'BANK_CHARGE' for an EXPENSE line that has no
 * source document), `dateOverrideReason`, `amountFloorReason`, `duplicateOverrideReason`,
 * `duplicateSameDayConfirmed`, `skipDuplicateCheck` (system replays only).
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} payload
 */
export function insertTreasuryMovementTx(db, payload) {
  const ctx = getTreasuryContext();
  const actor = payload.actor || ctx?.actor || null;
  const treasuryAccountId = Number(payload.treasuryAccountId);
  if (!treasuryAccountId) throw new Error('treasuryAccountId is required.');
  if (payload.workspaceBranchId && actor) {
    const gate = assertTreasuryAccountForWorkspace(db, treasuryAccountId, {
      workspaceBranchId: payload.workspaceBranchId,
      workspaceViewAll: Boolean(payload.workspaceViewAll),
      user: actor,
    });
    if (!gate.ok) throw new Error(gate.error);
  }

  const amountNgn = roundMoney(payload.amountNgn);
  const type = String(payload.type || '').trim().toUpperCase();
  const isReversal = Boolean(payload.reversesMovementId || payload.isReversal);
  const policy = payload.skipPolicyLoad ? null : getTreasuryPostingPolicy(db);
  const overrides = postingOverrideContext(actor, payload, ctx);
  const floorOn = treasuryAmountFloorEnabled() && !payload.skipAmountPolicy;
  withRefusalNote(() =>
    assertTreasuryAmount({
      type,
      amountNgn,
      floorNgn: policy?.amountFloorNgn,
      amountFloorReason: overrides.amountFloorReason,
      skipFloor: !floorOn || payload.skipFloor === true,
      isReversal,
    })
  );

  const postedAtISO = withRefusalNote(() =>
    normalizeIsoTimestampStrict(payload.postedAtISO, { label: 'Posting date' })
  );
  const parsed = parseIsoTimestampOrThrow(postedAtISO, 'Posting date');
  if (!payload.skipPeriodLock) {
    assertPeriodOpen(db, parsed.day, payload.periodContextLabel || 'Posting date');
  }
  const sourceDocParsed = payload.sourceDocDate ? parseIsoTimestamp(String(payload.sourceDocDate)) : null;
  const sourceDocDay = sourceDocParsed?.ok ? sourceDocParsed.day : null;
  let dateCheck = null;
  if (treasuryDatePolicyEnabled() && !payload.skipDatePolicy && !isReversal) {
    dateCheck = withRefusalNote(() =>
      assertTreasuryPostingDate({
        day: parsed.day,
        todayDay: overrides.todayDay,
        type: String(payload.dateRuleType || type).trim().toUpperCase(),
        sourceDocDay,
        isPrivileged: overrides.isPrivileged,
        reason: overrides.dateReason,
        windowDays: policy?.dateWindowDays,
      })
    );
  }

  const cols = tableColumnSet(db, 'treasury_movements');
  const has = (c) => cols.has(c);
  const excludeIds = ctx?.insertedIds instanceof Set ? ctx.insertedIds : new Set();
  let duplicate = null;
  // Only on user money routes (request context present): system jobs cannot answer a prompt.
  if (ctx && treasuryDuplicatePolicyEnabled() && !isReversal && !payload.skipDuplicateCheck) {
    duplicate = assertNotDuplicate(
      db,
      {
        treasuryAccountId,
        amountNgn,
        type,
        day: parsed.day,
        sourceKind: String(payload.sourceKind ?? '').trim(),
        sourceId: String(payload.sourceId ?? '').trim(),
        counterpartyId: String(payload.counterpartyId ?? '').trim(),
        batchId: String(payload.batchId ?? '').trim(),
      },
      overrides,
      excludeIds,
      has('created_at_iso')
    );
  }

  const allowNeg = payload.allowNegativeBalance === true || type === 'BANK_RECON_ADJUSTMENT';
  const account = adjustTreasuryBalanceTx(db, treasuryAccountId, amountNgn, {
    allowNegativeBalance: allowNeg,
  });
  const branchForTm = String(
    payload.workspaceBranchId || payload.branchId || account.branch_id || DEFAULT_BRANCH_ID
  ).trim();
  const id = String(payload.id ?? '').trim() || nextTreasuryMovementHumanId(db, branchForTm);
  const createdAtISO = new Date().toISOString();
  const createdByUserId = actor?.id != null ? String(actor.id) : null;
  const dateReasonUsed = dateCheck?.override ? overrides.dateReason : '';
  const floorReasonUsed = overrides.amountFloorReason;
  const duplicateReasonUsed = duplicate ? overrides.duplicateReason || 'same-day confirmed' : '';
  const idempotencyKey = String(payload.idempotencyKey || ctx?.idempotencyKey || '').trim();

  const fields = [
    ['id', id],
    ['posted_at_iso', postedAtISO],
    ['type', payload.type],
    ['treasury_account_id', treasuryAccountId],
    ['amount_ngn', amountNgn],
    ['reference', payload.reference ?? null],
    ['counterparty_kind', payload.counterpartyKind ?? null],
    ['counterparty_id', payload.counterpartyId ?? null],
    ['counterparty_name', payload.counterpartyName ?? null],
    ['source_kind', payload.sourceKind ?? null],
    ['source_id', payload.sourceId ?? null],
    ['note', payload.note ?? null],
    ['created_by', payload.createdBy ?? null],
    ['reverses_movement_id', payload.reversesMovementId ?? null],
    ['batch_id', payload.batchId ?? null],
  ];
  const optional = [
    ['created_at_iso', createdAtISO],
    ['created_by_user_id', createdByUserId],
    ['source_doc_date', sourceDocDay],
    ['date_override_reason', dateReasonUsed || null],
    ['amount_floor_reason', floorReasonUsed || null],
    ['duplicate_override_reason', duplicateReasonUsed || null],
    ['idempotency_key', idempotencyKey || null],
  ];
  for (const f of optional) if (has(f[0])) fields.push(f);
  db.prepare(
    `INSERT INTO treasury_movements (${fields.map((f) => f[0]).join(', ')})
     VALUES (${fields.map(() => '?').join(',')})`
  ).run(...fields.map((f) => f[1]));
  excludeIds.add(id);

  try {
    appendAuditLog(db, {
      actor,
      action: isReversal ? 'treasury.movement.reverse' : 'treasury.movement.insert',
      entityKind: 'treasury_movement',
      entityId: id,
      note: payload.note || `${type} ${amountNgn}`,
      details: {
        treasuryAccountId,
        type,
        amountNgn,
        postedAtISO,
        sourceDocDate: sourceDocDay,
        storedBefore: account.storedBefore,
        storedAfter: account.storedAfter,
        deltaNgn: account.deltaNgn,
        reversesMovementId: payload.reversesMovementId ?? null,
        sourceKind: payload.sourceKind ?? null,
        sourceId: payload.sourceId ?? null,
        createdByUserId,
        dateOverride: dateCheck?.override || null,
        dateOverrideReason: dateReasonUsed || null,
        amountFloorReason: floorReasonUsed || null,
        duplicateOf: duplicate?.matchId || null,
        duplicateOverride: duplicate?.kind || null,
        duplicateOverrideReason: duplicateReasonUsed || null,
        idempotencyKey: idempotencyKey || null,
      },
    });
  } catch {
    /* audit must never block the cash write after the row is in */
  }

  return {
    id,
    postedAtISO,
    treasuryAccountId,
    amountNgn,
    accountName: account.name,
    accountType: account.type,
    reference: payload.reference ?? '',
    sourceKind: payload.sourceKind ?? '',
    sourceId: payload.sourceId ?? '',
    batchId: payload.batchId ?? '',
    storedBefore: account.storedBefore,
    storedAfter: account.storedAfter,
  };
}
