export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { isSqliteMode } = await import('@/lib/db');
  if (!isSqliteMode()) return; // Supabase mode keeps using Vercel Cron externally

  const { runUpdateCheck } = await import('@/lib/auto-update/check-updates');
  const intervalMs = 24 * 60 * 60 * 1000;

  console.log('[Scheduler] Starting update-check interval (every 24h)');
  setInterval(() => {
    runUpdateCheck()
      .then((result) => {
        console.log(`[Scheduler] Update check complete: ${result.updatesFound} updates found, ${result.errors.length} errors`);
        if (result.errors.length > 0) console.error('[Scheduler] Errors:', result.errors);
      })
      .catch((err) => console.error('[Scheduler] Update check failed:', err));
  }, intervalMs);
}
