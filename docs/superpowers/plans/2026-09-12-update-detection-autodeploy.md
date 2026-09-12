# Update Detection + Auto-Deploy (SQLite Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make update detection, per-app auto-update policies, and the notification pipeline work end-to-end in SQLite self-hosted mode, with zero manual action once a policy is set to auto-update.

**Architecture:** Standalone SQLite modules in `lib/db/sqlite.ts` (matching the `sqliteWebhooks`/`sqliteClaims` pattern already in this file), each existing Supabase-only route gets an `isSqliteMode()` branch that calls the new module instead, a pure `runUpdateCheck()` function is extracted from the cron route so both the route and a new in-process scheduler call the same logic, and a SQLite-backed sibling to `AutoUpdateTrigger` handles the actual auto-deploy with the QA device-fleet gate skipped and MSP-only checks removed.

**Tech Stack:** Next.js 16 (App Router, standalone output), TypeScript, `better-sqlite3`, existing `getServicePrincipalToken`/`triggerPackagingWorkflow`/`getCatalogSource` (already dual-mode or SQLite-native).

**Spec:** `docs/superpowers/specs/2026-09-12-update-detection-autodeploy-design.md`

## Global Constraints

- Every new/modified route: the Supabase code path is left completely untouched — only add an `isSqliteMode()` branch before it, mirroring `app/api/webhooks/route.ts` and `app/api/intune/claim/route.ts` from this session's earlier fixes.
- No `DatabaseAdapter` interface changes — new SQLite modules are standalone exports from `lib/db/sqlite.ts`, imported directly where needed (per the spec's explicit choice).
- No new npm dependencies (plain `setInterval`, per the spec).
- MSP/multi-tenant lookups (`msp_managed_tenants`, `resolveTargetTenantId`'s cross-tenant branch) are never called in the SQLite branches — use `user.tenantId` directly, single-tenant.
- The QA device-fleet gate (`ensureQaDemand`, `lib/qa/demand.ts`) is never called from the SQLite auto-deploy path.
- All new SQLite tables use `TEXT` timestamps (`datetime('now')`) and `INTEGER` booleans (0/1), matching every existing table in `lib/db/sqlite.ts`.

---

## Task 1: SQLite schema — four new tables

**Files:**
- Modify: `lib/db/sqlite.ts` (the `initializeSchema()` function, after the existing `claimed_apps` block)
- Test: `lib/db/sqlite-updates.test.ts` (new)

**Interfaces:**
- Produces: four new tables — `update_check_results`, `app_update_policies`, `auto_update_history`, `notification_preferences` — queryable via a raw `better-sqlite3` connection obtained through the file's existing (unexported) `getDb()`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/db/sqlite-updates.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('sqlite update-detection schema', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-updates-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
  });

  afterEach(() => {
    const { closeSqliteDb } = require('./sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
  });

  it('creates all four update-related tables on first access', () => {
    const { sqliteDb } = require('./sqlite');
    // Any call that internally calls getDb() triggers initializeSchema()
    sqliteDb.jobs.getStats();

    const Database = require('better-sqlite3');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts`
Expected: FAIL — the four tables don't exist yet.

- [ ] **Step 3: Add the four tables to `initializeSchema()`**

In `lib/db/sqlite.ts`, immediately after the existing `claimed_apps` index block (the one ending `idx_claimed_apps_tenant_discovered`), add:

```typescript
  // Create update_check_results table
  db.exec(`
    CREATE TABLE IF NOT EXISTS update_check_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      intune_app_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      current_version TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      is_critical INTEGER NOT NULL DEFAULT 0,
      is_managed INTEGER NOT NULL DEFAULT 1,
      notified_at TEXT,
      dismissed_at TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tenant_id, winget_id, intune_app_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_update_check_results_user ON update_check_results(user_id, tenant_id);
  `);

  // Create app_update_policies table
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_update_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      policy_type TEXT NOT NULL DEFAULT 'notify',
      pinned_version TEXT,
      deployment_config TEXT,
      original_upload_history_id TEXT,
      delay_days INTEGER NOT NULL DEFAULT 0,
      last_auto_update_at TEXT,
      last_auto_update_version TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tenant_id, winget_id)
    )
  `);

  // Create auto_update_history table
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_update_history (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      packaging_job_id TEXT,
      from_version TEXT NOT NULL,
      to_version TEXT NOT NULL,
      update_type TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auto_update_history_policy ON auto_update_history(policy_id);
  `);

  // Create notification_preferences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      email_enabled INTEGER NOT NULL DEFAULT 0,
      email_frequency TEXT NOT NULL DEFAULT 'daily',
      email_address TEXT,
      notify_critical_only INTEGER NOT NULL DEFAULT 0,
      webhook_enabled INTEGER NOT NULL DEFAULT 1,
      notify_on_update_available INTEGER NOT NULL DEFAULT 1,
      notify_on_deployed INTEGER NOT NULL DEFAULT 1,
      notify_on_error INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/db/sqlite.ts lib/db/sqlite-updates.test.ts
