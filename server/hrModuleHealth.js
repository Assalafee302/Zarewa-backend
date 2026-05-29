/**
 * HR submodule readiness for production health checks.
 */

import { hrEngagementTablesReady } from './hrEngagement.js';
import { hrLearningTablesReady } from './hrLearning.js';
import { hrNotificationsTableReady } from './hrNotifications.js';
import { hrRecruitingTablesReady } from './hrRecruiting.js';
import { hrTablesReady } from './hrOps.js';

export function getHrModuleHealth(db) {
  return {
    core: hrTablesReady(db),
    notifications: hrNotificationsTableReady(db),
    recruiting: hrRecruitingTablesReady(db),
    learning: hrLearningTablesReady(db),
    engagement: hrEngagementTablesReady(db),
    allReady:
      hrTablesReady(db) &&
      hrNotificationsTableReady(db) &&
      hrRecruitingTablesReady(db) &&
      hrLearningTablesReady(db) &&
      hrEngagementTablesReady(db),
  };
}
