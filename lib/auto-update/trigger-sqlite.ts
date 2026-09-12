/**
 * SQLite-mode auto-update trigger. Mirrors the safety-check logic of
 * AutoUpdateTrigger (lib/auto-update/trigger.ts) - rate limits, cooldowns,
 * prior-deployment check - against sqliteUpdatePolicies/sqliteAutoUpdateHistory
 * instead of Supabase. Packaging-job creation reuses the same
 * getLatestInstallerInfo -> getDatabase().jobs.create -> triggerPackagingWorkflow
 * path the Supabase-mode app/api/updates/trigger/route.ts already uses.
 */
import {
  sqliteUpdatePolicies,
  sqliteAutoUpdateHistory,
  type UpdateCheckInsert,
} from '@/lib/db/sqlite';
import { getDatabase } from '@/lib/db';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import {
  AppUpdatePolicy,
  DeploymentConfig,
  DEFAULT_SAFETY_CONFIG,
  AutoUpdateSafetyConfig,
  classifyUpdateType,
  canAutoUpdate,
} from '@/types/update-policies';
import { getLatestInstallerInfo, type TriggerResult, type UpdateInfo } from './trigger';
import type { Json } from '@/types/database';

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

    let jobId: string | undefined;
    try {
      const installerResolution = await getLatestInstallerInfo(
        undefined,
        updateInfo.wingetId,
        (policy.deployment_config as DeploymentConfig).architecture,
        (policy.deployment_config as DeploymentConfig).installScope
      );
      if (!installerResolution.ok) {
        await sqliteUpdatePolicies.incrementFailureCount(policy.id);
        await sqliteAutoUpdateHistory.updateStatus(historyId, 'failed', {
          errorMessage: installerResolution.failure.message,
          completedAt: new Date().toISOString(),
        });
        return { success: false, error: installerResolution.failure.message, historyId };
      }
      const installerInfo = { ...installerResolution.info, currentVersion: updateInfo.currentVersion };

      const deploymentConfig = policy.deployment_config as DeploymentConfig;
      const db = getDatabase();
      const job = await db.jobs.create({
        user_id: policy.user_id,
        tenant_id: policy.tenant_id,
        winget_id: policy.winget_id,
        version: installerInfo.latestVersion,
        display_name: deploymentConfig.displayName,
        publisher: deploymentConfig.publisher,
        architecture: deploymentConfig.architecture,
        installer_type: installerInfo.installerType || deploymentConfig.installerType,
        installer_url: installerInfo.installerUrl,
        installer_sha256: installerInfo.installerSha256,
        install_command: deploymentConfig.installCommand,
        uninstall_command: deploymentConfig.uninstallCommand,
        install_scope: deploymentConfig.installScope,
        detection_rules: deploymentConfig.detectionRules as unknown as Json,
        status: 'queued',
      });

      jobId = job.id;
      await sqliteAutoUpdateHistory.updateStatus(historyId, 'packaging', { packagingJobId: job.id });

      const { isGitHubActionsConfigured, triggerPackagingWorkflow } = await import('@/lib/github-actions');
      if (isGitHubActionsConfigured()) {
        const callbackUrl = `${process.env.CALLBACK_BASE_URL || process.env.NEXT_PUBLIC_APP_URL}/api/package/callback`;
        await triggerPackagingWorkflow({
          jobId: job.id,
          tenantId: policy.tenant_id,
          wingetId: policy.winget_id,
          displayName: deploymentConfig.displayName,
          description: `Auto-updated via IntuneGet from Winget: ${policy.winget_id}`,
          publisher: deploymentConfig.publisher,
          version: installerInfo.latestVersion,
          architecture: deploymentConfig.architecture,
          installerUrl: installerInfo.installerUrl,
          installerSha256: installerInfo.installerSha256 || '',
          installerType: installerInfo.installerType || deploymentConfig.installerType,
          silentSwitches: installerInfo.silentSwitches || '',
          uninstallCommand: deploymentConfig.uninstallCommand,
          callbackUrl,
          detectionRules: JSON.stringify(deploymentConfig.detectionRules),
          psadtConfig: deploymentConfig.psadtConfig ? JSON.stringify(deploymentConfig.psadtConfig) : undefined,
          installScope: (deploymentConfig.installScope === 'user' ? 'user' : 'machine') as 'machine' | 'user',
          forceCreate: deploymentConfig.forceCreateNewApp !== false,
        });
      }

      await sqliteUpdatePolicies.update(policy.id, policy.user_id, {
        last_auto_update_at: new Date().toISOString(),
        last_auto_update_version: installerInfo.latestVersion,
      });

      return { success: true, packagingJobId: job.id, historyId };
    } catch (error) {
      await sqliteUpdatePolicies.incrementFailureCount(policy.id);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const completedAt = new Date().toISOString();
      await sqliteAutoUpdateHistory.updateStatus(historyId, 'failed', {
        errorMessage,
        completedAt,
      });
      // The packaging job row (if one was already created before the failure,
      // e.g. triggerPackagingWorkflow threw after jobs.create) has its own
      // status column that isn't touched by the history update above - leave
      // it in a matching terminal state instead of stuck at 'queued' forever.
      if (jobId) {
        await getDatabase().jobs.update(jobId, {
          status: 'failed',
          error_message: errorMessage,
          completed_at: completedAt,
        });
      }
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

    const delayDays = policy.delay_days ?? 0;
    const detectedAt = new Date(update.detected_at).getTime();
    const eligibleAt = detectedAt + delayDays * 24 * 60 * 60 * 1000;
    if (Date.now() < eligibleAt) continue; // still waiting out the delay

    const triggerResult = await trigger.triggerAutoUpdate(policy, {
      wingetId: update.winget_id,
      currentVersion: update.current_version,
      latestVersion: update.latest_version,
      displayName: update.display_name,
      // Required by UpdateInfo's type but unused dead parameters here:
      // triggerAutoUpdate re-resolves the installer itself via
      // getLatestInstallerInfo(undefined, updateInfo.wingetId, ...), it never
      // reads these three fields off the updateInfo object it's passed.
      installerUrl: '',
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
