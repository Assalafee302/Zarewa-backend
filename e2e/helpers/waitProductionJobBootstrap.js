/** Poll until GET /api/bootstrap lists the production job (handles branch roll-up / snapshot lag). */
export async function waitForProductionJobInBootstrap(page, jobID, { timeoutMs = 45_000 } = {}) {
  const id = String(jobID ?? '').trim();
  if (!id) throw new Error('waitForProductionJobInBootstrap: jobID required');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await page.request.get('/api/bootstrap');
    if (r.ok()) {
      const j = await r.json();
      if ((j.productionJobs || []).some((x) => String(x.jobID) === id)) return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Production job ${id} did not appear in bootstrap within ${timeoutMs}ms`);
}
