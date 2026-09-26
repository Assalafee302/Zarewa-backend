/**
 * Classify quoted service names for refund preview and payout splits.
 * Roofing “labour” on a quotation is installation labour, not a miscellaneous extra.
 */

function normServiceName(nameLower) {
  return String(nameLower || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function hasServiceToken(hay, token) {
  const n = String(hay || '');
  const t = String(token || '');
  if (!n || !t) return false;
  return new RegExp(`(?:^|[^a-z])${t}(?:$|[^a-z])`, 'i').test(n);
}

export function matchesTransportService(nameLower) {
  const n = normServiceName(nameLower);
  if (!n) return false;
  return (
    n.includes('transport') ||
    n.includes('haulage') ||
    n.includes('hauling') ||
    n.includes('delivery') ||
    n.includes('logistic') ||
    n.includes('dispatch') ||
    n.includes('freight') ||
    n.includes('waybill')
  );
}

export function matchesInstallationService(nameLower) {
  const n = normServiceName(nameLower);
  if (!n) return false;
  if (n.includes('laboratory')) return false;
  return (
    n.includes('install') ||
    n.includes('fitting') ||
    n.includes('erection') ||
    n.includes('mounting') ||
    n.includes('workmanship') ||
    hasServiceToken(n, 'labour') ||
    hasServiceToken(n, 'labor') ||
    hasServiceToken(n, 'labourer') ||
    hasServiceToken(n, 'laborer')
  );
}

/** Corrugation is never suggested or counted as a refundable service line. */
export function matchesCorrugationService(nameLower) {
  const n = normServiceName(nameLower);
  if (!n) return false;
  return n.includes('corrugation') || n.includes('currugation');
}

/** @returns {'driver'|'installer'|''} */
export function quotedServiceAssigneeRole(name) {
  const n = normServiceName(name);
  if (matchesTransportService(n) && !matchesInstallationService(n)) return 'driver';
  if (matchesInstallationService(n) && !matchesTransportService(n)) return 'installer';
  if (matchesTransportService(n)) return 'driver';
  if (matchesInstallationService(n)) return 'installer';
  return '';
}
