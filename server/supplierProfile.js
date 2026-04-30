/** @typedef {{ id: string; fileName: string; mimeType: string; uploadedAtIso: string; dataBase64?: string }} SupplierAgreement */
/** @typedef {{ bankName?: string; accountName?: string; accountNumber?: string; sortCode?: string; currency?: string }} SupplierBankAccount */
/** @typedef {{ name?: string; role?: string; email?: string; phone?: string }} SupplierContact */

const MAX_PROFILE_BYTES = 2_600_000;
const MAX_ATTACHMENT_BYTES = 750_000;
const MAX_ATTACHMENTS = 6;

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function parseSupplierProfileJson(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw !== 'string') return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Remove base64 payloads from agreements for list/bootstrap payloads.
 * @param {Record<string, unknown>} profile
 */
export function stripAgreementBodiesForList(profile) {
  const p = { ...profile };
  const agreements = Array.isArray(p.agreements) ? p.agreements : [];
  p.agreements = agreements.map((a) => {
    if (!a || typeof a !== 'object') return a;
    const { dataBase64, ...rest } = a;
    return {
      ...rest,
      hasFile: Boolean(dataBase64 && String(dataBase64).length > 0),
    };
  });
  return p;
}

/**
 * @param {Record<string, unknown>} profile
 * @returns {{ ok: true; profile: Record<string, unknown> } | { ok: false; error: string }}
 */
export function validateAndNormalizeSupplierProfile(profile) {
  if (!profile || typeof profile !== 'object') return { ok: true, profile: {} };

  const out = { ...profile };

  const str = (k, max = 2000) => {
    const v = out[k];
    if (v == null) return '';
    const s = String(v).trim();
    return s.length > max ? s.slice(0, max) : s;
  };

  out.companyEmail = str('companyEmail', 320);
  out.website = str('website', 500);
  out.vatTin = str('vatTin', 80);
  out.rcNumber = str('rcNumber', 80);
  out.registeredAddress = str('registeredAddress', 2000);
  out.billingAddress = str('billingAddress', 2000);
  out.phoneMain = str('phoneMain', 80);
  out.whatsapp = str('whatsapp', 80);
  out.notesCommercial = str('notesCommercial', 4000);

  const banks = Array.isArray(out.bankAccounts) ? out.bankAccounts : [];
  out.bankAccounts = banks
    .slice(0, 6)
    .map((b) =>
      b && typeof b === 'object'
        ? {
            bankName: String(b.bankName || '').trim().slice(0, 200),
            accountName: String(b.accountName || '').trim().slice(0, 200),
            accountNumber: String(b.accountNumber || '').trim().slice(0, 40),
            sortCode: String(b.sortCode || '').trim().slice(0, 40),
            currency: String(b.currency || 'NGN').trim().slice(0, 12),
          }
        : {}
    )
    .filter((b) => b.bankName || b.accountNumber || b.accountName);

  const contacts = Array.isArray(out.contacts) ? out.contacts : [];
  out.contacts = contacts
    .slice(0, 8)
    .map((c) =>
      c && typeof c === 'object'
        ? {
            name: String(c.name || '').trim().slice(0, 200),
            role: String(c.role || '').trim().slice(0, 120),
            email: String(c.email || '').trim().slice(0, 320),
            phone: String(c.phone || '').trim().slice(0, 80),
          }
        : {}
    )
    .filter((c) => c.name || c.email || c.phone);

  const agreements = Array.isArray(out.agreements) ? out.agreements : [];
  const normAgreements = [];
  for (const a of agreements.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id || '').trim().slice(0, 120);
    const fileName = String(a.fileName || 'document').trim().slice(0, 240);
    const mimeType = String(a.mimeType || 'application/octet-stream').trim().slice(0, 120);
    const uploadedAtIso = String(a.uploadedAtIso || new Date().toISOString()).trim().slice(0, 40);
    const dataBase64 = a.dataBase64 != null ? String(a.dataBase64).trim() : '';
    if (!id) continue;
    const row = { id, fileName, mimeType, uploadedAtIso };
    if (dataBase64) {
      const approxBytes = Math.floor((dataBase64.length * 3) / 4);
      if (approxBytes > MAX_ATTACHMENT_BYTES) {
        return {
          ok: false,
          error: `Attachment "${fileName}" is too large (max ~${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB per file).`,
        };
      }
      row.dataBase64 = dataBase64;
    }
    normAgreements.push(row);
  }
  out.agreements = normAgreements;

  let json;
  try {
    json = JSON.stringify(out);
  } catch {
    return { ok: false, error: 'Supplier profile could not be serialized.' };
  }
  if (json.length > MAX_PROFILE_BYTES) {
    return {
      ok: false,
      error: `Supplier profile JSON exceeds ${Math.round(MAX_PROFILE_BYTES / 1024 / 1024)} MB. Remove or shrink attachments.`,
    };
  }

  return { ok: true, profile: out };
}

/**
 * Merge PATCH `supplierProfile` onto existing JSON. Keeps prior agreement `dataBase64` when the client resends metadata only.
 * @param {string | null | undefined} prevJson
 * @param {Record<string, unknown>} patch
 */
export function mergeSupplierProfilePatch(prevJson, patch) {
  const prev = parseSupplierProfileJson(prevJson);
  if (!patch || typeof patch !== 'object') return prev;
  const merged = { ...prev, ...patch };
  if (!Object.prototype.hasOwnProperty.call(patch, 'agreements')) {
    merged.agreements = Array.isArray(prev.agreements) ? prev.agreements : [];
  } else {
    const prevById = new Map(
      (Array.isArray(prev.agreements) ? prev.agreements : [])
        .filter((a) => a && typeof a === 'object' && a.id)
        .map((a) => [String(a.id), a])
    );
    const mergedAgreements = [];
    for (const a of Array.isArray(patch.agreements) ? patch.agreements : []) {
      if (!a || typeof a !== 'object' || !a.id) continue;
      const id = String(a.id);
      const prevRow = prevById.get(id);
      const row = { ...a };
      if (!row.dataBase64 && prevRow?.dataBase64) {
        row.dataBase64 = prevRow.dataBase64;
      }
      mergedAgreements.push(row);
    }
    merged.agreements = mergedAgreements;
  }
  return merged;
}
