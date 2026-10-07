/**
 * OM/manager release of the uncleared-receipts hold on one refund payee split.
 * Does not post treasury payout. Optionally closes open partner-wallet credits for that
 * payee so the net becomes till-payable on the cashier desk.
 */
import { actorName } from '../auth.js';
import { appendAuditLog } from '../controlOps.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function parseSplits(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function splitCustomerId(s) {
  return String(s?.recipientCustomerID ?? s?.recipient_customer_id ?? s?.payoutAccount?.partyId ?? '').trim();
}

function splitMatchesPayee(s, payeeCustomerId, payeeAccountNo) {
  const cid = splitCustomerId(s);
  if (payeeCustomerId && cid === payeeCustomerId) return true;
  const acct = String(s?.payoutAccount?.payeeAccountNo || '').trim();
  if (payeeAccountNo && acct && acct === payeeAccountNo) return true;
  return false;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @param {{
 *   payeeCustomerId?: string,
 *   payeeAccountNo?: string,
 *   note?: string,
 *   closePartnerWallet?: boolean,
 *   actor?: object | null,
 * }} payload
 */
export function releaseRefundSplitUnclearedHoldTx(db, refundId, payload = {}) {
  const rid = String(refundId || '').trim();
  if (!rid) return { ok: false, error: 'Refund id is required.' };
  const note = String(payload.note || '').trim();
  if (note.length < 10) {
    return { ok: false, error: 'OM release note is required (at least 10 characters).' };
  }
  const payeeCustomerId = String(payload.payeeCustomerId || '').trim();
  const payeeAccountNo = String(payload.payeeAccountNo || '').trim();
  if (!payeeCustomerId && !payeeAccountNo) {
    return { ok: false, error: 'payeeCustomerId or payeeAccountNo is required.' };
  }

  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(rid);
  if (!row) return { ok: false, error: 'Refund not found.' };
  const status = String(row.status || '').trim();
  if (!['Approved', 'Partially paid'].includes(status)) {
    return { ok: false, error: `Refund status ${status || '(blank)'} cannot release a hold.` };
  }

  const splits = parseSplits(row.split_distributions_json);
  const idx = splits.findIndex((s) => splitMatchesPayee(s, payeeCustomerId, payeeAccountNo));
  if (idx < 0) {
    return { ok: false, error: 'Matching payee split not found on this refund.' };
  }

  const now = new Date().toISOString();
  const who = actorName(payload.actor) || 'OM';
  const before = splits[idx];
  const netPayoutNgn = roundMoney(before.netPayoutNgn ?? before.net_payout_ngn);
  splits[idx] = {
    ...before,
    unclearedReceiptHoldNgn: 0,
    unclearedReceiptOffsetNgn: 0,
    payoutHeldForUnclearedReceipts: false,
    unclearedHoldOmReleased: true,
    unclearedHoldReleasedAtISO: now,
    unclearedHoldReleasedBy: who,
    unclearedHoldReleaseNote: note,
    note: String(before.note || '')
      .replace(/\s*·\s*HELD\s*$/i, '')
      .replace(/\s*HELD\s*$/i, '')
      .trim(),
  };

  const existingNote = String(row.payment_note || '').trim();
  const releaseLine = `OM uncleared-hold release (${who}): ${note}`;
  const paymentNote = existingNote.includes(note)
    ? existingNote
    : [existingNote, releaseLine].filter(Boolean).join(' ').trim();

  db.prepare(
    `UPDATE customer_refunds
     SET split_distributions_json = ?, payment_note = ?
     WHERE refund_id = ?`
  ).run(JSON.stringify(splits), paymentNote || null, rid);

  let walletClosedNgn = 0;
  const closeWallet = payload.closePartnerWallet !== false;
  if (closeWallet) {
    try {
      const walletRows = db
        .prepare(
          `SELECT id, open_ngn, party_id, payee_account_no, note
           FROM partner_wallet_entries
           WHERE refund_id = ? AND entry_type = 'credit' AND open_ngn > 0`
        )
        .all(rid);
      const upd = db.prepare(
        `UPDATE partner_wallet_entries
         SET open_ngn = 0,
             note = ?
         WHERE id = ?`
      );
      for (const w of walletRows) {
        const partyOk =
          (!payeeCustomerId || String(w.party_id || '').trim() === payeeCustomerId) &&
          (!payeeAccountNo ||
            !String(w.payee_account_no || '').trim() ||
            String(w.payee_account_no || '').trim() === payeeAccountNo);
        if (!partyOk) continue;
        const open = roundMoney(w.open_ngn);
        if (open <= 0) continue;
        const prior = String(w.note || '').trim();
        upd.run(
          `${prior}${prior ? ' · ' : ''}[OM released to till ${now.slice(0, 10)}: ${note}]`,
          w.id
        );
        walletClosedNgn += open;
      }
    } catch {
      /* partner_wallet_entries may be absent */
    }
  }

  appendAuditLog(db, {
    actor: payload.actor,
    action: 'refund.split.uncleared_hold_release',
    entityKind: 'refund',
    entityId: rid,
    note,
    details: {
      refundId: rid,
      payeeCustomerId: payeeCustomerId || splitCustomerId(splits[idx]),
      payeeAccountNo: payeeAccountNo || String(splits[idx]?.payoutAccount?.payeeAccountNo || '').trim(),
      netPayoutNgn,
      walletClosedNgn,
      previousHoldNgn: roundMoney(before.unclearedReceiptHoldNgn),
    },
  });

  return {
    ok: true,
    refundId: rid,
    status,
    payeeCustomerId: payeeCustomerId || splitCustomerId(splits[idx]),
    netPayoutNgn,
    walletClosedNgn,
    tillReadyNgn: netPayoutNgn,
    releaseNote: note,
    split: splits[idx],
  };
}
