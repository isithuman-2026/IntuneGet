/**
 * Microsoft Intune Graph API Client
 * Handles Win32 app creation, upload, and configuration
 */

import type {
  IntuneWin32App,
  DetectionRule,
  RequirementRule,
  Win32LobAppAssignment,
  WindowsMinimumOperatingSystem,
  EntraIDGroup,
  IntuneMobileAppCategory,
  IntuneAssignmentFilter,
  GraphApiResponse,
  Win32LobAppRule,
} from '@/types/intune';
import type { PackageAssignment } from '@/types/upload';

const GRAPH_API_BASE = 'https://graph.microsoft.com/beta';

/**
 * Create a Win32 app in Intune
 */
export async function createWin32App(
  accessToken: string,
  app: Partial<IntuneWin32App>
): Promise<string> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.win32LobApp',
        displayName: app.displayName,
        description: app.description || '',
        publisher: app.publisher || '',
        ...(app.largeIcon ? { largeIcon: app.largeIcon } : {}),
        fileName: app.fileName,
        installCommandLine: app.installCommandLine,
        uninstallCommandLine: app.uninstallCommandLine,
        applicableArchitectures: app.applicableArchitectures || 'x64',
        minimumSupportedOperatingSystem: app.minimumSupportedOperatingSystem || {
          v10_1903: true,
        },
        installExperience: app.installExperience || {
          runAsAccount: 'system',
          deviceRestartBehavior: 'basedOnReturnCode',
        },
        returnCodes: app.returnCodes || getDefaultReturnCodes(),
        rules: [], // Rules are added after content upload
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create Win32 app: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.id;
}

/**
 * Create a content version for the app
 */
export async function createContentVersion(
  accessToken: string,
  appId: string
): Promise<string> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to create content version');
  }

  const data = await response.json();
  return data.id;
}

/**
 * Create a content file and get upload URL
 */
export async function createContentFile(
  accessToken: string,
  appId: string,
  contentVersionId: string,
  fileName: string,
  fileSize: number,
  encryptedFileSize: number
): Promise<{ fileId: string; uploadUrl: string }> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions/${contentVersionId}/files`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.mobileAppContentFile',
        name: fileName,
        size: fileSize,
        sizeEncrypted: encryptedFileSize,
        isDependency: false,
      }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to create content file');
  }

  const data = await response.json();

  // Wait for Azure Storage URI
  const uploadUrl = await waitForUploadUrl(accessToken, appId, contentVersionId, data.id);

  return {
    fileId: data.id,
    uploadUrl,
  };
}

/**
 * Wait for the Azure Storage upload URL to be ready
 */
async function waitForUploadUrl(
  accessToken: string,
  appId: string,
  contentVersionId: string,
  fileId: string,
  maxAttempts: number = 20
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(
      `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions/${contentVersionId}/files/${fileId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error('Failed to check upload URL status');
    }

    const data = await response.json();

    if (data.azureStorageUri) {
      return data.azureStorageUri;
    }

    if (data.uploadState === 'azureStorageUriRequestFailed') {
      throw new Error('Failed to get Azure Storage URI');
    }

    // Wait before retrying
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error('Timeout waiting for upload URL');
}

/**
 * Commit the content file after upload
 */
export async function commitContentFile(
  accessToken: string,
  appId: string,
  contentVersionId: string,
  fileId: string,
  encryptionInfo: {
    encryptionKey: string;
    macKey: string;
    initializationVector: string;
    mac: string;
    profileIdentifier: string;
    fileDigest: string;
    fileDigestAlgorithm: string;
  }
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions/${contentVersionId}/files/${fileId}/commit`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileEncryptionInfo: {
          ...encryptionInfo,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to commit content file');
  }
}

/**
 * Wait for content file to be committed
 */
export async function waitForCommit(
  accessToken: string,
  appId: string,
  contentVersionId: string,
  fileId: string,
  maxAttempts: number = 30
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(
      `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions/${contentVersionId}/files/${fileId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error('Failed to check commit status');
    }

    const data = await response.json();

    if (data.uploadState === 'commitFileSuccess') {
      return;
    }

    if (data.uploadState === 'commitFileFailed') {
      throw new Error('Content file commit failed');
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error('Timeout waiting for commit');
}

/**
 * Update app with committed content version
 */
export async function updateAppWithContent(
  accessToken: string,
  appId: string,
  contentVersionId: string
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.win32LobApp',
        committedContentVersion: contentVersionId,
      }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to update app with content');
  }
}

