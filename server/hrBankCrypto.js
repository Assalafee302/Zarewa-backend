/**
 * Field-level encryption for bank account numbers at rest.
 * @module server/hrBankCrypto
 */

import crypto from 'node:crypto';

const PREFIX = 'v1:';
const ALGO = 'aes-256-gcm';

function encryptionKey() {
  const raw =
    process.env.HR_BANK_ENCRYPTION_KEY ||
    process.env.ZAREWA_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    'zarewa-hr-bank-dev-key';
  return crypto.createHash('sha256').update(String(raw)).digest();
}

export function encryptBankAccount(plain) {
  const text = String(plain || '').replace(/\s/g, '');
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

export function decryptBankAccount(stored) {
  const s = String(stored || '');
  if (!s) return null;
  if (!s.startsWith(PREFIX)) return s.replace(/\s/g, '');
  try {
    const body = s.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split(':');
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const data = Buffer.from(dataB64, 'base64url');
    const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function maskBankAccount(plain) {
  const s = String(plain || '').replace(/\s/g, '');
  if (!s) return null;
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

export function storedBankToMasked(stored) {
  if (!stored) return null;
  const plain = decryptBankAccount(stored);
  return maskBankAccount(plain);
}

export function isEncryptedBankValue(stored) {
  return String(stored || '').startsWith(PREFIX);
}
