/**
 * When signed in as HQ (admin/md/ceo), ensure "All branches" is checked so bootstrap includes
 * production jobs and refunds created on any branch during the same E2E run.
 */
export async function ensureAllBranchesRollup(page) {
  const cb = page.getByRole('checkbox', { name: /all branches/i });
  try {
    await cb.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return;
  }
  if (!(await cb.isChecked())) {
    try {
      await cb.check({ timeout: 5000 });
    } catch {
      /* Already rolled up or HQ control not applicable */
    }
  }
}