/**
 * Set detection rules for the app
 */
export async function setDetectionRules(
  accessToken: string,
  appId: string,
  rules: DetectionRule[],
  requirementRules?: RequirementRule[]
): Promise<void> {
  const graphRules: Record<string, unknown>[] = rules.map(convertToGraphDetectionRule);

  // Merge requirement rules into the rules array (they are already in Graph format)
  if (requirementRules && requirementRules.length > 0) {
    for (const reqRule of requirementRules) {
      graphRules.push(reqRule as unknown as Record<string, unknown>);
    }
  }

  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.win32LobApp',
        rules: graphRules,
      }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to set detection rules');
  }
}

/**
 * Convert our detection rule format to Graph API format
 */
function convertToGraphDetectionRule(rule: DetectionRule): Record<string, unknown> {
  switch (rule.type) {
    case 'msi':
      return {
        '@odata.type': '#microsoft.graph.win32LobAppProductCodeRule',
        ruleType: 'detection',
        productCode: rule.productCode,
        productVersionOperator: rule.productVersionOperator || 'notConfigured',
        productVersion: rule.productVersion,
      };

    case 'file':
      return {
        '@odata.type': '#microsoft.graph.win32LobAppFileSystemRule',
        ruleType: 'detection',
        path: rule.path,
        fileOrFolderName: rule.fileOrFolderName,
        check32BitOn64System: rule.check32BitOn64System || false,
        operationType: mapFileDetectionType(rule.detectionType),
        operator: rule.operator || 'notConfigured',
        comparisonValue: rule.detectionValue,
      };

    case 'registry':
      return {
        '@odata.type': '#microsoft.graph.win32LobAppRegistryRule',
        ruleType: 'detection',
        keyPath: rule.keyPath,
        valueName: rule.valueName,
        check32BitOn64System: rule.check32BitOn64System || false,
        operationType: mapRegistryDetectionType(rule.detectionType),
        operator: rule.operator || 'notConfigured',
        comparisonValue: rule.detectionValue,
      };

    case 'script':
      return {
        '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRule',
        ruleType: 'detection',
        scriptContent: Buffer.from(rule.scriptContent).toString('base64'),
        enforceSignatureCheck: rule.enforceSignatureCheck || false,
        runAs32Bit: rule.runAs32Bit || false,
        operationType: 'notConfigured',
      };

    default:
      throw new Error(`Unknown detection rule type: ${(rule as DetectionRule).type}`);
  }
}

function mapFileDetectionType(type: string): string {
  const mapping: Record<string, string> = {
    exists: 'exists',
    notExists: 'doesNotExist',
    version: 'version',
    dateModified: 'modifiedDate',
    dateCreated: 'createdDate',
    string: 'string',
    sizeInMB: 'sizeInMB',
  };
  return mapping[type] || 'exists';
}

function mapRegistryDetectionType(type: string): string {
  const mapping: Record<string, string> = {
    exists: 'exists',
    notExists: 'doesNotExist',
    string: 'string',
    integer: 'integer',
    version: 'version',
  };
  return mapping[type] || 'exists';
}

/**
 * Assign app to groups
 */
