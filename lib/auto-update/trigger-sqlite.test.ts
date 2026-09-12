import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('AutoUpdateTriggerSqlite', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-trigger-sqlite-${Date.now()}.db`);
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

  it('skips when policy.policy_type is not auto_update', async () => {
    const { sqliteUpdatePolicies } = await import('../db/sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: '7zip.7zip', tenant_id: 'tenant-1', policy_type: 'notify',
    });

    const { AutoUpdateTriggerSqlite } = await import('./trigger-sqlite');
    const trigger = new AutoUpdateTriggerSqlite();
    const result = await trigger.triggerAutoUpdate(policy, {
      wingetId: '7zip.7zip', currentVersion: '22.0', latestVersion: '23.0',
      displayName: '7-Zip', installerUrl: 'https://x', installerSha256: 'a'.repeat(64), installerType: 'exe',
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it('enforces the per-policy cooldown from auto_update_history', async () => {
    const { sqliteUpdatePolicies, sqliteAutoUpdateHistory } = await import('../db/sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: '7zip.7zip', tenant_id: 'tenant-1', policy_type: 'auto_update',
      original_upload_history_id: 'some-id',
      deployment_config: { displayName: '7-Zip', publisher: '7-Zip', architecture: 'x64', installerType: 'exe', installCommand: 'x', uninstallCommand: 'x', installScope: 'machine', detectionRules: [] },
    });
    await sqliteAutoUpdateHistory.create(policy.id, '21.0', '22.0', 'minor');

    const { AutoUpdateTriggerSqlite } = await import('./trigger-sqlite');
    const trigger = new AutoUpdateTriggerSqlite();
    const result = await trigger.triggerAutoUpdate(policy, {
      wingetId: '7zip.7zip', currentVersion: '22.0', latestVersion: '23.0',
      displayName: '7-Zip', installerUrl: 'https://x', installerSha256: 'a'.repeat(64), installerType: 'exe',
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/cooldown/i);
  });

  it('creates a packaging job and dispatches the workflow on success', async () => {
    // Consent check acquires a real Graph token outside tests; stub it so the
    // safety checks pass through to the packaging path under test.
    vi.doMock('@/lib/intune/graph-client', () => ({
      getServicePrincipalToken: vi.fn().mockResolvedValue('fake-token'),
    }));
    vi.doMock('@/lib/github-actions', () => ({
      isGitHubActionsConfigured: () => false, // skip the real dispatch, job stays queued for local pickup
      triggerPackagingWorkflow: vi.fn(),
    }));
    vi.doMock('./trigger', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./trigger')>();
      return {
        ...actual,
        getLatestInstallerInfo: vi.fn().mockResolvedValue({
          ok: true,
          info: { wingetId: '7zip.7zip', latestVersion: '23.0', displayName: '7-Zip', installerUrl: 'https://x', installerSha256: 'a'.repeat(64), installerType: 'exe' },
        }),
      };
    });

    const { sqliteDb, sqliteUpdatePolicies } = await import('../db/sqlite');
    const job = await sqliteDb.jobs.create({
      user_id: 'user-1', winget_id: '7zip.7zip', version: '22.0', display_name: '7-Zip',
      installer_type: 'exe', installer_url: 'https://x', install_command: 'x', uninstall_command: 'x',
      install_scope: 'machine', status: 'deployed',
    });
    await sqliteDb.uploadHistory.create({
      packaging_job_id: job.id, user_id: 'user-1', winget_id: '7zip.7zip', version: '22.0',
      display_name: '7-Zip', intune_app_id: 'intune-1', intune_tenant_id: 'tenant-1',
    });
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: '7zip.7zip', tenant_id: 'tenant-1', policy_type: 'auto_update',
      original_upload_history_id: job.id,
      deployment_config: { displayName: '7-Zip', publisher: '7-Zip', architecture: 'x64', installerType: 'exe', installCommand: 'x', uninstallCommand: 'x', installScope: 'machine', detectionRules: [] },
    });

    const { AutoUpdateTriggerSqlite } = await import('./trigger-sqlite');
    const trigger = new AutoUpdateTriggerSqlite();
    const result = await trigger.triggerAutoUpdate(policy, {
      wingetId: '7zip.7zip', currentVersion: '22.0', latestVersion: '23.0',
      displayName: '7-Zip', installerUrl: 'https://x', installerSha256: 'a'.repeat(64), installerType: 'exe',
    });

    expect(result.success).toBe(true);
    expect(result.packagingJobId).toBeTruthy();
  });
});
