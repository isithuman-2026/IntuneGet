import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode } from '@/lib/db';
import { sqliteUploadHistory, sqliteUpdatePolicies } from '@/lib/db/sqlite';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import { assignToGroups, syncAppCategories } from '@/lib/intune-api';
import { buildDeploymentConfigForApp } from '@/lib/update-policies/build-deployment-config';
import { AutoUpdateTriggerSqlite } from '@/lib/auto-update/trigger-sqlite';
import { getCatalogSource } from '@/lib/catalog';
import type { Win32LobAppAssignment, DetectionRule } from '@/types/intune';
import type { UpdatePolicyType } from '@/types/update-policies';

interface EditAppRequest {
  assignments?: Win32LobAppAssignment[];
  categories?: { id: string }[];
  policyType?: UpdatePolicyType;
  delayDays?: number;
  installCommand?: string;
  uninstallCommand?: string;
  detectionRules?: DetectionRule[];
  confirmRedeploy?: boolean;
}

type FieldResult = 'ok' | { error: string };

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: intuneAppId } = await params;
  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (!isSqliteMode()) {
    return NextResponse.json({ error: 'Not implemented outside SQLite mode' }, { status: 501 });
  }

  const uploadHistory = await sqliteUploadHistory.getLatestByIntuneAppId(user.tenantId, intuneAppId);
  if (!uploadHistory) {
    return NextResponse.json({ error: 'App was not deployed by IntuneGet' }, { status: 404 });
  }

  const body = (await request.json()) as EditAppRequest;
  const results: Record<string, FieldResult> = {};

  if (body.assignments || body.categories) {
    const graphToken = await getServicePrincipalToken(user.tenantId);
    if (!graphToken) {
      return NextResponse.json({ error: 'Tenant consent is no longer active' }, { status: 403 });
    }

    if (body.assignments) {
      try {
        await assignToGroups(graphToken, intuneAppId, body.assignments);
        results.assignments = 'ok';
      } catch (error) {
        results.assignments = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }

    if (body.categories) {
      try {
        await syncAppCategories(graphToken, intuneAppId, body.categories);
        results.categories = 'ok';
      } catch (error) {
        results.categories = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
  }

  if (body.policyType || body.delayDays !== undefined) {
    try {
      await sqliteUpdatePolicies.upsert(uploadHistory.user_id, {
        winget_id: uploadHistory.winget_id,
        tenant_id: user.tenantId,
        policy_type: body.policyType ?? 'notify',
        delay_days: body.delayDays,
      });
      results.policy = 'ok';
    } catch (error) {
      results.policy = { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  const hasPackageEdit = body.installCommand !== undefined || body.uninstallCommand !== undefined || body.detectionRules !== undefined;
  let redeploy: { packagingJobId?: string; error?: string } | undefined;

  if (hasPackageEdit) {
    if (!body.confirmRedeploy) {
      return NextResponse.json(
        { error: 'confirmRedeploy must be true to change install command, uninstall command, or detection rules' },
        { status: 400 }
      );
    }

    const built = await buildDeploymentConfigForApp({
      userId: uploadHistory.user_id,
      tenantId: user.tenantId,
      wingetId: uploadHistory.winget_id,
      latestVersion: uploadHistory.version,
    });

    if (built.status !== 'ok') {
      redeploy = { error: `Could not resolve current deployment config (${built.status})` };
    } else {
      const overriddenConfig = {
        ...built.deploymentConfig,
        installCommand: body.installCommand ?? built.deploymentConfig.installCommand,
        uninstallCommand: body.uninstallCommand ?? built.deploymentConfig.uninstallCommand,
        detectionRules: body.detectionRules ?? built.deploymentConfig.detectionRules,
      };

      const { policy } = await sqliteUpdatePolicies.upsert(uploadHistory.user_id, {
        winget_id: uploadHistory.winget_id,
        tenant_id: user.tenantId,
        policy_type: 'auto_update',
        deployment_config: overriddenConfig,
        original_upload_history_id: uploadHistory.id,
      });

      const versions = await getCatalogSource().getVersions(uploadHistory.winget_id);
      const latestVersion = versions[0] ?? uploadHistory.version;
      const trigger = new AutoUpdateTriggerSqlite();
      const result = await trigger.triggerAutoUpdate(policy, {
        wingetId: uploadHistory.winget_id,
        currentVersion: uploadHistory.version,
        latestVersion,
        displayName: overriddenConfig.displayName,
        currentIntuneAppId: intuneAppId,
        installerUrl: '', installerSha256: '', installerType: '',
      }, { skipRateLimits: false, skipPriorDeploymentCheck: true });

      redeploy = result.success
        ? { packagingJobId: result.packagingJobId }
        : { error: result.error };
    }
  }

  return NextResponse.json({ results, ...(redeploy ? { redeploy } : {}) });
}
