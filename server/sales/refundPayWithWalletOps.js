/**
 * Cashier refund pay with optional partner-wallet release on the same request.
 * Keeps wallet withdraw out of writeOps to avoid circular imports with partnerWalletOps.
 */
import { withdrawPartnerWallet, listPartnerWalletOpenCreditsForRefund } from '../finance/partnerWalletOps.js';
import { payRefundEntry } from '../writeOps.js';

function roundMoney(v) {
  return Math.round(Number(v) || 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @param {Record<string, unknown>} payload
 */
export function payRefundEntryWithOptionalWalletRelease(db, refundId, payload = {}) {
  const rid = String(refundId || '').trim();
  if (!rid) return { ok: false, error: 'Refund id required.' };

  const releaseWallet = Boolean(
    payload.releasePartnerWallet === true ||
      payload.releaseWallet === true ||
      payload.release_partner_wallet === true
  );

  const paymentLines = Array.isArray(payload.paymentLines) ? payload.paymentLines : [];
  const tillLines = paymentLines.filter((line) => roundMoney(line?.amountNgn) > 0);
  const hasLegacyTill =
    tillLines.length === 0 &&
    Number(payload.treasuryAccountId) > 0 &&
    (payload.amountNgn == null || roundMoney(payload.amountNgn) > 0);

  const walletWithdrawals = [];
  if (releaseWallet) {
    const credits = listPartnerWalletOpenCreditsForRefund(db, rid).filter(
      (c) => roundMoney(c.openNgn) > 0
    );
    if (!credits.length) {
      if (tillLines.length === 0 && !hasLegacyTill) {
        return { ok: false, error: 'No open partner-wallet balance on this refund to release.' };
      }
    } else {
      const treasuryAccountId = Number(
        payload.treasuryAccountId ||
          tillLines[0]?.treasuryAccountId ||
          paymentLines[0]?.treasuryAccountId ||
          0
      );
      if (!treasuryAccountId) {
        return {
          ok: false,
          error: 'Select a treasury account to release partner-wallet balance.',
          code: 'PARTNER_WALLET_TREASURY_REQUIRED',
        };
      }
      const byParty = new Map();
      for (const credit of credits) {
        const key = `${credit.partyKind || 'customer'}::${credit.partyId || ''}`;
        const prev = byParty.get(key) || {
          partyKind: credit.partyKind || 'customer',
          partyId: String(credit.partyId || '').trim(),
          partyName: credit.partyName || credit.payeeName || '',
          amountNgn: 0,
        };
        prev.amountNgn += roundMoney(credit.openNgn);
        byParty.set(key, prev);
      }
      const note =
        String(payload.paymentNote ?? payload.note ?? '').trim() ||
        `Refund ${rid} partner wallet release`;
      for (const party of byParty.values()) {
        if (!party.partyId || party.amountNgn <= 0) continue;
        const withdrawn = withdrawPartnerWallet(db, {
          partyKind: party.partyKind,
          partyId: party.partyId,
          partyName: party.partyName,
          amountNgn: party.amountNgn,
          treasuryAccountId,
          refundId: rid,
          note,
          paidBy: payload.paidBy,
          actor: payload.actor,
          workspaceBranchId: payload.workspaceBranchId,
          workspaceViewAll: payload.workspaceViewAll,
          paidAtISO: payload.paidAtISO || payload.dateISO,
          dateISO: payload.dateISO,
          reference: payload.reference,
        });
        if (!withdrawn.ok) return withdrawn;
        walletWithdrawals.push(withdrawn);
      }
    }
  }

  if (tillLines.length === 0 && !hasLegacyTill) {
    if (walletWithdrawals.length > 0) {
      return {
        ok: true,
        walletOnly: true,
        walletWithdrawals,
      };
    }
    return {
      ok: false,
      error: 'Add at least one payout line, or set releasePartnerWallet to release wallet balance.',
    };
  }

  const payPayload =
    tillLines.length > 0
      ? { ...payload, paymentLines: tillLines }
      : payload;
  const paid = payRefundEntry(db, rid, payPayload);
  if (!paid.ok) {
    return {
      ...paid,
      walletWithdrawals: walletWithdrawals.length ? walletWithdrawals : undefined,
      walletReleasedBeforePayFailure: walletWithdrawals.length > 0,
    };
  }
  return {
    ...paid,
    walletWithdrawals: walletWithdrawals.length ? walletWithdrawals : undefined,
  };
}