export async function assignToGroups(
  accessToken: string,
  appId: string,
  assignments: Win32LobAppAssignment[]
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/assign`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mobileAppAssignments: assignments,
      }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to assign app to groups');
  }
}

/**
 * Get Entra ID groups for assignment
 */
export async function getEntraIDGroups(
  accessToken: string,
  search?: string
): Promise<EntraIDGroup[]> {
  const url = new URL(`${GRAPH_API_BASE}/groups`);
  url.searchParams.set('$select', 'id,displayName,description,securityEnabled');
  url.searchParams.set('$top', '50');

  if (search) {
    url.searchParams.set('$search', `"displayName:${search}"`);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: 'eventual',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to get Entra ID groups');
  }

  const data: GraphApiResponse<EntraIDGroup> = await response.json();
  return data.value || [];
}

/**
 * Fetch every page of a Graph collection by following @odata.nextLink.
 * Graph paginates list endpoints; reading only the first page silently
 * truncates results (e.g. a category/filter dropdown missing entries).
 */
async function fetchAllGraphPages<T>(
  initialUrl: string,
  accessToken: string,
  errorMessage: string,
  extraHeaders?: Record<string, string>
): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | undefined = initialUrl;

  while (nextUrl) {
    const response: Response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...extraHeaders,
      },
    });

    if (!response.ok) {
      // Carry the HTTP status so callers can distinguish a permission error
      // (403) from a genuinely empty list and surface an actionable message.
      const err = new Error(`${errorMessage} (${response.status})`) as Error & {
        status?: number;
      };
      err.status = response.status;
      throw err;
    }

    const data: GraphApiResponse<T> = await response.json();
    if (data.value) {
      results.push(...data.value);
    }
    nextUrl = data['@odata.nextLink'];
  }

  return results;
}

/**
 * Get Intune mobile app categories
 */
export async function getMobileAppCategories(
  accessToken: string
): Promise<IntuneMobileAppCategory[]> {
  const url = new URL(`${GRAPH_API_BASE}/deviceAppManagement/mobileAppCategories`);
  url.searchParams.set('$select', 'id,displayName,lastModifiedDateTime');

  const categories = await fetchAllGraphPages<IntuneMobileAppCategory>(
    url.toString(),
    accessToken,
    'Failed to get Intune app categories'
  );
  return categories
    .filter((category) => Boolean(category.id && category.displayName))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Get Intune assignment filters
 */
export async function getAssignmentFilters(
  accessToken: string
): Promise<IntuneAssignmentFilter[]> {
  const url = new URL(`${GRAPH_API_BASE}/deviceManagement/assignmentFilters`);
  url.searchParams.set('$select', 'id,displayName,description,platform,rule');
  url.searchParams.set('$orderby', 'displayName');

  const filters = await fetchAllGraphPages<IntuneAssignmentFilter>(
    url.toString(),
    accessToken,
    'Failed to get Intune assignment filters'
  );
  return filters
    .filter((filter) => Boolean(filter.id && filter.displayName))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Get default return codes for Win32 apps
 */
function getDefaultReturnCodes() {
  return [
    { returnCode: 0, type: 'success' },
    { returnCode: 1707, type: 'success' },
    { returnCode: 3010, type: 'softReboot' },
    { returnCode: 1641, type: 'hardReboot' },
    { returnCode: 1618, type: 'retry' },
  ];
}

/**
 * Get app details
 */
export async function getApp(
  accessToken: string,
  appId: string
): Promise<IntuneWin32App | null> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error('Failed to get app');
  }

  return response.json();
}

/** Replace an app's Graph rules array. Callers must preserve existing rules. */
export async function setAppRules(
  accessToken: string,
  appId: string,
  rules: Win32LobAppRule[]
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rules }),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to update app requirement rules');
  }
}

/**
 * Delete an app
 */
export async function deleteApp(
  accessToken: string,
  appId: string
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error('Failed to delete app');
  }
}

/**
 * Convert PackageAssignment array to Microsoft Graph API Win32LobAppAssignment format
 */
export function convertToGraphAssignments(
  assignments: PackageAssignment[]
): Win32LobAppAssignment[] {
  return assignments.map((assignment) => {
    let target: Win32LobAppAssignment['target'];

    switch (assignment.type) {
      case 'allUsers':
        target = {
          '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget',
        };
        break;
      case 'allDevices':
        target = {
          '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget',
        };
        break;
      case 'group':
        target = {
          '@odata.type': '#microsoft.graph.groupAssignmentTarget',
          groupId: assignment.groupId,
        };
        break;
      case 'exclusionGroup':
        target = {
          '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget',
          groupId: assignment.groupId,
        };
        break;
      default:
        throw new Error(`Unknown assignment type: ${(assignment as PackageAssignment).type}`);
    }

    // Add filter properties if configured
    if (assignment.filterId) {
      target.deviceAndAppManagementAssignmentFilterId = assignment.filterId;
      target.deviceAndAppManagementAssignmentFilterType = assignment.filterType || 'include';
    }

    // Map 'updateOnly' to 'required' for Graph API (requirement rules handle the gating)
    const graphIntent = assignment.intent === 'updateOnly' ? 'required' : assignment.intent;

    const graphAssignment: Win32LobAppAssignment = {
      '@odata.type': '#microsoft.graph.mobileAppAssignment',
      intent: graphIntent,
      target,
    };

    // Exclusion assignments do not support settings
    if (assignment.type !== 'exclusionGroup') {
      graphAssignment.settings = {
        '@odata.type': '#microsoft.graph.win32LobAppAssignmentSettings',
        notifications: assignment.notifications ?? 'showAll',
        deliveryOptimizationPriority: assignment.deliveryOptimizationPriority ?? 'notConfigured',
      };
    }

    return graphAssignment;
  });
}

/**
 * Get categories currently assigned to an app
 */
export async function getAppCategories(
  accessToken: string,
  appId: string
): Promise<IntuneMobileAppCategory[]> {
  return await fetchAllGraphPages<IntuneMobileAppCategory>(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/categories`,
    accessToken,
    'Failed to get app categories'
  );
}

