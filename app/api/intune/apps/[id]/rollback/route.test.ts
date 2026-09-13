import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('POST /api/intune/apps/[id]/rollback', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-rollback-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1' }),
    }));
    // Route fetches current live assignments/categories via Graph before
    // upserting the rollback policy (see task-8 brief note on the
    // assignments/categories gap) - stub the service-principal token the
    // same way edit/route.test.ts does.
    vi.doMock('@/lib/intune/graph-client', () => ({
      getServicePrincipalToken: async () => 'fake-graph-token',
    }));
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    // getDatabase() (lib/db/index.ts) loads lib/db/sqlite.ts via a plain
    // Node require(), which is cached outside Vitest's per-test module
    // registry - vi.resetModules() alone leaves its stale db handle (and
    // adapter singleton) pointing at the previous test's tmp file. Reset
    // both here so the next test's getDatabase() call re-opens fresh.
    const { resetDatabaseInstance } = await import('@/lib/db');
    resetDatabaseInstance();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('404s when the app has no upload_history row', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://x/api/intune/apps/unknown/rollback', {
        method: 'POST',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId: 'job-1' }),
      }),
      { params: Promise.resolve({ id: 'unknown' }) }
    );
    expect(response.status).toBe(404);
  });

  it('400s when packagingJobId belongs to a different winget_id', async () => {
    const { sqliteDb } = await import('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.2.0.39747',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });
    // Job lookups in the route go through getDatabase() (lib/db), a
    // separate module instance from the sqliteDb import above (see
    // lib/db/index.ts's require('./sqlite.ts')) - create the job the same
    // way the route reads it back.
    const { getDatabase } = await import('@/lib/db');
    const otherJob = await getDatabase().jobs.create({
      user_id: 'user-1', winget_id: 'Microsoft.PowerToys', version: '0.101.0',
      display_name: 'PowerToys', publisher: 'Microsoft', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://x/pt.exe',
      install_command: 'x', uninstall_command: 'x', install_scope: 'machine', status: 'deployed',
    });

    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://x/api/intune/apps/app-abc/rollback', {
        method: 'POST',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId: otherJob.id }),
      }),
      { params: Promise.resolve({ id: 'app-abc' }) }
    );
    expect(response.status).toBe(400);
  });

  it('dispatches a rollback to the older packaging_jobs row', async () => {
    const { sqliteDb } = await import('@/lib/db/sqlite');
    const { getDatabase } = await import('@/lib/db');
    const oldJob = await getDatabase().jobs.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', publisher: 'Foxit', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://x/foxit-old.exe',
      install_command: 'old.exe /S', uninstall_command: 'olduninst.exe /S',
      install_scope: 'machine', status: 'deployed',
    });
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.2.0.39747',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/auto-update/trigger-sqlite', () => ({
      AutoUpdateTriggerSqlite: class {
        async triggerAutoUpdate() {
          return { success: true, packagingJobId: 'rollback-job-id' };
        }
      },
    }));
    vi.doMock('@/lib/intune-api', () => ({
      getAppAssignments: vi.fn().mockResolvedValue([]),
      getAppCategories: vi.fn().mockResolvedValue([]),
    }));

    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://x/api/intune/apps/app-abc/rollback', {
        method: 'POST',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId: oldJob.id }),
      }),
      { params: Promise.resolve({ id: 'app-abc' }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.packagingJobId).toBe('rollback-job-id');
  });
});
