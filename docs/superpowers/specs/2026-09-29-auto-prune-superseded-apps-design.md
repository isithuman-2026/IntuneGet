# Auto-Prune Superseded Apps (SQLite Mode)

Status: design + implementation, SQLite-mode only.
Backlog ref: auto-update supersedence works end-to-end (live-verified
2026-09-13) but nothing ever deletes the OLD app afterward. Manual cleanup
gap in production Intune tenants today.

## Problem

`AutoUpdateTriggerSqlite.triggerAutoUpdate` sets a real Graph
`#microsoft.graph.mobileAppSupersedence` relationship (via the packaging
workflow, `packageConfig.autoSupersede`) between the new app and the old one
it replaces. The old app object is never deleted. `deleteApp()` and
`applyAppRelationships()` (`lib/intune-api.ts`) already exist for this but
have zero callers.

Live manual test confirmed `DELETE /mobileApps/{oldAppId}` fails while a
supersedence relationship referencing it still exists
(`"This app cannot be deleted because it is related to another app..."`).
Fix sequence, confirmed working manually:

1. `POST /deviceAppManagement/mobileApps/{newAppId}/updateRelationships`
   with `{"relationships": []}` — replaces the whole list (not additive).
2. `DELETE /deviceAppManagement/mobileApps/{oldAppId}`.

**Real risk:** the supersedence relationship is what migrates devices off
the old app via check-in evaluation. Breaking it and deleting the old app
immediately would strand devices still on the old version. Deletion must
only happen once devices have actually migrated off (installSummary shows
zero installed/pending on the old app), after a grace period.

Rollback (`app/api/intune/apps/[id]/rollback/route.ts`) was checked and
confirmed to work entirely from local DB (`jobs` table) and never touches
an old superseded app's Intune ID, so this feature does not break it.

## Design

**New table** `pending_app_prune` (SQLite only, standalone module in
`lib/db/sqlite.ts`, mirrors `claimed_apps`/`auto_update_history`):

```
id, old_app_id, new_app_id (nullable), job_id, tenant_id,
superseded_at, status ('pending'|'deleted'), last_checked_at, last_error,
created_at
```

`new_app_id` starts NULL: at record-time (right after the packaging job for
the new app is created) the new app's real Intune app ID doesn't exist yet
— it's only known once the async GitHub Actions packaging workflow finishes
and calls back. Rather than threading a second write through the callback
route (`app/api/package/callback/route.ts`, which is already a large
shared handler this task must not touch), the prune job resolves
`new_app_id` lazily at check time via `job_id -> db.jobs.getById(job_id)`.
If the job hasn't reached `deployed` yet, the row is left `pending` and
retried next cycle — this naturally also covers "packaging still running,"
which needs the same "not ready yet, don't error" handling anyway.

**Row recorded**: in `trigger-sqlite.ts`, right after the packaging job is
created and `autoSupersede` is true (job.id is required for the FK, so
this is a few lines after the literal point `autoSupersede` is computed,
not before).

**Audit trail**: a small append-only `pending_app_prune_log` table
(id, pending_prune_id, action, detail, created_at) — one row per prune-job
attempt outcome (`skipped` / `deleted` / `error`). This is destructive to
real tenant objects, so every attempt is durably logged, not just the
current row state.

**Prune job** (`lib/auto-update/prune.ts`, `runAppPrune()`):
- No-ops entirely unless `AUTO_PRUNE_OLD_APPS=true` (default off — this
  permanently deletes real Intune app objects).
- For each `pending` row where `superseded_at` is older than
  `AUTO_PRUNE_GRACE_DAYS` (default 14) days ago:
  - Resolve `new_app_id` via the job if not yet known; if job isn't
    `deployed` yet, log `skipped` ("new app not deployed yet"), leave row
    `pending`.
  - `GET /mobileApps/{oldAppId}/installSummary` (new `intune-api.ts`
    function `getAppInstallSummary`). If `installedDeviceCount > 0` or
    `pendingInstallDeviceCount > 0`, log `skipped`, leave row `pending`.
  - Otherwise: `clearAppRelationships(newAppId)` (new small function next
    to `applyAppRelationships`, POSTs `updateRelationships` with an empty
    list) then `deleteApp(oldAppId)` (existing, reused as-is). On success,
    row -> `deleted`, log `deleted`. On any Graph error, log `error` with
    the message, row stays `pending` for retry next cycle (deliberate:
    permanently giving up on a destructive-cleanup row is worse than
    retrying — `ponytail: no backoff/retry cap, add one if a tenant token
    revocation causes a hot retry loop in the logs`).
  - Missing/failed service-principal token: same treatment as a Graph
    error (log `error`, retry next cycle).

**Scheduler wiring**: `instrumentation.ts` already runs a 24h
`setInterval` calling `runUpdateCheck()` in SQLite mode. `runAppPrune()` is
called from the same interval callback, after the update check — no new
timer.

**Supabase-mode parity**: not implemented. `AUTO_PRUNE_OLD_APPS` and the
prune job are gated behind `isSqliteMode()` implicitly (the table only
exists in the SQLite schema, and `runAppPrune` is only wired into the
SQLite-only `instrumentation.ts` branch). This mirrors existing precedent
(`sqliteClaims`, `handleAutoUpdateJobCompletion` is the mirror-image case —
Supabase-only, SQLite has no equivalent). A code comment on `runAppPrune`
notes the gap for anyone porting this to Supabase mode later.

## Out of scope

- Rollback route (confirmed safe, not touched).
- Description-fingerprint duplicate matching (backlog #15).
- In-place app replacement design (backlog #6).
- Any UI/settings toggle — env vars only, per ponytail (set once, rarely
  touched).
