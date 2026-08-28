/**
 * Partner wallet credits (BM-approved refund accruals). No imports from controlOps/writeOps
 * so approval can call this without circular dependencies.
 */
import { actorId, actorName } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { allocateHumanId } from '../humanId.js';
import { savedCustomerPayoutAccount } from '../sales/customerPayoutAccount.js';
import {
  applyRefundStaffAllocationDeduction,
} from '../../shared/lib/refundStaffAllocationDeduction.js';
import {
  unclearedReceiptFloatBySalesCustomerIds,
  unclearedTotalsMap,
} from '../sales/refundClaimingStaffUnclearedReceipts.js';
import { getRefundStaffAllocationDeductionRate } from '../orgPolicy.js';
import {
  creditCompanyRetentionFromRefundTx,
  refundCompanyRetentionTablesReady,
  voidCompanyRetentionForRefundTx,
} from './refundCompanyRetentionLedger.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

export function partnerWalletEnabled() {
  const raw = String(process.env.ZAREWA_PARTNER_WALLET_V1 ?? '').trim();
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  return /^(1|true|yes|on)$/i.test(String(process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 || '0'));
}

export function partnerWalletTablesReady(db) {
  try {
    db.prepare(`SELECT 1 FROM partner_wallet_entries LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

export function nextWalletEntryId(db, branchId) {
  return allocateHumanId(db, 'PWL', branchId, {
    table: 'partner_wallet_entries',
    idColumn: 'id',
  });
}

function branchFilter(scope) {
  if (scope === 'ALL' || !scope) return { sql: '', args: [] };
  return { sql: ` AND branch_id = ?`, args: [scope] };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} refundRow
 * @param {number} approvedAmountNgn
 */
function resolveCreditTargets(db, refundRow, approvedAmountNgn) {
  const approved = roundMoney(approvedAmountNgn);
  if (approved <= 0) return [];
  let splits = [];
  try {
    const parsed = JSON.parse(String(refundRow.split_distributions_json || '[]'));
    splits = Array.isArray(parsed) ? parsed : [];
  } catch {
    splits = [];
  }
  const usable = splits
    .map((s) => {
      const kind = String(s?.recipientKind || s?.payoutAccount?.partyKind || 'customer')
        .trim()
        .toLowerCase();
      const staffId = String(s?.recipientAssociatedStaffID || '').trim();
      const customerId = String(s?.recipientCustomerID || '').trim();
      const isStaff = kind === 'associated_staff' || kind === 'staff' || (staffId && !customerId);
      return {
        recipientKind: isStaff ? 'associated_staff' : 'customer',
        recipientAssociatedStaffID: isStaff ? staffId || customerId : '',
        recipientCustomerID: isStaff ? '' : customerId,
        amountNgn: roundMoney(s?.amountNgn),
        payoutAccount: s?.payoutAccount && typeof s.payoutAccount === 'object' ? s.payoutAccount : null,
        note: String(s?.note || '').trim(),
        companyCutWaived: Boolean(
          s?.companyCutWaived === true || s?.company_cut_waived === true || s?.waiveCompanyCut === true
        ),
        companyCutWaiverNote: String(
          s?.companyCutWaiverNote ?? s?.company_cut_waiver_note ?? ''
        ).trim(),
      };
    })
    .filter(
      (s) =>
        s.amountNgn > 0 &&
        (s.recipientCustomerID || s.recipientAssociatedStaffID)
    );

  if (usable.length > 0) {
    const quoteCustomerId = String(refundRow.customer_id || '').trim();
    const deductionRate = getRefundStaffAllocationDeductionRate(db);
    const unclearedByCustomerId = unclearedTotalsMap(
      unclearedReceiptFloatBySalesCustomerIds(
        db,
        usable.map((s) => s.recipientCustomerID).filter(Boolean)
      )
    );
    const splitSum = usable.reduce((s, r) => s + r.amountNgn, 0) || 1;
    let allocated = 0;
    return usable
      .map((s, idx) => {
        const isLast = idx === usable.length - 1;
        const share = isLast
          ? Math.max(0, approved - allocated)
          : roundMoney((approved * s.amountNgn) / splitSum);
        allocated += share;
        const withDeduction = applyRefundStaffAllocationDeduction(
          { ...s, amountNgn: share },
          quoteCustomerId,
          {
            deductionRate,
            unclearedReceiptHoldNgn: unclearedByCustomerId.get(
              String(s.recipientCustomerID || '').trim()
            ),
            honorCompanyCutWaiver: true,
          }
        );
        const creditAmount = roundMoney(withDeduction.netPayoutNgn ?? share);
        const cutPct = Math.round((Number(withDeduction.deductionRate) || 0) * 100);
        const noteParts = [];
        if (withDeduction.companyCutWaived) {
          noteParts.push('company cut waived (Admin/MD)');
        } else if (withDeduction.companyDeductionNgn > 0) {
          noteParts.push(`net after ${cutPct}% company cut`);
        }
        if (withDeduction.unclearedReceiptOffsetNgn > 0) {
          noteParts.push(
            `−₦${roundMoney(withDeduction.unclearedReceiptOffsetNgn).toLocaleString('en-NG')} uncleared receipts`
          );
        }
        if (withDeduction.payoutHeldForUnclearedReceipts) {
          noteParts.push('held until cashier clears receipts');
        }
        const detailNote = noteParts.length ? ` (${noteParts.join('; ')})` : '';
        if (s.recipientKind === 'associated_staff') {
          const staff = db
            .prepare(
              `SELECT name, bank_account_name, bank_name, bank_account_no FROM associated_staff WHERE id = ?`
            )
            .get(s.recipientAssociatedStaffID);
          const payeeName =
            String(s.payoutAccount?.payeeName || staff?.bank_account_name || staff?.name || '').trim() ||
            String(refundRow.payee_name || '').trim();
          const payeeBankName =
            String(s.payoutAccount?.payeeBankName || staff?.bank_name || '').trim() ||
            String(refundRow.payee_bank_name || '').trim();
          const payeeAccountNo =
            String(s.payoutAccount?.payeeAccountNo || staff?.bank_account_no || '').trim() ||
            String(refundRow.payee_account_no || '').trim();
          return {
            partyKind: 'associated_staff',
            partyId: s.recipientAssociatedStaffID,
            partyName: String(staff?.name || payeeName || s.recipientAssociatedStaffID).trim(),
            amountNgn: creditAmount,
            grossNgn: share,
            companyDeductionNgn: roundMoney(withDeduction.companyDeductionNgn),
            unclearedReceiptOffsetNgn: roundMoney(withDeduction.unclearedReceiptOffsetNgn),
            payeeName,
            payeeBankName,
            payeeAccountNo,
            note: s.note || `Refund ${refundRow.refund_id} staff split${detailNote}`,
          };
        }
        const resolved = savedCustomerPayoutAccount(db, s.recipientCustomerID);
        const payeeName =
          String(s.payoutAccount?.payeeName || resolved?.payeeName || '').trim() ||
          String(refundRow.payee_name || '').trim();
        const payeeBankName =
          String(s.payoutAccount?.payeeBankName || resolved?.payeeBankName || '').trim() ||
          String(refundRow.payee_bank_name || '').trim();
        const payeeAccountNo =
          String(s.payoutAccount?.payeeAccountNo || resolved?.payeeAccountNo || '').trim() ||
          String(refundRow.payee_account_no || '').trim();
        return {
          partyKind: 'customer',
          partyId: s.recipientCustomerID,
          partyName: String(resolved?.partyName || payeeName || s.recipientCustomerID).trim(),
          amountNgn: creditAmount,
          grossNgn: share,
          companyDeductionNgn: roundMoney(withDeduction.companyDeductionNgn),
          unclearedReceiptOffsetNgn: roundMoney(withDeduction.unclearedReceiptOffsetNgn),
          payeeName,
          payeeBankName,
          payeeAccountNo,
          note: s.note || `Refund ${refundRow.refund_id} split${detailNote}`,
        };
      })
      .filter((t) => t.amountNgn > 0 || roundMoney(t.companyDeductionNgn) > 0 || roundMoney(t.unclearedReceiptOffsetNgn) > 0);
  }

  const customerId = String(refundRow.customer_id || '').trim();
  if (!customerId) return [];
  const resolved = savedCustomerPayoutAccount(db, customerId);
  return [
    {
      partyKind: 'customer',
      partyId: customerId,
      partyName: String(resolved?.partyName || refundRow.customer_name || customerId).trim(),
      amountNgn: approved,
      payeeName: String(refundRow.payee_name || resolved?.payeeName || '').trim(),
      payeeBankName: String(refundRow.payee_bank_name || resolved?.payeeBankName || '').trim(),
      payeeAccountNo: String(refundRow.payee_account_no || resolved?.payeeAccountNo || '').trim(),
      note: `Refund ${refundRow.refund_id} approved`,
    },
  ];
}

/**
 * Idempotent — credit company cut into retention when approval settled paid_amount but ledger insert was skipped.
 */
export function ensureRefundCompanyRetentionCreditTx(db, refundRow, { approvedAmountNgn, actor } = {}) {
  const refundId = String(refundRow?.refund_id || refundRow?.refundID || '').trim();
  if (!refundId) return { ok: true, skipped: true, reason: 'no_refund_id' };

  const approved = roundMoney(
    approvedAmountNgn ?? refundRow?.approved_amount_ngn ?? refundRow?.approvedAmountNgn ?? refundRow?.amount_ngn ?? refundRow?.amountNgn
  );
  const targets = resolveCreditTargets(db, refundRow, approved);
  const companyRetentionNgn = targets.reduce((s, t) => s + roundMoney(t.companyDeductionNgn), 0);
  if (companyRetentionNgn <= 0) {
    return { ok: true, skipped: true, reason: 'no_company_cut' };
  }

  const branchId = String(refundRow.branch_id || refundRow.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  try {
    return creditCompanyRetentionFromRefundTx(db, {
      refundId,
      branchId,
      amountNgn: companyRetentionNgn,
      actor,
      note: `Company cut ₦${companyRetentionNgn.toLocaleString('en-NG')} from refund ${refundId}`,
    });
  } catch (e) {
    console.warn('[partnerWallet] ensure company retention credit failed', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Backfill retention credits for refunds whose payment note records a company cut but ledger row is missing.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchScope]
 * @param {{ limit?: number, actor?: object }} [opts]
 */
export function backfillMissingRefundCompanyRetentionCredits(db, branchScope = 'ALL', opts = {}) {
  const limit = Math.max(1, Math.min(200, Math.round(Number(opts.limit) || 50)));
  if (!refundCompanyRetentionTablesReady(db)) {
    return { ok: true, backfilled: 0, skipped: true, reason: 'tables_missing' };
  }

  const scope = trim(branchScope);
  const branchSql =
    scope && scope !== 'ALL' ? ` AND trim(IFNULL(r.branch_id, '')) = ?` : '';
  const branchArgs = scope && scope !== 'ALL' ? [scope] : [];

  const rows = db
    .prepare(
      `SELECT r.*
       FROM customer_refunds r
       LEFT JOIN refund_company_retention_entries e
         ON e.entry_type = 'credit'
        AND e.source_kind = 'REFUND_COMPANY_CUT'
        AND e.source_id = r.refund_id
       WHERE e.id IS NULL
         AND LOWER(IFNULL(r.status, '')) IN ('approved', 'paid')
         AND r.payment_note LIKE '%company cut%'
         AND r.payment_note LIKE '%retention ledger%'${branchSql}
       ORDER BY r.requested_at_iso DESC
       LIMIT ?`
    )
    .all(...branchArgs, limit);

  let backfilled = 0;
  for (const row of rows) {
    const result = ensureRefundCompanyRetentionCreditTx(db, row, {
      approvedAmountNgn: row.approved_amount_ngn || row.amount_ngn,
      actor: opts.actor,
    });
    if (result?.ok && !result?.skipped) backfilled += 1;
  }
  return { ok: true, backfilled, scanned: rows.length };
}

function trim(v) {
  return String(v ?? '').trim();
}

/**
 * Apply company cut + uncleared offsets at BM approval.
 * Always settles the company % into retention + paid_amount_ngn (so cashier only pays net),
 * even when partner-wallet credits are disabled.
 * When the wallet flag is on, also credits net amounts to partner wallets for cashier release.
 */
export function creditRefundToPartnerWalletTx(db, refundRow, { approvedAmountNgn, actor } = {}) {
  const refundId = String(refundRow?.refund_id || '').trim();
  if (!refundId) return { ok: false, error: 'Refund id required for wallet credit.' };

  const walletOn = partnerWalletEnabled() && partnerWalletTablesReady(db);
  const alreadySettled = /settled at approval/i.test(String(refundRow?.payment_note || ''));
  let walletCreditsExist = false;
  if (walletOn) {
    const existing = db
      .prepare(
        `SELECT id FROM partner_wallet_entries
         WHERE entry_type = 'credit' AND source_kind = 'REFUND' AND source_id = ? AND amount_ngn > 0`
      )
      .all(refundId);
    walletCreditsExist = existing.length > 0;
  } else if (alreadySettled) {
    const retentionCredit = ensureRefundCompanyRetentionCreditTx(db, refundRow, {
      approvedAmountNgn,
      actor,
    });
    return {
      ok: true,
      skipped: true,
      reason: 'deductions_already_settled',
      retentionCredit,
    };
  }

  const targets = resolveCreditTargets(db, refundRow, approvedAmountNgn);
  const companyRetentionNgn = targets.reduce((s, t) => s + roundMoney(t.companyDeductionNgn), 0);
  const unclearedOffsetNgn = targets.reduce(
    (s, t) => s + roundMoney(t.unclearedReceiptOffsetNgn),
    0
  );
  const settledAtApprovalNgn = companyRetentionNgn + unclearedOffsetNgn;
  const creditTargets = targets.filter((t) => roundMoney(t.amountNgn) > 0);

  if (walletOn && walletCreditsExist && alreadySettled) {
    const retentionCredit = ensureRefundCompanyRetentionCreditTx(db, refundRow, {
      approvedAmountNgn,
      actor,
    });
    return {
      ok: true,
      skipped: true,
      reason: 'already_credited',
      companyRetentionNgn,
      unclearedOffsetNgn,
      settledAtApprovalNgn,
      retentionCredit,
    };
  }

  if (walletOn) {
    if (!targets.length) {
      return { ok: false, error: 'Could not resolve wallet payee for approved refund.' };
    }
    if (!walletCreditsExist) {
      for (const t of creditTargets) {
        if (!t.payeeName || !t.payeeBankName || !t.payeeAccountNo) {
          return {
            ok: false,
            error: `Wallet credit blocked: ${t.partyName || t.partyId} needs complete bank details on profile.`,
          };
        }
      }
    }
  } else if (!targets.length) {
    return { ok: true, skipped: true, reason: 'no_split_targets' };
  }

  const branchId = String(refundRow.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const at = new Date().toISOString();
  const credits = [];

  if (walletOn && !walletCreditsExist) {
    const ins = db.prepare(`
      INSERT INTO partner_wallet_entries (
        id, party_kind, party_id, party_name, entry_type, amount_ngn, open_ngn,
        source_kind, source_id, refund_id, withdrawal_id, branch_id,
        payee_name, payee_bank_name, payee_account_no, note,
        created_at_iso, created_by_user_id, created_by_name, treasury_movement_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const t of creditTargets) {
      const id = nextWalletEntryId(db, branchId);
      ins.run(
        id,
        t.partyKind,
        t.partyId,
        t.partyName,
        'credit',
        t.amountNgn,
        t.amountNgn,
        'REFUND',
        refundId,
        refundId,
        null,
        branchId,
        t.payeeName,
        t.payeeBankName,
        t.payeeAccountNo,
        t.note,
        at,
        actorId(actor),
        actorName(actor),
        null
      );
      credits.push({
        id,
        partyId: t.partyId,
        amountNgn: t.amountNgn,
        grossNgn: t.grossNgn != null ? t.grossNgn : t.amountNgn,
        companyDeductionNgn: roundMoney(t.companyDeductionNgn),
        unclearedReceiptOffsetNgn: roundMoney(t.unclearedReceiptOffsetNgn),
      });
    }
  }

  // Company cut + uncleared-receipt offset settled at approval (not paid out by cashier).
  // Company cut accumulates in the branch retention ledger for later BM-approved withdrawal.
  let retentionCredit = null;
  if (companyRetentionNgn > 0) {
    try {
      retentionCredit = creditCompanyRetentionFromRefundTx(db, {
        refundId,
        branchId,
        amountNgn: companyRetentionNgn,
        actor,
        note: `Company cut ₦${companyRetentionNgn.toLocaleString('en-NG')} from refund ${refundId}`,
      });
    } catch (e) {
      console.warn('[partnerWallet] company retention credit failed', e?.message || e);
    }
  }
  if (!alreadySettled && settledAtApprovalNgn > 0) {
    const paidNow = roundMoney(
      db.prepare(`SELECT paid_amount_ngn FROM customer_refunds WHERE refund_id = ?`).get(refundId)
        ?.paid_amount_ngn
    );
    const nextPaid = paidNow + settledAtApprovalNgn;
    const approved = roundMoney(approvedAmountNgn || refundRow.approved_amount_ngn || refundRow.amount_ngn);
    const noteParts = [];
    if (companyRetentionNgn > 0) {
      noteParts.push(
        `company cut ₦${companyRetentionNgn.toLocaleString('en-NG')} → retention ledger`
      );
    }
    if (unclearedOffsetNgn > 0) {
      noteParts.push(
        `uncleared receipts offset ₦${unclearedOffsetNgn.toLocaleString('en-NG')}`
      );
    }
    const paymentNote = `Settled at approval: ${noteParts.join('; ')}.`;
    db.prepare(
      `UPDATE customer_refunds
       SET paid_amount_ngn = ?,
           status = CASE WHEN ? >= ? THEN 'Paid' ELSE status END,
           payment_note = CASE
             WHEN TRIM(COALESCE(payment_note, '')) = '' THEN ?
             ELSE payment_note
           END
       WHERE refund_id = ?`
    ).run(nextPaid, nextPaid, approved, paymentNote, refundId);
  }

  if (walletOn && !walletCreditsExist && !credits.length && settledAtApprovalNgn <= 0) {
    return { ok: false, error: 'Could not resolve wallet payee for approved refund.' };
  }

  return {
    ok: true,
    credits,
    companyRetentionNgn,
    unclearedOffsetNgn,
    settledAtApprovalNgn,
    retentionCredit,
    walletCredited: walletOn && credits.length > 0,
    skippedWallet: !walletOn,
    backfilledSettlement: walletCreditsExist && !alreadySettled && settledAtApprovalNgn > 0,
  };
}

/** Void open credits for a cancelled refund (no withdrawals yet). */
export function voidPartnerWalletCreditsForRefundTx(db, refundId) {
  if (!partnerWalletTablesReady(db)) return { ok: true, skipped: true };
  const rid = String(refundId || '').trim();
  if (!rid) return { ok: true };
  const open = db
    .prepare(
      `SELECT id, amount_ngn, open_ngn FROM partner_wallet_entries
       WHERE entry_type = 'credit' AND refund_id = ?`
    )
    .all(rid);
  for (const row of open) {
    if (roundMoney(row.open_ngn) < roundMoney(row.amount_ngn)) {
      return {
        ok: false,
        error: 'Cannot cancel: part of this refund was already withdrawn from the partner wallet.',
      };
    }
  }
  db.prepare(
    `UPDATE partner_wallet_entries SET open_ngn = 0, note = COALESCE(note,'') || ' [voided on refund cancel]'
     WHERE entry_type = 'credit' AND refund_id = ?`
  ).run(rid);
  const retentionVoid = voidCompanyRetentionForRefundTx(db, rid);
  if (!retentionVoid.ok) return retentionVoid;
  return { ok: true };
}

export function refundHasOpenWalletCredit(db, refundId) {
  if (!partnerWalletTablesReady(db)) return false;
  const rid = String(refundId || '').trim();
  if (!rid) return false;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(open_ngn), 0) AS s FROM partner_wallet_entries
       WHERE entry_type = 'credit' AND refund_id = ? AND open_ngn > 0`
    )
    .get(rid);
  return roundMoney(row?.s) > 0;
}

export function openWalletCreditNgnForRefund(db, refundId) {
  if (!partnerWalletTablesReady(db)) return 0;
  const rid = String(refundId || '').trim();
  if (!rid) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(open_ngn), 0) AS s FROM partner_wallet_entries
       WHERE entry_type = 'credit' AND refund_id = ? AND open_ngn > 0`
    )
    .get(rid);
  return roundMoney(row?.s);
}

