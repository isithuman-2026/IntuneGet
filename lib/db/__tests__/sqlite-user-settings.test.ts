import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { DEFAULT_USER_SETTINGS } from '@/types/user-settings';

// Import will fail until we add the exports, which is the point of the failing test
let sqliteUserSettings: any;
let sqliteDb: any;
let closeSqliteDb: any;

describe('sqliteUserSettings', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-user-settings-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
  });

  afterEach(() => {
    if (closeSqliteDb) closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
  });

  it('creates the user_settings table on first access', async () => {
    // Dynamic import to work around module not found initially
    const mod = await import('../sqlite');
    sqliteDb = mod.sqliteDb;
    closeSqliteDb = mod.closeSqliteDb;

    await sqliteDb.jobs.getStats();

    const db = new Database(tmpDbPath, { readonly: true });
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tableNames).toContain('user_settings');
    db.close();
  });

  it('get returns null when no row exists', async () => {
    const mod = await import('../sqlite');
    sqliteUserSettings = mod.sqliteUserSettings;
    closeSqliteDb = mod.closeSqliteDb;

    expect(await sqliteUserSettings.get('user-1')).toBeNull();
  });

  it('upsert creates a row merged over DEFAULT_USER_SETTINGS, then merges again over the stored row', async () => {
    const mod = await import('../sqlite');
    sqliteUserSettings = mod.sqliteUserSettings;
    closeSqliteDb = mod.closeSqliteDb;

    const first = await sqliteUserSettings.upsert('user-2', { carryOverAssignments: true });
    expect(first.carryOverAssignments).toBe(true);
    expect(first.supersedePreviousApp).toBe(DEFAULT_USER_SETTINGS.supersedePreviousApp);
    expect(first.theme).toBe(DEFAULT_USER_SETTINGS.theme);

    const second = await sqliteUserSettings.upsert('user-2', { supersedePreviousApp: true });
    expect(second.carryOverAssignments).toBe(true); // preserved from first upsert
    expect(second.supersedePreviousApp).toBe(true);

    const fetched = await sqliteUserSettings.get('user-2');
    expect(fetched?.carryOverAssignments).toBe(true);
    expect(fetched?.supersedePreviousApp).toBe(true);
  });
});
