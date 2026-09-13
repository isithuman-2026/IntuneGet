import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('GET /api/intune/apps/[intuneAppId]/versions', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-versions-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1' }),
    }));
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
  });

  it('lists prior deployed versions for the app, newest first', async () => {
    const { sqliteDb } = await import('@/lib/db/sqlite');
    const jobOld = await sqliteDb.jobs.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', publisher: 'Foxit', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://x/old.exe',
      install_command: 'x', uninstall_command: 'x', install_scope: 'machine', status: 'deployed',
    });
    await sqliteDb.jobs.update(jobOld.id, { completed_at: '2026-08-30T08:55:27.869Z' });
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.2.0.39747',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    const { GET } = await import('./route');
    const response = await GET(
      new Request('http://x/api/intune/apps/app-abc/versions', { headers: { Authorization: 'Bearer x' } }),
      { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].version).toBe('2026.1.3.36551');
  });
});
