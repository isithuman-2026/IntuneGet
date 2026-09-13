# Inventory Edit-and-Redeploy + Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the real "Carry over assignments" / "Supersede previous version" settings toggle (currently a silent no-op in SQLite mode), wire that setting into `AutoUpdateTriggerSqlite` so auto-updates actually supersede in place instead of duplicating, then add Inventory-view editing (instant metadata edits, confirmed repackage-and-redeploy for package-affecting edits) and a rollback-to-prior-version action for apps IntuneGet deployed.

**Architecture:** A new `sqliteUserSettings` module (mirrors the existing `sqliteNotificationPreferences` single-row-per-user pattern) backs a fixed `app/api/user/settings/route.ts`. `AutoUpdateTriggerSqlite` reads that setting and forwards the already-existing-but-unused `WorkflowInputs` supersedence fields. A new `app/api/intune/apps/[intuneAppId]/edit/route.ts` splits edits into an instant Graph-PATCH path (assignments/categories/notifications/policy/delay_days) and a staged repackage path (install/uninstall command, detection rules) that reuses the fixed `AutoUpdateTriggerSqlite` pipeline. Rollback is the same staged path pointed at an older `packaging_jobs` row instead of the latest catalog version.

**Tech Stack:** Next.js 16 (App Router), TypeScript, `better-sqlite3`, existing Microsoft Graph helpers in `lib/intune-api.ts`, existing `lib/github-actions.ts` workflow dispatch, React Query hooks pattern already used in `hooks/use-inventory.ts`/`hooks/use-updates.ts`.

**Spec:** `docs/superpowers/specs/2026-09-13-inventory-redeploy-rollback-design.md`

**Scope note (deviation from spec, decided during planning):** the spec's
"editable fields" list includes assignments/categories as instant-path
edits. The *backend* for this ships in Task 6 (assignments/categories
apply via Graph, same as every other instant field). The *UI* for
picking/editing assignment groups and categories is a full group-picker
surface (matching the existing `CartItemConfig.tsx`/`PackageConfig.tsx`
complexity) that doesn't fit one bite-sized task alongside everything else
in this plan — Task 9 ships the Edit toggle and policy/delay editing UI
only, and explicitly calls out assignment/category editing UI as a
fast-follow. The spec's acceptance criteria bullet covering this should be
read as backend-complete, UI-phased for this plan.

## Global Constraints

- Every modified route: the Supabase code path is left completely untouched — only add an `isSqliteMode()` branch before it, exactly mirroring the pattern from the 2026-09-12 plan (e.g. `app/api/notifications/preferences/route.ts`).
- No `DatabaseAdapter` interface changes — new SQLite modules are standalone exports from `lib/db/sqlite.ts`, same as `sqliteNotificationPreferences`/`sqliteUpdatePolicies`.
- No new npm dependencies.
- Single-tenant SQLite mode: no MSP/multi-tenant lookups in any new SQLite-mode code path — use `user.tenantId`/`user.userId` directly.
- `carryOverAssignments`/`supersedePreviousApp` default to `false` (matching `DEFAULT_USER_SETTINGS` in `types/user-settings.ts:26-27`) — never assume `true`.
- The edit-and-redeploy and rollback capabilities apply only to apps with an `upload_history` row for the current tenant (IntuneGet-deployed apps) — every new route enforces this with a 404, and the UI mirrors the same gate so it never shows an edit affordance that will 404.
- Win32LobApp objects are immutable per version in Graph: "replace in place" is implemented as create-new + supersede-old (`autoSupersede`/`sourceIntuneAppId`/`supersedenceType`), never a PATCH of the existing app object's package.

---

## Task 1: SQLite schema + `sqliteUserSettings` module

**Files:**
- Modify: `lib/db/sqlite.ts` (the `initializeSchema()` function, after the existing `notification_preferences` block)
- Test: `lib/db/__tests__/sqlite-user-settings.test.ts` (new)

