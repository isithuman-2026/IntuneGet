import { NextRequest } from 'next/server';

const {
  parseAccessTokenMock,
  triggerAutoUpdateMock,
  buildDeploymentConfigForAppMock,
  getOneMock,
  getByAppMock,
  upsertMock,
  updateMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  triggerAutoUpdateMock: vi.fn(),
  buildDeploymentConfigForAppMock: vi.fn(),
  getOneMock: vi.fn(),
  getByAppMock: vi.fn(),
  upsertMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/db', () => ({
  isSqliteMode: () => true,
}));

vi.mock('@/lib/db/sqlite', () => ({
  sqliteUpdateChecks: { getOne: getOneMock },
  sqliteUpdatePolicies: { getByApp: getByAppMock, upsert: upsertMock, update: updateMock },
}));

vi.mock('@/lib/auto-update/trigger-sqlite', () => ({
  AutoUpdateTriggerSqlite: class {
    triggerAutoUpdate = triggerAutoUpdateMock;
  },
}));

vi.mock('@/lib/update-policies/build-deployment-config', () => ({
  buildDeploymentConfigForApp: buildDeploymentConfigForAppMock,
}));

import { POST } from '@/app/api/updates/trigger/route';

const basePolicy = {
  id: 'policy-1',
  user_id: 'user-1',
  tenant_id: 'tenant-a',
  winget_id: 'Microsoft.Edge',
  policy_type: 'notify',
  is_enabled: true,
  deployment_config: { displayName: 'Edge' },
};

const baseUpdateResult = {
  id: 'update-1',
  user_id: 'user-1',
  tenant_id: 'tenant-a',
  winget_id: 'Microsoft.Edge',
  intune_app_id: 'app-1',
  display_name: 'Edge',
  current_version: '1.0.0',
  latest_version: '1.1.0',
};

function makeRequest(payload: unknown) {
  const request = new NextRequest('http://localhost:3000/api/updates/trigger', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return request;
}

describe('SQLite mode: POST /api/updates/trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'home-tenant',
      userName: 'User',
    });
  });

  it('triggers an update for an app with an existing policy, using skipRateLimits', async () => {
    getOneMock.mockResolvedValue(baseUpdateResult);
    getByAppMock.mockResolvedValue({ ...basePolicy });
    triggerAutoUpdateMock.mockResolvedValue({ success: true, packagingJobId: 'job-1' });

    const response = await POST(makeRequest({ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a' }));
    const body = await response.json();

    expect(body).toEqual({
      success: true,
      triggered: 1,
      failed: 0,
      results: [{ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a', success: true, packaging_job_id: 'job-1' }],
    });
    expect(triggerAutoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ policy_type: 'auto_update', is_enabled: true }),
      expect.objectContaining({ wingetId: 'Microsoft.Edge', currentVersion: '1.0.0', latestVersion: '1.1.0' }),
      { skipRateLimits: true, skipPriorDeploymentCheck: true }
    );
    // Manual trigger must not permanently flip a pre-existing 'notify' policy
    expect(updateMock).toHaveBeenCalledWith('policy-1', 'user-1', { policy_type: 'auto_update', is_enabled: true });
    expect(updateMock).toHaveBeenCalledWith('policy-1', 'user-1', { policy_type: 'notify' });
  });

  it('builds a deployment config and creates a policy when none exists', async () => {
    getOneMock.mockResolvedValue(baseUpdateResult);
    getByAppMock.mockResolvedValue(null);
    buildDeploymentConfigForAppMock.mockResolvedValue({
      status: 'ok',
      deploymentConfig: { displayName: 'Edge' },
      originalUploadHistoryId: 'upload-1',
    });
    upsertMock.mockResolvedValue({ policy: { ...basePolicy }, created: true });
    triggerAutoUpdateMock.mockResolvedValue({ success: true, packagingJobId: 'job-2' });

    const response = await POST(makeRequest({ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a' }));
    const body = await response.json();

    expect(body.triggered).toBe(1);
    expect(upsertMock).toHaveBeenCalledWith('user-1', expect.objectContaining({
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a', policy_type: 'notify',
    }));
  });

  it('rejects self-updating apps without calling the trigger', async () => {
    const response = await POST(makeRequest({ winget_id: 'microsoft.office', tenant_id: 'tenant-a' }));
    const body = await response.json();

    expect(body.failed).toBe(1);
    expect(body.results[0].success).toBe(false);
    expect(getOneMock).not.toHaveBeenCalled();
  });

  it('reports failure when the update check result is missing', async () => {
    getOneMock.mockResolvedValue(null);
    const response = await POST(makeRequest({ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a' }));
    const body = await response.json();

    expect(body.failed).toBe(1);
    expect(body.results[0].error).toBe('Update not found');
  });

  it('still requires auth in SQLite mode', async () => {
    parseAccessTokenMock.mockResolvedValue(null);
    const response = await POST(makeRequest({ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a' }));

    expect(response.status).toBe(401);
    expect(getOneMock).not.toHaveBeenCalled();
  });
});