git commit -m "Add SQLite schema for update detection, policies, history, notification prefs"
```

---

## Task 2: `sqliteUpdatePolicies` module (CRUD for `app_update_policies`)

**Files:**
- Modify: `lib/db/sqlite.ts`
- Test: `lib/db/sqlite-updates.test.ts` (extend)

**Interfaces:**
- Consumes: `AppUpdatePolicy`, `AppUpdatePolicyInput`, `UpdatePolicyType` from `types/update-policies.ts` (already defined, unchanged).
- Produces:
  - `sqliteUpdatePolicies.listByUser(userId: string, tenantId?: string): Promise<AppUpdatePolicy[]>`
  - `sqliteUpdatePolicies.getByApp(userId: string, tenantId: string, wingetId: string): Promise<AppUpdatePolicy | null>`
  - `sqliteUpdatePolicies.getById(id: string, userId: string): Promise<AppUpdatePolicy | null>`
  - `sqliteUpdatePolicies.upsert(userId: string, input: AppUpdatePolicyInput & { delay_days?: number }): Promise<{ policy: AppUpdatePolicy; created: boolean }>`
  - `sqliteUpdatePolicies.update(id: string, userId: string, data: Partial<AppUpdatePolicyInput> & { delay_days?: number; is_enabled?: boolean; consecutive_failures?: number }): Promise<AppUpdatePolicy | null>`
  - `sqliteUpdatePolicies.delete(id: string, userId: string): Promise<boolean>`
  - `sqliteUpdatePolicies.incrementFailureCount(id: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to lib/db/sqlite-updates.test.ts
it('sqliteUpdatePolicies upsert then getByApp round-trips', async () => {
  const { sqliteUpdatePolicies } = require('./sqlite');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts -t "upsert then getByApp"`
Expected: FAIL — `sqliteUpdatePolicies` is not exported yet.

- [ ] **Step 3: Implement `sqliteUpdatePolicies`**

In `lib/db/sqlite.ts`, add near the other module-level exports (after `sqliteClaims`):

```typescript
import type { AppUpdatePolicy, AppUpdatePolicyInput } from '@/types/update-policies';

function parseUpdatePolicyRow(row: Record<string, unknown>): AppUpdatePolicy {
  return {
    ...row,
    deployment_config: row.deployment_config ? JSON.parse(row.deployment_config as string) : null,
    is_enabled: Boolean(row.is_enabled),
  } as unknown as AppUpdatePolicy;
}

export const sqliteUpdatePolicies = {
  async listByUser(userId: string, tenantId?: string): Promise<AppUpdatePolicy[]> {
    const database = getDb();
    const rows = tenantId
      ? database.prepare('SELECT * FROM app_update_policies WHERE user_id = ? AND tenant_id = ? ORDER BY updated_at DESC').all(userId, tenantId)
      : database.prepare('SELECT * FROM app_update_policies WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    return (rows as Record<string, unknown>[]).map(parseUpdatePolicyRow);
  },

  async getByApp(userId: string, tenantId: string, wingetId: string): Promise<AppUpdatePolicy | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM app_update_policies WHERE user_id = ? AND tenant_id = ? AND winget_id = ?')
      .get(userId, tenantId, wingetId) as Record<string, unknown> | undefined;
    return row ? parseUpdatePolicyRow(row) : null;
  },

  async getById(id: string, userId: string): Promise<AppUpdatePolicy | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM app_update_policies WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? parseUpdatePolicyRow(row) : null;
  },

  async upsert(
    userId: string,
    input: AppUpdatePolicyInput & { delay_days?: number }
  ): Promise<{ policy: AppUpdatePolicy; created: boolean }> {
    const database = getDb();
    const existing = await this.getByApp(userId, input.tenant_id, input.winget_id);
    const now = new Date().toISOString();

    if (existing) {
      database
        .prepare(`
          UPDATE app_update_policies
          SET policy_type = ?, pinned_version = ?, deployment_config = ?,
              original_upload_history_id = ?, delay_days = ?, is_enabled = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.policy_type,
          input.policy_type === 'pin_version' ? (input.pinned_version || null) : null,
          input.deployment_config ? JSON.stringify(input.deployment_config) : null,
          input.original_upload_history_id || null,
          input.delay_days ?? existing.delay_days ?? 0,
          input.is_enabled ?? true ? 1 : 0,
          now,
          existing.id
        );
      return { policy: (await this.getById(existing.id, userId)) as AppUpdatePolicy, created: false };
    }

    const id = crypto.randomUUID();
    database
      .prepare(`
        INSERT INTO app_update_policies (
          id, user_id, tenant_id, winget_id, policy_type, pinned_version,
          deployment_config, original_upload_history_id, delay_days, is_enabled,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        userId,
        input.tenant_id,
        input.winget_id,
        input.policy_type,
        input.policy_type === 'pin_version' ? (input.pinned_version || null) : null,
        input.deployment_config ? JSON.stringify(input.deployment_config) : null,
        input.original_upload_history_id || null,
        input.delay_days ?? 0,
        input.is_enabled ?? true ? 1 : 0,
        now,
        now
      );
    return { policy: (await this.getById(id, userId)) as AppUpdatePolicy, created: true };
  },

  async update(
    id: string,
    userId: string,
    data: Partial<AppUpdatePolicyInput> & { delay_days?: number; is_enabled?: boolean; consecutive_failures?: number }
  ): Promise<AppUpdatePolicy | null> {
    const database = getDb();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];

    if (data.policy_type !== undefined) { sets.push('policy_type = ?'); values.push(data.policy_type); }
    if (data.pinned_version !== undefined) { sets.push('pinned_version = ?'); values.push(data.pinned_version); }
    if (data.deployment_config !== undefined) { sets.push('deployment_config = ?'); values.push(JSON.stringify(data.deployment_config)); }
    if (data.original_upload_history_id !== undefined) { sets.push('original_upload_history_id = ?'); values.push(data.original_upload_history_id); }
    if (data.delay_days !== undefined) { sets.push('delay_days = ?'); values.push(data.delay_days); }
    if (data.is_enabled !== undefined) {
      sets.push('is_enabled = ?');
      values.push(data.is_enabled ? 1 : 0);
      if (data.is_enabled === true) { sets.push('consecutive_failures = 0'); }
    }

    values.push(id, userId);
    const result = database
      .prepare(`UPDATE app_update_policies SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...values);
    if (result.changes === 0) return null;
    return this.getById(id, userId);
  },

  async delete(id: string, userId: string): Promise<boolean> {
    const database = getDb();
    const result = database
      .prepare('DELETE FROM app_update_policies WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },

  async incrementFailureCount(id: string): Promise<void> {
    const database = getDb();
    database
      .prepare('UPDATE app_update_policies SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add lib/db/sqlite.ts lib/db/sqlite-updates.test.ts
git commit -m "Add sqliteUpdatePolicies CRUD module"
```

---

## Task 3: `sqliteUpdateChecks` and `sqliteAutoUpdateHistory` modules

**Files:**
- Modify: `lib/db/sqlite.ts`
- Test: `lib/db/sqlite-updates.test.ts` (extend)

**Interfaces:**
- Produces:
  - `sqliteUpdateChecks.listByUser(userId: string, opts?: { tenantId?: string; includeDismissed?: boolean; criticalOnly?: boolean }): Promise<UpdateCheckRow[]>`
  - `sqliteUpdateChecks.upsertMany(rows: UpdateCheckInsert[]): Promise<void>`
  - `sqliteUpdateChecks.deleteStale(userId: string, activeKeys: Set<string>): Promise<number>` — deletes rows for this user whose `winget_id:intune_app_id` isn't in `activeKeys`
  - `sqliteUpdateChecks.deleteOlderThan(cutoffIso: string): Promise<number>`
  - `sqliteUpdateChecks.getOne(userId: string, tenantId: string, wingetId: string): Promise<UpdateCheckRow | null>`
  - `sqliteUpdateChecks.dismiss(userId: string, ids: string[], dismissed: boolean): Promise<number>`
  - `sqliteAutoUpdateHistory.create(policyId: string, fromVersion: string, toVersion: string, updateType: string): Promise<{ id: string }>`
  - `sqliteAutoUpdateHistory.updateStatus(id: string, status: string, extra?: { packagingJobId?: string; errorMessage?: string; completedAt?: string }): Promise<void>`
  - `sqliteAutoUpdateHistory.countSince(policyIds: string[], sinceIso: string, statusFilter?: string): Promise<number>`
  - `sqliteAutoUpdateHistory.hasRecentForPolicy(policyId: string, sinceIso: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to lib/db/sqlite-updates.test.ts
it('sqliteUpdateChecks upsertMany then listByUser round-trips and deleteStale removes stale rows', async () => {
  const { sqliteUpdateChecks } = require('./sqlite');
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
  const { sqliteUpdatePolicies, sqliteAutoUpdateHistory } = require('./sqlite');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts -t "upsertMany"`
Expected: FAIL

- [ ] **Step 3: Implement both modules**

In `lib/db/sqlite.ts`:

```typescript
export interface UpdateCheckInsert {
  user_id: string;
  tenant_id: string;
  winget_id: string;
  intune_app_id: string;
  display_name: string;
  current_version: string;
  latest_version: string;
  is_critical: boolean;
  is_managed: boolean;
  notified_at: string | null;
  detected_at: string;
  updated_at: string;
}

export interface UpdateCheckRow extends UpdateCheckInsert {
  id: string;
  dismissed_at: string | null;
}

function parseUpdateCheckRow(row: Record<string, unknown>): UpdateCheckRow {
  return {
    ...row,
    is_critical: Boolean(row.is_critical),
    is_managed: Boolean(row.is_managed),
  } as UpdateCheckRow;
}

export const sqliteUpdateChecks = {
  async listByUser(
    userId: string,
    opts: { tenantId?: string; includeDismissed?: boolean; criticalOnly?: boolean } = {}
  ): Promise<UpdateCheckRow[]> {
    const database = getDb();
    const conditions = ['user_id = ?'];
    const values: unknown[] = [userId];
    if (opts.tenantId) { conditions.push('tenant_id = ?'); values.push(opts.tenantId); }
    if (!opts.includeDismissed) { conditions.push('dismissed_at IS NULL'); }
    if (opts.criticalOnly) { conditions.push('is_critical = 1'); }
    const rows = database
      .prepare(`SELECT * FROM update_check_results WHERE ${conditions.join(' AND ')} ORDER BY detected_at DESC`)
      .all(...values) as Record<string, unknown>[];
    return rows.map(parseUpdateCheckRow);
  },

  async getOne(userId: string, tenantId: string, wingetId: string): Promise<UpdateCheckRow | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM update_check_results WHERE user_id = ? AND tenant_id = ? AND winget_id = ?')
      .get(userId, tenantId, wingetId) as Record<string, unknown> | undefined;
    return row ? parseUpdateCheckRow(row) : null;
  },

  async upsertMany(rows: UpdateCheckInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const database = getDb();
    const stmt = database.prepare(`
      INSERT INTO update_check_results (
        id, user_id, tenant_id, winget_id, intune_app_id, display_name,
        current_version, latest_version, is_critical, is_managed,
        notified_at, detected_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, tenant_id, winget_id, intune_app_id) DO UPDATE SET
        display_name = excluded.display_name,
        current_version = excluded.current_version,
        latest_version = excluded.latest_version,
        is_critical = excluded.is_critical,
        is_managed = excluded.is_managed,
        notified_at = excluded.notified_at,
        detected_at = excluded.detected_at,
        updated_at = excluded.updated_at
    `);
    const insertAll = database.transaction((items: UpdateCheckInsert[]) => {
      for (const r of items) {
        stmt.run(
          crypto.randomUUID(), r.user_id, r.tenant_id, r.winget_id, r.intune_app_id,
          r.display_name, r.current_version, r.latest_version,
          r.is_critical ? 1 : 0, r.is_managed ? 1 : 0, r.notified_at, r.detected_at, r.updated_at
        );
      }
    });
    insertAll(rows);
  },

  async deleteStale(userId: string, activeKeys: Set<string>): Promise<number> {
    const database = getDb();
    const rows = database
      .prepare('SELECT id, winget_id, intune_app_id FROM update_check_results WHERE user_id = ?')
      .all(userId) as Array<{ id: string; winget_id: string; intune_app_id: string }>;
    const staleIds = rows
      .filter((r) => !activeKeys.has(`${r.winget_id}:${r.intune_app_id}`))
      .map((r) => r.id);
    if (staleIds.length === 0) return 0;
    const placeholders = staleIds.map(() => '?').join(', ');
    const result = database.prepare(`DELETE FROM update_check_results WHERE id IN (${placeholders})`).run(...staleIds);
    return result.changes;
  },

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const database = getDb();
    const result = database.prepare('DELETE FROM update_check_results WHERE detected_at < ?').run(cutoffIso);
    return result.changes;
  },

  async dismiss(userId: string, ids: string[], dismissed: boolean): Promise<number> {
    const database = getDb();
    const placeholders = ids.map(() => '?').join(', ');
    const now = new Date().toISOString();
    const result = database
      .prepare(`UPDATE update_check_results SET dismissed_at = ?, updated_at = ? WHERE id IN (${placeholders}) AND user_id = ?`)
      .run(dismissed ? now : null, now, ...ids, userId);
    return result.changes;
  },
};

export const sqliteAutoUpdateHistory = {
  async create(policyId: string, fromVersion: string, toVersion: string, updateType: string): Promise<{ id: string }> {
    const database = getDb();
    const id = crypto.randomUUID();
    database
      .prepare(`
        INSERT INTO auto_update_history (id, policy_id, from_version, to_version, update_type, status, triggered_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(id, policyId, fromVersion, toVersion, updateType, new Date().toISOString());
    return { id };
  },

  async updateStatus(
    id: string,
    status: string,
    extra: { packagingJobId?: string; errorMessage?: string; completedAt?: string } = {}
  ): Promise<void> {
    const database = getDb();
    const sets = ['status = ?'];
    const values: unknown[] = [status];
    if (extra.packagingJobId !== undefined) { sets.push('packaging_job_id = ?'); values.push(extra.packagingJobId); }
    if (extra.errorMessage !== undefined) { sets.push('error_message = ?'); values.push(extra.errorMessage); }
    if (extra.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(extra.completedAt); }
    values.push(id);
    database.prepare(`UPDATE auto_update_history SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  },

  async countSince(policyIds: string[], sinceIso: string, statusFilter?: string): Promise<number> {
    if (policyIds.length === 0) return 0;
    const database = getDb();
    const placeholders = policyIds.map(() => '?').join(', ');
    const statusClause = statusFilter ? 'AND status = ?' : '';
    const row = database
      .prepare(`SELECT COUNT(*) as count FROM auto_update_history WHERE policy_id IN (${placeholders}) AND triggered_at >= ? ${statusClause}`)
      .get(...policyIds, sinceIso, ...(statusFilter ? [statusFilter] : [])) as { count: number };
    return row.count;
  },

  async hasRecentForPolicy(policyId: string, sinceIso: string): Promise<boolean> {
    const database = getDb();
    const row = database
      .prepare('SELECT id FROM auto_update_history WHERE policy_id = ? AND triggered_at >= ? LIMIT 1')
      .get(policyId, sinceIso);
    return Boolean(row);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add lib/db/sqlite.ts lib/db/sqlite-updates.test.ts
git commit -m "Add sqliteUpdateChecks and sqliteAutoUpdateHistory modules"
```

---

## Task 4: `sqliteNotificationPreferences` module

**Files:**
- Modify: `lib/db/sqlite.ts`
- Test: `lib/db/sqlite-updates.test.ts` (extend)

**Interfaces:**
- Produces:
  - `sqliteNotificationPreferences.get(userId: string): Promise<NotificationPreferencesRow | null>`
  - `sqliteNotificationPreferences.upsert(userId: string, data: Partial<NotificationPreferencesRow>): Promise<NotificationPreferencesRow>`

Where `NotificationPreferencesRow` is a new exported interface (this table doesn't exist in `types/notifications.ts` today with the extended fields, so it's defined here and re-exported for the route to use):

```typescript
export interface NotificationPreferencesRow {
  id: string;
  user_id: string;
  email_enabled: boolean;
  email_frequency: 'immediate' | 'daily' | 'weekly';
  email_address: string | null;
  notify_critical_only: boolean;
  webhook_enabled: boolean;
  notify_on_update_available: boolean;
  notify_on_deployed: boolean;
  notify_on_error: boolean;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 1: Write the failing test**

```typescript
// append to lib/db/sqlite-updates.test.ts
it('sqliteNotificationPreferences get returns null then upsert creates defaults-merged row', async () => {
  const { sqliteNotificationPreferences } = require('./sqlite');
  expect(await sqliteNotificationPreferences.get('user-3')).toBeNull();

  const created = await sqliteNotificationPreferences.upsert('user-3', { email_enabled: true, notify_on_deployed: false });
  expect(created.email_enabled).toBe(true);
  expect(created.notify_on_deployed).toBe(false);
  expect(created.notify_on_error).toBe(true); // default preserved

  const fetched = await sqliteNotificationPreferences.get('user-3');
  expect(fetched?.email_enabled).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts -t "sqliteNotificationPreferences"`
Expected: FAIL

- [ ] **Step 3: Implement the module**

In `lib/db/sqlite.ts`:

```typescript
function parseNotificationPreferencesRow(row: Record<string, unknown>): NotificationPreferencesRow {
  return {
    ...row,
    email_enabled: Boolean(row.email_enabled),
    notify_critical_only: Boolean(row.notify_critical_only),
    webhook_enabled: Boolean(row.webhook_enabled),
    notify_on_update_available: Boolean(row.notify_on_update_available),
    notify_on_deployed: Boolean(row.notify_on_deployed),
    notify_on_error: Boolean(row.notify_on_error),
  } as NotificationPreferencesRow;
}

export const sqliteNotificationPreferences = {
  async get(userId: string): Promise<NotificationPreferencesRow | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    return row ? parseNotificationPreferencesRow(row) : null;
  },

  async upsert(userId: string, data: Partial<NotificationPreferencesRow>): Promise<NotificationPreferencesRow> {
    const database = getDb();
    const existing = await this.get(userId);
    const now = new Date().toISOString();

    if (existing) {
      const sets: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];
      const boolFields = ['email_enabled', 'notify_critical_only', 'webhook_enabled', 'notify_on_update_available', 'notify_on_deployed', 'notify_on_error'] as const;
      const textFields = ['email_frequency', 'email_address'] as const;
      for (const f of boolFields) {
        if (data[f] !== undefined) { sets.push(`${f} = ?`); values.push(data[f] ? 1 : 0); }
      }
      for (const f of textFields) {
        if (data[f] !== undefined) { sets.push(`${f} = ?`); values.push(data[f]); }
      }
      values.push(userId);
      database.prepare(`UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = ?`).run(...values);
      return (await this.get(userId)) as NotificationPreferencesRow;
    }

    const id = crypto.randomUUID();
    database
      .prepare(`
        INSERT INTO notification_preferences (
          id, user_id, email_enabled, email_frequency, email_address, notify_critical_only,
          webhook_enabled, notify_on_update_available, notify_on_deployed, notify_on_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, userId,
        data.email_enabled ? 1 : 0,
        data.email_frequency || 'daily',
        data.email_address ?? null,
        data.notify_critical_only ? 1 : 0,
        data.webhook_enabled === undefined ? 1 : (data.webhook_enabled ? 1 : 0),
        data.notify_on_update_available === undefined ? 1 : (data.notify_on_update_available ? 1 : 0),
        data.notify_on_deployed === undefined ? 1 : (data.notify_on_deployed ? 1 : 0),
        data.notify_on_error === undefined ? 1 : (data.notify_on_error ? 1 : 0),
        now, now
      );
    return (await this.get(userId)) as NotificationPreferencesRow;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/sqlite-updates.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add lib/db/sqlite.ts lib/db/sqlite-updates.test.ts
git commit -m "Add sqliteNotificationPreferences module"
```

---

## Task 5: Generalize `buildDeploymentConfigForApp` to work in both DB modes

**Files:**
- Modify: `lib/update-policies/build-deployment-config.ts`
- Modify (call sites): `app/api/update-policies/route.ts`, `app/api/updates/trigger/route.ts`
- Test: `lib/update-policies/build-deployment-config.test.ts` (new)

**Interfaces:**
- Consumes: `getDatabase()` from `lib/db` (`jobs.getById`, `uploadHistory.getByUserId` — already dual-mode).
- Produces: `buildDeploymentConfigForApp(args: { userId: string; tenantId: string; wingetId: string; latestVersion: string }): Promise<BuildDeploymentConfigResult>` — **signature changes: drops the `supabase` first parameter**, works identically in both DB modes.

This function's only two DB reads (`upload_history`, `packaging_jobs`) already have working dual-mode equivalents via `getDatabase()`, so this becomes a genuine dual-mode function rather than needing an `isSqliteMode()` fork — reuse, don't duplicate.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/update-policies/build-deployment-config.test.ts
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

  afterEach(() => {
    const { closeSqliteDb } = require('../db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
  });

  it('returns status "ok" built from a prior packaging job', async () => {
    const { sqliteDb } = require('../db/sqlite');
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

    const { buildDeploymentConfigForApp } = require('./build-deployment-config');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/update-policies/build-deployment-config.test.ts`
Expected: FAIL — current signature still takes `supabase` as first param and calls it unconditionally.

- [ ] **Step 3: Rewrite `buildDeploymentConfigForApp` and `buildDefaultDeploymentConfig`**

In `lib/update-policies/build-deployment-config.ts`, replace the `createServerClient` import and the two functions' signatures:

```typescript
import { getDatabase } from '@/lib/db';
// remove: import { createServerClient } from '@/lib/supabase';
```

Replace `buildDefaultDeploymentConfig`'s signature (drop the unused `_supabase` param entirely — it was already unused inside the function body):

```typescript
export async function buildDefaultDeploymentConfig(
  wingetId: string,
  latestVersion: string
): Promise<DeploymentConfig | null> {
  // ...unchanged body...
}
```

Replace `buildDeploymentConfigForApp`:

```typescript
export async function buildDeploymentConfigForApp(
  args: {
    userId: string;
    tenantId: string;
    wingetId: string;
    latestVersion: string;
  }
): Promise<BuildDeploymentConfigResult> {
  const { userId, tenantId, wingetId, latestVersion } = args;
  const db = getDatabase();

  // Get the original deployment config from upload_history
  const uploads = await db.uploadHistory.getByUserId(userId, 200);
  const uploadHistory = uploads
    .filter((u) => u.winget_id === wingetId && u.intune_tenant_id === tenantId)
    .sort((a, b) => new Date(b.deployed_at).getTime() - new Date(a.deployed_at).getTime())[0];

  if (uploadHistory?.packaging_job_id) {
    const packagingJob = await db.jobs.getById(uploadHistory.packaging_job_id);

    if (!packagingJob) {
      return { status: 'orphaned_job' };
    }

    const packageConfig = packagingJob.package_config;
    const parsedAssignments = parsePackageAssignments(packageConfig);
    const parsedCategories = parsePackageCategories(packageConfig);
    const parsedRequirementRules = parseRequirementRules(packageConfig);
    const parsedRelationships = parseAppRelationships(packageConfig);
    const assignmentMigration = parseAssignmentMigration(packageConfig);

    const deploymentConfig: DeploymentConfig = {
      displayName: packagingJob.display_name,
      publisher: packagingJob.publisher || 'Unknown Publisher',
      architecture: packagingJob.architecture || 'x64',
      installerType: packagingJob.installer_type || 'exe',
      installCommand: packagingJob.install_command || '',
      uninstallCommand: packagingJob.uninstall_command || '',
      installScope: packagingJob.install_scope || 'system',
      detectionRules: parseDetectionRules(packagingJob.detection_rules),
      assignments: parsedAssignments,
      categories: parsedCategories,
      requirementRules: parsedRequirementRules,
      relationships: parsedRelationships.length > 0 ? parsedRelationships : undefined,
      psadtConfig: parsePsadtConfig(packageConfig),
      forceCreateNewApp: true,
      assignmentMigration,
    };

    return { status: 'ok', deploymentConfig, originalUploadHistoryId: uploadHistory.id };
  }

  const defaultConfig = await buildDefaultDeploymentConfig(wingetId, latestVersion);

  if (!defaultConfig) {
    return { status: 'unavailable' };
  }

  return { status: 'ok', deploymentConfig: defaultConfig, originalUploadHistoryId: null };
}
```

Note: `db.uploadHistory.getByUserId` doesn't filter by `intune_tenant_id`/`winget_id` server-side in either adapter today — the filter above happens in memory, matching this function's low call volume (once per policy save, not a hot path). If a tenant has an unusually large upload history, increase the `200` limit rather than optimize prematurely (YAGNI).

- [ ] **Step 4: Update the two call sites**

In `app/api/update-policies/route.ts`, change:
```typescript
const built = await buildDeploymentConfigForApp(supabase, {
```
to:
```typescript
const built = await buildDeploymentConfigForApp({
```

In `app/api/updates/trigger/route.ts`, same change (one call site, inside the `if (!policy)` block).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/update-policies/build-deployment-config.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full existing test suite to confirm no regression in Supabase-mode callers**

Run: `cd /opt/intuneget/app && npx vitest run lib/update-policies`
Expected: PASS — no existing test in this directory should have broken (the two call sites still pass the same arguments, minus `supabase`).

- [ ] **Step 7: Commit**

```bash
git add lib/update-policies/build-deployment-config.ts lib/update-policies/build-deployment-config.test.ts app/api/update-policies/route.ts app/api/updates/trigger/route.ts
git commit -m "Generalize buildDeploymentConfigForApp to work in both DB modes via getDatabase()"
```

---

## Task 6: `runUpdateCheck()` — pure detection logic, SQLite-only for now

**Files:**
- Create: `lib/auto-update/check-updates.ts`
- Modify: `app/api/cron/check-updates/route.ts` (delegate to the new function for SQLite mode, keep the existing Supabase logic untouched for Supabase mode)
- Test: `lib/auto-update/check-updates.test.ts` (new)

**Interfaces:**
- Consumes: `sqliteUpdateChecks`, `sqliteUpdatePolicies` (Task 2/3), `getDatabase()` (`uploadHistory.getByUserId`), `getCatalogSource().getAllLatestVersions()` (already dual-mode), `shouldSkipUpdate` from `types/update-policies.ts` (unchanged).
- Produces: `runUpdateCheck(): Promise<{ usersChecked: number; updatesFound: number; errors: string[] }>` — no parameters; single-tenant SQLite mode has exactly one effective "user scope": every row in `upload_history`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/auto-update/check-updates.test.ts
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

  afterEach(() => {
    const { closeSqliteDb } = require('../db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('writes an update_check_results row when a deployed app has a newer catalog version', async () => {
    const { sqliteDb } = require('../db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: '7zip.7zip', version: '22.0',
      display_name: '7-Zip', intune_app_id: 'intune-1', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/catalog', () => ({
      getCatalogSource: () => ({
        getAllLatestVersions: async () => [{ winget_id: '7zip.7zip', latest_version: '23.0' }],
      }),
    }));

    const { runUpdateCheck } = require('./check-updates');
    const result = await runUpdateCheck();

    expect(result.updatesFound).toBe(1);

    const { sqliteUpdateChecks } = require('../db/sqlite');
    const row = await sqliteUpdateChecks.getOne('user-1', 'tenant-1', '7zip.7zip');
    expect(row?.latest_version).toBe('23.0');
    expect(row?.current_version).toBe('22.0');
  });

  it('skips an app with an ignore policy', async () => {
    const { sqliteDb, sqliteUpdatePolicies } = require('../db/sqlite');
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

    const { runUpdateCheck } = require('./check-updates');
    const result = await runUpdateCheck();

    expect(result.updatesFound).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/auto-update/check-updates.test.ts`
Expected: FAIL — `./check-updates` doesn't exist yet.

- [ ] **Step 3: Implement `runUpdateCheck()`**

`DatabaseAdapter.uploadHistory.getByUserId(userId, limit)` requires a `userId`, and there's no "list all users" method on the shared interface (correct — Supabase mode has no reason to ever list all users at once outside its own batched cron). Add a SQLite-only helper for this scan instead of forcing the shared interface to support it.

In `lib/db/sqlite.ts`, add a standalone export (SQLite-specific, not part of `DatabaseAdapter`):

```typescript
export function sqliteListAllUploadHistory(): UploadHistoryRecord[] {
  const database = getDb();
  return database.prepare('SELECT * FROM upload_history').all() as UploadHistoryRecord[];
}
```

Then `check-updates.ts` itself:

```typescript
// lib/auto-update/check-updates.ts
import { sqliteListAllUploadHistory } from '@/lib/db/sqlite';
import { sqliteUpdateChecks, sqliteUpdatePolicies, type UpdateCheckInsert } from '@/lib/db/sqlite';
import { compareVersions, parseVersion } from '@/lib/version-compare';
import { getCatalogSource } from '@/lib/catalog';
import { shouldSkipUpdate } from '@/types/update-policies';

export interface RunUpdateCheckResult {
  usersChecked: number;
  updatesFound: number;
  errors: string[];
}

export async function runUpdateCheck(): Promise<RunUpdateCheckResult> {
  const errors: string[] = [];
  const allUploads = sqliteListAllUploadHistory();

  if (allUploads.length === 0) {
    return { usersChecked: 0, updatesFound: 0, errors };
  }

  const curatedApps = await getCatalogSource().getAllLatestVersions();
  const latestVersions = new Map<string, string>();
  curatedApps?.forEach((app) => {
    if (app.latest_version) latestVersions.set(app.winget_id, app.latest_version);
  });

  // Group by user+tenant, keep the newest deployment per winget_id (an app can
  // be redeployed at a newer version, superseding an older upload_history row)
  const userTenantApps = new Map<string, typeof allUploads>();
  allUploads.forEach((app) => {
    const key = `${app.user_id}:${app.intune_tenant_id || 'default'}`;
    if (!userTenantApps.has(key)) userTenantApps.set(key, []);
    userTenantApps.get(key)!.push(app);
  });

  const activeKeysByUser = new Map<string, Set<string>>();
  const allUpdates: UpdateCheckInsert[] = [];
  let updatesFound = 0;

  for (const [key, apps] of userTenantApps) {
    const [userId, tenantId] = key.split(':');
    const uniqueApps = new Map<string, (typeof apps)[number]>();
    apps.forEach((app) => {
      const existing = uniqueApps.get(app.winget_id);
      if (!existing || compareVersions(app.version, existing.version) > 0) {
        uniqueApps.set(app.winget_id, app);
      }
    });

    const activeKeys = activeKeysByUser.get(userId) ?? new Set<string>();
    activeKeysByUser.set(userId, activeKeys);

    for (const app of uniqueApps.values()) {
      const latestVersion = latestVersions.get(app.winget_id);
      if (!latestVersion) continue;

      const policy = await sqliteUpdatePolicies.getByApp(userId, tenantId, app.winget_id);
      if (shouldSkipUpdate(policy, latestVersion)) continue;

      if (compareVersions(app.version, latestVersion) < 0) {
        const currentParsed = parseVersion(app.version);
        const latestParsed = parseVersion(latestVersion);
        const isCritical = latestParsed.major > currentParsed.major;

        const prior = await sqliteUpdateChecks.getOne(userId, tenantId, app.winget_id);
        const notifiedAt = prior && prior.latest_version === latestVersion ? prior.notified_at : null;
        const now = new Date().toISOString();

        allUpdates.push({
          user_id: userId,
          tenant_id: tenantId,
          winget_id: app.winget_id,
          intune_app_id: app.intune_app_id,
          display_name: app.display_name,
          current_version: app.version,
          latest_version: latestVersion,
          is_critical: isCritical,
          is_managed: true,
          notified_at: notifiedAt,
          detected_at: now,
          updated_at: now,
        });
        activeKeys.add(`${app.winget_id}:${app.intune_app_id}`);
        updatesFound++;
      }
    }
  }

  await sqliteUpdateChecks.upsertMany(allUpdates);

  for (const [userId, activeKeys] of activeKeysByUser) {
    try {
      await sqliteUpdateChecks.deleteStale(userId, activeKeys);
    } catch (err) {
      errors.push(`Error clearing stale updates for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await sqliteUpdateChecks.deleteOlderThan(thirtyDaysAgo);

  return { usersChecked: userTenantApps.size, updatesFound, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/auto-update/check-updates.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Add `sqliteListAllUploadHistory` and wire the route**

Confirm the `sqliteListAllUploadHistory` export landed in `lib/db/sqlite.ts` (Step 3 above). Then in `app/api/cron/check-updates/route.ts`, add an SQLite branch at the very top of the `GET` handler, before the existing `supabaseUrl`/`supabaseServiceKey` checks:

```typescript
import { isSqliteMode } from '@/lib/db';
import { runUpdateCheck } from '@/lib/auto-update/check-updates';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (isSqliteMode()) {
    const result = await runUpdateCheck();
    return NextResponse.json({
      success: result.errors.length === 0,
      usersChecked: result.usersChecked,
      updatesFound: result.updatesFound,
      autoUpdates: { triggered: 0, skipped: 0, failed: 0 }, // wired in Task 8
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  }

  // ...rest of the existing Supabase-only logic, unchanged...
}
```

- [ ] **Step 6: Manual verification**

Run: `docker exec intuneget node -e "require('/app/.next/server/app/api/cron/check-updates/route.js')"` is not viable for a compiled Next route directly — instead, after deploying (Task 10), hit the route manually:
```bash
curl -H "Authorization: Bearer $(grep CRON_SECRET /opt/intuneget/.env | cut -d= -f2)" https://iget.node1.buildtestrun.com/api/cron/check-updates
```
Expected: `{"success":true,"usersChecked":N,"updatesFound":N,...}` with no error.

- [ ] **Step 7: Commit**

```bash
git add lib/auto-update/check-updates.ts lib/auto-update/check-updates.test.ts lib/db/sqlite.ts app/api/cron/check-updates/route.ts
git commit -m "Add runUpdateCheck() SQLite detection logic, wire into cron route"
```

---

## Task 7: In-process scheduler (`instrumentation.ts`)

**Files:**
- Create: `instrumentation.ts` (project root, next to `next.config.ts`)
- Test: manual (Next.js instrumentation hooks run at server boot, not unit-testable in isolation without booting the whole server — verified via deployment logs instead, consistent with how this session verified the Docker rebuilds)

**Interfaces:**
- Consumes: `runUpdateCheck()` from Task 6, `isSqliteMode()` from `lib/db`.
- Produces: nothing importable — a side-effecting module Next.js loads automatically.

- [ ] **Step 1: Check Next.js config doesn't need an extra flag**

Run: `grep -n "next" /opt/intuneget/app/package.json` to confirm the Next version (already known: 16.2.10). Next.js 15+ has `instrumentation.ts` enabled by default (no `experimental.instrumentationHook` needed) — confirm `next.config.ts`/`next.config.mjs` has no explicit `instrumentationHook: false` override:

Run: `grep -rn "instrumentationHook" /opt/intuneget/app/next.config.*`
Expected: no output (not present, so the default "enabled" applies).

- [ ] **Step 2: Write `instrumentation.ts`**

```typescript
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { isSqliteMode } = await import('@/lib/db');
  if (!isSqliteMode()) return; // Supabase mode keeps using Vercel Cron externally

  const { runUpdateCheck } = await import('@/lib/auto-update/check-updates');
  const intervalMs = 24 * 60 * 60 * 1000;

  console.log('[Scheduler] Starting update-check interval (every 24h)');
  setInterval(() => {
    runUpdateCheck()
      .then((result) => {
        console.log(`[Scheduler] Update check complete: ${result.updatesFound} updates found, ${result.errors.length} errors`);
        if (result.errors.length > 0) console.error('[Scheduler] Errors:', result.errors);
      })
      .catch((err) => console.error('[Scheduler] Update check failed:', err));
  }, intervalMs);
}
```

- [ ] **Step 3: Deploy and verify the scheduler registered (manual, no automated test)**

After Task 10's final deployment step, run:
```bash
docker logs intuneget --since 1m 2>&1 | grep -i "Scheduler] Starting"
```
Expected: `[Scheduler] Starting update-check interval (every 24h)` present exactly once (instrumentation's `register()` runs once per server process, not per-request).

- [ ] **Step 4: Commit**

```bash
git add instrumentation.ts
git commit -m "Add in-process 24h scheduler for SQLite-mode update detection"
```

---

## Task 8: SQLite auto-deploy trigger (`AutoUpdateTriggerSqlite`)

**Files:**
- Create: `lib/auto-update/trigger-sqlite.ts`
- Modify: `lib/auto-update/check-updates.ts` (call the trigger for eligible `auto_update` policies after detection)
- Test: `lib/auto-update/trigger-sqlite.test.ts` (new)

**Interfaces:**
- Consumes: `sqliteUpdatePolicies`, `sqliteAutoUpdateHistory` (Tasks 2/3), `getServicePrincipalToken` from `lib/intune/graph-client.ts` (already used elsewhere in SQLite mode), `getLatestInstallerInfo(supabase?, wingetId, architecture?, installScope?)` from `lib/auto-update/trigger.ts` — confirmed its `_supabase: SupabaseClient` first parameter is entirely unused inside the function body (the parameter's own comment reads "Kept for call-site compatibility; the catalog source owns client creation" — the function only calls `getCatalogSource()` internally, already dual-mode), `canAutoUpdate`/`DEFAULT_SAFETY_CONFIG`/`classifyUpdateType` from `types/update-policies.ts` (unchanged, pure functions).
- Produces:
  - `class AutoUpdateTriggerSqlite` with one public method: `triggerAutoUpdate(policy: AppUpdatePolicy, updateInfo: UpdateInfo, options?: { skipRateLimits?: boolean; skipPriorDeploymentCheck?: boolean }): Promise<TriggerResult>` — same shape as the existing `AutoUpdateTrigger.triggerAutoUpdate`.
  - `runAutoUpdatesForNewDetections(updates: UpdateCheckInsert[]): Promise<{ triggered: number; skipped: number; failed: number; errors: string[] }>` — the SQLite equivalent of the cron route's `processAutoUpdates()`, called from `runUpdateCheck()`.

- [ ] **Step 1: Make `getLatestInstallerInfo`'s unused `_supabase` parameter optional**

In `lib/auto-update/trigger.ts`, change the signature from:
```typescript
export async function getLatestInstallerInfo(
  // Kept for call-site compatibility; the catalog source owns client creation.
  _supabase: SupabaseClient,
  wingetId: string,
  architecture?: string,
  installScope?: string
): Promise<InstallerResolutionResult> {
```
to:
```typescript
export async function getLatestInstallerInfo(
  // Optional and unused - the catalog source owns client creation. Kept only
  // so existing Supabase-mode callers don't need to change their call sites.
  _supabase?: SupabaseClient,
  wingetId: string,
  architecture?: string,
  installScope?: string
): Promise<InstallerResolutionResult> {
```
`wingetId` stays required (the function body assumes it's a string throughout) — SQLite call sites simply pass `undefined` as the first argument, which is valid once `_supabase` is optional. Existing Supabase-mode callers (`app/api/cron/check-updates/route.ts`'s `processAutoUpdates`, `AutoUpdateTrigger.triggerAutoUpdate`) keep passing a real client and are unaffected.

Run the existing test suite for this file to confirm no regression: `cd /opt/intuneget/app && npx vitest run lib/auto-update` — expect all pre-existing tests to still pass (a parameter becoming optional is backward compatible).

- [ ] **Step 2: Write the failing test**

```typescript
// lib/auto-update/trigger-sqlite.test.ts
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

  afterEach(() => {
    const { closeSqliteDb } = require('../db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('skips when policy.policy_type is not auto_update', async () => {
    const { sqliteUpdatePolicies } = require('../db/sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: '7zip.7zip', tenant_id: 'tenant-1', policy_type: 'notify',
    });

    const { AutoUpdateTriggerSqlite } = require('./trigger-sqlite');
    const trigger = new AutoUpdateTriggerSqlite();
    const result = await trigger.triggerAutoUpdate(policy, {
      wingetId: '7zip.7zip', currentVersion: '22.0', latestVersion: '23.0',
      displayName: '7-Zip', installerUrl: 'https://x', installerSha256: 'a'.repeat(64), installerType: 'exe',
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it('enforces the per-policy cooldown from auto_update_history', async () => {
    const { sqliteUpdatePolicies, sqliteAutoUpdateHistory } = require('../db/sqlite');
    const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
      winget_id: '7zip.7zip', tenant_id: 'tenant-1', policy_type: 'auto_update',
      original_upload_history_id: 'some-id',
      deployment_config: { displayName: '7-Zip', publisher: '7-Zip', architecture: 'x64', installerType: 'exe', installCommand: 'x', uninstallCommand: 'x', installScope: 'machine', detectionRules: [] },
    });
    await sqliteAutoUpdateHistory.create(policy.id, '21.0', '22.0', 'minor');

    const { AutoUpdateTriggerSqlite } = require('./trigger-sqlite');
    const trigger = new AutoUpdateTriggerSqlite();
    const result = await trigger.triggerAutoUpdate(policy, {
      wingetId: '7zip.7zip', currentVersion: '22.0', latestVersion: '23.0',
      displayName: '7-Zip', installerUrl: 'https://x', installerSha256: 'a'.repeat(64), installerType: 'exe',
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/cooldown/i);
  });
});
```

- [ ] **Step 3: Implement `AutoUpdateTriggerSqlite`**

```typescript
// lib/auto-update/trigger-sqlite.ts
import {
  sqliteUpdatePolicies,
  sqliteAutoUpdateHistory,
  type UpdateCheckInsert,
} from '@/lib/db/sqlite';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import {
  AppUpdatePolicy,
  DEFAULT_SAFETY_CONFIG,
  AutoUpdateSafetyConfig,
  classifyUpdateType,
  canAutoUpdate,
} from '@/types/update-policies';
import type { TriggerResult, UpdateInfo } from './trigger';
// The QA gate (ensureQaDemand) and packaging-job creation the Supabase version
// calls internally live in trigger.ts's private methods; this SQLite version
// reimplements only what differs (safety checks) and reuses the shared,
// already-dual-mode packaging helpers directly - see Step 4 note.

export class AutoUpdateTriggerSqlite {
  private safetyConfig: AutoUpdateSafetyConfig;

  constructor(safetyConfig: AutoUpdateSafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.safetyConfig = safetyConfig;
  }

  async triggerAutoUpdate(
    policy: AppUpdatePolicy,
    updateInfo: UpdateInfo,
    options?: { skipRateLimits?: boolean; skipPriorDeploymentCheck?: boolean }
  ): Promise<TriggerResult> {
    if (!canAutoUpdate(policy)) {
      return { success: false, skipped: true, skipReason: 'Policy does not allow auto-update or is disabled' };
    }

    if (!policy.deployment_config) {
      return { success: false, error: 'No deployment configuration saved for this policy' };
    }

    if (this.safetyConfig.requirePriorDeployment && !options?.skipPriorDeploymentCheck && !policy.original_upload_history_id) {
      return { success: false, error: 'Auto-update requires a prior manual deployment' };
    }

    if (!options?.skipRateLimits) {
      const rateLimitResult = await this.checkRateLimits(policy);
      if (!rateLimitResult.allowed) {
        return { success: false, skipped: true, skipReason: rateLimitResult.reason };
      }
    }

    // Consent check: SQLite mode has no tenant_consent table. The de-facto
    // proof of consent is a successful service-principal token acquisition,
    // the same check the Discovered Apps live-scan route already relies on.
    if (this.safetyConfig.verifyConsentBeforeDeployment) {
      const token = await getServicePrincipalToken(policy.tenant_id);
      if (!token) {
        return { success: false, error: 'Tenant consent is no longer active' };
      }
    }

    const updateType = classifyUpdateType(updateInfo.currentVersion, updateInfo.latestVersion);
    const { id: historyId } = await sqliteAutoUpdateHistory.create(
      policy.id,
      updateInfo.currentVersion,
      updateInfo.latestVersion,
      updateType
    );

    try {
      // Packaging-job creation reuses the same code path the manual
      // claim -> cart -> deploy flow already uses in SQLite mode today
      // (detection-rules.ts, packaging-adapters.ts, getDatabase().jobs.create) -
      // deliberately NOT reimplemented here. This plan's Task 9 wires the
      // actual call once the exact shared helper is confirmed (see note below).
      throw new Error('NOT_YET_WIRED');
    } catch (error) {
      await sqliteUpdatePolicies.incrementFailureCount(policy.id);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await sqliteAutoUpdateHistory.updateStatus(historyId, 'failed', {
        errorMessage,
        completedAt: new Date().toISOString(),
      });
      return { success: false, error: errorMessage, historyId };
    }
  }

  private async checkRateLimits(policy: AppUpdatePolicy): Promise<{ allowed: boolean; reason?: string }> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { rateLimits } = this.safetyConfig;

    const tenantPolicies = await sqliteUpdatePolicies.listByUser(policy.user_id, policy.tenant_id);
    const tenantPolicyIds = tenantPolicies.map((p) => p.id);
    if (tenantPolicyIds.length > 0) {
      const tenantCount = await sqliteAutoUpdateHistory.countSince(tenantPolicyIds, oneHourAgo, 'completed');
      if (tenantCount >= rateLimits.maxUpdatesPerTenant) {
        return { allowed: false, reason: `Rate limit exceeded: ${rateLimits.maxUpdatesPerTenant} updates per tenant per hour` };
      }
    }

    const userPolicies = await sqliteUpdatePolicies.listByUser(policy.user_id);
    const userPolicyIds = userPolicies.map((p) => p.id);
    if (userPolicyIds.length > 0) {
      const globalCount = await sqliteAutoUpdateHistory.countSince(userPolicyIds, oneHourAgo);
      if (globalCount >= rateLimits.maxUpdatesPerHour) {
        return { allowed: false, reason: `Rate limit exceeded: ${rateLimits.maxUpdatesPerHour} updates per hour` };
      }
    }

    const cooldownTime = new Date(Date.now() - rateLimits.cooldownMinutes * 60 * 1000).toISOString();
    const recent = await sqliteAutoUpdateHistory.hasRecentForPolicy(policy.id, cooldownTime);
    if (recent) {
      return { allowed: false, reason: `Cooldown period: wait ${rateLimits.cooldownMinutes} minutes between updates` };
    }

    return { allowed: true };
  }
}

/**
 * Called from runUpdateCheck() after detection, for every update whose
 * policy is auto_update and whose delay has elapsed.
 */
export async function runAutoUpdatesForNewDetections(
  updates: UpdateCheckInsert[]
): Promise<{ triggered: number; skipped: number; failed: number; errors: string[] }> {
  const result = { triggered: 0, skipped: 0, failed: 0, errors: [] as string[] };
  const trigger = new AutoUpdateTriggerSqlite();

  for (const update of updates) {
    const policy = await sqliteUpdatePolicies.getByApp(update.user_id, update.tenant_id, update.winget_id);
    if (!policy || policy.policy_type !== 'auto_update' || !policy.is_enabled) continue;

    const delayDays = (policy as unknown as { delay_days: number }).delay_days ?? 0;
    const detectedAt = new Date(update.detected_at).getTime();
    const eligibleAt = detectedAt + delayDays * 24 * 60 * 60 * 1000;
    if (Date.now() < eligibleAt) continue; // still waiting out the delay

    const triggerResult = await trigger.triggerAutoUpdate(policy, {
      wingetId: update.winget_id,
      currentVersion: update.current_version,
      latestVersion: update.latest_version,
      displayName: update.display_name,
      installerUrl: '', // filled in by getLatestInstallerInfo inside triggerAutoUpdate once Task 9 wires packaging
      installerSha256: '',
      installerType: '',
    });

    if (triggerResult.success) result.triggered++;
    else if (triggerResult.skipped) result.skipped++;
    else {
      result.failed++;
      if (triggerResult.error) result.errors.push(`${update.winget_id}: ${triggerResult.error}`);
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/auto-update/trigger-sqlite.test.ts`
Expected: PASS (both tests — they only exercise the safety-check short-circuits, not the packaging path, which intentionally throws `NOT_YET_WIRED` until Task 9).

- [ ] **Step 5: Commit**

```bash
git add lib/auto-update/trigger-sqlite.ts lib/auto-update/trigger-sqlite.test.ts
git commit -m "Add AutoUpdateTriggerSqlite safety checks (packaging dispatch wired in next task)"
```

---

## Task 9: Wire actual packaging-job creation into `AutoUpdateTriggerSqlite`

**Files:**
- Modify: `lib/auto-update/trigger-sqlite.ts`
- Modify: `lib/auto-update/check-updates.ts` (call `runAutoUpdatesForNewDetections` after upserting detections)
- Test: `lib/auto-update/trigger-sqlite.test.ts` (extend)

**Interfaces:**
- Consumes: `getDatabase().jobs.create()` (SQLite-native), `getLatestInstallerInfo(undefined, wingetId, architecture?, installScope?)` (Task 8 Step 1 made its first parameter optional — pass `undefined`), `triggerPackagingWorkflow`/`isGitHubActionsConfigured` from `lib/github-actions.ts` (already SQLite-safe per this session's memory — `enforceQaGate()` is guarded there), same `WorkflowInputs` construction already used by `app/api/updates/trigger/route.ts` (read in this plan's research phase, lines 274-443: installer resolution → `triggerResult.packagingJobId` → `WorkflowInputs` construction → `triggerPackagingWorkflow` call).

- [ ] **Step 1: Replace the `throw new Error('NOT_YET_WIRED')` block in `trigger-sqlite.ts`**

```typescript
    try {
      const installerResolution = await getLatestInstallerInfo(
        undefined,
        updateInfo.wingetId,
        (policy.deployment_config as DeploymentConfig).architecture,
        (policy.deployment_config as DeploymentConfig).installScope
      );
      if (!installerResolution.ok) {
        await sqliteUpdatePolicies.incrementFailureCount(policy.id);
        await sqliteAutoUpdateHistory.updateStatus(historyId, 'failed', {
          errorMessage: installerResolution.failure.message,
          completedAt: new Date().toISOString(),
        });
        return { success: false, error: installerResolution.failure.message, historyId };
      }
      const installerInfo = { ...installerResolution.info, currentVersion: updateInfo.currentVersion };

      const deploymentConfig = policy.deployment_config as DeploymentConfig;
      const db = getDatabase();
      const job = await db.jobs.create({
        user_id: policy.user_id,
        tenant_id: policy.tenant_id,
        winget_id: policy.winget_id,
        version: installerInfo.latestVersion,
        display_name: deploymentConfig.displayName,
        publisher: deploymentConfig.publisher,
        architecture: deploymentConfig.architecture,
        installer_type: installerInfo.installerType || deploymentConfig.installerType,
        installer_url: installerInfo.installerUrl,
        installer_sha256: installerInfo.installerSha256,
        install_command: deploymentConfig.installCommand,
        uninstall_command: deploymentConfig.uninstallCommand,
        install_scope: deploymentConfig.installScope,
        detection_rules: deploymentConfig.detectionRules,
        status: 'queued',
      });

      await sqliteAutoUpdateHistory.updateStatus(historyId, 'packaging', { packagingJobId: job.id });

      const { isGitHubActionsConfigured, triggerPackagingWorkflow } = await import('@/lib/github-actions');
      if (isGitHubActionsConfigured()) {
        const callbackUrl = `${process.env.CALLBACK_BASE_URL || process.env.NEXT_PUBLIC_APP_URL}/api/package/callback`;
        await triggerPackagingWorkflow({
          jobId: job.id,
          tenantId: policy.tenant_id,
          wingetId: policy.winget_id,
          displayName: deploymentConfig.displayName,
          description: `Auto-updated via IntuneGet from Winget: ${policy.winget_id}`,
          publisher: deploymentConfig.publisher,
          version: installerInfo.latestVersion,
          architecture: deploymentConfig.architecture,
          installerUrl: installerInfo.installerUrl,
          installerSha256: installerInfo.installerSha256 || '',
          installerType: installerInfo.installerType || deploymentConfig.installerType,
          uninstallCommand: deploymentConfig.uninstallCommand,
          callbackUrl,
          detectionRules: JSON.stringify(deploymentConfig.detectionRules),
          psadtConfig: deploymentConfig.psadtConfig ? JSON.stringify(deploymentConfig.psadtConfig) : undefined,
          installScope: (deploymentConfig.installScope === 'user' ? 'user' : 'machine') as 'machine' | 'user',
          forceCreate: deploymentConfig.forceCreateNewApp !== false,
        });
      }

      await sqliteUpdatePolicies.update(policy.id, policy.user_id, {
        // last_auto_update_at/version are not part of AppUpdatePolicyInput's
        // type; extend sqliteUpdatePolicies.update's accepted fields if the
        // compiler rejects this - see Task 2's signature, add the two fields
        // there if missing.
      });

      return { success: true, packagingJobId: job.id, historyId };
    } catch (error) {
      await sqliteUpdatePolicies.incrementFailureCount(policy.id);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await sqliteAutoUpdateHistory.updateStatus(historyId, 'failed', {
        errorMessage,
        completedAt: new Date().toISOString(),
      });
      return { success: false, error: errorMessage, historyId };
    }
```

- [ ] **Step 2: Add `last_auto_update_at`/`last_auto_update_version` to `sqliteUpdatePolicies.update`'s accepted fields (Task 2)**

In `lib/db/sqlite.ts`, extend the `update()` method's `data` parameter type and body (added in Task 2) with:
```typescript
    if (data.last_auto_update_at !== undefined) { sets.push('last_auto_update_at = ?'); values.push(data.last_auto_update_at); }
    if (data.last_auto_update_version !== undefined) { sets.push('last_auto_update_version = ?'); values.push(data.last_auto_update_version); }
```
and call it from Step 2's success path with `{ last_auto_update_at: new Date().toISOString(), last_auto_update_version: installerInfo.latestVersion }`.

- [ ] **Step 3: Wire `runAutoUpdatesForNewDetections` into `runUpdateCheck()`**

In `lib/auto-update/check-updates.ts`, after the `await sqliteUpdateChecks.upsertMany(allUpdates);` line, add:

```typescript
  const { runAutoUpdatesForNewDetections } = await import('./trigger-sqlite');
  const autoUpdateResult = await runAutoUpdatesForNewDetections(allUpdates);
  errors.push(...autoUpdateResult.errors);
```

And extend `RunUpdateCheckResult` to include `autoUpdates: { triggered: number; skipped: number; failed: number }`, returning `autoUpdateResult` in the final return statement. Update Task 6's route wiring in `app/api/cron/check-updates/route.ts` to use the real values instead of the `{ triggered: 0, skipped: 0, failed: 0 }` placeholder from Task 6 Step 5.

- [ ] **Step 4: Write a test for the full success path with a mocked GitHub Actions dispatch**

```typescript
// append to lib/auto-update/trigger-sqlite.test.ts
it('creates a packaging job and dispatches the workflow on success', async () => {
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

  const { sqliteDb, sqliteUpdatePolicies } = require('../db/sqlite');
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

  const { AutoUpdateTriggerSqlite } = require('./trigger-sqlite');
  const trigger = new AutoUpdateTriggerSqlite();
  const result = await trigger.triggerAutoUpdate(policy, {
    wingetId: '7zip.7zip', currentVersion: '22.0', latestVersion: '23.0',
    displayName: '7-Zip', installerUrl: 'https://x', installerSha256: 'a'.repeat(64), installerType: 'exe',
  });

  expect(result.success).toBe(true);
  expect(result.packagingJobId).toBeTruthy();
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/auto-update/trigger-sqlite.test.ts`
Expected: PASS (all three tests)

- [ ] **Step 6: Commit**

```bash
git add lib/auto-update/trigger-sqlite.ts lib/auto-update/check-updates.ts lib/db/sqlite.ts app/api/cron/check-updates/route.ts lib/auto-update/trigger-sqlite.test.ts
git commit -m "Wire packaging-job creation and workflow dispatch into AutoUpdateTriggerSqlite"
```

---

## Task 10: `isSqliteMode()` branches on the read/list routes

**Files:**
- Modify: `app/api/updates/available/route.ts` (GET, PATCH)
- Modify: `app/api/update-policies/route.ts` (GET, POST)
- Modify: `app/api/update-policies/[id]/route.ts` (GET, PATCH, DELETE)

**Interfaces:**
- Consumes: `sqliteUpdateChecks`, `sqliteUpdatePolicies` (Tasks 2/3), `AvailableUpdate` type (unchanged).

- [ ] **Step 1: `app/api/updates/available/route.ts` GET — add SQLite branch**

Before the existing `if (!isSupabaseServerConfigured())` check, add:

```typescript
import { isSqliteMode } from '@/lib/db';
import { sqliteUpdateChecks, sqliteUpdatePolicies } from '@/lib/db/sqlite';

// ...inside GET, after parsing searchParams:
if (isSqliteMode()) {
  const rows = await sqliteUpdateChecks.listByUser(user.userId, { tenantId: tenantId || undefined, includeDismissed, criticalOnly });
  const policies = await sqliteUpdatePolicies.listByUser(user.userId, tenantId || undefined);
  const policyMap = new Map(policies.map((p) => [`${p.winget_id}:${p.tenant_id}`, {
    id: p.id, policy_type: p.policy_type, is_enabled: p.is_enabled, pinned_version: p.pinned_version,
    last_auto_update_at: p.last_auto_update_at, last_auto_update_version: p.last_auto_update_version,
    consecutive_failures: p.consecutive_failures,
  }]));
  const updatesWithPolicies: AvailableUpdate[] = rows
    .map((update) => ({
      ...update,
      has_prior_deployment: true, // every update_check_results row in SQLite mode was built from upload_history
      policy: policyMap.get(`${update.winget_id}:${update.tenant_id}`) || null,
    }))
    .filter((u) => u.current_version !== 'Unknown')
    .filter((u) => compareVersions(u.current_version, u.latest_version) < 0)
    .filter((u) => u.policy?.last_auto_update_version !== u.latest_version)
    .filter((u) => includeUnmanaged || u.is_managed);
  const criticalCount = updatesWithPolicies.filter((u) => u.is_critical).length;
  return NextResponse.json({ updates: updatesWithPolicies, count: updatesWithPolicies.length, criticalCount });
}
```

- [ ] **Step 2: `app/api/updates/available/route.ts` PATCH — add SQLite branch**

Before `if (!isSupabaseServerConfigured())` in `PATCH`:

```typescript
if (isSqliteMode()) {
  const updated = await sqliteUpdateChecks.dismiss(user.userId, update_ids, action === 'dismiss');
  return NextResponse.json({ success: true, updated, action });
}
```

- [ ] **Step 3: `app/api/update-policies/route.ts` GET — add SQLite branch**

Replace the `if (!isSupabaseServerConfigured())` early-return (currently `{ policies: [], count: 0 }`) with an `isSqliteMode()` branch placed before it:

```typescript
import { isSqliteMode } from '@/lib/db';
import { sqliteUpdatePolicies } from '@/lib/db/sqlite';

// after parseAccessToken check:
if (isSqliteMode()) {
  const tenantId = request.nextUrl.searchParams.get('tenant_id') || undefined;
  const policies = await sqliteUpdatePolicies.listByUser(user.userId, tenantId);
  return NextResponse.json({ policies, count: policies.length });
}
```

- [ ] **Step 4: `app/api/update-policies/route.ts` POST — add SQLite branch**

Replace the body's structure so the SQLite branch reuses the same validation (winget_id/tenant_id/policy_type required, policy_type enum check) already present, then diverges at the DB write. Insert after the policy-type validation block and before `const supabase = createServerClient();`:

```typescript
if (isSqliteMode()) {
  let derivedPinnedVersion = body.pinned_version || null;
  let derivedDeploymentConfig: DeploymentConfig | null = body.deployment_config || null;
  let derivedOriginalUploadHistoryId = body.original_upload_history_id || null;

  if (body.policy_type === 'pin_version' && !derivedPinnedVersion) {
    const updateRow = await sqliteUpdateChecks.getOne(user.userId, body.tenant_id, body.winget_id);
    derivedPinnedVersion = updateRow?.current_version || null;
    if (!derivedPinnedVersion) {
      const db = getDatabase();
      const uploads = await db.uploadHistory.getByUserId(user.userId, 200);
      const latest = uploads.filter((u) => u.winget_id === body.winget_id && u.intune_tenant_id === body.tenant_id)[0];
      derivedPinnedVersion = latest?.version || null;
    }
    if (!derivedPinnedVersion) {
      return NextResponse.json({ error: 'pinned_version is required for pin_version policy' }, { status: 400 });
    }
  }

  if (body.policy_type === 'auto_update' && !derivedDeploymentConfig) {
    const updateRow = await sqliteUpdateChecks.getOne(user.userId, body.tenant_id, body.winget_id);
    let latestVersion = updateRow?.latest_version || '';
    if (!latestVersion) {
      const catalogApp = await getCatalogSource().getAppForInstaller(body.winget_id);
      latestVersion = catalogApp?.latest_version || '';
    }
    const built = await buildDeploymentConfigForApp({ userId: user.userId, tenantId: body.tenant_id, wingetId: body.winget_id, latestVersion });
    if (built.status !== 'ok') {
      return NextResponse.json({
        error: built.status === 'orphaned_job'
          ? 'Could not retrieve the saved deployment configuration for this app.'
          : 'Auto-update requires a prior deployment of this app, or the app must be in the catalog.',
      }, { status: 400 });
    }
    derivedDeploymentConfig = built.deploymentConfig;
    derivedOriginalUploadHistoryId = built.originalUploadHistoryId;
  }

  const { policy, created } = await sqliteUpdatePolicies.upsert(user.userId, {
    winget_id: body.winget_id,
    tenant_id: body.tenant_id,
    policy_type: body.policy_type,
    pinned_version: derivedPinnedVersion || undefined,
    deployment_config: derivedDeploymentConfig || undefined,
    original_upload_history_id: derivedOriginalUploadHistoryId || undefined,
    is_enabled: body.is_enabled,
  });
  return NextResponse.json({ policy, created });
}
```

Add `import { getDatabase } from '@/lib/db';` to this file's imports (needed for the pin_version fallback path).

- [ ] **Step 5: `app/api/update-policies/[id]/route.ts` GET/PATCH/DELETE — add SQLite branches**

GET, after the auth check:
```typescript
if (isSqliteMode()) {
  const policy = await sqliteUpdatePolicies.getById(id, user.userId);
  if (!policy) return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
  return NextResponse.json({ policy });
}
```

PATCH, after parsing `body` and before `const supabase = createServerClient();`:
```typescript
if (isSqliteMode()) {
  const existing = await sqliteUpdatePolicies.getById(id, user.userId);
  if (!existing) return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
  if (body.policy_type === 'pin_version' && !body.pinned_version && !existing.pinned_version) {
    return NextResponse.json({ error: 'pinned_version is required for pin_version policy' }, { status: 400 });
  }
  if (body.policy_type === 'auto_update' && !body.deployment_config && !existing.deployment_config) {
    return NextResponse.json({ error: 'deployment_config is required for auto_update policy' }, { status: 400 });
  }
  const updated = await sqliteUpdatePolicies.update(id, user.userId, {
    policy_type: body.policy_type,
    pinned_version: body.pinned_version,
    deployment_config: body.deployment_config,
    original_upload_history_id: body.original_upload_history_id,
    is_enabled: body.is_enabled,
    delay_days: body.delay_days,
  });
  return NextResponse.json({ policy: updated });
}
```

DELETE, after the auth check:
```typescript
if (isSqliteMode()) {
  const deleted = await sqliteUpdatePolicies.delete(id, user.userId);
  if (!deleted) return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
  return NextResponse.json({ success: true, deleted: true });
}
```

- [ ] **Step 6: Manual verification (build + curl each route)**

Run: `cd /opt/intuneget && docker compose build intuneget && docker compose up -d intuneget`
Then, with a valid bearer token (reuse the same token-acquisition approach as earlier callback tests in this session, or sign in via the browser and copy the token from devtools):
```bash
curl -H "Authorization: Bearer $TOKEN" https://iget.node1.buildtestrun.com/api/update-policies
curl -H "Authorization: Bearer $TOKEN" https://iget.node1.buildtestrun.com/api/updates/available
```
Expected: both return `200` with `{"policies":[],"count":0}` / `{"updates":[],"count":0,"criticalCount":0}` on a fresh instance (no error, no 503).

- [ ] **Step 7: Commit**

```bash
git add app/api/updates/available/route.ts app/api/update-policies/route.ts "app/api/update-policies/[id]/route.ts"
git commit -m "Add isSqliteMode() branches to update-policies and updates/available routes"
```

---

## Task 11: `app/api/updates/refresh` and `app/api/updates/trigger` — SQLite branches

**Files:**
- Modify: `app/api/updates/refresh/route.ts`
- Modify: `app/api/updates/trigger/route.ts`

**Interfaces:**
- Consumes: `runUpdateCheck()` (Task 6/9 — now includes auto-update triggering).

Per the spec's simplification: the Supabase-mode `refresh` route does a heavier *live Graph-based* rescan (`getLiveIntuneUpdates`) distinct from the cron's catalog-comparison approach. Porting that live-scan variant is unnecessary duplicate work — SQLite mode's on-demand refresh just re-runs the same `runUpdateCheck()` the scheduler uses, synchronously, so the user sees fresh results immediately without waiting for the next scheduled tick.

- [ ] **Step 1: `app/api/updates/refresh/route.ts` — add SQLite branch**

After the auth check, before `if (!isSupabaseServerConfigured())`:

```typescript
import { isSqliteMode } from '@/lib/db';
import { runUpdateCheck } from '@/lib/auto-update/check-updates';

if (isSqliteMode()) {
  const result = await runUpdateCheck();
  return NextResponse.json({
    success: result.errors.length === 0,
    refreshedCount: result.updatesFound,
    removedCount: 0,
    updateCount: result.updatesFound,
    matchingSummary: { totalChecked: result.usersChecked, noMatch: 0, lowConfidenceSkipped: 0, packageNotInCache: 0 },
    ...(result.errors.length > 0 ? { errors: result.errors } : {}),
  });
}
```

- [ ] **Step 2: `app/api/updates/trigger/route.ts` — add SQLite branch**

This route's job is "manually force this specific app's update right now, bypassing its policy's rate limits" — reuse `AutoUpdateTriggerSqlite` with `skipRateLimits: true`. After the `updateRequests` validation and length check, before `if (!isSupabaseServerConfigured())`:

```typescript
import { isSqliteMode } from '@/lib/db';
import { sqliteUpdateChecks, sqliteUpdatePolicies } from '@/lib/db/sqlite';
import { AutoUpdateTriggerSqlite } from '@/lib/auto-update/trigger-sqlite';
import { buildDeploymentConfigForApp } from '@/lib/update-policies/build-deployment-config';

if (isSqliteMode()) {
  const trigger = new AutoUpdateTriggerSqlite();
  const response: TriggerUpdateResponse = { success: true, triggered: 0, failed: 0, results: [] };

  for (const req of updateRequests) {
    if (isSelfUpdatingApp(req.winget_id)) {
      response.failed++;
      response.results.push({ winget_id: req.winget_id, tenant_id: req.tenant_id, success: false, error: `${req.winget_id} keeps itself up to date on the device (Click-to-Run); IntuneGet does not deploy updates for it.` });
      continue;
    }

    const updateResult = await sqliteUpdateChecks.getOne(user.userId, req.tenant_id, req.winget_id);
    if (!updateResult) {
      response.failed++;
      response.results.push({ winget_id: req.winget_id, tenant_id: req.tenant_id, success: false, error: 'Update not found' });
      continue;
    }

    let policy = await sqliteUpdatePolicies.getByApp(user.userId, req.tenant_id, req.winget_id);
    if (!policy) {
      const built = await buildDeploymentConfigForApp({ userId: user.userId, tenantId: req.tenant_id, wingetId: req.winget_id, latestVersion: updateResult.latest_version });
      if (built.status !== 'ok') {
        response.failed++;
        response.results.push({ winget_id: req.winget_id, tenant_id: req.tenant_id, success: false, error: built.status === 'orphaned_job' ? 'Could not retrieve deployment configuration' : 'No installer data or catalog entry available for this app.' });
        continue;
      }
      const { policy: newPolicy } = await sqliteUpdatePolicies.upsert(user.userId, {
        winget_id: req.winget_id, tenant_id: req.tenant_id, policy_type: 'notify',
        deployment_config: built.deploymentConfig, original_upload_history_id: built.originalUploadHistoryId || undefined,
      });
      policy = newPolicy;
    }

    const shouldTemporarilyEnable = policy.policy_type !== 'auto_update' || !policy.is_enabled;
    if (shouldTemporarilyEnable) {
      await sqliteUpdatePolicies.update(policy.id, user.userId, { policy_type: 'auto_update', is_enabled: true });
      policy = { ...policy, policy_type: 'auto_update', is_enabled: true };
    }

    const triggerResult = await trigger.triggerAutoUpdate(policy, {
      wingetId: req.winget_id,
      currentVersion: updateResult.current_version,
      latestVersion: updateResult.latest_version,
      displayName: updateResult.display_name,
      installerUrl: '', installerSha256: '', installerType: '',
    }, { skipRateLimits: true, skipPriorDeploymentCheck: true });

    if (shouldTemporarilyEnable && policy.policy_type !== 'auto_update') {
      // triggerAutoUpdate doesn't mutate the caller's policy_type back; restore
      // explicitly since manual trigger shouldn't permanently flip the policy.
      await sqliteUpdatePolicies.update(policy.id, user.userId, { policy_type: 'notify' });
    }

    if (triggerResult.success) {
      response.triggered++;
      response.results.push({ winget_id: req.winget_id, tenant_id: req.tenant_id, success: true, packaging_job_id: triggerResult.packagingJobId });
    } else {
      response.failed++;
      response.results.push({ winget_id: req.winget_id, tenant_id: req.tenant_id, success: false, error: triggerResult.error || triggerResult.skipReason || 'Unknown error' });
    }
  }

  response.success = response.failed === 0;
  return NextResponse.json(response);
}
```

Note the restore logic is simplified vs. the Supabase version (always resets to `notify` rather than tracking exact prior state) since a manually-triggered app that had no policy before this call is now correctly left at `notify`, not restored to "no policy" (SQLite mode always creates one, unlike Supabase's `restorePolicyState` dance which only applied to pre-existing policies).

- [ ] **Step 3: Manual verification**

After rebuilding/redeploying, use the Updates dashboard (`/dashboard/updates`) to click "Update Now" on a real detected update (if one exists) and confirm a packaging job appears in `/dashboard/uploads`.

- [ ] **Step 4: Commit**

```bash
git add app/api/updates/refresh/route.ts app/api/updates/trigger/route.ts
git commit -m "Add isSqliteMode() branches to updates/refresh and updates/trigger routes"
```

---

## Task 12: `app/api/updates/history` — SQLite branch

**Files:**
- Modify: `lib/db/sqlite.ts` (extend `sqliteAutoUpdateHistory` from Task 3 with a `listByUser` method)
- Modify: `app/api/updates/history/route.ts`

**Interfaces:**
- Produces: `sqliteAutoUpdateHistory.listByUser(userId: string, opts: { tenantId?: string; wingetId?: string; status?: string; limit: number; offset: number }): Promise<AutoUpdateHistoryWithPolicy[]>` — joins `auto_update_history` → `app_update_policies` → `packaging_jobs` in application code (three small SQLite queries; this endpoint is a low-traffic settings-page list, not a hot path, so a manual join beats hand-writing SQL joins against `better-sqlite3`'s synchronous API for marginal gain).

- [ ] **Step 1: Extend `sqliteAutoUpdateHistory` with `listByUser`**

In `lib/db/sqlite.ts`, add to the `sqliteAutoUpdateHistory` object (from Task 3):

```typescript
  async listByUser(
    userId: string,
    opts: { tenantId?: string; wingetId?: string; status?: string; limit: number; offset: number }
  ): Promise<Array<{
    id: string; policy_id: string; packaging_job_id: string | null; from_version: string;
    to_version: string; update_type: string; status: string; error_message: string | null;
    triggered_at: string; completed_at: string | null;
    policy: { winget_id: string; tenant_id: string }; display_name?: string;
  }>> {
    const database = getDb();
    const policyConditions = ['user_id = ?'];
    const policyValues: unknown[] = [userId];
    if (opts.tenantId) { policyConditions.push('tenant_id = ?'); policyValues.push(opts.tenantId); }
    if (opts.wingetId) { policyConditions.push('winget_id = ?'); policyValues.push(opts.wingetId); }
    const policies = database
      .prepare(`SELECT id, winget_id, tenant_id FROM app_update_policies WHERE ${policyConditions.join(' AND ')}`)
      .all(...policyValues) as Array<{ id: string; winget_id: string; tenant_id: string }>;

    if (policies.length === 0) return [];
    const policyMap = new Map(policies.map((p) => [p.id, p]));
    const policyIds = policies.map((p) => p.id);
    const placeholders = policyIds.map(() => '?').join(', ');

    const statusClause = opts.status ? 'AND status = ?' : '';
    const rows = database
      .prepare(`
        SELECT * FROM auto_update_history
        WHERE policy_id IN (${placeholders}) ${statusClause}
        ORDER BY triggered_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...policyIds, ...(opts.status ? [opts.status] : []), opts.limit, opts.offset) as Array<Record<string, unknown>>;

    const jobIds = rows.map((r) => r.packaging_job_id).filter((id): id is string => typeof id === 'string');
    const jobNames = new Map<string, string>();
    if (jobIds.length > 0) {
      const jobPlaceholders = jobIds.map(() => '?').join(', ');
      const jobs = database
        .prepare(`SELECT id, display_name FROM packaging_jobs WHERE id IN (${jobPlaceholders})`)
        .all(...jobIds) as Array<{ id: string; display_name: string }>;
      jobs.forEach((j) => jobNames.set(j.id, j.display_name));
    }

    return rows.map((r) => {
      const policy = policyMap.get(r.policy_id as string)!;
      return {
        id: r.id as string,
        policy_id: r.policy_id as string,
        packaging_job_id: r.packaging_job_id as string | null,
        from_version: r.from_version as string,
        to_version: r.to_version as string,
        update_type: r.update_type as string,
        status: r.status as string,
        error_message: r.error_message as string | null,
        triggered_at: r.triggered_at as string,
        completed_at: r.completed_at as string | null,
        policy: { winget_id: policy.winget_id, tenant_id: policy.tenant_id },
        display_name: r.packaging_job_id ? jobNames.get(r.packaging_job_id as string) : undefined,
      };
    });
  },
```

- [ ] **Step 2: Add the SQLite branch to `app/api/updates/history/route.ts`**

After parsing `limit`/`offset` and before `if (!isSupabaseServerConfigured())`:

```typescript
import { isSqliteMode } from '@/lib/db';
import { sqliteAutoUpdateHistory } from '@/lib/db/sqlite';

if (isSqliteMode()) {
  const history = await sqliteAutoUpdateHistory.listByUser(user.userId, {
    tenantId: tenantId || undefined,
    wingetId: wingetId || undefined,
    status: status && ['pending', 'packaging', 'deploying', 'completed', 'failed', 'cancelled'].includes(status) ? status : undefined,
    limit,
    offset,
  });
  return NextResponse.json({ history, count: history.length, hasMore: history.length === limit });
}
```

- [ ] **Step 3: Manual verification**

```bash
curl -H "Authorization: Bearer $TOKEN" "https://iget.node1.buildtestrun.com/api/updates/history?limit=10"
```
Expected: `200` with `{"history":[],"count":0,"hasMore":false}` on an instance with no auto-update history yet, or real rows once Task 9's auto-deploy has run at least once.

- [ ] **Step 4: Commit**

```bash
git add lib/db/sqlite.ts app/api/updates/history/route.ts
git commit -m "Add isSqliteMode() branch to updates/history route"
```

---

## Task 13: Notification event types — `notify-user.ts` deployed/error events

**Files:**
- Modify: `lib/notifications/notify-user.ts` (add two new exported functions alongside the existing `notifyUserOfPendingUpdates`)
- Modify: `app/api/package/callback/route.ts` (call the new functions from the existing `deployed`/`failed` branches)
- Test: `lib/notifications/notify-user.test.ts` (extend, if it exists — otherwise create)

**Interfaces:**
- Consumes: `sqliteWebhooks`, `sqliteNotificationPreferences` (Task 4), `deliverWebhook` from `lib/webhooks/service.ts` (already SQLite-agnostic — it takes a `WebhookConfiguration` object, not a DB client).
- Produces:
  - `notifyUserOfDeployedUpdate(userId: string, tenantId: string, info: { wingetId: string; displayName: string; version: string; intuneAppId: string }): Promise<void>` — SQLite-only (guarded internally by `isSqliteMode()`, no-ops in Supabase mode since that path keeps its existing behavior).
  - `notifyUserOfUpdateError(userId: string, tenantId: string, info: { wingetId: string; displayName: string; errorMessage: string }): Promise<void>` — same guard.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/notifications/notify-user.test.ts (new, or append if it already exists)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('SQLite-mode deployed/error notifications', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-notify-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
  });

  afterEach(() => {
    const { closeSqliteDb } = require('../db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('does not call deliverWebhook when notify_on_deployed is false', async () => {
    const { sqliteWebhooks, sqliteNotificationPreferences } = require('../db/sqlite');
    await sqliteWebhooks.create('user-1', { name: 'test', url: 'https://discord.com/api/webhooks/x/y', webhook_type: 'discord' });
    await sqliteNotificationPreferences.upsert('user-1', { notify_on_deployed: false });

    const deliverMock = vi.fn().mockResolvedValue({ success: true });
    vi.doMock('@/lib/webhooks/service', () => ({ deliverWebhook: deliverMock }));

    const { notifyUserOfDeployedUpdate } = require('./notify-user');
    await notifyUserOfDeployedUpdate('user-1', 'tenant-1', { wingetId: '7zip.7zip', displayName: '7-Zip', version: '23.0', intuneAppId: 'app-1' });

    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('calls deliverWebhook when notify_on_deployed is true (the default)', async () => {
    const { sqliteWebhooks } = require('../db/sqlite');
    await sqliteWebhooks.create('user-1', { name: 'test', url: 'https://discord.com/api/webhooks/x/y', webhook_type: 'discord' });

    const deliverMock = vi.fn().mockResolvedValue({ success: true });
    vi.doMock('@/lib/webhooks/service', () => ({ deliverWebhook: deliverMock }));

    const { notifyUserOfDeployedUpdate } = require('./notify-user');
    await notifyUserOfDeployedUpdate('user-1', 'tenant-1', { wingetId: '7zip.7zip', displayName: '7-Zip', version: '23.0', intuneAppId: 'app-1' });

    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/notifications/notify-user.test.ts`
Expected: FAIL — `notifyUserOfDeployedUpdate` doesn't exist yet.

- [ ] **Step 3: Implement the two functions**

Append to `lib/notifications/notify-user.ts`:

```typescript
import { isSqliteMode } from '@/lib/db';
import { sqliteWebhooks, sqliteNotificationPreferences } from '@/lib/db/sqlite';
import { deliverWebhook } from '@/lib/webhooks/service';

export async function notifyUserOfDeployedUpdate(
  userId: string,
  tenantId: string,
  info: { wingetId: string; displayName: string; version: string; intuneAppId: string }
): Promise<void> {
  if (!isSqliteMode()) return;
  const prefs = await sqliteNotificationPreferences.get(userId);
  if (prefs && (!prefs.webhook_enabled || !prefs.notify_on_deployed)) return;

  const webhooks = await sqliteWebhooks.listByUser(userId);
  const enabledWebhooks = webhooks.filter((w) => w.is_enabled);
  if (enabledWebhooks.length === 0) return;

  const payload: NotificationPayload = {
    event: 'app_deployed',
    timestamp: new Date().toISOString(),
    tenant_id: tenantId,
    updates: [{ app_name: info.displayName, winget_id: info.wingetId, intune_app_id: info.intuneAppId, current_version: '', latest_version: info.version, is_critical: false }],
    summary: { total: 1, critical: 0 },
  };

  for (const webhook of enabledWebhooks) {
    await deliverWebhook(webhook, payload).catch((err) => console.error(`[Notify] Deployed-webhook to ${webhook.name} failed:`, err));
  }
}

export async function notifyUserOfUpdateError(
  userId: string,
  tenantId: string,
  info: { wingetId: string; displayName: string; errorMessage: string }
): Promise<void> {
  if (!isSqliteMode()) return;
  const prefs = await sqliteNotificationPreferences.get(userId);
  if (prefs && (!prefs.webhook_enabled || !prefs.notify_on_error)) return;

  const webhooks = await sqliteWebhooks.listByUser(userId);
  const enabledWebhooks = webhooks.filter((w) => w.is_enabled);
  if (enabledWebhooks.length === 0) return;

  const payload: NotificationPayload = {
    event: 'app_update_error',
    timestamp: new Date().toISOString(),
    tenant_id: tenantId,
    updates: [{ app_name: info.displayName, winget_id: info.wingetId, intune_app_id: '', current_version: '', latest_version: '', is_critical: false }],
    summary: { total: 1, critical: 0 },
  };
  void payload; // include error text in a channel-specific format inside deliverWebhook's formatter (Step 3a)

  for (const webhook of enabledWebhooks) {
    await deliverWebhook(webhook, { ...payload, error_message: info.errorMessage } as NotificationPayload).catch((err) => console.error(`[Notify] Error-webhook to ${webhook.name} failed:`, err));
  }
}
```

- [ ] **Step 3a: Check `NotificationPayload` and `lib/webhooks/formatters.ts` accept the new `event` values**

Run: `grep -n "event:" /opt/intuneget/app/types/notifications.ts` and `grep -n "app_updates_available\|case '" /opt/intuneget/app/lib/webhooks/formatters.ts`. If `NotificationPayload['event']` is a narrow union (likely `'app_updates_available'` only) and `formatters.ts` switches on it, add the two new literal values to the union in `types/notifications.ts` and a matching case in each formatter (Discord/Slack/Teams/custom) that at minimum passes the message through — mirror the existing `app_updates_available` case's structure exactly, substituting a "deployed" / "error" title and using `info.errorMessage`/`error_message` in the error case's body text. Do not invent a new formatter architecture — extend the existing switch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/notifications/notify-user.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into the callback route**

In `app/api/package/callback/route.ts`, inside the existing `if (data.status === 'deployed' && data.intuneAppId)` block (right after the `upload_history.create` call this session already added the claim-sync fix next to), add:

```typescript
      if (isSqliteMode()) {
        const { notifyUserOfDeployedUpdate } = await import('@/lib/notifications/notify-user');
        await notifyUserOfDeployedUpdate(currentJob.user_id, currentJob.tenant_id || '', {
          wingetId: currentJob.winget_id,
          displayName: currentJob.display_name,
          version: currentJob.version,
          intuneAppId: data.intuneAppId,
        }).catch((err) => console.error('[Callback] Deployed notification failed:', err));
      }
```

And inside the existing `if (data.status === 'failed')` block:

```typescript
      if (isSqliteMode()) {
        const { notifyUserOfUpdateError } = await import('@/lib/notifications/notify-user');
        await notifyUserOfUpdateError(currentJob.user_id, currentJob.tenant_id || '', {
          wingetId: currentJob.winget_id,
          displayName: currentJob.display_name,
          errorMessage: data.message || 'Unknown error',
        }).catch((err) => console.error('[Callback] Error notification failed:', err));
      }
```

`isSqliteMode` is already imported in this file from Task from this session's earlier claim-sync fix (`app/api/package/callback/route.ts` already imports it — confirm before adding a duplicate import).

- [ ] **Step 6: Update `runAutoUpdatesForNewDetections` (Task 8/9) to also fire the "update available" notification**

In `lib/auto-update/check-updates.ts`, before the `runAutoUpdatesForNewDetections` call (or inside `runUpdateCheck`, right after `upsertMany`), add a loop that sends the update-available notification for genuinely new detections (where `notified_at` was `null` going in):

```typescript
  const { notifyUserOfWebhookOnly } = await import('@/lib/notifications/notify-user-sqlite-available');
```

Actually — do not create a third module. Instead, reuse the existing `notifyUserOfPendingUpdates` shape is Supabase-specific (takes a `SupabaseClient`); for SQLite mode, add a small local helper inline in `check-updates.ts` since it's only ever called from here:

```typescript
  const newlyDetected = allUpdates.filter((u) => u.notified_at === null);
  if (newlyDetected.length > 0) {
    const { sqliteWebhooks, sqliteNotificationPreferences } = await import('@/lib/db/sqlite');
    const { deliverWebhook } = await import('@/lib/webhooks/service');
    const byUser = new Map<string, typeof newlyDetected>();
    newlyDetected.forEach((u) => {
      if (!byUser.has(u.user_id)) byUser.set(u.user_id, []);
      byUser.get(u.user_id)!.push(u);
    });
    for (const [userId, userUpdates] of byUser) {
      const prefs = await sqliteNotificationPreferences.get(userId);
      if (prefs && (!prefs.webhook_enabled || !prefs.notify_on_update_available)) continue;
      const webhooks = (await sqliteWebhooks.listByUser(userId)).filter((w) => w.is_enabled);
      if (webhooks.length === 0) continue;
      const payload = {
        event: 'app_updates_available' as const,
        timestamp: new Date().toISOString(),
        tenant_id: userUpdates[0].tenant_id,
        updates: userUpdates.map((u) => ({ app_name: u.display_name, winget_id: u.winget_id, intune_app_id: u.intune_app_id, current_version: u.current_version, latest_version: u.latest_version, is_critical: u.is_critical })),
        summary: { total: userUpdates.length, critical: userUpdates.filter((u) => u.is_critical).length },
      };
      for (const webhook of webhooks) {
        await deliverWebhook(webhook, payload).catch((err) => errors.push(`Webhook to ${webhook.name} failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }
```

Place this block in `lib/auto-update/check-updates.ts` right after `await sqliteUpdateChecks.upsertMany(allUpdates);` and before the `runAutoUpdatesForNewDetections` call from Task 9 Step 4.

- [ ] **Step 7: Commit**

```bash
git add lib/notifications/notify-user.ts lib/notifications/notify-user.test.ts app/api/package/callback/route.ts lib/auto-update/check-updates.ts types/notifications.ts lib/webhooks/formatters.ts
git commit -m "Add deployed/error notification events alongside existing update-available"
```

---

## Task 14: Notification preferences route — SQLite branch

**Files:**
- Modify: `app/api/notifications/preferences/route.ts`

**Interfaces:**
- Consumes: `sqliteNotificationPreferences` (Task 4).

- [ ] **Step 1: GET — add SQLite branch**

Replace the `if (!isSupabaseServerConfigured())` default-preferences early return with an `isSqliteMode()` branch placed before it that reads real stored preferences (not hardcoded defaults):

```typescript
import { isSqliteMode } from '@/lib/db';
import { sqliteNotificationPreferences } from '@/lib/db/sqlite';
import { isEmailConfigured } from '@/lib/email/service';

if (isSqliteMode()) {
  const prefs = await sqliteNotificationPreferences.get(user.userId);
  return NextResponse.json({
    preferences: prefs || {
      user_id: user.userId, email_enabled: false, email_frequency: 'daily', email_address: null,
      notify_critical_only: false, webhook_enabled: true,
      notify_on_update_available: true, notify_on_deployed: true, notify_on_error: true,
    },
    isEmailConfigured: isEmailConfigured(),
  });
}
```

- [ ] **Step 2: PUT — add SQLite branch**

Replace the `if (!isSupabaseServerConfigured())` 503 early-return with an `isSqliteMode()` branch, keeping the existing `email_frequency`/`email_address` validation above it unchanged:

```typescript
if (isSqliteMode()) {
  const updated = await sqliteNotificationPreferences.upsert(user.userId, {
    email_enabled: body.email_enabled,
    email_frequency: body.email_frequency as 'immediate' | 'daily' | 'weekly' | undefined,
    email_address: body.email_address || (user.userEmail && user.userEmail !== 'unknown' ? user.userEmail : null),
    notify_critical_only: body.notify_critical_only,
    webhook_enabled: (body as { webhook_enabled?: boolean }).webhook_enabled,
    notify_on_update_available: (body as { notify_on_update_available?: boolean }).notify_on_update_available,
    notify_on_deployed: (body as { notify_on_deployed?: boolean }).notify_on_deployed,
    notify_on_error: (body as { notify_on_error?: boolean }).notify_on_error,
  });

  let testEmailResult = null;
  if (body.sendTestEmail && body.email_enabled) {
    const emailAddress = body.email_address || user.userEmail;
    if (emailAddress && isEmailConfigured()) {
      testEmailResult = await sendTestEmail(emailAddress);
    }
  }

  return NextResponse.json({
    preferences: updated,
    testEmailSent: testEmailResult?.success ?? false,
    testEmailError: testEmailResult?.error,
  });
}
```

- [ ] **Step 3: Extend `NotificationPreferencesInput` (types/notifications.ts) with the three new optional fields**

```typescript
export interface NotificationPreferencesInput {
  email_enabled?: boolean;
  email_frequency?: EmailFrequency;
  email_address?: string | null;
  notify_critical_only?: boolean;
  webhook_enabled?: boolean;
  notify_on_update_available?: boolean;
  notify_on_deployed?: boolean;
  notify_on_error?: boolean;
}
```

This also lets Step 2 above drop the `as { ... }` casts once the type includes these fields — simplify Step 2's body to read `body.webhook_enabled` etc. directly after this change.

- [ ] **Step 4: Manual verification**

```bash
curl -H "Authorization: Bearer $TOKEN" https://iget.node1.buildtestrun.com/api/notifications/preferences
```
Expected: `200` with the full 9-field preferences object (not the old 4-field default), `isEmailConfigured: false` (no SMTP configured on this instance per this session's earlier finding).

- [ ] **Step 5: Commit**

```bash
git add app/api/notifications/preferences/route.ts types/notifications.ts
git commit -m "Add isSqliteMode() branch and extended fields to notification preferences route"
```

---

## Task 15: Notification settings UI — webhook toggle + event checkboxes

**Files:**
- Modify: `components/settings/NotificationSettings.tsx`

**Interfaces:**
- Consumes: the extended `NotificationPreferencesInput`/response shape from Task 14.

- [ ] **Step 1: Extend the `preferences` state's initial shape**

```typescript
  const [preferences, setPreferences] = useState<Partial<NotificationPreferences> & {
    webhook_enabled?: boolean;
    notify_on_update_available?: boolean;
    notify_on_deployed?: boolean;
    notify_on_error?: boolean;
  }>({
    email_enabled: false,
    email_frequency: 'daily',
    email_address: null,
    notify_critical_only: false,
    webhook_enabled: true,
    notify_on_update_available: true,
    notify_on_deployed: true,
    notify_on_error: true,
  });
```

- [ ] **Step 2: Add the webhook toggle, following the exact pattern of the existing "Enable Email Notifications" toggle at line ~168**

Insert immediately after the closing `</div>` of the "Critical only" block (after line 270 in the current file):

```tsx
        {/* Webhook toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-text-primary font-medium">Enable Webhook Notifications</p>
            <p className="text-sm text-text-secondary">Send alerts to your configured Discord/Slack/Teams webhooks</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={preferences.webhook_enabled ?? true}
              onChange={(e) => setPreferences({ ...preferences, webhook_enabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className={cn(
              "w-11 h-6 rounded-full transition-colors",
              "bg-overlay/10 peer-checked:bg-accent-cyan",
              "peer-focus:ring-2 peer-focus:ring-accent-cyan/20",
              "after:content-[''] after:absolute after:top-[2px] after:left-[2px]",
              "after:bg-white after:rounded-full after:h-5 after:w-5",
              "after:transition-transform peer-checked:after:translate-x-5",
              "after:shadow-sm"
            )} />
          </label>
        </div>

        {/* Event type checkboxes */}
        <div className="space-y-3">
          <p className="text-text-primary font-medium">Notify me about</p>
          {([
            { key: 'notify_on_update_available' as const, label: 'Update available', description: 'A newer version was detected for a deployed app' },
            { key: 'notify_on_deployed' as const, label: 'Deployed', description: 'An auto-update finished deploying to Intune' },
            { key: 'notify_on_error' as const, label: 'Errors', description: 'An auto-update failed' },
          ]).map(({ key, label, description }) => (
            <div key={key} className="flex items-center justify-between pl-2">
              <div>
                <p className="text-text-primary text-sm">{label}</p>
                <p className="text-xs text-text-secondary">{description}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={preferences[key] ?? true}
                  onChange={(e) => setPreferences({ ...preferences, [key]: e.target.checked })}
                  className="sr-only peer"
                />
                <div className={cn(
                  "w-11 h-6 rounded-full transition-colors",
                  "bg-overlay/10 peer-checked:bg-accent-cyan",
                  "peer-focus:ring-2 peer-focus:ring-accent-cyan/20",
                  "after:content-[''] after:absolute after:top-[2px] after:left-[2px]",
                  "after:bg-white after:rounded-full after:h-5 after:w-5",
                  "after:transition-transform peer-checked:after:translate-x-5",
                  "after:shadow-sm"
                )} />
              </label>
            </div>
          ))}
        </div>
```

- [ ] **Step 3: Confirm `handleSave`'s PUT body already includes the new fields**

The existing `handleSave` spreads `...preferences` into the PUT body (seen at line ~86-89 of the current file), so no change needed there — the new fields ride along automatically once they're in `preferences` state.

- [ ] **Step 4: Manual verification**

Run: `cd /opt/intuneget && docker compose build intuneget && docker compose up -d intuneget`
Then in the browser, navigate to Settings → Notifications, toggle the new webhook switch and two of the three event checkboxes off, click Save, refresh the page, confirm the toggles persisted in their new state (proves the round-trip through Task 13's route and Task 4's SQLite module).

- [ ] **Step 5: Commit**

```bash
git add components/settings/NotificationSettings.tsx
git commit -m "Add webhook toggle and per-event notification checkboxes to settings UI"
```

---

## Task 16: End-to-end verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-update-detection-autodeploy-design.md` (mark implemented)
- No code changes — this task is entirely verification.

- [ ] **Step 1: Rebuild and deploy**

```bash
cd /opt/intuneget && docker compose build intuneget && docker compose up -d intuneget
sleep 15 && docker ps --filter name=intuneget --format "{{.Names}}: {{.Status}}"
docker logs intuneget --since 1m 2>&1 | grep -i "Scheduler] Starting"
```
Expected: container healthy, scheduler log line present.

- [ ] **Step 2: Set an already-deployed app's policy to `auto_update` with `delay_days: 0`**

Via the `/dashboard/updates` UI (or `curl -X POST .../api/update-policies` directly), set a real deployed app (e.g. 7-Zip) to `auto_update`, `delay_days: 0`.

- [ ] **Step 3: Manually trigger a check (don't wait 24h)**

```bash
curl -H "Authorization: Bearer $(grep CRON_SECRET /opt/intuneget/.env | cut -d= -f2)" https://iget.node1.buildtestrun.com/api/cron/check-updates
```

- [ ] **Step 4: Confirm outcome**

- If the catalog's `latest_version` for that app is genuinely newer than what's deployed: confirm a new row appears in `/dashboard/uploads` (a new packaging job), and a webhook notification arrived (if `notify_on_update_available`/`notify_on_deployed` are enabled).
- If not (nothing newer available right now): confirm the route still returns `200` with `updatesFound: 0` and no errors — this is the realistic outcome most of the time and is a valid pass condition.

- [ ] **Step 5: Update the spec's Status line**

```markdown
Status: implemented 2026-09-DD, verified end-to-end on the lab tenant.
```

- [ ] **Step 6: Update `backlog_intuneget_lab_pilot.md` item 9b to DONE** (memory file, not a repo file — done by the assistant driving this plan, not a git-tracked step)

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-12-update-detection-autodeploy-design.md
git commit -m "Mark update-detection + auto-deploy spec as implemented"
git push origin HEAD
```
