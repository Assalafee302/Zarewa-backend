export const OPS_METRIC_CATALOG = {
  ot_hours: {
    key: 'ot_hours',
    label: 'Overtime hours',
    unit: 'hours',
    description: 'Worked minutes above scheduled minutes from daily roll calls.',
  },
  csat_avg: {
    key: 'csat_avg',
    label: 'Average delivery CSAT',
    unit: 'score / 5',
    description: 'Average satisfaction score recorded on delivered orders.',
  },
  floor_giveaway_ngn: {
    key: 'floor_giveaway_ngn',
    label: 'Floor giveaway',
    unit: 'NGN',
    description: 'Approved below-floor price delta from pricing exceptions.',
  },
  cost_variance_flags: {
    key: 'cost_variance_flags',
    label: 'Cost variance flags',
    unit: 'count',
    description: 'Workbook cost rows diverging materially from GRN weighted-average cost.',
  },
  vendor_avg_job: {
    key: 'vendor_avg_job',
    label: 'Average vendor cost per job',
    unit: 'NGN / job',
    description: 'Attributed maintenance spend divided by distinct vendor work orders.',
  },
};

export function listOpsMetricDefinitions() {
  return Object.values(OPS_METRIC_CATALOG);
}
