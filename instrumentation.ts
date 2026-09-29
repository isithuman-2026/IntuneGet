export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { isSqliteMode } = await import('@/lib/db');
  if (!isSqliteMode()) return; // Supabase mode keeps using Vercel Cron externally

  const { runUpdateCheck } = await import('@/lib/auto-update/check-updates');
  const { runAppPrune } = await import('@/lib/auto-update/prune');
  const intervalMs = 24 * 60 * 60 * 1000;

  console.log('[Scheduler] Starting update-check interval (every 24h)');
  setInterval(() => {
    runUpdateCheck()
      .then((result) => {
        console.log(`[Scheduler] Update check complete: ${result.updatesFound} updates found, ${result.errors.length} errors`);
        if (result.errors.length > 0) console.error('[Scheduler] Errors:', result.errors);
      })
      .catch((err) => console.error('[Scheduler] Update check failed:', err));

    // Auto-prune old superseded apps (no-op unless AUTO_PRUNE_OLD_APPS=true).
    // Reuses this same interval rather than adding a second scheduler.
    runAppPrune()
      .then((result) => {
        if (result.checked > 0) {
          console.log(`[Scheduler] App prune complete: ${result.deleted} deleted, ${result.skipped} skipped, ${result.errors} errors`);
        }
      })
      .catch((err) => console.error('[Scheduler] App prune failed:', err));
  }, intervalMs);
}
