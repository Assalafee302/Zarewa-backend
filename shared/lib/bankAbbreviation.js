/**
 * Short display codes for Nigerian banks, used on printed reports so a reader
 * can match a payment line against a bank statement without wading through
 * full legal bank names or internal treasury account names.
 * Frontend copy via `npm run sync:shared` -> src/shared/lib/bankAbbreviation.js
 */

const BANK_ABBREVIATIONS = [
  ['guaranty trust', 'GTB'],
  ['gtbank', 'GTB'],
  ['gtco', 'GTB'],
  ['united bank for africa', 'UBA'],
  ['uba', 'UBA'],
  ['zenith', 'ZENITH'],
  ['access', 'ACCESS'],
  ['diamond', 'ACCESS'],
  ['first bank', 'FIRSTBANK'],
  ['firstbank', 'FIRSTBANK'],
  ['fbn', 'FIRSTBANK'],
  ['fidelity', 'FIDELITY'],
  ['stanbic', 'STANBIC'],
  ['ibtc', 'STANBIC'],
  ['union bank', 'UNION'],
  ['wema', 'WEMA'],
  ['alat', 'WEMA'],
  ['sterling', 'STERLING'],
  ['fcmb', 'FCMB'],
  ['first city monument', 'FCMB'],
  ['keystone', 'KEYSTONE'],
  ['polaris', 'POLARIS'],
  ['ecobank', 'ECOBANK'],
  ['heritage', 'HERITAGE'],
  ['unity bank', 'UNITY'],
  ['providus', 'PROVIDUS'],
  ['jaiz', 'JAIZ'],
  ['titan', 'TITAN'],
  ['suntrust', 'SUNTRUST'],
  ['globus', 'GLOBUS'],
  ['premium trust', 'PREMIUMTRUST'],
  ['parallex', 'PARALLEX'],
  ['standard chartered', 'STANCHART'],
  ['citibank', 'CITI'],
  ['moniepoint', 'MONIEPOINT'],
  ['opay', 'OPAY'],
  ['palmpay', 'PALMPAY'],
  ['kuda', 'KUDA'],
];

/**
 * Reduces a full bank name (e.g. "Guaranty Trust Bank Plc") to a short,
 * recognizable code (e.g. "GTB") for use on printed/exported reports.
 * Falls back to an initials-style short form for unrecognized banks so the
 * column never falls back to a blank or an internal account name.
 * @param {string} bankName
 * @returns {string}
 */
export function abbreviateBankName(bankName) {
  const raw = String(bankName || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase();
  for (const [needle, code] of BANK_ABBREVIATIONS) {
    if (key.includes(needle)) return code;
  }
  const words = raw
    .replace(/\b(plc|nigeria|limited|ltd|of|the)\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    return words
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 8);
  }
  return raw.slice(0, 8).toUpperCase();
}
