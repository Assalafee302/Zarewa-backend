import { createDatabase } from '../server/db.js';
import { registerBankDeposit, allocateBankDepositTx, listBankDeposits } from '../server/bankDepositOps.js';
import { BANK_DEPOSIT_ALLOC_KIND_RECEIPT } from '../shared/lib/bankDeposits.js';

const db = createDatabase(':memory:', { seed: true });
const admin = db.prepare('SELECT id, display_name FROM app_users LIMIT 1').get();
const tid = db.prepare('SELECT id FROM treasury_accounts LIMIT 1').get()?.id;
const actor = { id: admin.id, displayName: admin.display_name || 'Admin' };

const reg = registerBankDeposit(
  db,
  {
    bankDateISO: '2026-06-19',
    description: 'UBA TEST',
    bankReference: 'TX-SMOKE-001',
    amountNgn: 500_000,
    treasuryAccountId: tid,
  },
  'BR-KD',
  actor
);
console.log('register', reg.ok, reg.id, reg.error || '');

const alloc = allocateBankDepositTx(db, {
  depositId: reg.id,
  ledgerEntryId: 'LE-TEST-001',
  kind: BANK_DEPOSIT_ALLOC_KIND_RECEIPT,
  amountNgn: 500_000,
  actor,
  branchId: 'BR-KD',
});
console.log('allocate', alloc.ok, alloc.error || '');

const dep = listBankDeposits(db, 'BR-KD')[0];
console.log('status', dep?.status, 'remaining', dep?.remainingNgn);
db.close();
