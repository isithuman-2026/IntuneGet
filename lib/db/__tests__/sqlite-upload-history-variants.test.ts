import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('sqliteUploadHistory.listAppIdsForWinget', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-uh-variants-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('../sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
  });

  it('only returns copies of the same user, architecture and install scope', async () => {
    const { sqliteDb, sqliteUploadHistory } = await import('../sqlite');
    const deploy = async (appId: string, user: string, arch: string, scope: string) => {
      const job = await sqliteDb.jobs.create({
        user_id: user, winget_id: 'Contoso.App', version: '1.0', display_name: 'App', publisher: 'C',
        architecture: arch, installer_type: 'exe', installer_url: 'https://x', install_scope: scope, status: 'deployed',
      });
      await sqliteDb.uploadHistory.create({
        user_id: user, winget_id: 'Contoso.App', version: '1.0', display_name: 'App',
        intune_app_id: appId, intune_tenant_id: 't1', packaging_job_id: job.id,
      });
    };
    await deploy('x64-machine', 'u1', 'x64', 'machine');
    await deploy('arm64-machine', 'u1', 'arm64', 'machine');
    await deploy('x64-user', 'u1', 'x64', 'user');
    await deploy('other-user', 'u2', 'x64', 'machine');

    const ids = await sqliteUploadHistory.listAppIdsForWinget('t1', 'Contoso.App', {
      userId: 'u1', architecture: 'x64', installScope: 'machine',
    });
    expect(ids).toEqual(['x64-machine']);
  });
});
