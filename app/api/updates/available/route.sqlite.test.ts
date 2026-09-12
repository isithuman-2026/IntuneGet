import { NextRequest } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs';

const { parseAccessTokenMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

describe('SQLite mode: GET/PATCH /api/updates/available', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-available-sqlite-${Date.now()}-${Math.random()}.db`);
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
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    delete process.env.DATABASE_PATH;
  });

  it('GET returns updates joined with policy info, filtering Unknown/non-newer/dismissed', async () => {
    const { sqliteUpdateChecks, sqliteUpdatePolicies } = await import('@/lib/db/sqlite');
    const now = new Date().toISOString();
    await sqliteUpdateChecks.upsertMany([
      {
        user_id: 'user-1', tenant_id: 'tenant-a', winget_id: 'Microsoft.Edge',
        intune_app_id: 'app-1', display_name: 'Edge', current_version: '1.0.0',
        latest_version: '1.1.0', is_critical: true, is_managed: true,
        notified_at: null, detected_at: now, updated_at: now,
      },
      {
        // Unknown current_version must be excluded
        user_id: 'user-1', tenant_id: 'tenant-a', winget_id: 'VideoLAN.VLC',
        intune_app_id: 'app-2', display_name: 'VLC', current_version: 'Unknown',
        latest_version: '3.0.0', is_critical: false, is_managed: true,
        notified_at: null, detected_at: now, updated_at: now,
      },
    ]);
    await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'Microsoft.Edge', tenant_id: 'tenant-a', policy_type: 'notify',
    });

    const { GET } = await import('@/app/api/updates/available/route');
    const request = new NextRequest('http://localhost:3000/api/updates/available?tenant_id=tenant-a');
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.criticalCount).toBe(1);
    expect(body.updates[0].winget_id).toBe('Microsoft.Edge');
    expect(body.updates[0].policy?.policy_type).toBe('notify');
  });

  it('PATCH dismisses updates and GET honors include_dismissed', async () => {
    const { sqliteUpdateChecks } = await import('@/lib/db/sqlite');
    const now = new Date().toISOString();
    await sqliteUpdateChecks.upsertMany([{
      user_id: 'user-1', tenant_id: 'tenant-a', winget_id: 'Microsoft.Edge',
      intune_app_id: 'app-1', display_name: 'Edge', current_version: '1.0.0',
      latest_version: '1.1.0', is_critical: false, is_managed: true,
      notified_at: null, detected_at: now, updated_at: now,
    }]);
    const [row] = await sqliteUpdateChecks.listByUser('user-1');

    const { PATCH, GET } = await import('@/app/api/updates/available/route');
    const patchRequest = new NextRequest('http://localhost:3000/api/updates/available', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_ids: [row.id], action: 'dismiss' }),
    });
    const patchResponse = await PATCH(patchRequest);
    const patchBody = await patchResponse.json();

    expect(patchResponse.status).toBe(200);
    expect(patchBody).toEqual({ success: true, updated: 1, action: 'dismiss' });

    const defaultReq = new NextRequest('http://localhost:3000/api/updates/available');
    defaultReq.headers.set('Authorization', 'Bearer test-token');
    const defaultBody = await (await GET(defaultReq)).json();
    expect(defaultBody.count).toBe(0);

    const includeDismissedReq = new NextRequest('http://localhost:3000/api/updates/available?include_dismissed=true');
    includeDismissedReq.headers.set('Authorization', 'Bearer test-token');
    const includeDismissedBody = await (await GET(includeDismissedReq)).json();
    expect(includeDismissedBody.count).toBe(1);
  });
});
