import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('GET /api/intune/apps/[id]', () => {
  let tmpDbPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-app-details-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1' }),
    }));
    vi.doMock('@/lib/intune/graph-client', () => ({
      getServicePrincipalToken: async () => 'fake-graph-token',
    }));

    fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/assignments')) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: 'app-abc', displayName: 'Foxit PDF Reader' }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns hasUploadHistory: false and policy: null for an app with no upload_history row', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      new Request('http://x/api/intune/apps/unknown-app'),
      { params: Promise.resolve({ id: 'unknown-app' }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hasUploadHistory).toBe(false);
    expect(body.policy).toBe(null);
  });

  it('returns the real current policy_type/delay_days for an app with an existing auto_update policy', async () => {
    const { sqliteDb, sqliteUpdatePolicies } = await import('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });
    await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'Foxit.FoxitReader',
      tenant_id: 'tenant-1',
      policy_type: 'auto_update',
      delay_days: 5,
    });

    const { GET } = await import('./route');
    const response = await GET(
      new Request('http://x/api/intune/apps/app-abc'),
      { params: Promise.resolve({ id: 'app-abc' }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hasUploadHistory).toBe(true);
    expect(body.policy).toEqual({ policyType: 'auto_update', delayDays: 5 });
  });

  it('defaults policy to notify/0 when upload history exists but no policy row has been created yet', async () => {
    const { sqliteDb } = await import('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    const { GET } = await import('./route');
    const response = await GET(
      new Request('http://x/api/intune/apps/app-abc'),
      { params: Promise.resolve({ id: 'app-abc' }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hasUploadHistory).toBe(true);
    expect(body.policy).toEqual({ policyType: 'notify', delayDays: 0 });
  });
});
