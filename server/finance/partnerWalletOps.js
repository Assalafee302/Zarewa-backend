/**
 * Partner wallet cashier withdrawals — full or partial release of BM-approved credits.
 * No second approval; dual-control (approver ≠ payer) still applies per source refund.
 */
import { actorId, actorName, userHasPermission } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { assertEntityBranchForWorkspaceWrite } from '../branchScope.js';
import { assertPeriodOpen, appendAuditLog } from '../controlOps.js';
import { allocateHumanId } from '../humanId.js';
import { assertActorMayPayCustomerRefund } from '../refundHandlers.js';
import { evaluateRefundPayoutGlPolicy } from '../ap1cReversalRefundOps.js';
import { tryPostCustomerRefundPayoutGlTx, ensureSupplementalGlAccounts } from '../glOps.js';
import { insertTreasuryMovementTx } from '../writeOps.js';
import { effectiveOutstandingNgn } from '../../shared/lib/paymentOutstandingTolerance.js';
import { resolveRefundStatus, assertRefundMoneyOutWithinApproved } from '../sales/refundPayoutStatus.js';
import {
  listPartnerWalletOpenCredits,
  nextWalletEntryId,
  partnerWalletEnabled,
  partnerWalletTablesReady,
} from './partnerWalletCredit.js';

export {
  creditRefundToPartnerWalletTx,
  listPartnerWalletBalancesDue,
  listPartnerWalletOpenCredits,
  listPartnerWalletOpenCreditsForRefund,
  openWalletCreditNgnForRefund,
  partnerWalletEnabled,
  partnerWalletTablesReady,
  refundHasOpenWalletCredit,
  voidPartnerWalletCreditsForRefundTx,
} from './partnerWalletCredit.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function nextWithdrawalId(db, branchId) {
  return allocateHumanId(db, 'PWV', branchId, {
    table: 'partner_wallet_entries',
    idColumn: 'id',
  });
}

function nextAllocationId(db, branchId) {
  return allocateHumanId(db, 'PWA', branchId, {
    table: 'partner_wallet_withdrawal_allocations',
    idColumn: 'id',
  });
}

function normalizeIso(value) {
  const s = String(value || '').trim();
  if (!s) return new Date().toISOString();
  if (s.includes('T')) return s;
  return `${s}T12:00:00.000Z`;
}

/**
 * Cashier withdraws full or partial balance — no BM re-approval.
 */
