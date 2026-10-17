/**
 * Finance Phase A (A1): the pay routes refuse a payout when the payee has no usable
 * bank + 10-digit account. Rules live in shared/lib/payoutAccountGuard.js.
 */
import {
  payoutAccountBlock,
  payoutRouteBlock,
  refundPayeesStillOwed,
  transportAgentPayoutAccount,
  treasuryAccountIsCashOffice,
} from '../../shared/lib/payoutAccountGuard.js';
import { resolveCreditTargets } from './partnerWalletCredit.js';
import { buildRefundSettlementSummary } from '../sales/refundPayoutStatus.js';

function roundMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseJson(text) {
  try {
    const v = JSON.parse(String(text || '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export { transportAgentPayoutAccount };

/** D2: treasury account type (Cash / Bank / POS) for each payout line. */
export function payoutLineAccountTypes(db, lines = []) {
  const ids = [...new Set((lines || []).map((l) => Number(l?.treasuryAccountId)).filter(Boolean))];
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, type FROM treasury_accounts WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const typeById = new Map(rows.map((r) => [Number(r.id), String(r.type || '')]));
  return (lines || []).map((l) => typeById.get(Number(l?.treasuryAccountId)) || 'Bank');
}

/**
 * D2: Cash Office lines carry the voucher as their reference and name the recipient in the note,
 * so the cash book shows who took the cash. Lines are changed in place.
 */
export function stampCashOfficeLines(db, lines = [], cash = {}) {
  const types = payoutLineAccountTypes(db, lines);
  const name = String(cash?.recipientName || '').trim();
  const voucher = String(cash?.voucherReference || '').trim();
  (lines || []).forEach((line, i) => {
    if (!treasuryAccountIsCashOffice(types[i])) return;
    if (!String(line.reference || '').trim()) line.reference = voucher;
    const tag = `Cash Office — paid to ${name}, voucher ${voucher}`;
    line.note = line.note ? `${tag} · ${line.note}` : tag;
  });
  return lines;
}

/**
 * Payees on a refund that still have cash to receive, with the account each would be paid to.
 * @param {(target: object) => boolean} [skip] payees paid another way (A7 weekly staff batch)
 */
export function refundPayeesAwaitingCash(db, refundRow, { skip } = {}) {
  const approved = roundMoney(refundRow?.approved_amount_ngn || refundRow?.amount_ngn);
  if (approved <= 0) return [];
  const targets = resolveCreditTargets(db, refundRow, approved, { skipUnclearedFloat: true });
  const netDue = targets.reduce((s, t) => s + Math.max(0, roundMoney(t.amountNgn)), 0);
  const summary = buildRefundSettlementSummary(db, refundRow, { targets });
  const settled = Math.max(0, netDue - roundMoney(summary.cashOutstandingNgn));
  return refundPayeesStillOwed(targets, settled).filter((t) => !(typeof skip === 'function' && skip(t)));
}

/** @returns {null | { ok: false, code: 'PAYOUT_ACCOUNT_MISSING', error: string, payees: object[] }} */
/** @param {{ skip?: Function, lines?: object[], cash?: { recipientName?: string, voucherReference?: string } }} [opts] */
export function refundPayoutAccountBlock(db, refundId, opts = {}) {
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(String(refundId || '').trim());
  if (!row) return null;
  const owed = refundPayeesAwaitingCash(db, row, opts);
  return payoutRouteBlock({
    accountTypes: payoutLineAccountTypes(db, opts.lines),
    cash: opts.cash,
    payees: owed.map((t) => ({
      label: `${t.partyName || t.partyId || 'Payee'} (${t.partyKind === 'customer' ? 'customer' : 'staff'})`,
      bankName: t.payeeBankName,
      accountNo: t.payeeAccountNo,
    })),
  });
}

/** @param {{ lines?: object[], cash?: { recipientName?: string, voucherReference?: string } }} [opts] */
export function paymentRequestPayoutAccountBlock(db, requestId, opts = {}) {
  const row = db
    .prepare(`SELECT request_id, payee_name, payee_bank_name, payee_account_no FROM payment_requests WHERE request_id = ?`)
    .get(String(requestId || '').trim());
  if (!row) return null;
  return payoutRouteBlock({
    accountTypes: payoutLineAccountTypes(db, opts.lines),
    cash: opts.cash,
    payees: [
      {
        label: String(row.payee_name || '').trim() || `Payee on ${row.request_id}`,
        bankName: row.payee_bank_name,
        accountNo: row.payee_account_no,
      },
    ],
  });
}

/** D2: Cash Office name + voucher from a pay request body. */
export function cashOfficeFromBody(body = {}) {
  return {
    recipientName: String(body?.cashRecipientName ?? body?.recipientName ?? '').trim(),
    voucherReference: String(body?.voucherReference ?? body?.cashVoucherReference ?? '').trim(),
  };
}

/** Haulage is paid to the PO's transport agent; the account lives on the agent profile. */
export function poTransportPayoutAccountBlock(db, poId, transportAgentId) {
  let agentId = String(transportAgentId || '').trim();
  if (!agentId) {
    const po = db.prepare(`SELECT transport_agent_id FROM purchase_orders WHERE po_id = ?`).get(String(poId || '').trim());
    agentId = String(po?.transport_agent_id || '').trim();
  }
  if (!agentId) return null;
  const agent = db.prepare(`SELECT id, name, profile_json FROM transport_agents WHERE id = ?`).get(agentId);
  const acct = transportAgentPayoutAccount(parseJson(agent?.profile_json));
  return payoutAccountBlock([
    {
      label: String(agent?.name || agentId).trim(),
      bankName: acct.payeeBankName,
      accountNo: acct.payeeAccountNo,
    },
  ]);
}
