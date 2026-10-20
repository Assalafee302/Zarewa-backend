/**
 * Finance Phase A (A1): "Add payout account" from a desk card.
 * Fills a payee's missing bank + 10-digit account on the profile and on the open document
 * (refund split, payment request, or transport agent). A payee that already has a usable
 * account is not changed here, so an approved payout cannot be redirected from the desk.
 */
import { appendAuditLog } from '../controlOps.js';
import { payoutAccountDigits, payoutAccountProblem } from '../../shared/lib/payoutAccountGuard.js';
import { saveRefundPayoutBank } from '../sales/refundPayoutBankOps.js';
import { refundPayeesAwaitingCash, transportAgentPayoutAccount } from './payoutAccountGate.js';

function trim(v) {
  return String(v ?? '').trim();
}

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(String(text || ''));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function lastFour(accountNo) {
  const d = String(accountNo || '').replace(/\D/g, '');
  return d ? `…${d.slice(-4)}` : '(none)';
}

const ALREADY_SET =
  'This payee already has a payout account. Change it from the payee profile or the document, not from the pay desk.';

function refuse(error, code = 'PAYOUT_ACCOUNT_INVALID') {
  return { ok: false, code, error };
}

function addToRefund(db, payload, actor) {
  const refundId = trim(payload.refundId);
  const partyKind = trim(payload.partyKind) === 'associated_staff' ? 'associated_staff' : 'customer';
  const partyId = trim(payload.partyId);
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundId);
  if (!row) return refuse('Refund not found.', 'NOT_FOUND');
  const quoteCustomerId = trim(row.customer_id);
  const id = partyId || (partyKind === 'customer' ? quoteCustomerId : '');
  if (!id) return refuse('Say which payee on the refund needs the account.');
  const owed = refundPayeesAwaitingCash(db, row);
  const target = owed.find((t) => t.partyKind === partyKind && trim(t.partyId) === id);
  if (!target) return refuse(`${id} is not a payee still waiting for cash on ${refundId}.`);
  if (!payoutAccountProblem({ bankName: target.payeeBankName, accountNo: target.payeeAccountNo })) {
    return refuse(ALREADY_SET, 'PAYOUT_ACCOUNT_ALREADY_SET');
  }
  const profile = saveRefundPayoutBank(db, {
    kind: partyKind,
    id,
    bankName: payload.bankName,
    bankAccountNo: payload.accountNo,
    bankAccountName: payload.accountName,
    branchId: trim(row.branch_id),
  });
  if (!profile.ok) return profile;

  const account = {
    payeeName: trim(payload.accountName) || trim(profile.bankAccountName) || trim(target.partyName),
    payeeBankName: trim(payload.bankName),
    payeeAccountNo: payoutAccountDigits(payload.accountNo),
  };
  const splits = parseJson(row.split_distributions_json, []);
  let splitsChanged = false;
  if (Array.isArray(splits)) {
    for (const s of splits) {
      const sid =
        partyKind === 'associated_staff'
          ? trim(s?.recipientAssociatedStaffID ?? s?.recipient_associated_staff_id)
          : trim(s?.recipientCustomerID ?? s?.recipient_customer_id);
      if (sid !== id) continue;
      s.payoutAccount = { ...(s.payoutAccount && typeof s.payoutAccount === 'object' ? s.payoutAccount : {}), partyKind, partyId: id, ...account };
      splitsChanged = true;
    }
  }
  const touchesRefundPayee = partyKind === 'customer' && id === quoteCustomerId;
  if (splitsChanged) {
    db.prepare(`UPDATE customer_refunds SET split_distributions_json = ? WHERE refund_id = ?`).run(JSON.stringify(splits), refundId);
  }
  if (touchesRefundPayee) {
    db.prepare(
      `UPDATE customer_refunds SET payee_name = COALESCE(NULLIF(TRIM(payee_name), ''), ?), payee_bank_name = ?, payee_account_no = ? WHERE refund_id = ?`
    ).run(account.payeeName, account.payeeBankName, account.payeeAccountNo, refundId);
  }
  appendAuditLog(db, {
    actor,
    action: 'payout_account.add',
    entityKind: 'refund',
    entityId: refundId,
    note: `Payout account added for ${target.partyName || id} on ${refundId}: ${account.payeeBankName} ${lastFour(account.payeeAccountNo)}`,
    details: {
      partyKind,
      partyId: id,
      before: { bankName: trim(target.payeeBankName), account: lastFour(target.payeeAccountNo) },
      after: { bankName: account.payeeBankName, account: lastFour(account.payeeAccountNo) },
      profileUpdated: true,
      refundSplitUpdated: splitsChanged,
      refundPayeeUpdated: touchesRefundPayee,
    },
  });
  return { ok: true, target: 'refund', refundId, partyKind, partyId: id, ...account };
}

