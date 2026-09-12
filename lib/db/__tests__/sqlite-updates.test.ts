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
});
