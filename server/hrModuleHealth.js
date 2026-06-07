/**
 * HR submodule readiness for production health checks.
 */

import { hrEngagementTablesReady } from './hrEngagement.js';
import { hrLearningTablesReady } from './hrLearning.js';
import { hrNotificationsTableReady } from './hrNotifications.js';
import { hrRecruitingTablesReady } from './hrRecruiting.js';
import { hrNextUatReadiness, hrTablesReady } from './hrOps.js';
import { hrPhase6BenefitsTablesReady, hrPhase8OperationalTablesReady, hrPhase9ExecutiveBenefitsTablesReady } from './hrTableChecks.js';
import { hrGovernanceTablesReady } from './hrGovernanceOps.js';
import { hrPayrollControlTablesReady } from './hrPayrollControl.js';

const MODULE_LABELS = {
  core: 'Core HR',
  notifications: 'Notifications',
  recruiting: 'Recruiting',
  learning: 'Learning & development',
  engagement: 'Engagement surveys',
  phase6Benefits: 'Benefits & incidents',
  phase8Operational: 'Letter workflow & bulk import',
  phase9ExecutiveBenefits: 'Executive benefits & domestic staff',
  payrollControl: 'Payroll control',
  governance: 'Skills & grievances',
};

export function getHrModuleHealth(db) {
  return {
    core: hrTablesReady(db),
    notifications: hrNotificationsTableReady(db),
    recruiting: hrRecruitingTablesReady(db),
    learning: hrLearningTablesReady(db),
    engagement: hrEngagementTablesReady(db),
    phase6Benefits: hrPhase6BenefitsTablesReady(db),
    phase8Operational: hrPhase8OperationalTablesReady(db),
    phase9ExecutiveBenefits: hrPhase9ExecutiveBenefitsTablesReady(db),
    payrollControl: hrPayrollControlTablesReady(db),
    governance: hrGovernanceTablesReady(db),
    allReady:
      hrTablesReady(db) &&
      hrNotificationsTableReady(db) &&
      hrRecruitingTablesReady(db) &&
      hrLearningTablesReady(db) &&
      hrEngagementTablesReady(db) &&
      hrPhase6BenefitsTablesReady(db) &&
      hrPhase8OperationalTablesReady(db) &&
      hrPayrollControlTablesReady(db) &&
      hrGovernanceTablesReady(db),
  };
}

/** @param {ReturnType<typeof getHrModuleHealth>} modules */
export function buildHrModuleBlockers(modules) {
  return Object.entries(MODULE_LABELS)
    .filter(([key]) => !modules[key])
    .map(([, label]) => `Run \`npm run db:migrate\` — ${label} tables missing.`);
}

/**
 * Merge schema readiness with optional scoped UAT data gates.
 * @param {import('better-sqlite3').Database} db
 * @param {object | null | undefined} scope
 */
export function buildHrReadiness(db, scope) {
  const modules = getHrModuleHealth(db);
  const uat = scope ? hrNextUatReadiness(db, scope) : null;
  const moduleBlockers = buildHrModuleBlockers(modules);
  const productionReady = modules.allReady;
  const canCutover = productionReady && Boolean(uat?.canCutover);
  return {
    modules,
    productionReady,
    gates: uat?.gates ?? null,
    canCutover,
    blockers: [...moduleBlockers, ...(uat?.blockers || [])],
  };
}