export function listPartnerWalletBalancesDue(db, branchScope = 'ALL') {
  if (!partnerWalletEnabled() || !partnerWalletTablesReady(db)) return [];
  const bw = branchFilter(branchScope);
  const rows = db
    .prepare(
      `
      SELECT party_kind, party_id,
             MAX(party_name) AS party_name,
             MAX(payee_name) AS payee_name,
             MAX(payee_bank_name) AS payee_bank_name,
             MAX(payee_account_no) AS payee_account_no,
             MAX(branch_id) AS branch_id,
             COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN open_ngn ELSE 0 END), 0) AS balance_ngn,
             COUNT(CASE WHEN entry_type = 'credit' AND open_ngn > 0 THEN 1 END) AS open_credit_count
      FROM partner_wallet_entries
      WHERE 1=1 ${bw.sql}
      GROUP BY party_kind, party_id
      HAVING balance_ngn > 0
      ORDER BY party_name COLLATE NOCASE
    `
    )
    .all(...bw.args);
  return rows.map((r) => ({
    partyKind: r.party_kind,
    partyId: r.party_id,
    partyName: r.party_name || r.party_id,
    payeeName: r.payee_name || '',
    payeeBankName: r.payee_bank_name || '',
    payeeAccountNo: r.payee_account_no || '',
    branchId: r.branch_id || '',
    balanceNgn: roundMoney(r.balance_ngn),
    openCreditCount: Number(r.open_credit_count) || 0,
  }));
}

