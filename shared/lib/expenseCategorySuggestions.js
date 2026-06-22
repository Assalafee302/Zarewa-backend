/**
 * Heuristic expense category hints from memo / payment-request text.
 * Shared by Office Desk conversion, expense forms, and API suggest endpoint.
 */
import { actorMaySelectExpenseCategory } from '../expenseCategoryPolicy.js';

/**
 * @param {{ subject?: string; body?: string; description?: string; reference?: string }} input
 * @returns {{ category: string | null; reasons: string[]; confidence: 'high' | 'medium' | 'low' }}
 */
export function suggestExpenseCategoryFromMemoText(input) {
  const raw = [input?.subject, input?.body, input?.description, input?.reference]
    .filter(Boolean)
    .join('\n');
  const text = String(raw || '').toLowerCase();
  const reasons = [];

  const pick = (category, code, confidence = 'medium') => {
    reasons.push(code);
    return { category, reasons, confidence };
  };

  if (/\bgenerator\b/i.test(text)) {
    return pick('Generator', 'generator_keywords', 'high');
  }
  if (/(land\s*and\s*building|building\s*purchase|property\s*purchase)/i.test(text)) {
    return pick('Land and buildings', 'capex_building', 'high');
  }
  if (/(plant\s*and\s*machinery|new\s*machine|production\s*line)/i.test(text)) {
    return pick('Plant and machinery', 'capex_plant', 'high');
  }
  if (/(furniture|fittings|office\s*fit\s*out)/i.test(text)) {
    return pick('Furniture & fittings', 'capex_furniture', 'medium');
  }
  if (/(diesel|fuel|lubricant|petrol|avgas)/i.test(text) && !/(haulage|logistics|transporter)/i.test(text)) {
    return pick('Fuel & lubricant', 'fuel_keywords', 'high');
  }
  if (/(haulage|logistics|transport|delivery\s*truck|transporter|truck\s*hire)/i.test(text)) {
    return pick('Truck & mining', 'logistics_keywords', 'medium');
  }
  if (/(carriage\s*inward|landing\s*cost|inbound\s*freight)/i.test(text)) {
    return pick('Carriage inward', 'carriage_inward', 'high');
  }
  if (/(phcn|utility|repair|maintenance|plant|machine|equipment|service\s*contract)/i.test(text)) {
    return pick('Maintenance', 'maintenance_keywords', 'medium');
  }
  if (/(rent|utilities|electric|water\s*bill|office\s*rent|tenancy)/i.test(text)) {
    return pick('Rent & utilities', 'operational_rent', 'medium');
  }
  if (/(raw\s*material|coil|sheet|consumable|supply|stock|accessories)/i.test(text)) {
    return pick('Purchases', 'cogs_materials', 'medium');
  }
  if (/(payroll|salary|pension|statutory|nhis|paye)/i.test(text)) {
    return pick('Admin salary', 'payroll_keywords', 'high');
  }
  if (/(welfare|training|staff\s*meal)/i.test(text)) {
    return pick('Welfare', 'welfare_keywords', 'medium');
  }
  if (/(legal|lawyer|audit\s*fee|professional|consultant)/i.test(text)) {
    return pick('Professional fees', 'professional_keywords', 'medium');
  }
  if (/(marketing|advert|branding|event|promotion)/i.test(text)) {
    return pick('Marketing & advertising', 'marketing_keywords', 'medium');
  }
  if (/(bank\s*charge|transfer\s*fee|swift|domiciliary)/i.test(text)) {
    return pick('Bank charges', 'bank_keywords', 'high');
  }
  if (/(licen[cs]e|tax\s*bill|permit|firs|lga)/i.test(text)) {
    return pick('Tax', 'tax_licence_keywords', 'medium');
  }
  if (/(staff\s*loan|loan\s*disburse)/i.test(text)) {
    return pick('Staff loan', 'staff_loan_keywords', 'high');
  }
  if (/(zakat|sallah|ramadan)/i.test(text)) {
    return pick('Zakat & Sallah', 'zakat_keywords', 'high');
  }
  if (/(office\s*supplies|stationery|printing|postage)/i.test(text)) {
    return pick('Office expenses', 'office_supplies', 'medium');
  }
  if (/(software|it\s*subscription|microsoft|license\s*renewal)/i.test(text)) {
    return pick('IT & software', 'it_keywords', 'medium');
  }

  return { category: null, reasons: [], confidence: 'low' };
}

/**
 * Suggest category filtered for actor permissions.
 * @param {object} input
 * @param {{ roleKey?: string; permissions?: string[] } | null | undefined} actor
 * @param {(perm: string) => boolean} [hasPermission]
 */
export function suggestExpenseCategoryForActor(input, actor, hasPermission = () => false) {
  const base = suggestExpenseCategoryFromMemoText(input);
  if (!base.category) {
    return { ok: true, category: null, reasons: [], confidence: 'low', actorMaySelect: false };
  }
  const actorMaySelect = actorMaySelectExpenseCategory(actor, base.category, hasPermission);
  return {
    ok: true,
    category: actorMaySelect ? base.category : null,
    suggestedCategory: base.category,
    actorMaySelect,
    reasons: base.reasons,
    confidence: base.confidence,
    blockedReason: actorMaySelect
      ? null
      : `"${base.category}" requires Finance or manager approval to select.`,
  };
}