**Interfaces:**
- Consumes: `UserSettings`, `UserSettingsUpdate`, `DEFAULT_USER_SETTINGS` from `types/user-settings.ts` (already defined, unchanged).
- Produces:
  - `sqliteUserSettings.get(userId: string): Promise<UserSettings | null>` — `null` when no row exists yet.
  - `sqliteUserSettings.upsert(userId: string, update: Partial<UserSettings>): Promise<UserSettings>` — merges `update` over the existing stored settings (or over `DEFAULT_USER_SETTINGS` if none stored yet), same merge-over-existing semantics as the Supabase route's `PATCH` handler.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/db/__tests__/sqlite-user-settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('sqliteUserSettings', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-user-settings-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
  });

  afterEach(() => {
    const { closeSqliteDb } = require('../sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
  });

  it('creates the user_settings table on first access', () => {
    const { sqliteDb } = require('../sqlite');
    sqliteDb.jobs.getStats();

    const Database = require('better-sqlite3');
    const db = new Database(tmpDbPath, { readonly: true });
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tableNames).toContain('user_settings');
    db.close();
  });

  it('get returns null when no row exists', async () => {
    const { sqliteUserSettings } = require('../sqlite');
    expect(await sqliteUserSettings.get('user-1')).toBeNull();
  });

  it('upsert creates a row merged over DEFAULT_USER_SETTINGS, then merges again over the stored row', async () => {
    const { sqliteUserSettings } = require('../sqlite');
    const { DEFAULT_USER_SETTINGS } = require('@/types/user-settings');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/__tests__/sqlite-user-settings.test.ts`
Expected: FAIL — `user_settings` table and `sqliteUserSettings` don't exist yet.

- [ ] **Step 3: Add the table and module**

In `lib/db/sqlite.ts`, after the `notification_preferences` table block in `initializeSchema()`, add:

```typescript
  // Create user_settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      settings TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
```

Then, near the other module-level exports (after `sqliteNotificationPreferences`), add:

```typescript
import type { UserSettings } from '@/types/user-settings';
import { DEFAULT_USER_SETTINGS } from '@/types/user-settings';

export const sqliteUserSettings = {
  async get(userId: string): Promise<UserSettings | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT settings FROM user_settings WHERE user_id = ?')
      .get(userId) as { settings: string } | undefined;
    if (!row) return null;
    return { ...DEFAULT_USER_SETTINGS, ...JSON.parse(row.settings) };
  },

  async upsert(userId: string, update: Partial<UserSettings>): Promise<UserSettings> {
    const database = getDb();
    const existing = await this.get(userId);
    const merged: UserSettings = { ...(existing ?? DEFAULT_USER_SETTINGS), ...update };
    const now = new Date().toISOString();

    const result = database
      .prepare('UPDATE user_settings SET settings = ?, updated_at = ? WHERE user_id = ?')
      .run(JSON.stringify(merged), now, userId);

    if (result.changes === 0) {
      database
        .prepare('INSERT INTO user_settings (id, user_id, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), userId, JSON.stringify(merged), now, now);
    }

    return merged;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/__tests__/sqlite-user-settings.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/db/sqlite.ts lib/db/__tests__/sqlite-user-settings.test.ts
git commit -m "Add sqliteUserSettings module and user_settings SQLite table"
```

---

## Task 2: `app/api/user/settings/route.ts` — SQLite branches

**Files:**
- Modify: `app/api/user/settings/route.ts`
- Test: `app/api/user/settings/route.test.ts` (new)

**Interfaces:**
- Consumes: `sqliteUserSettings` (Task 1), `isSqliteMode()` from `@/lib/db`, the route's own existing `sanitizeSettings()` helper (unchanged).

- [ ] **Step 1: Write the failing test**

```typescript
// app/api/user/settings/route.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('GET/PATCH /api/user/settings (SQLite mode)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-user-settings-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1' }),
    }));
  });

  afterEach(() => {
    const { closeSqliteDb } = require('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('GET returns defaults with hasStoredSettings false when nothing saved', async () => {
    const { GET } = require('./route');
    const response = await GET(new Request('http://x/api/user/settings', {
      headers: { Authorization: 'Bearer x' },
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.settings.carryOverAssignments).toBe(false);
    expect(body.settings.supersedePreviousApp).toBe(false);
    expect(body.hasStoredSettings).toBe(false);
  });

  it('PATCH saves and GET reflects it (no 503)', async () => {
    const { PATCH, GET } = require('./route');
    const patchResponse = await PATCH(new Request('http://x/api/user/settings', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ carryOverAssignments: true, supersedePreviousApp: true }),
    }));
    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json();
    expect(patchBody.settings.carryOverAssignments).toBe(true);
    expect(patchBody.hasStoredSettings).toBe(true);

    const getResponse = await GET(new Request('http://x/api/user/settings', {
      headers: { Authorization: 'Bearer x' },
    }));
    const getBody = await getResponse.json();
    expect(getBody.settings.supersedePreviousApp).toBe(true);
    expect(getBody.hasStoredSettings).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run app/api/user/settings/route.test.ts`
Expected: FAIL — `PATCH` currently returns 503 in SQLite mode.

- [ ] **Step 3: Add the SQLite branches**

In `app/api/user/settings/route.ts`, add the import:

```typescript
import { isSqliteMode } from '@/lib/db';
import { sqliteUserSettings } from '@/lib/db/sqlite';
```

In `GET`, replace the `if (!isSupabaseServerConfigured())` block:

```typescript
    if (isSqliteMode()) {
      const stored = await sqliteUserSettings.get(user.userId);
      return NextResponse.json({
        settings: { ...DEFAULT_USER_SETTINGS, ...(stored ?? {}) },
        hasStoredSettings: stored !== null,
      });
    }

    if (!isSupabaseServerConfigured()) {
```

In `PATCH`, replace the `if (!isSupabaseServerConfigured())` 503 block:

```typescript
    if (isSqliteMode()) {
      const payload = (await request.json()) as Record<string, unknown>;
      const settingsUpdate = sanitizeSettings(payload);
      if (Object.keys(settingsUpdate).length === 0) {
        return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 });
      }
      const updated = await sqliteUserSettings.upsert(user.userId, settingsUpdate);
      return NextResponse.json({ settings: updated, hasStoredSettings: true });
    }

    if (!isSupabaseServerConfigured()) {
```

Note: `PATCH`'s existing `const payload = (await request.json())...` line (currently below the Supabase check) must be moved above both branches or duplicated exactly as shown — `request.json()` can only be read once. Move the existing `payload`/`settingsUpdate`/empty-check lines to before the `isSqliteMode()` branch, and delete the duplicate that would otherwise remain in the Supabase path below (the Supabase path continues to use the same `settingsUpdate` variable, not a fresh one).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run app/api/user/settings/route.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Run the existing Supabase-mode tests for this route (if any) to confirm no regression**

Run: `cd /opt/intuneget/app && npx vitest run app/api/user`
Expected: PASS — no existing test in this directory should break (the Supabase branch is unmoved logic, just relocated `payload` parsing).

- [ ] **Step 6: Commit**

```bash
git add app/api/user/settings/route.ts app/api/user/settings/route.test.ts
git commit -m "Add isSqliteMode() branch to user settings route (fixes silent 503 on Cart Behaviour toggles)"
```

---

## Task 3: Wire supersedence + assignment carry-over into `AutoUpdateTriggerSqlite`

**Files:**
- Modify: `lib/auto-update/trigger-sqlite.ts`
- Test: `lib/auto-update/__tests__/trigger-sqlite.test.ts` (extend if it exists, else new — check for an existing test file for this class before creating one)

**Interfaces:**
- Consumes: `sqliteUserSettings.get()` (Task 1), `UpdateInfo.currentIntuneAppId` (already declared in `lib/auto-update/trigger.ts:68`, just never populated for the SQLite path).
- Produces: no new exports — the fix is internal to `triggerAutoUpdate()` and its caller `runAutoUpdatesForNewDetections()`.

- [ ] **Step 1: Write the failing test**

First check whether `lib/auto-update/__tests__/trigger-sqlite.test.ts` already exists (it likely does, from the 2026-09-12 plan's Task 8/9). If it exists, add this test to it; if not, create it following the mocking pattern used by `lib/auto-update/__tests__/check-updates.test.ts` in this same directory (mock `@/lib/github-actions`'s `triggerPackagingWorkflow`/`isGitHubActionsConfigured`, mock `@/lib/intune/graph-client`'s `getServicePrincipalToken` to return a truthy token).

```typescript
// append to lib/auto-update/__tests__/trigger-sqlite.test.ts
it('passes supersedence and assignment-carryover fields when supersedePreviousApp is enabled and a currentIntuneAppId is known', async () => {
  const { sqliteDb, sqliteUpdatePolicies, sqliteUserSettings } = require('@/lib/db/sqlite');
  await sqliteUserSettings.upsert('user-1', {
    carryOverAssignments: true,
    supersedePreviousApp: true,
  });
  const { policy } = await sqliteUpdatePolicies.upsert('user-1', {
    winget_id: 'VideoLAN.VLC',
    tenant_id: 'tenant-1',
    policy_type: 'auto_update',
    deployment_config: {
      displayName: 'VLC', publisher: 'VideoLAN', architecture: 'x64',
      installerType: 'exe', installCommand: 'x', uninstallCommand: 'x',
      installScope: 'machine', detectionRules: [],
      assignments: [{ '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }],
      categories: [{ id: 'cat-1', displayName: 'Utilities' }],
    },
    original_upload_history_id: 'hist-1',
  });

  vi.doMock('@/lib/github-actions', () => ({
    isGitHubActionsConfigured: () => true,
    triggerPackagingWorkflow: vi.fn().mockResolvedValue({ success: true }),
  }));
  vi.doMock('@/lib/intune/graph-client', () => ({
    getServicePrincipalToken: async () => 'fake-token',
  }));
  vi.doMock('./trigger', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./trigger')>();
    return {
      ...actual,
      getLatestInstallerInfo: async () => ({
        ok: true,
        info: { installerUrl: 'https://x/vlc.exe', installerSha256: 'abc', installerType: 'exe', silentSwitches: '', latestVersion: '3.0.23' },
      }),
    };
  });

  const { AutoUpdateTriggerSqlite } = require('../trigger-sqlite');
  const trigger = new AutoUpdateTriggerSqlite();
  await trigger.triggerAutoUpdate(policy, {
    wingetId: 'VideoLAN.VLC',
    currentVersion: '3.0.22',
    latestVersion: '3.0.23',
    displayName: 'VLC',
    installerUrl: '', installerSha256: '', installerType: '',
    currentIntuneAppId: 'existing-app-id-123',
  });

  const { triggerPackagingWorkflow } = require('@/lib/github-actions');
  expect(triggerPackagingWorkflow).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceIntuneAppId: 'existing-app-id-123',
      autoSupersede: true,
      supersedenceType: 'update',
      carryOverAssignments: true,
      removeAssignmentsFromPreviousApp: true,
      assignments: JSON.stringify([{ '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }]),
      categories: JSON.stringify([{ id: 'cat-1', displayName: 'Utilities' }]),
    })
  );
});

it('defaults autoSupersede/carryOverAssignments to false when the setting is unset', async () => {
  const { sqliteUpdatePolicies } = require('@/lib/db/sqlite');
  const { policy } = await sqliteUpdatePolicies.upsert('user-2', {
    winget_id: '7zip.7zip',
    tenant_id: 'tenant-1',
    policy_type: 'auto_update',
    deployment_config: {
      displayName: '7-Zip', publisher: '7-Zip', architecture: 'x64',
      installerType: 'exe', installCommand: 'x', uninstallCommand: 'x',
      installScope: 'machine', detectionRules: [],
    },
    original_upload_history_id: 'hist-2',
  });

  vi.doMock('@/lib/github-actions', () => ({
    isGitHubActionsConfigured: () => true,
    triggerPackagingWorkflow: vi.fn().mockResolvedValue({ success: true }),
  }));
  vi.doMock('@/lib/intune/graph-client', () => ({
    getServicePrincipalToken: async () => 'fake-token',
  }));
  vi.doMock('./trigger', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./trigger')>();
    return {
      ...actual,
      getLatestInstallerInfo: async () => ({
        ok: true,
        info: { installerUrl: 'https://x/7z.exe', installerSha256: 'abc', installerType: 'exe', silentSwitches: '', latestVersion: '23.0' },
      }),
    };
  });

  const { AutoUpdateTriggerSqlite } = require('../trigger-sqlite');
  const trigger = new AutoUpdateTriggerSqlite();
  await trigger.triggerAutoUpdate(policy, {
    wingetId: '7zip.7zip', currentVersion: '22.0', latestVersion: '23.0',
    displayName: '7-Zip', installerUrl: '', installerSha256: '', installerType: '',
    currentIntuneAppId: 'some-app-id',
  });

  const { triggerPackagingWorkflow } = require('@/lib/github-actions');
  expect(triggerPackagingWorkflow).toHaveBeenCalledWith(
    expect.objectContaining({
      autoSupersede: false,
      carryOverAssignments: false,
      removeAssignmentsFromPreviousApp: false,
    })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/auto-update/__tests__/trigger-sqlite.test.ts -t "supersedence"`
Expected: FAIL — `triggerPackagingWorkflow` is currently called without any of `sourceIntuneAppId`/`autoSupersede`/`supersedenceType`/`carryOverAssignments`/`removeAssignmentsFromPreviousApp`/`assignments`/`categories`.

- [ ] **Step 3: Fix `triggerAutoUpdate()`**

In `lib/auto-update/trigger-sqlite.ts`, add the import:

```typescript
import { sqliteUserSettings } from '@/lib/db/sqlite';
```

Inside `triggerAutoUpdate()`, right before the `const { isGitHubActionsConfigured, triggerPackagingWorkflow } = await import('@/lib/github-actions');` line, add:

```typescript
      const { carryOverAssignments, supersedePreviousApp } = await sqliteUserSettings.get(policy.user_id) ?? { carryOverAssignments: false, supersedePreviousApp: false };
      const autoSupersede = supersedePreviousApp && Boolean(updateInfo.currentIntuneAppId);
```

Then extend the `triggerPackagingWorkflow({...})` call to add these fields (alongside the existing ones already there):

```typescript
          assignments: deploymentConfig.assignments ? JSON.stringify(deploymentConfig.assignments) : undefined,
          categories: deploymentConfig.categories ? JSON.stringify(deploymentConfig.categories) : undefined,
          sourceIntuneAppId: updateInfo.currentIntuneAppId,
          autoSupersede,
          supersedenceType: autoSupersede ? 'update' : undefined,
          carryOverAssignments,
          removeAssignmentsFromPreviousApp: carryOverAssignments,
```

- [ ] **Step 4: Wire `currentIntuneAppId` at the call site**

In `runAutoUpdatesForNewDetections()` (same file), the `trigger.triggerAutoUpdate(policy, {...})` call currently omits `currentIntuneAppId`. Add it:

```typescript
    const triggerResult = await trigger.triggerAutoUpdate(policy, {
      wingetId: update.winget_id,
      currentVersion: update.current_version,
      latestVersion: update.latest_version,
      displayName: update.display_name,
      currentIntuneAppId: update.intune_app_id,
      // Required by UpdateInfo's type but unused dead parameters here:
      // triggerAutoUpdate re-resolves the installer itself via
      // getLatestInstallerInfo(undefined, updateInfo.wingetId, ...), it never
      // reads these three fields off the updateInfo object it's passed.
      installerUrl: '',
      installerSha256: '',
      installerType: '',
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/auto-update/__tests__/trigger-sqlite.test.ts`
Expected: PASS (all tests in the file, including both new ones)

- [ ] **Step 6: Run the full auto-update test suite to confirm no regression**

Run: `cd /opt/intuneget/app && npx vitest run lib/auto-update`
Expected: PASS — the 2026-09-12 plan's existing trigger-sqlite/check-updates tests should be unaffected (this only adds fields to an existing call and a new field to an existing object literal).

- [ ] **Step 7: Commit**

```bash
git add lib/auto-update/trigger-sqlite.ts lib/auto-update/__tests__/trigger-sqlite.test.ts
git commit -m "Wire supersedence and assignment carry-over into AutoUpdateTriggerSqlite"
```

---

## Task 4: `classifyUpdateType` rollback detection

**Files:**
- Modify: `types/update-policies.ts`
- Test: `types/update-policies.test.ts` (extend if it exists, else new)

**Interfaces:**
- Produces: `UpdateType` gains `'rollback'` as a valid value; `classifyUpdateType(fromVersion, toVersion)` returns `'rollback'` when `toVersion` is older than `fromVersion`.

- [ ] **Step 1: Write the failing test**

```typescript
// types/update-policies.test.ts (or append to existing file)
import { describe, it, expect } from 'vitest';
import { classifyUpdateType } from './update-policies';

describe('classifyUpdateType rollback detection', () => {
  it('classifies a downgrade as rollback', () => {
    expect(classifyUpdateType('2026.2.0.39747', '2026.1.3.36551')).toBe('rollback');
  });

  it('still classifies a forward upgrade correctly', () => {
    expect(classifyUpdateType('1.135.0', '1.137.0')).toBe('minor');
  });

  it('classifies an equal version as rollback-safe no-op, not a crash', () => {
    // Same version redeploy (e.g. editing install command only) - not a
    // version change at all, so not 'rollback' or a version-bump type.
    // classifyUpdateType only classifies version deltas; equal versions
    // fall through to the existing patch-level comparison (0.0.0 delta).
    expect(() => classifyUpdateType('3.0.22', '3.0.22')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run types/update-policies.test.ts -t "rollback"`
Expected: FAIL — `classifyUpdateType` has no rollback branch, and `UpdateType` doesn't include `'rollback'`.

- [ ] **Step 3: Add the rollback branch**

In `types/update-policies.ts`, change the `UpdateType` union:

```typescript
export type UpdateType = 'patch' | 'minor' | 'major' | 'rollback';
```

In `classifyUpdateType`, after computing `from`/`to` via `parseSimple`, add the rollback check before the existing major/minor/patch comparison logic:

```typescript
export function classifyUpdateType(fromVersion: string, toVersion: string): UpdateType {
  const parseSimple = (v: string) => {
    const match = v.match(/^(\d+)\.(\d+)\.?(\d+)?/);
    if (!match) return { major: 0, minor: 0, patch: 0 };
    return {
      major: parseInt(match[1], 10) || 0,
      minor: parseInt(match[2], 10) || 0,
      patch: parseInt(match[3], 10) || 0,
    };
  };

  const from = parseSimple(fromVersion);
  const to = parseSimple(toVersion);

  const toTuple = [to.major, to.minor, to.patch];
  const fromTuple = [from.major, from.minor, from.patch];
  const isDowngrade = toTuple[0] < fromTuple[0] ||
    (toTuple[0] === fromTuple[0] && toTuple[1] < fromTuple[1]) ||
    (toTuple[0] === fromTuple[0] && toTuple[1] === fromTuple[1] && toTuple[2] < fromTuple[2]);
  if (isDowngrade) return 'rollback';

  // ...existing major/minor/patch comparison logic continues unchanged below...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run types/update-policies.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full update-policies test suite to confirm no regression**

Run: `cd /opt/intuneget/app && npx vitest run types/update-policies.test.ts lib/auto-update`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add types/update-policies.ts types/update-policies.test.ts
git commit -m "Add rollback classification to classifyUpdateType"
```

---

## Task 5: `sqliteUpdateChecks`/upload-history helper — resolve an app's `upload_history` lineage

**Files:**
- Modify: `lib/db/sqlite.ts`
- Test: `lib/db/__tests__/sqlite.test.ts` (extend)

**Interfaces:**
- Produces: `sqliteUploadHistory.getLatestByIntuneAppId(tenantId: string, intuneAppId: string): Promise<UploadHistoryRecord | null>` — the single lookup the edit/rollback routes need to gate on "does IntuneGet own this app" and to resolve its `winget_id`/`user_id` for the rest of the pipeline.

- [ ] **Step 1: Write the failing test**

```typescript
// append to lib/db/__tests__/sqlite.test.ts (or create if uploadHistory tests live elsewhere - check first)
it('sqliteUploadHistory.getLatestByIntuneAppId finds the row and returns null for an unknown app id', async () => {
  const { sqliteDb, sqliteUploadHistory } = require('../sqlite');
  await sqliteDb.uploadHistory.create({
    user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
    display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
  });

  const found = await sqliteUploadHistory.getLatestByIntuneAppId('tenant-1', 'app-abc');
  expect(found?.winget_id).toBe('Foxit.FoxitReader');
  expect(found?.user_id).toBe('user-1');

  expect(await sqliteUploadHistory.getLatestByIntuneAppId('tenant-1', 'nonexistent')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/__tests__/sqlite.test.ts -t "getLatestByIntuneAppId"`
Expected: FAIL — `sqliteUploadHistory` is not exported.

- [ ] **Step 3: Implement it**

In `lib/db/sqlite.ts`, add near the other standalone SQLite-specific exports (alongside `sqliteListAllUploadHistory` from the 2026-09-12 plan's Task 6):

```typescript
export const sqliteUploadHistory = {
  async getLatestByIntuneAppId(tenantId: string, intuneAppId: string): Promise<UploadHistoryRecord | null> {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM upload_history WHERE intune_tenant_id = ? AND intune_app_id = ? ORDER BY deployed_at DESC LIMIT 1')
      .get(tenantId, intuneAppId) as UploadHistoryRecord | undefined;
    return row ?? null;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run lib/db/__tests__/sqlite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/db/sqlite.ts lib/db/__tests__/sqlite.test.ts
git commit -m "Add sqliteUploadHistory.getLatestByIntuneAppId lookup"
```

---

## Task 6: `PATCH /api/intune/apps/[intuneAppId]/edit` — instant-path fields

**Files:**
- Create: `app/api/intune/apps/[intuneAppId]/edit/route.ts`
- Test: `app/api/intune/apps/[intuneAppId]/edit/route.test.ts` (new)

**Interfaces:**
- Consumes: `sqliteUploadHistory.getLatestByIntuneAppId` (Task 5), `sqliteUpdatePolicies.upsert`/`update` (existing, 2026-09-12 plan Task 2), `assignToGroups`/`syncAppCategories` (existing, `lib/intune-api.ts`), `getServicePrincipalToken` (existing, `lib/intune/graph-client.ts`), `parseAccessToken` (existing, `lib/auth-utils.ts`).
- Produces: `PATCH` handler that 404s for apps with no `upload_history` row for this tenant; applies `assignments`/`categories`/policy fields from the request body that are present, and returns `{ results: { field: 'ok' | { error: string } } }` per instant field attempted (never a single all-or-nothing failure for this group).

Request body shape (all optional — only present fields are applied):

```typescript
interface EditAppRequest {
  assignments?: Win32LobAppAssignment[]; // includes per-assignment notifications setting
  categories?: { id: string }[];
  policyType?: 'notify' | 'auto_update' | 'ignore' | 'pin_version';
  delayDays?: number;
  // Redeploy-path fields (Task 7) also live in this same body, handled separately.
}
```

- [ ] **Step 1: Write the failing test**

```typescript
// app/api/intune/apps/[intuneAppId]/edit/route.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('PATCH /api/intune/apps/[intuneAppId]/edit - instant path', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-edit-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1' }),
    }));
    vi.doMock('@/lib/intune/graph-client', () => ({
      getServicePrincipalToken: async () => 'fake-graph-token',
    }));
  });

  afterEach(() => {
    const { closeSqliteDb } = require('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('404s for an app with no upload_history row', async () => {
    const { PATCH } = require('./route');
    const response = await PATCH(
      new Request('http://x/api/intune/apps/unknown-app/edit', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyType: 'ignore' }),
      }),
      { params: Promise.resolve({ intuneAppId: 'unknown-app' }) }
    );
    expect(response.status).toBe(404);
  });

  it('applies assignments/categories via Graph and policy/delayDays via DB, reporting per-field results', async () => {
    const { sqliteDb } = require('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/intune-api', () => ({
      assignToGroups: vi.fn().mockResolvedValue(undefined),
      syncAppCategories: vi.fn().mockResolvedValue(undefined),
    }));

    const { PATCH } = require('./route');
    const response = await PATCH(
      new Request('http://x/api/intune/apps/app-abc/edit', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments: [{ '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }],
          categories: [{ id: 'cat-1' }],
          policyType: 'auto_update',
          delayDays: 3,
        }),
      }),
      { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.assignments).toBe('ok');
    expect(body.results.categories).toBe('ok');
    expect(body.results.policy).toBe('ok');

    const { sqliteUpdatePolicies } = require('@/lib/db/sqlite');
    const policy = await sqliteUpdatePolicies.getByApp('user-1', 'tenant-1', 'Foxit.FoxitReader');
    expect(policy?.policy_type).toBe('auto_update');
    expect(policy?.delay_days).toBe(3);
  });

  it('reports a per-field failure without failing the whole request', async () => {
    const { sqliteDb } = require('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/intune-api', () => ({
      assignToGroups: vi.fn().mockRejectedValue(new Error('Failed to assign app to groups')),
      syncAppCategories: vi.fn().mockResolvedValue(undefined),
    }));

    const { PATCH } = require('./route');
    const response = await PATCH(
      new Request('http://x/api/intune/apps/app-abc/edit', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments: [{ '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }],
          categories: [{ id: 'cat-1' }],
        }),
      }),
      { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.assignments).toEqual({ error: 'Failed to assign app to groups' });
    expect(body.results.categories).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run "app/api/intune/apps/[intuneAppId]/edit/route.test.ts"`
Expected: FAIL — the route file doesn't exist yet.

- [ ] **Step 3: Implement the route (instant path only — Task 7 adds the redeploy path to this same file)**

```typescript
// app/api/intune/apps/[intuneAppId]/edit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode } from '@/lib/db';
import { sqliteUploadHistory, sqliteUpdatePolicies } from '@/lib/db/sqlite';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import { assignToGroups, syncAppCategories } from '@/lib/intune-api';
import type { Win32LobAppAssignment } from '@/types/intune';
import type { UpdatePolicyType } from '@/types/update-policies';

interface EditAppRequest {
  assignments?: Win32LobAppAssignment[];
  categories?: { id: string }[];
  policyType?: UpdatePolicyType;
  delayDays?: number;
}

type FieldResult = 'ok' | { error: string };

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ intuneAppId: string }> }
) {
  const { intuneAppId } = await params;
  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (!isSqliteMode()) {
    return NextResponse.json({ error: 'Not implemented outside SQLite mode' }, { status: 501 });
  }

  const uploadHistory = await sqliteUploadHistory.getLatestByIntuneAppId(user.tenantId, intuneAppId);
  if (!uploadHistory) {
    return NextResponse.json({ error: 'App was not deployed by IntuneGet' }, { status: 404 });
  }

  const body = (await request.json()) as EditAppRequest;
  const results: Record<string, FieldResult> = {};

  if (body.assignments || body.categories) {
    const graphToken = await getServicePrincipalToken(user.tenantId);
    if (!graphToken) {
      return NextResponse.json({ error: 'Tenant consent is no longer active' }, { status: 403 });
    }

    if (body.assignments) {
      try {
        await assignToGroups(graphToken, intuneAppId, body.assignments);
        results.assignments = 'ok';
      } catch (error) {
        results.assignments = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }

    if (body.categories) {
      try {
        await syncAppCategories(graphToken, intuneAppId, body.categories);
        results.categories = 'ok';
      } catch (error) {
        results.categories = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
  }

  if (body.policyType || body.delayDays !== undefined) {
    try {
      await sqliteUpdatePolicies.upsert(uploadHistory.user_id, {
        winget_id: uploadHistory.winget_id,
        tenant_id: user.tenantId,
        policy_type: body.policyType ?? 'notify',
        delay_days: body.delayDays,
      });
      results.policy = 'ok';
    } catch (error) {
      results.policy = { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  return NextResponse.json({ results });
}
```

Note: the test's second case expects `policyType: 'auto_update'` to be preserved via `upsert` even though no prior policy row exists — `sqliteUpdatePolicies.upsert` (2026-09-12 plan Task 2) already creates one if absent, using `input.policy_type` directly, so this works with no further change.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run "app/api/intune/apps/[intuneAppId]/edit/route.test.ts"`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add "app/api/intune/apps/[intuneAppId]/edit/route.ts" "app/api/intune/apps/[intuneAppId]/edit/route.test.ts"
git commit -m "Add instant-path Inventory edit route (assignments/categories/policy/delay)"
```

---

## Task 7: `PATCH /api/intune/apps/[intuneAppId]/edit` — redeploy-path fields

**Files:**
- Modify: `app/api/intune/apps/[intuneAppId]/edit/route.ts`
- Test: `app/api/intune/apps/[intuneAppId]/edit/route.test.ts` (extend)

**Interfaces:**
- Consumes: `buildDeploymentConfigForApp` (existing, 2026-09-12 plan Task 5), `AutoUpdateTriggerSqlite.triggerAutoUpdate` (Task 3's fixed version), `getCatalogSource().getLatestVersion` (existing, dual-mode).
- Produces: request body gains `installCommand?: string`, `uninstallCommand?: string`, `detectionRules?: DetectionRule[]`, `confirmRedeploy?: boolean`. When any of the three package-affecting fields are present, `confirmRedeploy` must be `true` or the route returns `400` without dispatching anything — this is the server-side half of "never silent" from the spec (the UI's confirmation dialog is the other half, Task 9).

- [ ] **Step 1: Write the failing test**

```typescript
// append to app/api/intune/apps/[intuneAppId]/edit/route.test.ts
it('rejects a redeploy-path edit without confirmRedeploy', async () => {
  const { sqliteDb } = require('@/lib/db/sqlite');
  await sqliteDb.uploadHistory.create({
    user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
    display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
  });

  const { PATCH } = require('./route');
  const response = await PATCH(
    new Request('http://x/api/intune/apps/app-abc/edit', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ installCommand: 'newinstall.exe /S' }),
    }),
    { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
  );
  expect(response.status).toBe(400);
});

it('dispatches a redeploy when confirmRedeploy is true', async () => {
  const { sqliteDb } = require('@/lib/db/sqlite');
  const job = await sqliteDb.jobs.create({
    user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
    display_name: 'Foxit PDF Reader', publisher: 'Foxit', architecture: 'x64',
    installer_type: 'exe', installer_url: 'https://x/foxit.exe',
    install_command: 'old.exe /S', uninstall_command: 'olduninst.exe /S',
    install_scope: 'machine', status: 'deployed',
  });
  await sqliteDb.uploadHistory.create({
    user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
    display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    packaging_job_id: job.id,
  });

  vi.doMock('@/lib/auto-update/trigger-sqlite', () => ({
    AutoUpdateTriggerSqlite: class {
      async triggerAutoUpdate() {
        return { success: true, packagingJobId: 'new-job-id' };
      }
    },
  }));

  const { PATCH } = require('./route');
  const response = await PATCH(
    new Request('http://x/api/intune/apps/app-abc/edit', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ installCommand: 'newinstall.exe /S', confirmRedeploy: true }),
    }),
    { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.redeploy.packagingJobId).toBe('new-job-id');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run "app/api/intune/apps/[intuneAppId]/edit/route.test.ts" -t "redeploy"`
Expected: FAIL — the route doesn't recognize these fields yet.

- [ ] **Step 3: Extend the route**

In `app/api/intune/apps/[intuneAppId]/edit/route.ts`, extend `EditAppRequest`:

```typescript
interface EditAppRequest {
  assignments?: Win32LobAppAssignment[];
  categories?: { id: string }[];
  policyType?: UpdatePolicyType;
  delayDays?: number;
  installCommand?: string;
  uninstallCommand?: string;
  detectionRules?: import('@/types/inventory').DetectionRule[];
  confirmRedeploy?: boolean;
}
```

Add the imports:

```typescript
import { buildDeploymentConfigForApp } from '@/lib/update-policies/build-deployment-config';
import { AutoUpdateTriggerSqlite } from '@/lib/auto-update/trigger-sqlite';
import { getCatalogSource } from '@/lib/catalog';
```

After the existing policy-field block, before `return NextResponse.json({ results });`, add:

```typescript
  const hasPackageEdit = body.installCommand !== undefined || body.uninstallCommand !== undefined || body.detectionRules !== undefined;
  let redeploy: { packagingJobId?: string; error?: string } | undefined;

  if (hasPackageEdit) {
    if (!body.confirmRedeploy) {
      return NextResponse.json(
        { error: 'confirmRedeploy must be true to change install command, uninstall command, or detection rules' },
        { status: 400 }
      );
    }

    const built = await buildDeploymentConfigForApp({
      userId: uploadHistory.user_id,
      tenantId: user.tenantId,
      wingetId: uploadHistory.winget_id,
      latestVersion: uploadHistory.version,
    });

    if (built.status !== 'ok') {
      redeploy = { error: `Could not resolve current deployment config (${built.status})` };
    } else {
      const overriddenConfig = {
        ...built.deploymentConfig,
        installCommand: body.installCommand ?? built.deploymentConfig.installCommand,
        uninstallCommand: body.uninstallCommand ?? built.deploymentConfig.uninstallCommand,
        detectionRules: body.detectionRules ?? built.deploymentConfig.detectionRules,
      };

      const policy = await sqliteUpdatePolicies.upsert(uploadHistory.user_id, {
        winget_id: uploadHistory.winget_id,
        tenant_id: user.tenantId,
        policy_type: 'auto_update',
        deployment_config: overriddenConfig,
        original_upload_history_id: uploadHistory.id,
      });

      const latestVersion = await getCatalogSource().getLatestVersion(uploadHistory.winget_id) ?? uploadHistory.version;
      const trigger = new AutoUpdateTriggerSqlite();
      const result = await trigger.triggerAutoUpdate(policy.policy, {
        wingetId: uploadHistory.winget_id,
        currentVersion: uploadHistory.version,
        latestVersion,
        displayName: overriddenConfig.displayName,
        currentIntuneAppId: intuneAppId,
        installerUrl: '', installerSha256: '', installerType: '',
      }, { skipRateLimits: false, skipPriorDeploymentCheck: true });

      redeploy = result.success
        ? { packagingJobId: result.packagingJobId }
        : { error: result.error };
    }
  }

  return NextResponse.json({ results, ...(redeploy ? { redeploy } : {}) });
```

Note: `skipPriorDeploymentCheck: true` is correct here — this route only ever operates on apps already confirmed via `upload_history` lineage, so `AutoUpdateTriggerSqlite`'s `requirePriorDeployment` safety check (meant to stop a *never-before-deployed* app from silently auto-updating) doesn't apply; the route's own 404 gate already proves prior deployment.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run "app/api/intune/apps/[intuneAppId]/edit/route.test.ts"`
Expected: PASS (all 5 tests in the file)

- [ ] **Step 5: Commit**

```bash
git add "app/api/intune/apps/[intuneAppId]/edit/route.ts" "app/api/intune/apps/[intuneAppId]/edit/route.test.ts"
git commit -m "Add redeploy-path fields to Inventory edit route (install command/detection rules)"
```

---

## Task 8: Rollback route

**Files:**
- Create: `app/api/intune/apps/[intuneAppId]/rollback/route.ts`
- Test: `app/api/intune/apps/[intuneAppId]/rollback/route.test.ts` (new)

**Interfaces:**
- Consumes: `sqliteUploadHistory.getLatestByIntuneAppId` (Task 5), `getDatabase().jobs.getById` (existing, dual-mode), same `AutoUpdateTriggerSqlite` pipeline as Task 7.
- Produces: `POST` body `{ packagingJobId: string }` (the prior `packaging_jobs` row to roll back to) → `{ packagingJobId: string }` of the new rollback job, or an error.

- [ ] **Step 1: Write the failing test**

```typescript
// app/api/intune/apps/[intuneAppId]/rollback/route.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('POST /api/intune/apps/[intuneAppId]/rollback', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `test-rollback-route-${Date.now()}.db`);
    process.env.DATABASE_PATH = tmpDbPath;
    process.env.DATABASE_MODE = 'sqlite';
    vi.resetModules();
    vi.doMock('@/lib/auth-utils', () => ({
      parseAccessToken: async () => ({ userId: 'user-1', tenantId: 'tenant-1' }),
    }));
  });

  afterEach(() => {
    const { closeSqliteDb } = require('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
    vi.restoreAllMocks();
  });

  it('404s when the app has no upload_history row', async () => {
    const { POST } = require('./route');
    const response = await POST(
      new Request('http://x/api/intune/apps/unknown/rollback', {
        method: 'POST',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId: 'job-1' }),
      }),
      { params: Promise.resolve({ intuneAppId: 'unknown' }) }
    );
    expect(response.status).toBe(404);
  });

  it('400s when packagingJobId belongs to a different winget_id', async () => {
    const { sqliteDb } = require('@/lib/db/sqlite');
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.2.0.39747',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });
    const otherJob = await sqliteDb.jobs.create({
      user_id: 'user-1', winget_id: 'Microsoft.PowerToys', version: '0.101.0',
      display_name: 'PowerToys', publisher: 'Microsoft', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://x/pt.exe',
      install_command: 'x', uninstall_command: 'x', install_scope: 'machine', status: 'deployed',
    });

    const { POST } = require('./route');
    const response = await POST(
      new Request('http://x/api/intune/apps/app-abc/rollback', {
        method: 'POST',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId: otherJob.id }),
      }),
      { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
    );
    expect(response.status).toBe(400);
  });

  it('dispatches a rollback to the older packaging_jobs row', async () => {
    const { sqliteDb } = require('@/lib/db/sqlite');
    const oldJob = await sqliteDb.jobs.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.1.3.36551',
      display_name: 'Foxit PDF Reader', publisher: 'Foxit', architecture: 'x64',
      installer_type: 'exe', installer_url: 'https://x/foxit-old.exe',
      install_command: 'old.exe /S', uninstall_command: 'olduninst.exe /S',
      install_scope: 'machine', status: 'deployed',
    });
    await sqliteDb.uploadHistory.create({
      user_id: 'user-1', winget_id: 'Foxit.FoxitReader', version: '2026.2.0.39747',
      display_name: 'Foxit PDF Reader', intune_app_id: 'app-abc', intune_tenant_id: 'tenant-1',
    });

    vi.doMock('@/lib/auto-update/trigger-sqlite', () => ({
      AutoUpdateTriggerSqlite: class {
        async triggerAutoUpdate() {
          return { success: true, packagingJobId: 'rollback-job-id' };
        }
      },
    }));

    const { POST } = require('./route');
    const response = await POST(
      new Request('http://x/api/intune/apps/app-abc/rollback', {
        method: 'POST',
        headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId: oldJob.id }),
      }),
      { params: Promise.resolve({ intuneAppId: 'app-abc' }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.packagingJobId).toBe('rollback-job-id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/intuneget/app && npx vitest run "app/api/intune/apps/[intuneAppId]/rollback/route.test.ts"`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Implement the route**

```typescript
// app/api/intune/apps/[intuneAppId]/rollback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode, getDatabase } from '@/lib/db';
import { sqliteUploadHistory, sqliteUpdatePolicies } from '@/lib/db/sqlite';
import { AutoUpdateTriggerSqlite } from '@/lib/auto-update/trigger-sqlite';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ intuneAppId: string }> }
) {
  const { intuneAppId } = await params;
  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (!isSqliteMode()) {
    return NextResponse.json({ error: 'Not implemented outside SQLite mode' }, { status: 501 });
  }

  const uploadHistory = await sqliteUploadHistory.getLatestByIntuneAppId(user.tenantId, intuneAppId);
  if (!uploadHistory) {
    return NextResponse.json({ error: 'App was not deployed by IntuneGet' }, { status: 404 });
  }

  const { packagingJobId } = (await request.json()) as { packagingJobId?: string };
  if (!packagingJobId) {
    return NextResponse.json({ error: 'packagingJobId is required' }, { status: 400 });
  }

  const db = getDatabase();
  const targetJob = await db.jobs.getById(packagingJobId);
  if (!targetJob || targetJob.winget_id !== uploadHistory.winget_id || targetJob.user_id !== uploadHistory.user_id) {
    return NextResponse.json({ error: 'packagingJobId does not match this app' }, { status: 400 });
  }

  const overriddenConfig = {
    displayName: targetJob.display_name,
    publisher: targetJob.publisher || 'Unknown Publisher',
    architecture: targetJob.architecture || 'x64',
    installerType: targetJob.installer_type || 'exe',
    installCommand: targetJob.install_command || '',
    uninstallCommand: targetJob.uninstall_command || '',
    installScope: targetJob.install_scope || 'machine',
    detectionRules: targetJob.detection_rules,
    forceCreateNewApp: true,
  };

  const policy = await sqliteUpdatePolicies.upsert(uploadHistory.user_id, {
    winget_id: uploadHistory.winget_id,
    tenant_id: user.tenantId,
    policy_type: 'auto_update',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deployment_config: overriddenConfig as any,
    original_upload_history_id: uploadHistory.id,
  });

  const trigger = new AutoUpdateTriggerSqlite();
  const result = await trigger.triggerAutoUpdate(policy.policy, {
    wingetId: uploadHistory.winget_id,
    currentVersion: uploadHistory.version,
    latestVersion: targetJob.version,
    displayName: targetJob.display_name,
    currentIntuneAppId: intuneAppId,
    installerUrl: targetJob.installer_url,
    installerSha256: targetJob.installer_sha256,
    installerType: targetJob.installer_type || 'exe',
  }, { skipPriorDeploymentCheck: true });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ packagingJobId: result.packagingJobId });
}
```

Note on the `deployment_config as any` cast: `overriddenConfig` is a partial `DeploymentConfig` missing `assignments`/`categories` on purpose — Design 5 of the spec requires rollback to use *current* assignments, not the old version's. `AutoUpdateTriggerSqlite.triggerAutoUpdate` reads `deploymentConfig.assignments`/`categories` when building the `triggerPackagingWorkflow` call (Task 3); leaving them undefined here means the redeployed app carries no explicit assignment list from this path, which is a real gap — flag this in the task's self-review/task-reviewer pass rather than silently shipping it. A correct fix pulls current assignments live via Graph (`getAppCategories`/an assignments-read equivalent for the *currently installed* `intuneAppId`) into `overriddenConfig` before calling `upsert`; do this as part of Step 3 instead of leaving the gap, using the same `getServicePrincipalToken` + a Graph GET on `/deviceAppManagement/mobileApps/{intuneAppId}/assignments` (add a small `getAppAssignments()` helper to `lib/intune-api.ts` alongside the existing `getAppCategories`, following its exact pattern) and `getAppCategories` (already exists) to populate `overriddenConfig.assignments`/`categories` for real before this route's `upsert` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run "app/api/intune/apps/[intuneAppId]/rollback/route.test.ts"`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add "app/api/intune/apps/[intuneAppId]/rollback/route.ts" "app/api/intune/apps/[intuneAppId]/rollback/route.test.ts" lib/intune-api.ts
git commit -m "Add rollback-to-prior-version route"
```

---

## Task 9: UI — Inventory app details Edit toggle + instant save

**Files:**
- Modify: `components/inventory/InventoryAppDetails.tsx`
- Create: `hooks/use-inventory-edit.ts`
- Test: manual verification only (this component has no existing test file — check `components/inventory/*.test.tsx` first; if none exist for this directory, don't introduce the project's first one for a UI-only change, per YAGNI — the route tests in Tasks 6-8 already cover the logic this UI calls)

**Interfaces:**
- Consumes: the `edit` route from Tasks 6-7, `useAppDetails` (existing), the app's own `upload_history` presence (surfaced via a new `hasUploadHistory: boolean` field the panel's data query needs — see Step 1).

- [ ] **Step 1: Add `hasUploadHistory` to the app details response**

Find where `useAppDetails`'s underlying API route (`app/api/intune/apps/[id]/route.ts` or similar — check `hooks/use-inventory.ts`'s `queryFn` for the exact endpoint) builds its response, and add a check against `sqliteUploadHistory.getLatestByIntuneAppId` (Task 5) when `isSqliteMode()`, returning `hasUploadHistory: Boolean(uploadHistory)` alongside the existing `app` payload. Extend `AppDetailsResponse`'s TypeScript interface in `types/inventory.ts` (or wherever it's declared — grep for `interface AppDetailsResponse` first) with `hasUploadHistory: boolean`.

- [ ] **Step 2: Create `hooks/use-inventory-edit.ts`**

```typescript
// hooks/use-inventory-edit.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMicrosoftAuth } from './useMicrosoftAuth';
import type { Win32LobAppAssignment } from '@/types/intune';
import type { UpdatePolicyType } from '@/types/update-policies';

export interface EditAppInstantFields {
  assignments?: Win32LobAppAssignment[];
  categories?: { id: string }[];
  policyType?: UpdatePolicyType;
  delayDays?: number;
}

export interface EditAppResult {
  results: Record<string, 'ok' | { error: string }>;
}

export function useEditApp(intuneAppId: string) {
  const { getAccessToken } = useMicrosoftAuth();
  const queryClient = useQueryClient();

  return useMutation<EditAppResult, Error, EditAppInstantFields>({
    mutationFn: async (fields) => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      const response = await fetch(`/api/intune/apps/${intuneAppId}/edit`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save changes');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory', 'app', intuneAppId] });
    },
  });
}
```

- [ ] **Step 3: Add the Edit toggle and instant-field controls to `InventoryAppDetails.tsx`**

Add local state for edit mode and the editable field values, gated by `data?.hasUploadHistory`:

```tsx
// near the top of the component, after `const app = data?.app;`
const [isEditing, setIsEditing] = useState(false);
const [editedPolicyType, setEditedPolicyType] = useState<UpdatePolicyType>('notify');
const [editedDelayDays, setEditedDelayDays] = useState(0);
const editApp = useEditApp(appId || '');
```

Add the toggle button next to the existing refresh button in `customHeader` (only when `data?.hasUploadHistory` is true):

```tsx
{data?.hasUploadHistory && (
  <Button
    variant="ghost"
    size="sm"
    onClick={() => setIsEditing((v) => !v)}
    className="text-text-secondary hover:text-text-primary flex-shrink-0"
  >
    {isEditing ? 'Done' : 'Edit'}
  </Button>
)}
```

When `isEditing` is true, render editable controls for policy type (a `<select>` with the four `UpdatePolicyType` values) and delay days (a number input) in place of any static display of these — since the current panel doesn't display policy/delay at all today, add a new section for it, following the existing "Assignments" section's `<h4>` label pattern:

```tsx
{isEditing && (
  <div>
    <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
      Update Policy
    </h4>
    <div className="flex items-center gap-3">
      <select
        value={editedPolicyType}
        onChange={(e) => setEditedPolicyType(e.target.value as UpdatePolicyType)}
        className="flex-1 bg-bg-elevated border border-overlay/10 rounded-lg px-3 py-2 text-sm text-text-primary"
      >
        <option value="notify">Notify</option>
        <option value="auto_update">Auto Update</option>
        <option value="pin_version">Pin Version</option>
        <option value="ignore">Ignore</option>
      </select>
      {editedPolicyType === 'auto_update' && (
        <input
          type="number"
          min={0}
          value={editedDelayDays}
          onChange={(e) => setEditedDelayDays(Number(e.target.value))}
          className="w-24 bg-bg-elevated border border-overlay/10 rounded-lg px-3 py-2 text-sm text-text-primary"
          placeholder="Delay days"
        />
      )}
    </div>
    <Button
      onClick={() => editApp.mutate({ policyType: editedPolicyType, delayDays: editedDelayDays })}
      disabled={editApp.isPending}
      className="w-full mt-3 bg-accent-cyan hover:bg-accent-cyan-bright text-white"
    >
      {editApp.isPending ? 'Saving...' : 'Save'}
    </Button>
    {editApp.isError && (
      <p className="text-sm text-status-error mt-2">{editApp.error.message}</p>
    )}
  </div>
)}
```

Add the necessary imports (`useState`, `useEditApp`, `UpdatePolicyType`) at the top of the file.

Assignments/categories editing (full group-picker UI, matching the existing `CartItemConfig.tsx`/`PackageConfig.tsx` assignment-selection UI) is a larger surface than fits one bite-sized step — scope it as its own follow-up task if the delivered policy/delay editing proves the pattern works; note this explicitly rather than half-building it.

- [ ] **Step 4: Manual verification**

Run the dev server, open Inventory for an app with upload history, click Edit, change policy type to `auto_update` with a delay, click Save, confirm no error and the change persisted (check via the same `curl`/DB approach used in the 2026-09-12 plan's Task 16, or re-open the panel and confirm — note the panel doesn't currently re-fetch/display the saved policy value, so verify via DB directly: `sqliteUpdatePolicies.getByApp`).

- [ ] **Step 5: Commit**

```bash
git add components/inventory/InventoryAppDetails.tsx hooks/use-inventory-edit.ts app/api/intune/apps types/inventory.ts
git commit -m "Add Edit toggle and instant policy/delay editing to Inventory app details"
```

---

## Task 10: UI — Package Settings redeploy confirmation

**Files:**
- Modify: `components/inventory/InventoryAppDetails.tsx`
- Modify: `hooks/use-inventory-edit.ts`

**Interfaces:**
- Consumes: the redeploy-path fields added to the edit route in Task 7.

- [ ] **Step 1: Extend `useEditApp`'s input type**

```typescript
export interface EditAppFields extends EditAppInstantFields {
  installCommand?: string;
  uninstallCommand?: string;
  confirmRedeploy?: boolean;
}
```

Rename the hook's generic parameter from `EditAppInstantFields` to `EditAppFields` in the `useMutation<EditAppResult, Error, EditAppFields>` line.

- [ ] **Step 2: Add the Package Settings subsection with confirmation**

In `InventoryAppDetails.tsx`, when `isEditing` is true, add editable text inputs for `app.installCommandLine`/`app.uninstallCommandLine` (replacing the existing read-only `CopyableCommand` display in edit mode) and a separate "Save & Redeploy" button that first shows a native `window.confirm` (simplest correct implementation — a custom modal is a larger UI surface not justified for a single Yes/No confirmation, matching YAGNI):

```tsx
const [editedInstallCommand, setEditedInstallCommand] = useState('');
const [editedUninstallCommand, setEditedUninstallCommand] = useState('');

// inside isEditing block, replacing the read-only CopyableCommand rendering:
<div className="space-y-3">
  <div>
    <label className="text-xs text-text-muted">Install Command</label>
    <input
      value={editedInstallCommand || app.installCommandLine || ''}
      onChange={(e) => setEditedInstallCommand(e.target.value)}
      className="w-full bg-bg-elevated border border-overlay/10 rounded-lg px-3 py-2 text-sm text-text-primary font-mono"
    />
  </div>
  <div>
    <label className="text-xs text-text-muted">Uninstall Command</label>
    <input
      value={editedUninstallCommand || app.uninstallCommandLine || ''}
      onChange={(e) => setEditedUninstallCommand(e.target.value)}
      className="w-full bg-bg-elevated border border-overlay/10 rounded-lg px-3 py-2 text-sm text-text-primary font-mono"
    />
  </div>
  <Button
    onClick={() => {
      const confirmed = window.confirm(
        'This creates a new packaging job, a new Intune app version that supersedes the current one, and installed devices will re-run install. Continue?'
      );
      if (!confirmed) return;
      editApp.mutate({
        installCommand: editedInstallCommand || undefined,
        uninstallCommand: editedUninstallCommand || undefined,
        confirmRedeploy: true,
      });
    }}
    disabled={editApp.isPending}
    variant="outline"
    className="w-full border-status-warning/30 text-status-warning"
  >
    {editApp.isPending ? 'Redeploying...' : 'Save & Redeploy'}
  </Button>
</div>
```

- [ ] **Step 3: Surface the dispatched job**

After a successful `editApp` mutation whose response includes `redeploy.packagingJobId`, show a link to `/dashboard/uploads` (the existing packaging-job status page — no new progress UI):

```tsx
{editApp.isSuccess && editApp.data.redeploy?.packagingJobId && (
  <p className="text-sm text-status-success mt-2">
    Redeploy started — <a href="/dashboard/uploads" className="underline">view progress</a>
  </p>
)}
```

- [ ] **Step 4: Manual verification**

Same method as Task 9 Step 4: edit an install command, confirm the browser confirmation dialog appears, confirm it, verify a new `packaging_jobs` row appears via DB check.

- [ ] **Step 5: Commit**

```bash
git add components/inventory/InventoryAppDetails.tsx hooks/use-inventory-edit.ts
git commit -m "Add Package Settings redeploy confirmation to Inventory app details"
```

---

## Task 11: UI — Version History and rollback action

**Files:**
- Modify: `components/inventory/InventoryAppDetails.tsx`
- Create: `hooks/use-app-version-history.ts`

**Interfaces:**
- Consumes: a version-history data source. Add a `GET /api/intune/apps/[intuneAppId]/versions` route returning `packaging_jobs` rows for this app's `winget_id`/`user_id` (from `upload_history` lineage, same gate as Tasks 6-8), and the rollback route from Task 8.

- [ ] **Step 1: Add the versions-list route**

```typescript
// app/api/intune/apps/[intuneAppId]/versions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode } from '@/lib/db';
import { sqliteUploadHistory } from '@/lib/db/sqlite';
import { getDb } from '@/lib/db/sqlite';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ intuneAppId: string }> }
) {
  const { intuneAppId } = await params;
  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (!isSqliteMode()) {
    return NextResponse.json({ error: 'Not implemented outside SQLite mode' }, { status: 501 });
  }

  const uploadHistory = await sqliteUploadHistory.getLatestByIntuneAppId(user.tenantId, intuneAppId);
  if (!uploadHistory) {
    return NextResponse.json({ error: 'App was not deployed by IntuneGet' }, { status: 404 });
  }

  const db = getDb();
  const versions = db
    .prepare('SELECT id, version, status, completed_at FROM packaging_jobs WHERE user_id = ? AND winget_id = ? AND status = ? ORDER BY completed_at DESC')
    .all(uploadHistory.user_id, uploadHistory.winget_id, 'deployed');

  return NextResponse.json({ versions });
}
```

`getDb` is currently unexported per the 2026-09-12 plan's own note ("the file's existing (unexported) `getDb()`") — export it from `lib/db/sqlite.ts` alongside the other standalone exports (`export function getDb()` instead of the current unexported declaration), since this route needs a raw read the existing module-level helpers (`sqliteDb.jobs.*`) don't directly expose in list form. Check for a closer-fitting existing export first (e.g. a `jobs.listByUserAndWinget` method) before adding this — prefer reusing an existing accessor if one already covers this query.

- [ ] **Step 2: Add the test for this route**

```typescript
// app/api/intune/apps/[intuneAppId]/versions/route.test.ts
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

  afterEach(() => {
    const { closeSqliteDb } = require('@/lib/db/sqlite');
    closeSqliteDb();
    fs.rmSync(tmpDbPath, { force: true });
    delete process.env.DATABASE_MODE;
  });

  it('lists prior deployed versions for the app, newest first', async () => {
    const { sqliteDb } = require('@/lib/db/sqlite');
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

    const { GET } = require('./route');
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
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd /opt/intuneget/app && npx vitest run "app/api/intune/apps/[intuneAppId]/versions/route.test.ts"`
Expected: PASS

- [ ] **Step 4: Add `hooks/use-app-version-history.ts`**

```typescript
// hooks/use-app-version-history.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMicrosoftAuth } from './useMicrosoftAuth';

export interface AppVersion {
  id: string;
  version: string;
  status: string;
  completed_at: string | null;
}

export function useAppVersionHistory(intuneAppId: string | null) {
  const { getAccessToken } = useMicrosoftAuth();
  return useQuery<{ versions: AppVersion[] }>({
    queryKey: ['inventory', 'app-versions', intuneAppId],
    enabled: !!intuneAppId,
    queryFn: async () => {
      const token = await getAccessToken();
      const response = await fetch(`/api/intune/apps/${intuneAppId}/versions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Failed to load version history');
      return response.json();
    },
  });
}

export function useRollbackApp(intuneAppId: string) {
  const { getAccessToken } = useMicrosoftAuth();
  const queryClient = useQueryClient();
  return useMutation<{ packagingJobId: string }, Error, { packagingJobId: string }>({
    mutationFn: async ({ packagingJobId }) => {
      const token = await getAccessToken();
      const response = await fetch(`/api/intune/apps/${intuneAppId}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ packagingJobId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Rollback failed');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory', 'app', intuneAppId] });
    },
  });
}
```

- [ ] **Step 5: Add the Version History section to `InventoryAppDetails.tsx`**

```tsx
const { data: versionHistory } = useAppVersionHistory(data?.hasUploadHistory ? appId : null);
const rollback = useRollbackApp(appId || '');

// new section, rendered whenever versionHistory?.versions is non-empty:
{versionHistory && versionHistory.versions.length > 0 && (
  <div>
    <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
      Version History
    </h4>
    <div className="space-y-2">
      {versionHistory.versions.map((v) => (
        <div key={v.id} className="flex items-center justify-between p-3 bg-bg-elevated rounded-lg border border-overlay/5">
          <span className="text-sm text-text-primary">v{v.version}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={rollback.isPending}
            onClick={() => {
              const confirmed = window.confirm(
                `Roll back to v${v.version}? This redeploys that version's exact installer with current assignments.`
              );
              if (confirmed) rollback.mutate({ packagingJobId: v.id });
            }}
          >
            Roll back to this version
          </Button>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 6: Manual verification**

Open Inventory for an app with more than one prior deployed version, confirm Version History lists them, confirm clicking "Roll back to this version" shows the confirmation and, once confirmed, produces a new `packaging_jobs` row via DB check.

- [ ] **Step 7: Commit**

```bash
git add "app/api/intune/apps/[intuneAppId]/versions" hooks/use-app-version-history.ts components/inventory/InventoryAppDetails.tsx lib/db/sqlite.ts
git commit -m "Add version history and rollback action to Inventory app details"
```

---

## Task 12: End-to-end verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-inventory-redeploy-rollback-design.md` (mark implemented)
- No other code changes — this task is entirely verification, same shape as the 2026-09-12 plan's Task 16.

- [ ] **Step 1: Rebuild and deploy**

```bash
docker build -t intuneget-intuneget:latest -f /opt/intuneget/app/.worktrees/update-detection-autodeploy/Dockerfile /opt/intuneget/app/.worktrees/update-detection-autodeploy
cd /opt/intuneget && docker compose up -d --no-deps --force-recreate intuneget
sleep 15 && docker ps --filter name=intuneget --format "{{.Names}}: {{.Status}}"
```

Expected: container healthy. (Same build-context caveat as the 2026-09-12 plan: `docker compose build` alone would use the main-branch checkout, not this worktree — build manually as shown.)

- [ ] **Step 2: Verify the settings toggle actually saves (Design 0 / Goal 0)**

In Settings → Cart Behaviour, toggle "Carry over assignments" and "Supersede previous version" on, save, refresh the page, confirm both show as on (no 503, no reset to off).

- [ ] **Step 3: Verify supersedence on a real auto-update (Design 1 / Goal 1)**

With both toggles on, set a real previously-deployed app's policy to `auto_update` (delay 0), manually trigger `/api/cron/check-updates` (same method as the 2026-09-12 plan's Task 16), and confirm: exactly one app for that winget package in Intune's Windows apps list after the update (not two), and its assignments match the pre-update app's.

- [ ] **Step 4: Verify Inventory edit and redeploy (Designs 2-4)**

In Inventory, open an app IntuneGet deployed, click Edit, change the update policy and delay, save, confirm via DB (`sqliteUpdatePolicies.getByApp`) that it persisted. Then edit the install command and click Save & Redeploy, confirm the browser dialog, confirm a new `packaging_jobs` row and GitHub Actions run appear.

- [ ] **Step 5: Verify rollback (Design 5)**

For an app with more than one prior deployed version, use "Roll back to this version" on an older entry, confirm a new packaging job dispatches with that version's installer/config and current assignments, and that `auto_update_history.update_type` for that dispatch reads `rollback`.

- [ ] **Step 6: Update the spec's Status line**

```markdown
Status: implemented 2026-09-DD, verified end-to-end on the lab tenant.
```

- [ ] **Step 7: Update `backlog_intuneget_lab_pilot.md`** (memory file, not a repo file — done by the assistant driving this plan, not a git-tracked step) to mark this work complete and supersede item 6's "Force replace" half.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-13-inventory-redeploy-rollback-design.md
git commit -m "Mark Inventory edit-and-redeploy + rollback spec as implemented"
git push origin HEAD
```

---
