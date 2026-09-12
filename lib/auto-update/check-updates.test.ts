import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('runUpdateCheck', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-check-updates-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('../db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('writes an update_check_results row when a deployed app has a newer catalog version', async () => {
    const { sqliteDb } = await import('../db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: '7zip.7zip', version: '22.0',
      display_name: '7-Zip', intune_app_id: 'intune-1', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/catalog', () => ({
      getCatalogSource: () => ({
        getAllLatestVersions: async () => [{ winget_id: '7zip.7zip', latest_version: '23.0' }],
      }),
    }));

    const { runUpdateCheck } = await import('./check-updates');
    const result = await runUpdateCheck();

    expect(result.updatesFound).toBe(1);

    const { sqliteUpdateChecks } = await import('../db/sqlite');
    const row = await sqliteUpdateChecks.getOne('user-1', 'tenant-1', '7zip.7zip');
    expect(row?.latest_version).toBe('23.0');
    expect(row?.current_version).toBe('22.0');
  });

  it('skips an app with an ignore policy', async () => {
    const { sqliteDb, sqliteUpdatePolicies } = await import('../db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'VideoLAN.VLC', version: '3.0.22',
      display_name: 'VLC', intune_app_id: 'intune-2', intune_tenant_id: 'tenant-1',
    });
    await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'VideoLAN.VLC', tenant_id: 'tenant-1', policy_type: 'ignore',
    });

    vi.doMock('@/lib/catalog', () => ({
      getCatalogSource: () => ({
        getAllLatestVersions: async () => [{ winget_id: 'VideoLAN.VLC', latest_version: '3.0.23' }],
      }),
    }));

    const { runUpdateCheck } = await import('./check-updates');
    const result = await runUpdateCheck();

    expect(result.updatesFound).toBe(0);
  });
});