/**
 * Get assignments currently on an app
 */
export async function getAppAssignments(
  accessToken: string,
  appId: string
): Promise<Win32LobAppAssignment[]> {
  return await fetchAllGraphPages<Win32LobAppAssignment>(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/assignments`,
    accessToken,
    'Failed to get app assignments'
  );
}

/**
 * Add a category to an app via $ref
 */
export async function addAppCategory(
  accessToken: string,
  appId: string,
  categoryId: string
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/categories/$ref`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        '@odata.id': `${GRAPH_API_BASE}/deviceAppManagement/mobileAppCategories/${categoryId}`,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to add category ${categoryId} to app`);
  }
}

/**
 * Remove a category from an app
 */
export async function removeAppCategory(
  accessToken: string,
  appId: string,
  categoryId: string
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/categories/${categoryId}/$ref`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to remove category ${categoryId} from app`);
  }
}

/**
 * Sync app categories: diff current vs desired, add missing, remove stale
 */
export async function syncAppCategories(
  accessToken: string,
  appId: string,
  desiredCategories: { id: string }[]
): Promise<void> {
  const currentCategories = await getAppCategories(accessToken, appId);
  const currentIds = new Set(currentCategories.map((c) => c.id));
  const desiredIds = new Set(desiredCategories.map((c) => c.id));

  const toAdd = desiredCategories.filter((c) => !currentIds.has(c.id));
  const toRemove = currentCategories.filter((c) => !desiredIds.has(c.id));

  await Promise.all([
    ...toAdd.map((c) => addAppCategory(accessToken, appId, c.id)),
    ...toRemove.map((c) => removeAppCategory(accessToken, appId, c.id)),
  ]);
}

/**
 * Apply app relationships (dependencies / supersedence) via Graph API.
 * Non-fatal: logs warnings on failure but does not throw.
 */
export async function applyAppRelationships(
  accessToken: string,
  appId: string,
  relationships: Array<{
    relationshipType: 'dependency' | 'supersedence';
    targetId: string;
    dependencyType?: 'detect' | 'autoInstall';
    supersedenceType?: 'update' | 'replace';
  }>
): Promise<string[]> {
  const warnings: string[] = [];

  for (const rel of relationships) {
    const body: Record<string, unknown> = {
      targetId: rel.targetId,
    };

    if (rel.relationshipType === 'dependency') {
      body['@odata.type'] = '#microsoft.graph.mobileAppDependency';
      body.dependencyType = rel.dependencyType || 'autoInstall';
    } else {
      body['@odata.type'] = '#microsoft.graph.mobileAppSupersedence';
      body.supersedenceType = rel.supersedenceType || 'update';
    }

    try {
      const response = await fetch(
        `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/relationships`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const msg = `Failed to create ${rel.relationshipType} with target ${rel.targetId}: ${(error as Record<string, Record<string, string>>).error?.message || response.statusText}`;
        console.error('[intune-api] Relationship error:', msg);
        warnings.push(msg);
      }
    } catch (err) {
      const msg = `Failed to create ${rel.relationshipType} with target ${rel.targetId}: ${err instanceof Error ? err.message : 'Unknown error'}`;
      console.error('[intune-api] Relationship error:', msg);
      warnings.push(msg);
    }
  }

  return warnings;
}

/**
 * Install summary counts for an app (device check-in status). Used to gate
 * auto-prune: an old superseded app is only safe to delete once no device
 * still has it installed or pending install.
 */
export interface AppInstallSummary {
  installedDeviceCount: number;
  pendingInstallDeviceCount: number;
}

export async function getAppInstallSummary(
  accessToken: string,
  appId: string
): Promise<AppInstallSummary> {
  const response = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/installSummary`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (response.status === 404) {
    // App already gone - nothing left to migrate off of.
    return { installedDeviceCount: 0, pendingInstallDeviceCount: 0 };
  }
  if (!response.ok) {
    throw new Error(`Failed to get install summary for app ${appId}: ${response.statusText}`);
  }

  const data = (await response.json()) as Partial<AppInstallSummary>;
  return {
    installedDeviceCount: data.installedDeviceCount ?? 0,
    pendingInstallDeviceCount: data.pendingInstallDeviceCount ?? 0,
  };
}

/**
 * Clear all relationships (dependency/supersedence) on an app. Graph's
 * updateRelationships REPLACES the whole list, so an empty array removes
 * every relationship. Required before deleteApp() will succeed on an app
 * still referenced by a supersedence relationship - confirmed via live
 * manual test (see auto-prune design spec).
 * Non-fatal: returns a warning string on failure instead of throwing,
 * mirroring applyAppRelationships().
 */
export async function clearAppRelationships(
  accessToken: string,
  appId: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/updateRelationships`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ relationships: [] }),
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const msg = `Failed to clear relationships on app ${appId}: ${(error as Record<string, Record<string, string>>).error?.message || response.statusText}`;
      console.error('[intune-api] clearAppRelationships error:', msg);
      return msg;
    }
    return null;
  } catch (err) {
    const msg = `Failed to clear relationships on app ${appId}: ${err instanceof Error ? err.message : 'Unknown error'}`;
    console.error('[intune-api] clearAppRelationships error:', msg);
    return msg;
  }
}

export interface ReplaceContentEncryptionInfo {
  encryptionKey: string;
  macKey: string;
  initializationVector: string;
  mac: string;
  profileIdentifier: string;
  fileDigest: string;
  fileDigestAlgorithm: string;
}

export interface ReplaceContentInput {
  fileName: string;
  fileSize: number;
  fileSizeEncrypted: number;
  // BodyInit (not Buffer/Uint8Array): this project's DOM lib typing rejects
  // typed arrays as a fetch body directly. Callers pass a Buffer — it
  // satisfies BodyInit at the fetch call site under Node's fetch runtime.
  uploadBuffer: BodyInit;
  encryptionInfo: ReplaceContentEncryptionInfo;
}

interface ContentFileState {
  uploadState?: string;
  azureStorageUri?: string;
}

/**
 * Poll a mobileAppContentFile resource until `extract` returns a non-null
 * result, or throw (extract itself throws on a terminal failure state).
 * Both the Azure Storage URI and the commit result are only available
 * asynchronously — never on the request that kicks them off.
 */
async function pollContentFile<T>(
  fileUrl: string,
  headers: Record<string, string>,
  extract: (file: ContentFileState) => T | null
): Promise<T> {
  const maxAttempts = 60;
  const delayMs = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(fileUrl, { headers: { Authorization: headers.Authorization } });
    if (!response.ok) {
      throw new Error(`Failed to poll content file state at ${fileUrl}: ${response.status}`);
    }
    const file = (await response.json()) as ContentFileState;
    const result = extract(file);
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Timed out polling content file state at ${fileUrl}`);
}

