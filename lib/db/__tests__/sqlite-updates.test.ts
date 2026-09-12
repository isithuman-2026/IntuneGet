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
});
