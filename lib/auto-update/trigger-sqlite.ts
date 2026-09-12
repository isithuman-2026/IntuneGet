/**
 * SQLite-mode auto-update trigger. Mirrors the safety-check logic of
 * AutoUpdateTrigger (lib/auto-update/trigger.ts) - rate limits, cooldowns,
 * prior-deployment check - against sqliteUpdatePolicies/sqliteAutoUpdateHistory
 * instead of Supabase. Packaging-job creation is deliberately stubbed here;
 * it's wired in a later task once the shared SQLite packaging path is
 * confirmed (detection-rules.ts, packaging-adapters.ts, getDatabase().jobs.create).
 */
import {
  sqliteUpdatePolicies,
  sqliteAutoUpdateHistory,
  type UpdateCheckInsert,
} from '@/lib/db/sqlite';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import {
  AppUpdatePolicy,
  DEFAULT_SAFETY_CONFIG,
  AutoUpdateSafetyConfig,
  classifyUpdateType,
  canAutoUpdate,
} from '@/types/update-policies';
import type { TriggerResult, UpdateInfo } from './trigger';

export class AutoUpdateTriggerSqlite {
  private safetyConfig: AutoUpdateSafetyConfig;

  constructor(safetyConfig: AutoUpdateSafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.safetyConfig = safetyConfig;
  }

  async triggerAutoUpdate(
    policy: AppUpdatePolicy,
    updateInfo: UpdateInfo,
    options?: { skipRateLimits?: boolean; skipPriorDeploymentCheck?: boolean }
  ): Promise<TriggerResult> {
    if (!canAutoUpdate(policy)) {
      return { success: false, skipped: true, skipReason: 'Policy does not allow auto-update or is disabled' };
    }

    if (!policy.deployment_config) {
      return { success: false, error: 'No deployment configuration saved for this policy' };
    }

    if (this.safetyConfig.requirePriorDeployment && !options?.skipPriorDeploymentCheck && !policy.original_upload_history_id) {
      return { success: false, error: 'Auto-update requires a prior manual deployment' };
    }

    if (!options?.skipRateLimits) {
      const rateLimitResult = await this.checkRateLimits(policy);
      if (!rateLimitResult.allowed) {
        return { success: false, skipped: true, skipReason: rateLimitResult.reason };
      }
    }

    // Consent check: SQLite mode has no tenant_consent table. The de-facto
    // proof of consent is a successful service-principal token acquisition,
    // the same check the Discovered Apps live-scan route already relies on.
    if (this.safetyConfig.verifyConsentBeforeDeployment) {
      const token = await getServicePrincipalToken(policy.tenant_id);
      if (!token) {
        return { success: false, error: 'Tenant consent is no longer active' };
      }
    }

    const updateType = classifyUpdateType(updateInfo.currentVersion, updateInfo.latestVersion);
    const { id: historyId } = await sqliteAutoUpdateHistory.create(
      policy.id,
      updateInfo.currentVersion,
      updateInfo.latestVersion,
      updateType
    );

    try {
      // Packaging-job creation reuses the same code path the manual
      // claim -> cart -> deploy flow already uses in SQLite mode today
      // (detection-rules.ts, packaging-adapters.ts, getDatabase().jobs.create) -
      // deliberately NOT reimplemented here. A later task wires the actual
      // call once the exact shared helper is confirmed.
      throw new Error('NOT_YET_WIRED');
    } catch (error) {
      await sqliteUpdatePolicies.incrementFailureCount(policy.id);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await sqliteAutoUpdateHistory.updateStatus(historyId, 'failed', {
        errorMessage,
        completedAt: new Date().toISOString(),
      });
      return { success: false, error: errorMessage, historyId };
    }
  }

  private async checkRateLimits(policy: AppUpdatePolicy): Promise<{ allowed: boolean; reason?: string }> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { rateLimits } = this.safetyConfig;

    const tenantPolicies = await sqliteUpdatePolicies.listByUser(policy.user_id, policy.tenant_id);
    const tenantPolicyIds = tenantPolicies.map((p) => p.id);
    if (tenantPolicyIds.length > 0) {
      const tenantCount = await sqliteAutoUpdateHistory.countSince(tenantPolicyIds, oneHourAgo, 'completed');
      if (tenantCount >= rateLimits.maxUpdatesPerTenant) {
        return { allowed: false, reason: `Rate limit exceeded: ${rateLimits.maxUpdatesPerTenant} updates per tenant per hour` };
      }
    }

    const userPolicies = await sqliteUpdatePolicies.listByUser(policy.user_id);
    const userPolicyIds = userPolicies.map((p) => p.id);
    if (userPolicyIds.length > 0) {
      const globalCount = await sqliteAutoUpdateHistory.countSince(userPolicyIds, oneHourAgo);
      if (globalCount >= rateLimits.maxUpdatesPerHour) {
        return { allowed: false, reason: `Rate limit exceeded: ${rateLimits.maxUpdatesPerHour} updates per hour` };
      }
    }

    const cooldownTime = new Date(Date.now() - rateLimits.cooldownMinutes * 60 * 1000).toISOString();
    const recent = await sqliteAutoUpdateHistory.hasRecentForPolicy(policy.id, cooldownTime);
    if (recent) {
      return { allowed: false, reason: `Cooldown period: wait ${rateLimits.cooldownMinutes} minutes between updates` };
    }

    return { allowed: true };
  }
}

/**
 * Called from runUpdateCheck() after detection, for every update whose
 * policy is auto_update and whose delay has elapsed.
 */
export async function runAutoUpdatesForNewDetections(
  updates: UpdateCheckInsert[]
): Promise<{ triggered: number; skipped: number; failed: number; errors: string[] }> {
  const result = { triggered: 0, skipped: 0, failed: 0, errors: [] as string[] };
  const trigger = new AutoUpdateTriggerSqlite();

  for (const update of updates) {
    const policy = await sqliteUpdatePolicies.getByApp(update.user_id, update.tenant_id, update.winget_id);
    if (!policy || policy.policy_type !== 'auto_update' || !policy.is_enabled) continue;

    const delayDays = (policy as unknown as { delay_days: number }).delay_days ?? 0;
    const detectedAt = new Date(update.detected_at).getTime();
    const eligibleAt = detectedAt + delayDays * 24 * 60 * 60 * 1000;
    if (Date.now() < eligibleAt) continue; // still waiting out the delay

    const triggerResult = await trigger.triggerAutoUpdate(policy, {
      wingetId: update.winget_id,
      currentVersion: update.current_version,
      latestVersion: update.latest_version,
      displayName: update.display_name,
      installerUrl: '', // filled in by getLatestInstallerInfo inside triggerAutoUpdate once packaging is wired
      installerSha256: '',
      installerType: '',
    });

    if (triggerResult.success) result.triggered++;
    else if (triggerResult.skipped) result.skipped++;
    else {
      result.failed++;
      if (triggerResult.error) result.errors.push(`${update.winget_id}: ${triggerResult.error}`);
    }
  }

  return result;
}