/**
 * Replace a win32LobApp's content in place: create a new content version on
 * the EXISTING app, upload + commit the new (already-encrypted) package
 * bytes, then activate it via committedContentVersion. No new Intune app
 * object is created — same id, same assignments, before and after.
 *
 * Sequence and request shapes verified live against a real, already-
 * published win32LobApp — see
 * docs/superpowers/sdd/2026-09-27-duplicate-handling-redesign/content-version-patch-spike.md
 */
export async function replaceAppContentInPlace(
  accessToken: string,
  appId: string,
  content: ReplaceContentInput
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  // 1. Create a new content version on the existing app.
  const cvResponse = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions`,
    { method: 'POST', headers, body: JSON.stringify({}) }
  );
  if (!cvResponse.ok) {
    throw new Error(`Failed to create content version for app ${appId}: ${cvResponse.status}`);
  }
  const { id: contentVersionId } = (await cvResponse.json()) as { id: string };

  // 2. Register the content file on that version.
  const fileResponse = await fetch(
    `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions/${contentVersionId}/files`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.mobileAppContentFile',
        name: content.fileName,
        size: content.fileSize,
        sizeEncrypted: content.fileSizeEncrypted,
        isDependency: false,
      }),
    }
  );
  if (!fileResponse.ok) {
    throw new Error(`Failed to register content file on app ${appId}: ${fileResponse.status}`);
  }
  const { id: contentFileId } = (await fileResponse.json()) as { id: string };

  const fileUrl = `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions/${contentVersionId}/files/${contentFileId}`;

  // 3. Poll until Graph hands back a real Azure Storage SAS URI — it is
  // never present on the POST response itself (confirmed live in the
  // Task 4 spike: the file starts in azureStorageUriRequestPending).
  const azureStorageUri = await pollContentFile<string>(fileUrl, headers, (file) => {
    if (file.uploadState === 'azureStorageUriRequestFailed') {
      throw new Error(`Azure Storage URI request failed for app ${appId}`);
    }
    return file.azureStorageUri ?? null;
  });

  // 4. Upload the encrypted bytes to that SAS URI.
  const uploadResponse = await fetch(azureStorageUri, {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob' },
    body: content.uploadBuffer,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload content to Azure Storage for app ${appId}: ${uploadResponse.status}`);
  }

  // 5. Commit the file with its encryption info (accepted synchronously,
  // but the actual commit result — success or failure — only shows up on
  // a later GET, exactly like the SAS URI above).
  const commitResponse = await fetch(`${fileUrl}/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fileEncryptionInfo: content.encryptionInfo }),
  });
  if (!commitResponse.ok) {
    throw new Error(`Failed to commit content file for app ${appId}: ${commitResponse.status}`);
  }

  // 6. Poll until the commit actually resolves. A failed commit (e.g. a
  // digest mismatch) must never reach the activate step — Graph rejects
  // that PATCH with "All AppFiles must be committed before committing an
  // application", observed live in the Task 4 spike.
  await pollContentFile<true>(fileUrl, headers, (file) => {
    if (file.uploadState === 'commitFileFailed' || file.uploadState === 'commitFileTimedOut') {
      throw new Error(`Content file commit failed for app ${appId} (state: ${file.uploadState})`);
    }
    return file.uploadState === 'commitFileSuccess' ? true : null;
  });

  // 7. Activate the new version.
  const patchResponse = await fetch(`${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${appId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      '@odata.type': '#microsoft.graph.win32LobApp',
      committedContentVersion: contentVersionId,
    }),
  });
  if (!patchResponse.ok) {
    throw new Error(`Failed to activate new content version for app ${appId}: ${patchResponse.status}`);
  }
}

/**
 * Get Intune portal URL for an app
 */
export function getIntunePortalUrl(appId: string): string {
  return `https://intune.microsoft.com/#view/Microsoft_Intune_Apps/SettingsBlade/appId/${appId}`;
}
