import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

describe('sqlite update-detection schema', () => {
  let tmpDbPath: string;

  beforeEach(async () => {
    tmpDbPath = path.join(os.tmpdir(), `test-updates-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
  });

  afterEach(async () => {
    const { closeSqliteDb } = await import('../sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
  });

  it('creates all four update-related tables on first access', async () => {
    // Import after setting DATABASE_PATH
    const { sqliteDb } = await import('../sqlite');

    // Any call that internally calls getDb() triggers initializeSchema()
    await sqliteDb.jobs.getStats();

    const db = new Database(tmpDbPath, { readonly: true });
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);

    expect(tableNames).toContain('update_check_results');
    expect(tableNames).toContain('app_update_policies');
    expect(tableNames).toContain('auto_update_history');
    expect(tableNames).toContain('notification_preferences');

    db.close();
  });

  it('sqliteUpdatePolicies upsert then getByApp round-trips', async () => {
    const { sqliteUpdatePolicies } = await import('../sqlite');
    const { policy, created } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'VideoLAN.VLC',
      tenant_id: 'tenant-1',
      policy_type: 'notify',
    });
    expect(created).toBe(true);
    expect(policy.policy_type).toBe('notify');

    const found = await sqliteUpdatePolicies.getByApp('user-1', 'tenant-1', 'VideoLAN.VLC');
    expect(found?.id).toBe(policy.id);

    const { policy: updated, created: createdAgain } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: 'VideoLAN.VLC',
      tenant_id: 'tenant-1',
      policy_type: 'auto_update',
      deployment_config: { displayName: 'VLC', publisher: 'VideoLAN', architecture: 'x64', installerType: 'wix', installCommand: 'x', uninstallCommand: 'x', installScope: 'machine', detectionRules: [] },
    });
    expect(createdAgain).toBe(false);
    expect(updated.id).toBe(policy.id);
    expect(updated.policy_type).toBe('auto_update');
  });

  it('sqliteUpdateChecks upsertMany then listByUser round-trips and deleteStale removes stale rows', async () => {
    const { sqliteUpdateChecks } = await import('../sqlite');
    const now = new Date().toISOString();
    await sqliteUpdateChecks.upsertMany([{
      user_id: 'user-1', tenant_id: 'tenant-1', winget_id: 'VideoLAN.VLC',
      intune_app_id: 'app-1', display_name: 'VLC', current_version: '3.0.22',
      latest_version: '3.0.23', is_critical: false, is_managed: true,
      notified_at: null, detected_at: now, updated_at: now,
    }]);

    const list = await sqliteUpdateChecks.listByUser('user-1');
    expect(list).toHaveLength(1);
    expect(list[0].latest_version).toBe('3.0.23');

    const removed = await sqliteUpdateChecks.deleteStale('user-1', new Set());
    expect(removed).toBe(1);
    expect(await sqliteUpdateChecks.listByUser('user-1')).toHaveLength(0);
  });

  it('sqliteAutoUpdateHistory create/updateStatus/countSince', async () => {
    const { sqliteUpdatePolicies, sqliteAutoUpdateHistory } = await import('../sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-2', {
      winget_id: '7zip.7zip', tenant_id: 'tenant-2', policy_type: 'auto_update',
    });
    const { id } = await sqliteAutoUpdateHistory.create(policy.id, '22.0', '23.0', 'minor');
    await sqliteAutoUpdateHistory.updateStatus(id, 'completed', { completedAt: new Date().toISOString() });

    const count = await sqliteAutoUpdateHistory.countSince([policy.id], new Date(Date.now() - 3600_000).toISOString());
    expect(count).toBe(1);

    const recent = await sqliteAutoUpdateHistory.hasRecentForPolicy(policy.id, new Date(Date.now() - 3600_000).toISOString());
    expect(recent).toBe(true);
  });

  it('sqliteAutoUpdateHistory listByUser joins policy + packaging job and applies filters', async () => {
    const { sqliteUpdatePolicies, sqliteAutoUpdateHistory, sqliteDb } = await import('../sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-4', {
      winget_id: 'Notepad++.Notepad++', tenant_id: 'tenant-4', policy_type: 'auto_update',
    });
    const otherUserPolicy = await sqliteUpdatePolicies.upsert('user-5', {
      winget_id: 'Other.App', tenant_id: 'tenant-4', policy_type: 'auto_update',
    });

    const job = await sqliteDb.jobs.create({
      user_id: 'user-4', winget_id: 'Notepad++.Notepad++', version: '8.7', display_name: 'Notepad++',
      installer_type: 'exe', installer_url: 'https://x', install_command: 'x', uninstall_command: 'x',
      install_scope: 'machine', status: 'deployed',
    });

    const { id } = await sqliteAutoUpdateHistory.create(policy.id, '8.6', '8.7', 'minor');
    await sqliteAutoUpdateHistory.updateStatus(id, 'completed', { packagingJobId: job.id, completedAt: new Date().toISOString() });
    await sqliteAutoUpdateHistory.create(otherUserPolicy.policy.id, '1.0', '1.1', 'patch');

    const list = await sqliteAutoUpdateHistory.listByUser('user-4', { limit: 10, offset: 0 });
    expect(list).toHaveLength(1);
    expect(list[0].policy).toEqual({ winget_id: 'Notepad++.Notepad++', tenant_id: 'tenant-4' });
    expect(list[0].display_name).toBe('Notepad++');
    expect(list[0].status).toBe('completed');

    expect(await sqliteAutoUpdateHistory.listByUser('user-4', { status: 'pending', limit: 10, offset: 0 })).toHaveLength(0);
    expect(await sqliteAutoUpdateHistory.listByUser('user-4', { wingetId: 'Other.App', limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('sqliteNotificationPreferences get returns null then upsert creates defaults-merged row', async () => {
    const { sqliteNotificationPreferences } = await import('../sqlite');
    expect(await sqliteNotificationPreferences.get('user-3')).toBeNull();

    const created = await sqliteNotificationPreferences.upsert('user-3', { email_enabled: true, notify_on_deployed: false });
    expect(created.email_enabled).toBe(true);
    expect(created.notify_on_deployed).toBe(false);
    expect(created.notify_on_error).toBe(true); // default preserved

    const fetched = await sqliteNotificationPreferences.get('user-3');
    expect(fetched?.email_enabled).toBe(true);
  });
});