export function listPartnerWalletOpenCredits(db, partyKind, partyId, branchScope = 'ALL') {
  if (!partnerWalletTablesReady(db)) return [];
  const pk = String(partyKind || '').trim();
  const pid = String(partyId || '').trim();
  if (!pk || !pid) return [];
  const bw = branchFilter(branchScope);
  return db
    .prepare(
      `
      SELECT id, refund_id, amount_ngn, open_ngn, payee_name, payee_bank_name, payee_account_no,
             branch_id, note, created_at_iso, source_id, party_name
      FROM partner_wallet_entries
      WHERE entry_type = 'credit' AND open_ngn > 0
        AND party_kind = ? AND party_id = ? ${bw.sql}
      ORDER BY created_at_iso ASC, id ASC
    `
    )
    .all(pk, pid, ...bw.args)
    .map((r) => ({
      id: r.id,
      refundId: r.refund_id || r.source_id || '',
      amountNgn: roundMoney(r.amount_ngn),
      openNgn: roundMoney(r.open_ngn),
      payeeName: r.payee_name || '',
      payeeBankName: r.payee_bank_name || '',
      payeeAccountNo: r.payee_account_no || '',
      branchId: r.branch_id || '',
      partyName: r.party_name || '',
      note: r.note || '',
      createdAtISO: r.created_at_iso || '',
    }));
}