function addToPaymentRequest(db, payload, actor) {
  const requestId = trim(payload.requestId);
  const row = db
    .prepare(`SELECT request_id, payee_name, payee_bank_name, payee_account_no FROM payment_requests WHERE request_id = ?`)
    .get(requestId);
  if (!row) return refuse('Payment request not found.', 'NOT_FOUND');
  if (!payoutAccountProblem({ bankName: row.payee_bank_name, accountNo: row.payee_account_no })) {
    return refuse(ALREADY_SET, 'PAYOUT_ACCOUNT_ALREADY_SET');
  }
  const payeeName = trim(payload.accountName) || trim(row.payee_name);
  const payeeBankName = trim(payload.bankName);
  const payeeAccountNo = payoutAccountDigits(payload.accountNo);
  db.prepare(
    `UPDATE payment_requests SET payee_name = ?, payee_bank_name = ?, payee_account_no = ? WHERE request_id = ?`
  ).run(payeeName || null, payeeBankName, payeeAccountNo, requestId);
  appendAuditLog(db, {
    actor,
    action: 'payout_account.add',
    entityKind: 'payment_request',
    entityId: requestId,
    note: `Payout account added on ${requestId}: ${payeeBankName} ${lastFour(payeeAccountNo)}`,
    details: {
      before: { payeeName: trim(row.payee_name), bankName: trim(row.payee_bank_name), account: lastFour(row.payee_account_no) },
      after: { payeeName, bankName: payeeBankName, account: lastFour(payeeAccountNo) },
    },
  });
  return { ok: true, target: 'payment_request', requestId, payeeName, payeeBankName, payeeAccountNo };
}

function addToTransportAgent(db, payload, actor) {
  const agentId = trim(payload.transportAgentId);
  const agent = db.prepare(`SELECT id, name, profile_json FROM transport_agents WHERE id = ?`).get(agentId);
  if (!agent) return refuse('Transport agent not found.', 'NOT_FOUND');
  const profile = parseJson(agent.profile_json, {});
  const current = transportAgentPayoutAccount(profile);
  if (!payoutAccountProblem({ bankName: current.payeeBankName, accountNo: current.payeeAccountNo })) {
    return refuse(ALREADY_SET, 'PAYOUT_ACCOUNT_ALREADY_SET');
  }
  const next = {
    ...(profile && typeof profile === 'object' ? profile : {}),
    payoutAccountName: trim(payload.accountName) || trim(agent.name),
    payoutBankName: trim(payload.bankName),
    payoutAccountNo: payoutAccountDigits(payload.accountNo),
  };
  db.prepare(`UPDATE transport_agents SET profile_json = ? WHERE id = ?`).run(JSON.stringify(next), agentId);
  appendAuditLog(db, {
    actor,
    action: 'payout_account.add',
    entityKind: 'transport_agent',
    entityId: agentId,
    note: `Payout account added for haulier ${agent.name}: ${next.payoutBankName} ${lastFour(next.payoutAccountNo)}`,
    details: {
      before: { bankName: current.payeeBankName, account: lastFour(current.payeeAccountNo) },
      after: { bankName: next.payoutBankName, account: lastFour(next.payoutAccountNo) },
      poId: trim(payload.poId) || null,
    },
  });
  return {
    ok: true,
    target: 'transport_agent',
    transportAgentId: agentId,
    payeeName: next.payoutAccountName,
    payeeBankName: next.payoutBankName,
    payeeAccountNo: next.payoutAccountNo,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ target: 'refund' | 'payment_request' | 'transport_agent', bankName: string, accountNo: string, accountName?: string,
 *   refundId?: string, partyKind?: string, partyId?: string, requestId?: string, transportAgentId?: string, poId?: string }} payload
 */
export function addMissingPayoutAccount(db, payload = {}, actor = null) {
  const problem = payoutAccountProblem({ bankName: payload.bankName, accountNo: payload.accountNo });
  if (problem) return refuse(problem);
  const target = trim(payload.target);
  let result;
  db.transaction(() => {
    if (target === 'refund') result = addToRefund(db, payload, actor);
    else if (target === 'payment_request') result = addToPaymentRequest(db, payload, actor);
    else if (target === 'transport_agent') result = addToTransportAgent(db, payload, actor);
    else result = refuse('target must be refund, payment_request or transport_agent.');
    if (!result.ok) throw Object.assign(new Error(result.error), { result });
  })();
  return result;
}

/** Same as {@link addMissingPayoutAccount} but returns the refusal instead of throwing. */
export function addMissingPayoutAccountSafe(db, payload = {}, actor = null) {
  try {
    return addMissingPayoutAccount(db, payload, actor);
  } catch (e) {
    if (e?.result) return e.result;
    throw e;
  }
}
