/**
 * Auto-prune superseded apps (SQLite mode only).
 * Deletes an old Intune app object once auto-update has superseded it AND
 * devices have finished migrating off it - see
 * docs/superpowers/specs/2026-09-29-auto-prune-superseded-apps-design.md
 * for the full design and the "why not delete immediately" reasoning.
 *
 * No Supabase equivalent: pending_app_prune is a SQLite-only table and this
 * is only called from instrumentation.ts's SQLite-mode scheduler branch.
 * Porting to Supabase mode would need an equivalent table/RPC there.
 */
import { getDatabase } from '@/lib/db';
import { sqlitePendingAppPrune, type PendingAppPrune } from '@/lib/db/sqlite';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import { getAppInstallSummary, clearAppRelationships, deleteApp, type AppInstallSummary } from '@/lib/intune-api';

const DEFAULT_GRACE_DAYS = 14;

/** Pure: has the grace period elapsed for this row? Exported for the self-check. */
export function isPastGrace(supersededAtIso: string, graceDays: number, now: Date = new Date()): boolean {
  const cutoff = new Date(supersededAtIso).getTime() + graceDays * 24 * 60 * 60 * 1000;
  return now.getTime() >= cutoff;
}

/** Pure: is it safe to delete - zero devices still installed or pending. Exported for the self-check. */
export function isSafeToDelete(summary: AppInstallSummary): boolean {
  return summary.installedDeviceCount === 0 && summary.pendingInstallDeviceCount === 0;
}

export interface RunAppPruneResult {
  checked: number;
  deleted: number;
  skipped: number;
  errors: number;
}

export async function runAppPrune(): Promise<RunAppPruneResult> {
  const result: RunAppPruneResult = { checked: 0, deleted: 0, skipped: 0, errors: 0 };

  if (process.env.AUTO_PRUNE_OLD_APPS !== 'true') {
    return result; // opt-in only - this permanently deletes real tenant objects
  }

  const graceDays = Number(process.env.AUTO_PRUNE_GRACE_DAYS) || DEFAULT_GRACE_DAYS;
  const now = new Date();
  // listDue filters on superseded_at <= cutoff in SQL for the common case;
  // isPastGrace is re-checked per-row below in case graceDays changed
  // between rows read and now (cheap, avoids a subtle off-by-a-row bug).
  const cutoffIso = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000).toISOString();
  const dueRows = await sqlitePendingAppPrune.listDue(cutoffIso);

  for (const row of dueRows) {
    result.checked++;
    if (!isPastGrace(row.superseded_at, graceDays, now)) {
      continue; // shouldn't happen given the SQL filter, but keep the pure check authoritative
    }

    await processRow(row, result);
  }

  return result;
}

async function processRow(row: PendingAppPrune, result: RunAppPruneResult): Promise<void> {
  const db = getDatabase();

  let newAppId = row.new_app_id;
  if (!newAppId) {
    const job = await db.jobs.getById(row.job_id);
    if (!job || job.status !== 'deployed' || !job.intune_app_id) {
      result.skipped++;
      await sqlitePendingAppPrune.logAttempt(row.id, 'skipped', 'new app not deployed yet');
      await sqlitePendingAppPrune.touchChecked(row.id);
      return;
    }
    newAppId = job.intune_app_id;
    await sqlitePendingAppPrune.setNewAppId(row.id, newAppId);
  }

  const token = await getServicePrincipalToken(row.tenant_id);
  if (!token) {
    result.errors++;
    await sqlitePendingAppPrune.logAttempt(row.id, 'error', 'Tenant consent is no longer active');
    await sqlitePendingAppPrune.touchChecked(row.id, 'Tenant consent is no longer active');
    return;
  }

  try {
    const summary = await getAppInstallSummary(token, row.old_app_id);
    if (!isSafeToDelete(summary)) {
      result.skipped++;
      const detail = `installed=${summary.installedDeviceCount} pending=${summary.pendingInstallDeviceCount}`;
      await sqlitePendingAppPrune.logAttempt(row.id, 'skipped', detail);
      await sqlitePendingAppPrune.touchChecked(row.id);
      return;
    }

    const relWarning = await clearAppRelationships(token, newAppId);
    if (relWarning) throw new Error(relWarning);

    await deleteApp(token, row.old_app_id);

    result.deleted++;
    await sqlitePendingAppPrune.logAttempt(row.id, 'deleted');
    await sqlitePendingAppPrune.markDeleted(row.id);
  } catch (error) {
    result.errors++;
    const message = error instanceof Error ? error.message : 'Unknown error';
    // ponytail: no backoff/retry cap - row stays 'pending' and retries every
    // cycle. Add a cap if a persistent failure (e.g. revoked consent) causes
    // a hot retry loop in the logs.
    await sqlitePendingAppPrune.logAttempt(row.id, 'error', message);
    await sqlitePendingAppPrune.touchChecked(row.id, message);
  }
}
