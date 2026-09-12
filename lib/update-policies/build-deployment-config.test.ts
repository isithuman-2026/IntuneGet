import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('buildDeploymentConfigForApp (SQLite mode)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-build-config-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('../db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
  });

  it('returns status "ok" built from a prior packaging job', async () => {
    const { sqliteDb } = await import('../db/sqlite');
    const job = await sqliteDb.jobs.create({
      user_id: 'user-1', winget_id: '7zip.7zip', version: '22.0',
      display_name: '7-Zip', publisher: '7-Zip', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://example.com/x.exe',
      install_command: 'x.exe /S', uninstall_command: 'uninst.exe /S',
      install_scope: 'machine', status: 'deployed',
    });
    await sqliteDb.uploadHistory.create({
      packaging_job_id: job.id, user_id: 'user-1', winget_id: '7zip.7zip',
      version: '22.0', display_name: '7-Zip', intune_app_id: 'intune-1',
      intune_tenant_id: 'tenant-1',
    });

    const { buildDeploymentConfigForApp } = await import('./build-deployment-config');
    const result = await buildDeploymentConfigForApp({
      userId: 'user-1', tenantId: 'tenant-1', wingetId: '7zip.7zip', latestVersion: '23.0',
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.deploymentConfig.displayName).toBe('7-Zip');
      expect(result.originalUploadHistoryId).toBeTruthy();
    }
  });
});
