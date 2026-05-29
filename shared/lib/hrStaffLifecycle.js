/**
 * HR onboarding / offboarding operational checklists (beyond document uploads).
 */

export const HR_ONBOARDING_TASKS = [
  { key: 'welcome_briefing', label: 'Welcome briefing completed', ownerRole: 'hr' },
  { key: 'it_access', label: 'IT / system access provisioned', ownerRole: 'it' },
  { key: 'bank_details', label: 'Bank details confirmed for payroll', ownerRole: 'hr' },
  { key: 'uniform_ppe', label: 'Uniform / PPE issued', ownerRole: 'hr' },
  { key: 'policy_ack', label: 'HR policies acknowledged', ownerRole: 'employee' },
  { key: 'probation_scheduled', label: 'Probation review date scheduled', ownerRole: 'manager' },
];

export const HR_OFFBOARDING_TASKS = [
  { key: 'separation_recorded', label: 'Separation details recorded', ownerRole: 'hr' },
  { key: 'handover', label: 'Handover completed', ownerRole: 'manager' },
  { key: 'asset_return', label: 'Company assets returned', ownerRole: 'hr' },
  { key: 'access_revoked', label: 'System access revoked', ownerRole: 'it' },
  { key: 'exit_interview', label: 'Exit interview completed', ownerRole: 'hr' },
  { key: 'final_pay', label: 'Final pay note recorded', ownerRole: 'hr' },
];

export const HR_SEPARATION_STATUSES = ['active', 'separating', 'separated'];

const OWNER_LABEL = {
  hr: 'HR',
  it: 'IT',
  manager: 'Manager',
  employee: 'Employee',
};

/** @param {string} role */
export function hrLifecycleOwnerLabel(role) {
  return OWNER_LABEL[role] || role || '—';
}

/**
 * @param {'onboarding' | 'offboarding'} workflow
 * @param {Record<string, { done?: boolean; at?: string; by?: string }>} taskState
 */
export function buildHrLifecycleChecklist(workflow, taskState = {}) {
  const defs = workflow === 'offboarding' ? HR_OFFBOARDING_TASKS : HR_ONBOARDING_TASKS;
  const tasks = defs.map((def) => {
    const row = taskState[def.key] && typeof taskState[def.key] === 'object' ? taskState[def.key] : {};
    return {
      key: def.key,
      label: def.label,
      ownerRole: def.ownerRole,
      ownerLabel: hrLifecycleOwnerLabel(def.ownerRole),
      done: Boolean(row.done),
      completedAtIso: row.at || null,
      completedByUserId: row.by || null,
    };
  });
  const pending = tasks.filter((t) => !t.done);
  return {
    workflow,
    tasks,
    complete: pending.length === 0,
    pendingCount: pending.length,
    pendingLabels: pending.map((t) => t.label),
  };
}

/**
 * @param {Record<string, unknown>} lifecycleRaw
 */
export function normalizeHrLifecycleState(lifecycleRaw = {}) {
  const raw = lifecycleRaw && typeof lifecycleRaw === 'object' ? lifecycleRaw : {};
  const onboarding = raw.onboarding && typeof raw.onboarding === 'object' ? raw.onboarding : {};
  const offboarding = raw.offboarding && typeof raw.offboarding === 'object' ? raw.offboarding : {};
  const sep = raw.separation && typeof raw.separation === 'object' ? raw.separation : {};
  const status = HR_SEPARATION_STATUSES.includes(String(sep.status || '')) ? String(sep.status) : 'active';
  return {
    onboarding: buildHrLifecycleChecklist('onboarding', onboarding),
    offboarding: buildHrLifecycleChecklist('offboarding', offboarding),
    separation: {
      status,
      lastWorkingDayIso: String(sep.lastWorkingDayIso || '').slice(0, 10) || null,
      reason: String(sep.reason || '').trim() || null,
      notes: String(sep.notes || '').trim() || null,
      updatedAtIso: sep.updatedAtIso || null,
    },
  };
}
