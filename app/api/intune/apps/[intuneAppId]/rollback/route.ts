import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode, getDatabase } from '@/lib/db';
import { sqliteUploadHistory, sqliteUpdatePolicies } from '@/lib/db/sqlite';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import { getAppAssignments, getAppCategories } from '@/lib/intune-api';
import { AutoUpdateTriggerSqlite } from '@/lib/auto-update/trigger-sqlite';
import type { DeploymentConfig } from '@/types/update-policies';
import type { DetectionRule, Win32LobAppAssignment } from '@/types/intune';
import type { PackageAssignment } from '@/types/upload';

// Graph assignment -> the flatter PackageAssignment shape DeploymentConfig
// stores. Mirrors convertToGraphAssignments in lib/intune-api.ts in reverse;
// groupName isn't present on a Graph assignment so it's left unset (only
// groupId is needed downstream for re-assignment).
function fromGraphAssignment(assignment: Win32LobAppAssignment): PackageAssignment {
  const odataType = assignment.target['@odata.type'];
  const type =
    odataType === '#microsoft.graph.groupAssignmentTarget'
      ? 'group'
      : odataType === '#microsoft.graph.exclusionGroupAssignmentTarget'
        ? 'exclusionGroup'
        : odataType === '#microsoft.graph.allDevicesAssignmentTarget'
          ? 'allDevices'
          : 'allUsers';

  return {
    type,
    intent: assignment.intent === 'availableWithoutEnrollment' ? 'available' : assignment.intent,
    groupId: assignment.target.groupId,
    filterId: assignment.target.deviceAndAppManagementAssignmentFilterId,
    filterType: assignment.target.deviceAndAppManagementAssignmentFilterType,
    notifications: assignment.settings?.notifications,
    deliveryOptimizationPriority: assignment.settings?.deliveryOptimizationPriority,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ intuneAppId: string }> }
) {
  const { intuneAppId } = await params;
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

  const { packagingJobId } = (await request.json()) as { packagingJobId?: string };
  if (!packagingJobId) {
    return NextResponse.json({ error: 'packagingJobId is required' }, { status: 400 });
  }

  const db = getDatabase();
  const targetJob = await db.jobs.getById(packagingJobId);
  if (!targetJob || targetJob.winget_id !== uploadHistory.winget_id || targetJob.user_id !== uploadHistory.user_id) {
    return NextResponse.json({ error: 'packagingJobId does not match this app' }, { status: 400 });
  }

  const graphToken = await getServicePrincipalToken(user.tenantId);
  if (!graphToken) {
    return NextResponse.json({ error: 'Tenant consent is no longer active' }, { status: 403 });
  }

  // Rollback re-deploys the OLD version's install/uninstall/detection config,
  // but assignments/categories should follow the CURRENTLY deployed app, not
  // whatever the old job happened to have - fetch those live.
  const [currentAssignments, currentCategories] = await Promise.all([
    getAppAssignments(graphToken, intuneAppId),
    getAppCategories(graphToken, intuneAppId),
  ]);

  const overriddenConfig: DeploymentConfig = {
    displayName: targetJob.display_name,
    publisher: targetJob.publisher || 'Unknown Publisher',
    architecture: targetJob.architecture || 'x64',
    installerType: targetJob.installer_type || 'exe',
    installCommand: targetJob.install_command || '',
    uninstallCommand: targetJob.uninstall_command || '',
    installScope: targetJob.install_scope || 'machine',
    detectionRules: (targetJob.detection_rules as unknown as DetectionRule[]) || [],
    assignments: currentAssignments.map(fromGraphAssignment),
    categories: currentCategories.map((c) => ({ id: c.id, displayName: c.displayName })),
    forceCreateNewApp: true,
  };

  const { policy } = await sqliteUpdatePolicies.upsert(uploadHistory.user_id, {
    winget_id: uploadHistory.winget_id,
    tenant_id: user.tenantId,
    policy_type: 'auto_update',
    deployment_config: overriddenConfig,
    original_upload_history_id: uploadHistory.id,
  });

  const trigger = new AutoUpdateTriggerSqlite();
  const result = await trigger.triggerAutoUpdate(policy, {
    wingetId: uploadHistory.winget_id,
    currentVersion: uploadHistory.version,
    latestVersion: targetJob.version,
    displayName: targetJob.display_name,
    currentIntuneAppId: intuneAppId,
    installerUrl: targetJob.installer_url || '',
    installerSha256: targetJob.installer_sha256 || '',
    installerType: targetJob.installer_type || 'exe',
  }, { skipPriorDeploymentCheck: true });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ packagingJobId: result.packagingJobId });
}
