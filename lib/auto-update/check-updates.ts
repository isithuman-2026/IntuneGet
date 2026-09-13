/**
 * Update detection for SQLite (single-tenant) mode.
 * Compares deployed apps (upload_history) against catalog latest versions,
 * writes results to update_check_results, then triggers auto-updates for
 * newly-detected updates whose policy allows it (trigger-sqlite.ts).
 */
import {
  sqliteListAllUploadHistory,
  sqliteUpdateChecks,
  sqliteUpdatePolicies,
  type UpdateCheckInsert,
} from '@/lib/db/sqlite';
import { compareVersions, parseVersion } from '@/lib/version-compare';
import { getCatalogSource } from '@/lib/catalog';
import { shouldSkipUpdate } from '@/types/update-policies';

export interface RunUpdateCheckResult {
  usersChecked: number;
  updatesFound: number;
  autoUpdates: { triggered: number; skipped: number; failed: number };
  errors: string[];
}

export async function runUpdateCheck(): Promise<RunUpdateCheckResult> {
  const errors: string[] = [];
  const allUploads = sqliteListAllUploadHistory();

  if (allUploads.length === 0) {
    return { usersChecked: 0, updatesFound: 0, autoUpdates: { triggered: 0, skipped: 0, failed: 0 }, errors };
  }

  const curatedApps = await getCatalogSource().getAllLatestVersions();
  const latestVersions = new Map<string, string>();
  curatedApps?.forEach((app) => {
    if (app.latest_version) latestVersions.set(app.winget_id, app.latest_version);
  });

  // Group by user+tenant, keep the newest deployment per winget_id (an app can
  // be redeployed at a newer version, superseding an older upload_history row)
  const userTenantApps = new Map<string, typeof allUploads>();
  allUploads.forEach((app) => {
    const key = `${app.user_id}:${app.intune_tenant_id || 'default'}`;
    if (!userTenantApps.has(key)) userTenantApps.set(key, []);
    userTenantApps.get(key)!.push(app);
  });

  const activeKeysByUser = new Map<string, Set<string>>();
  const allUpdates: UpdateCheckInsert[] = [];
  let updatesFound = 0;

  for (const [key, apps] of userTenantApps) {
    const [userId, tenantId] = key.split(':');
    const uniqueApps = new Map<string, (typeof apps)[number]>();
    apps.forEach((app) => {
      const existing = uniqueApps.get(app.winget_id);
      if (!existing || compareVersions(app.version, existing.version) > 0) {
        uniqueApps.set(app.winget_id, app);
      }
    });

    const activeKeys = activeKeysByUser.get(userId) ?? new Set<string>();
    activeKeysByUser.set(userId, activeKeys);

    for (const app of uniqueApps.values()) {
      const latestVersion = latestVersions.get(app.winget_id);
      if (!latestVersion) continue;

      const policy = await sqliteUpdatePolicies.getByApp(userId, tenantId, app.winget_id);
      if (shouldSkipUpdate(policy, latestVersion)) continue;

      if (compareVersions(app.version, latestVersion) < 0) {
        const currentParsed = parseVersion(app.version);
        const latestParsed = parseVersion(latestVersion);
        const isCritical = latestParsed.major > currentParsed.major;

        const prior = await sqliteUpdateChecks.getOne(userId, tenantId, app.winget_id);
        const samePending = Boolean(prior && prior.latest_version === latestVersion);
        const notifiedAt = samePending ? prior!.notified_at : null;
        const now = new Date().toISOString();
        // Keep the ORIGINAL detection timestamp while the same update is still
        // pending. Re-stamping it every check makes delay_days never elapse
        // (runAutoUpdatesForNewDetections measures the deferral from here).
        const detectedAt = samePending ? prior!.detected_at : now;

        allUpdates.push({
          user_id: userId,
          tenant_id: tenantId,
          winget_id: app.winget_id,
          intune_app_id: app.intune_app_id,
          display_name: app.display_name,
          current_version: app.version,
          latest_version: latestVersion,
          is_critical: isCritical,
          is_managed: true,
          notified_at: notifiedAt,
          detected_at: detectedAt,
          updated_at: now,
        });
        activeKeys.add(`${app.winget_id}:${app.intune_app_id}`);
        updatesFound++;
      }
    }
  }

  await sqliteUpdateChecks.upsertMany(allUpdates);

  const newlyDetected = allUpdates.filter((u) => u.notified_at === null);
  if (newlyDetected.length > 0) {
    const { sqliteWebhooks, sqliteNotificationPreferences } = await import('@/lib/db/sqlite');
    const { deliverWebhook } = await import('@/lib/webhooks/service');
    const byUser = new Map<string, typeof newlyDetected>();
    newlyDetected.forEach((u) => {
      if (!byUser.has(u.user_id)) byUser.set(u.user_id, []);
      byUser.get(u.user_id)!.push(u);
    });
    for (const [userId, userUpdates] of byUser) {
      const prefs = await sqliteNotificationPreferences.get(userId);
      if (prefs && (!prefs.webhook_enabled || !prefs.notify_on_update_available)) continue;
      const webhooks = (await sqliteWebhooks.listByUser(userId)).filter((w) => w.is_enabled);
      if (webhooks.length === 0) continue;
      const payload = {
        event: 'app_updates_available' as const,
        timestamp: new Date().toISOString(),
        tenant_id: userUpdates[0].tenant_id,
        updates: userUpdates.map((u) => ({ app_name: u.display_name, winget_id: u.winget_id, intune_app_id: u.intune_app_id, current_version: u.current_version, latest_version: u.latest_version, is_critical: u.is_critical })),
        summary: { total: userUpdates.length, critical: userUpdates.filter((u) => u.is_critical).length },
      };
      let delivered = false;
      for (const webhook of webhooks) {
        const result = await deliverWebhook(webhook, payload).catch((err) => {
          errors.push(`Webhook to ${webhook.name} failed: ${err instanceof Error ? err.message : String(err)}`);
          return { success: false };
        });
        delivered = delivered || result.success;
      }
      if (delivered) {
        await sqliteUpdateChecks.markNotified(
          userId,
          userUpdates.map((u) => ({ winget_id: u.winget_id, intune_app_id: u.intune_app_id }))
        );
      }
    }
  }

  const { runAutoUpdatesForNewDetections } = await import('./trigger-sqlite');
  const autoUpdateResult = await runAutoUpdatesForNewDetections(allUpdates);
  errors.push(...autoUpdateResult.errors);

  for (const [userId, activeKeys] of activeKeysByUser) {
    try {
      await sqliteUpdateChecks.deleteStale(userId, activeKeys);
    } catch (err) {
      errors.push(`Error clearing stale updates for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await sqliteUpdateChecks.deleteOlderThan(thirtyDaysAgo);

  return {
    usersChecked: userTenantApps.size,
    updatesFound,
    autoUpdates: {
      triggered: autoUpdateResult.triggered,
      skipped: autoUpdateResult.skipped,
      failed: autoUpdateResult.failed,
    },
    errors,
  };
}
