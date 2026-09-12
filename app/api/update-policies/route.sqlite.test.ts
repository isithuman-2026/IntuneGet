import { NextRequest } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs';

const { parseAccessTokenMock, getAppForInstallerMock, getCatalogSourceMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  getAppForInstallerMock: vi.fn(),
  getCatalogSourceMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/catalog', () => ({
  getCatalogSource: getCatalogSourceMock,
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/update-policies', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('SQLite mode: GET/POST /api/update-policies', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-policies-sqlite-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'home-tenant',
      userName: 'User',
    });
    getAppForInstallerMock.mockResolvedValue(null);
    getCatalogSourceMock.mockReturnValue({
      getAppForInstaller: getAppForInstallerMock,
      getAppNamePublisher: vi.fn(async () => null),
      getVersionInstallerInfo: vi.fn(async () => null),
    });
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    delete process.env.DATABASE_PATH;
  });

  it('GET lists policies for the user, filtered by tenant', async () => {
    const { sqliteUpdatePolicies } = await import('@/lib/db/sqlite');
    await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a', policy_type: 'notify',
    });
    await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'VideoLAN.VLC', tenant_id: 'tenant-b', policy_type: 'ignore',
    });

    const { GET } = await import('@/app/api/update-policies/route');
    const request = new NextRequest('http://localhost:3000/api/update-policies?tenant_id=tenant-a');
    request.headers.set('Authorization', 'Bearer test-token');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.policies[0].winget_id).toBe('Microsoft.Edge');
  });

  it('POST derives pinned_version from the current update-check row', async () => {
    const { sqliteUpdateChecks } = await import('@/lib/db/sqlite');
    const now = new Date().toISOString();
    await sqliteUpdateChecks.upsertMany([{
      user_id: 'user-1', tenant_id: 'tenant-1', winget_id: 'Microsoft.Edge',
      intune_app_id: 'app-1', display_name: 'Edge', current_version: '1.2.3',
      latest_version: '1.3.0', is_critical: false, is_managed: true,
      notified_at: null, detected_at: now, updated_at: now,
    }]);

    const { POST } = await import('@/app/api/update-policies/route');
    const response = await POST(makeRequest({
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1', policy_type: 'pin_version',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.created).toBe(true);
    expect(body.policy.pinned_version).toBe('1.2.3');
  });

  it('POST returns 400 for pin_version when no version can be derived', async () => {
    const { POST } = await import('@/app/api/update-policies/route');
    const response = await POST(makeRequest({
      winget_id: 'Missing.App', tenant_id: 'tenant-1', policy_type: 'pin_version',
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('pinned_version');
  });

  it('POST stores an auto_update policy with a client-supplied deployment_config', async () => {
    const deploymentConfig = {
      displayName: 'Microsoft Edge', publisher: 'Microsoft', architecture: 'x64',
      installerType: 'exe', installCommand: 'setup.exe /silent', uninstallCommand: 'setup.exe /uninstall',
      installScope: 'system', detectionRules: [],
    };
    const { POST } = await import('@/app/api/update-policies/route');
    const response = await POST(makeRequest({
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1', policy_type: 'auto_update', deployment_config: deploymentConfig,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.created).toBe(true);
    expect(body.policy.deployment_config.displayName).toBe('Microsoft Edge');
  });

  it('POST returns 400 for auto_update with no prior deployment and not in catalog', async () => {
    const { POST } = await import('@/app/api/update-policies/route');
    const response = await POST(makeRequest({
      winget_id: 'Not.InCatalog', tenant_id: 'tenant-1', policy_type: 'auto_update',
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Auto-update requires');
  });

  it('POST creates an ignore policy with just the policy type', async () => {
    const { POST } = await import('@/app/api/update-policies/route');
    const response = await POST(makeRequest({
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1', policy_type: 'ignore',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.created).toBe(true);
    expect(body.policy.policy_type).toBe('ignore');
    expect(body.policy.pinned_version).toBeNull();
  });
});
