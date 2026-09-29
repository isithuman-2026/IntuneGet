# Auto-Prune Superseded Apps Implementation Plan

**Goal:** After auto-update sets Graph supersedence between an old and new
app, delete the old app once devices have migrated off it (grace period +
zero-device check), gated behind an explicit opt-in env var.

**Spec:** `docs/superpowers/specs/2026-09-29-auto-prune-superseded-apps-design.md`

**Scope:** SQLite mode only. No UI. No new dependencies.

## Task 1: Schema — `pending_app_prune` + `pending_app_prune_log`

- Modify: `lib/db/sqlite.ts` (`initializeSchema()`, after `auto_update_history`)
- Add: `sqlitePendingAppPrune` CRUD module (create, listDue, resolveNewAppId,
  markDeleted, touchChecked, logAttempt) mirroring the `sqliteAutoUpdateHistory`
  / `sqliteClaims` style already in the file (plain `better-sqlite3` prepared
  statements, `TEXT` timestamps, `INTEGER` booleans where relevant).

## Task 2: Graph calls — install summary + relationship clear

- Modify: `lib/intune-api.ts`
- Add `getAppInstallSummary(accessToken, appId)`: `GET
  /deviceAppManagement/mobileApps/{appId}/installSummary`, returns
  `{ installedDeviceCount, pendingInstallDeviceCount }` (throws on non-ok
  except 404 -> treat as "already gone", both counts 0).
- Add `clearAppRelationships(accessToken, appId)`: `POST
  .../mobileApps/{appId}/updateRelationships` with `{"relationships": []}`.
  Mirrors `applyAppRelationships`'s non-fatal warning style (returns a
  warning string on failure instead of throwing, caller decides).

## Task 3: Record pending-prune row on supersedence

- Modify: `lib/auto-update/trigger-sqlite.ts`
- After `jobId = job.id;` (existing code, ~line 150), when `autoSupersede`
  is true, insert a `pending_app_prune` row: `old_app_id =
  updateInfo.currentIntuneAppId`, `job_id = job.id`, `tenant_id =
  policy.tenant_id`, `new_app_id = null`, `status = 'pending'`,
  `superseded_at = now`.

## Task 4: Prune job

- Add: `lib/auto-update/prune.ts`
- `runAppPrune()`:
  - Return immediately (no-op) unless `process.env.AUTO_PRUNE_OLD_APPS ===
    'true'`.
  - `graceDays = Number(process.env.AUTO_PRUNE_GRACE_DAYS) || 14`.
  - Pull due rows (`status = 'pending'` and `superseded_at <= now -
    graceDays`).
  - Per row: resolve `new_app_id` (via job lookup if null) -> check
    install summary -> clear relationship + delete, per the spec's
    decision table. Every branch calls `logAttempt`.
  - Export two pure helpers for the self-check: `isPastGrace(supersededAt,
    graceDays, now)` and `isSafeToDelete(summary)`.

## Task 5: Scheduler wiring

- Modify: `instrumentation.ts`
- Inside the existing `setInterval` callback (SQLite-mode branch only),
  after `runUpdateCheck()` resolves, call `runAppPrune()` and log its
  result the same way.

## Task 6: Env vars + docs

- Modify: `.env.example` — add `AUTO_PRUNE_OLD_APPS` (default false,
  comment on what it does) and `AUTO_PRUNE_GRACE_DAYS` (default 14) next to
  the other SQLite-mode auto-update vars.

## Task 7: Self-check

- Add: `lib/auto-update/prune.test.ts` (vitest, already the repo's test
  framework — no new dependency).
- Cases: `isPastGrace` true/false at the boundary; `isSafeToDelete` true
  only when both counts are 0, false if either is nonzero.

## Verification

- `npm run test -- prune` (new test file) plus existing
  `trigger-sqlite.test.ts` to confirm no regression from Task 3's insert.
- No live tenant available in this session — the actual Graph calls
  (`installSummary`, `updateRelationships`, `deleteApp`) are exercised only
  by the existing manual live verification referenced in the spec, not by
  this session. A human must dry-run against a real tenant before flipping
  `AUTO_PRUNE_OLD_APPS=true` in production.