export function withdrawPartnerWallet(db, payload = {}) {
  if (!partnerWalletEnabled()) {
    return { ok: false, error: 'Partner wallet withdrawals are not enabled.' };
  }
  if (!partnerWalletTablesReady(db)) {
    return { ok: false, error: 'Partner wallet tables are not ready. Run migrations.' };
  }
  const partyKind = String(payload.partyKind || 'customer').trim() || 'customer';
  const partyId = String(payload.partyId || '').trim();
  if (!partyId) return { ok: false, error: 'Partner profile is required.' };
  const amountNgn = roundMoney(payload.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Withdrawal amount must be positive.' };

  const refundIdFilter = String(payload.refundId || payload.refundID || '').trim();
  let credits = listPartnerWalletOpenCredits(db, partyKind, partyId, payload.branchScope || 'ALL');
  if (refundIdFilter) {
    credits = credits.filter((c) => String(c.refundId || '').trim() === refundIdFilter);
  }
  const balance = credits.reduce((s, c) => s + c.openNgn, 0);
  if (amountNgn > balance) {
    return {
      ok: false,
      error: refundIdFilter
        ? `Withdrawal ₦${amountNgn.toLocaleString('en-NG')} exceeds open wallet on this refund ₦${balance.toLocaleString('en-NG')}.`
        : `Withdrawal ₦${amountNgn.toLocaleString('en-NG')} exceeds open balance ₦${balance.toLocaleString('en-NG')}.`,
    };
  }
  if (!credits.length) {
    return {
      ok: false,
      error: refundIdFilter
        ? 'No open partner-wallet balance on this refund for that payee.'
        : 'No open wallet balance for this partner.',
    };
  }

  const payeeName = String(credits[0].payeeName || payload.payeeName || '').trim();
  const payeeBankName = String(credits[0].payeeBankName || payload.payeeBankName || '').trim();
  const payeeAccountNo = String(credits[0].payeeAccountNo || payload.payeeAccountNo || '').trim();
  if (!payeeName || !payeeBankName || !payeeAccountNo) {
    return { ok: false, error: 'Partner payee bank details are incomplete.' };
  }

  const treasuryAccountId = Number(payload.treasuryAccountId);
  if (!treasuryAccountId) return { ok: false, error: 'Select a treasury account.' };

  const actor = payload.actor || null;
  const hasPerm = (p) => userHasPermission(actor, p);
  const refundIds = [...new Set(credits.map((c) => c.refundId).filter(Boolean))];
  for (const rid of refundIds) {
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(rid);
    if (!row) continue;
    const seg = assertActorMayPayCustomerRefund(row, actor, hasPerm);
    if (!seg.ok) return { ok: false, error: seg.error };
    const branchGate = assertEntityBranchForWorkspaceWrite(
      actor,
      row.branch_id,
      payload.workspaceBranchId,
      Boolean(payload.workspaceViewAll)
    );
    if (!branchGate.ok) return { ok: false, error: branchGate.error };
  }

  const defaultDay =
    String(payload.paidAtISO || payload.dateISO || '').trim().slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, defaultDay, 'Partner wallet withdrawal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  // GL bootstrap uses DDL — must run before db.transaction (MySQL implicit commit breaks savepoints).
  try {
    ensureSupplementalGlAccounts(db);
  } catch {
    /* narrow tests may omit GL tables */
  }

  const branchId =
    String(credits[0].branchId || payload.workspaceBranchId || DEFAULT_BRANCH_ID).trim() ||
    DEFAULT_BRANCH_ID;
  const paidBy = String(payload.paidBy || '').trim() || actorName(actor) || 'Cashier';
  const bankReference = String(payload.reference || payload.bankReference || '').trim();
  const paymentNote = String(payload.note || '').trim();
  const postedAtISO = normalizeIso(payload.paidAtISO || defaultDay);

  try {
    const result = db.transaction(() => {
      let left = amountNgn;
      const allocations = [];
      for (const credit of credits) {
        if (left <= 0) break;
        const take = Math.min(left, credit.openNgn);
        if (take <= 0) continue;
        allocations.push({ credit, amountNgn: take });
        left -= take;
      }
      if (left > 0) throw new Error('Could not allocate withdrawal across open credits.');

      const withdrawalId = nextWithdrawalId(db, branchId);
      const movement = insertTreasuryMovementTx(db, {
        type: 'PARTNER_WALLET_PAYOUT',
        treasuryAccountId,
        amountNgn: -amountNgn,
        postedAtISO,
        reference: bankReference || withdrawalId,
        counterpartyKind: partyKind === 'associated_staff' ? 'ASSOCIATED_STAFF' : 'CUSTOMER',
        counterpartyId: partyId,
        counterpartyName: String(credits[0].partyName || payeeName),
        sourceKind: 'PARTNER_WALLET',
        sourceId: withdrawalId,
        note: paymentNote || `Partner wallet withdrawal ${withdrawalId}`,
        createdBy: paidBy,
        workspaceBranchId: payload.workspaceBranchId,
        workspaceViewAll: Boolean(payload.workspaceViewAll),
        actor,
        batchId: withdrawalId,
      });

      const at = new Date().toISOString();
      const withdrawEntryId = nextWalletEntryId(db, branchId);
      db.prepare(`
        INSERT INTO partner_wallet_entries (
          id, party_kind, party_id, party_name, entry_type, amount_ngn, open_ngn,
          source_kind, source_id, refund_id, withdrawal_id, branch_id,
          payee_name, payee_bank_name, payee_account_no, note,
          created_at_iso, created_by_user_id, created_by_name, treasury_movement_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        withdrawEntryId,
        partyKind,
        partyId,
        String(payload.partyName || credits[0].partyName || payeeName),
        'withdrawal',
        amountNgn,
        0,
        'PARTNER_WALLET',
        withdrawalId,
        null,
        withdrawalId,
        branchId,
        payeeName,
        payeeBankName,
        payeeAccountNo,
        paymentNote || null,
        at,
        actorId(actor),
        actorName(actor),
        movement.id
      );

      const updCredit = db.prepare(
        `UPDATE partner_wallet_entries SET open_ngn = open_ngn - ? WHERE id = ? AND open_ngn >= ?`
      );
      const insAlloc = db.prepare(`
        INSERT INTO partner_wallet_withdrawal_allocations (
          id, withdrawal_id, credit_entry_id, refund_id, amount_ngn, created_at_iso
        ) VALUES (?,?,?,?,?,?)
      `);

      const refundPaidDeltas = new Map();
      for (const alloc of allocations) {
        const info = updCredit.run(alloc.amountNgn, alloc.credit.id, alloc.amountNgn);
        if (!info.changes) throw new Error('Wallet credit changed concurrently — retry.');
        insAlloc.run(
          nextAllocationId(db, branchId),
          withdrawalId,
          alloc.credit.id,
          alloc.credit.refundId || null,
          alloc.amountNgn,
          at
        );
        if (alloc.credit.refundId) {
          refundPaidDeltas.set(
            alloc.credit.refundId,
            (refundPaidDeltas.get(alloc.credit.refundId) || 0) + alloc.amountNgn
          );
        }
      }

      for (const [refundId, delta] of refundPaidDeltas) {
        const fresh = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundId);
        if (!fresh) continue;
        const approvedFresh = roundMoney(fresh.approved_amount_ngn || fresh.amount_ngn);
        const paidFresh = roundMoney(fresh.paid_amount_ngn);
        const outstanding = effectiveOutstandingNgn(approvedFresh, paidFresh);
        if (delta > outstanding) {
          throw new Error(`Withdrawal exceeds open refund balance on ${refundId}.`);
        }
        const nextPaid = paidFresh + delta;
        const nextRow = { ...fresh, paid_amount_ngn: nextPaid };
        const nextStatus = resolveRefundStatus(db, nextRow);
        db.prepare(
          `UPDATE customer_refunds
           SET status = ?, paid_amount_ngn = ?, paid_at_iso = ?, paid_by = ?, paid_by_user_id = ?, payment_note = ?
           WHERE refund_id = ?`
        ).run(
          nextStatus,
          nextPaid,
          postedAtISO.slice(0, 10),
          paidBy,
          actorId(actor),
          paymentNote || fresh.payment_note || `Wallet withdrawal ${withdrawalId}`,
          refundId
        );

        const refundGlPolicy = evaluateRefundPayoutGlPolicy(db, {
          quotationRef: fresh.quotation_ref,
          customerId: fresh.customer_id,
          refundId,
        });
        const glPay = tryPostCustomerRefundPayoutGlTx(db, {
          refundId,
          payoutAmountNgn: delta,
          payoutMovementIds: [movement.id],
          entryDateISO: postedAtISO.slice(0, 10),
          branchId: fresh.branch_id ?? null,
          createdByUserId: actor?.id != null ? String(actor.id) : null,
          needsRevenueReview: refundGlPolicy.needsRevenueReview,
        });
        if (!glPay.ok && !glPay.skipped && !glPay.duplicate) {
          throw new Error(glPay.error || 'Refund payout GL failed.');
        }
        const afterWithdraw = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundId);
        assertRefundMoneyOutWithinApproved(db, afterWithdraw);
      }

      return {
        ok: true,
        withdrawalId,
        amountNgn,
        partyKind,
        partyId,
        treasuryMovementId: movement.id,
        allocations: allocations.map((a) => ({
          creditEntryId: a.credit.id,
          refundId: a.credit.refundId,
          amountNgn: a.amountNgn,
        })),
        remainingBalanceNgn: balance - amountNgn,
      };
    })();
    if (result?.ok) {
      try {
        appendAuditLog(db, {
          actor,
          action: 'partner_wallet.withdraw',
          entityKind: 'partner_wallet',
          entityId: result.withdrawalId,
          note: paymentNote || `Partner wallet withdrawal ${result.withdrawalId}`,
          details: {
            amountNgn: result.amountNgn,
            partyKind,
            partyId,
            remainingBalanceNgn: result.remainingBalanceNgn,
            allocations: result.allocations,
            treasuryMovementId: result.treasuryMovementId,
          },
        });
      } catch {
        /* audit optional if table unavailable in narrow tests */
      }
    }
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
