# Update Detection + Auto-Deploy for SQLite Mode

Status: approved design, not yet planned/implemented.
Backlog ref: `backlog_intuneget_lab_pilot.md` item 9b.

## Problem

This self-hosted (SQLite, `DATABASE_MODE=sqlite`) instance has zero working
update-detection or auto-patching, despite the feature being fully built on
the frontend and in the original hosted (Supabase) product:

- `app/api/cron/check-updates/route.ts` is never triggered — nothing calls
  it (the original product used Vercel Cron; nothing replaces that here).
- It is 100% Supabase-only (`@supabase/supabase-js` `createClient` directly),
  so it would error immediately even if triggered.
- The full auto-deploy pipeline (`lib/auto-update/trigger.ts`, ~1040 lines,
  23 direct Supabase call sites) that actually builds and pushes a new
  package to Intune is equally Supabase-only.
- Notification preferences (`app/api/notifications/preferences/route.ts`)
  are Supabase-only too, and today only support email, with no per-event
  granularity and no webhook toggle.

The `/dashboard/updates` page, its policy modal, and `hooks/use-updates.ts`
already exist and are already wired into the sidebar (Management section,
next to SCCM Migration/Inventory) — **no new UI is needed**, only a working
backend behind it.

## Goals

1. Daily, automatic detection of outdated deployed apps.
2. Per-app policy: `notify` (default), `auto_update` (immediate or delayed
   by N days), `ignore`, `pin_version` — surfaced through the existing
   `/dashboard/updates` UI and its policy modal.
3. `auto_update` policies actually rebuild and redeploy the app to Intune
   with zero manual action, once their delay elapses.
4. Notification settings gain: channel choice (email if SMTP configured,
   webhook — already working) × three independently-toggleable event types
   (update available, deployed, error).
5. All of the above works with zero Supabase configuration, in a single
   Docker container, single-tenant, on node1.

## Non-goals (explicitly cut, revisit only if asked)

- MSP / multi-tenant behavior. This instance is single-tenant
  (`user.tenantId` from the access token, same pattern already used by the
  Discovered Apps live-scan route). No `msp_managed_tenants` lookups.
- The QA device-testing-fleet gate (`lib/qa/demand.ts` `ensureQaDemand`).
  That's a hosted-product feature (a fleet of real devices testing
  candidate packages before they're marked safe) with no self-hosted
  equivalent and no SQLite tables backing it. Auto-updates skip this gate
  entirely in SQLite mode, the same way `enforceQaGate()` is already
  bypassed elsewhere via `isSupabaseServerConfigured()`.
- Fixed-time-of-day cron (e.g. "3am daily") — a plain interval is enough
  for a single self-hosted instance (user's explicit choice).
- Vercel Cron / host crontab — scheduling lives inside the Next.js process
  (user's explicit choice), see Scheduling below.

## Data model (new SQLite tables, mirroring the Supabase shapes these
routes/hooks already expect — see `types/update-policies.ts` and
`types/notifications.ts` for the exact existing TS interfaces)

```sql
CREATE TABLE update_check_results (
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
);

CREATE TABLE app_update_policies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  winget_id TEXT NOT NULL,
  policy_type TEXT NOT NULL DEFAULT 'notify', -- auto_update | notify | ignore | pin_version
  pinned_version TEXT,
  deployment_config TEXT, -- JSON, see DeploymentConfig in types/update-policies.ts
  original_upload_history_id TEXT,
  -- New field, not in the Supabase schema: how many days to wait after
  -- detection before an auto_update policy actually applies. 0 = immediate.
  delay_days INTEGER NOT NULL DEFAULT 0,
  last_auto_update_at TEXT,
  last_auto_update_version TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, tenant_id, winget_id)
);

CREATE TABLE auto_update_history (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  packaging_job_id TEXT,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  update_type TEXT NOT NULL, -- patch | minor | major
  status TEXT NOT NULL, -- pending | packaging | deploying | completed | failed | cancelled
  error_message TEXT,
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE notification_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  email_frequency TEXT NOT NULL DEFAULT 'daily',
  email_address TEXT,
  notify_critical_only INTEGER NOT NULL DEFAULT 0,
  -- New fields, not in the Supabase schema:
  webhook_enabled INTEGER NOT NULL DEFAULT 1,
  notify_on_update_available INTEGER NOT NULL DEFAULT 1,
  notify_on_deployed INTEGER NOT NULL DEFAULT 1,
  notify_on_error INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

All four are standalone SQLite modules (`lib/db/sqlite.ts`, following the
`sqliteWebhooks`/`sqliteClaims` pattern already established), not added to
the shared `DatabaseAdapter` interface — the Supabase path stays untouched.

## Detection

New `lib/auto-update/check-updates.ts` exports `runUpdateCheck()`, the pure
logic extracted from the current route (comparison, upsert, stale-row
cleanup), simplified for single-tenant SQLite:

- No `BATCH_SIZE` user-batching loop — one tenant, iterate its deployed
  apps from `upload_history` (already SQLite-native) directly.
- Compare against `getCatalogSource().getAllLatestVersions()` (already
  dual-mode, works today).
- Skip apps with an `ignore` policy or a `pin_version` policy pinned to
  the current latest (reuses existing `shouldSkipUpdate()` from
  `types/update-policies.ts` unchanged).
- Write/upsert `update_check_results`, preserving `notified_at` exactly
  like the current logic does (reset only when `latest_version` changed).
- After detection, for every row with an `auto_update` policy whose delay
  has elapsed (`detected_at + delay_days <= now`, or `delay_days = 0`),
  call the auto-deploy trigger (see below).
- `app/api/cron/check-updates/route.ts` keeps existing behind its
  `CRON_SECRET` bearer check for manual/external triggering, but delegates
  to the same `runUpdateCheck()` function — no duplicated logic between
  the scheduler and the route.

## Scheduling

`instrumentation.ts` at the project root, using Next.js's `register()`
hook (runs once per server process start, works in the standalone Docker
output this app already uses):

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.DATABASE_MODE !== 'sqlite') return; // Supabase mode keeps using Vercel Cron
  const { runUpdateCheck } = await import('@/lib/auto-update/check-updates');
  const intervalMs = 24 * 60 * 60 * 1000;
  setInterval(() => { runUpdateCheck().catch(console.error); }, intervalMs);
}
```

No new dependency (plain `setInterval`, per explicit choice over
`node-cron`). Interval resets on container restart — acceptable for a
single self-hosted instance per explicit choice over host crontab.

## Auto-deploy trigger (SQLite port of `lib/auto-update/trigger.ts`)

`AutoUpdateTrigger` gets a SQLite-backed sibling (same public
`triggerAutoUpdate()` shape, swapped internals), selected via
`isSqliteMode()` at the call site in `check-updates.ts` — mirroring how
`getDatabase()` already picks an adapter by mode, but kept as a separate
class rather than forced into `DatabaseAdapter` since this is a
process/workflow, not a CRUD table.

Kept from the original, ported to SQLite:
- Safety check 1 (`canAutoUpdate`) and 2 (deployment config exists) —
  pure functions, no DB calls, unchanged.
- Safety check 3 (prior manual deployment required) — unchanged logic,
  reads `original_upload_history_id` off the SQLite policy row.
- Safety check 4 (rate limits: per-hour, per-tenant, per-policy cooldown)
  — kept, now querying `auto_update_history` via `better-sqlite3`
  `COUNT`/`SELECT` instead of Supabase `count: 'exact'`. Still meaningful
  in single-tenant mode (protects against a runaway loop hammering Intune).
- `createHistoryRecord`/history status updates — new SQLite table above.
- The actual packaging-job creation call (QA-profile generation,
  detection-rule generation, `packaging-adapters.ts`) — these already work
  in SQLite mode today (the manual claim→cart→deploy flow uses the same
  code), so this part is reused as-is, not rewritten.

Changed for SQLite:
- Safety check 5 (`verifyTenantConsent` via Supabase `tenant_consent`
  table) → replaced with attempting `getServicePrincipalToken(tenantId)`
  (the same de-facto consent check the Discovered Apps live-scan route
  already uses in SQLite mode — a token acquisition failure means consent
  isn't there).
- `ensureQaDemand` QA-candidate gate → skipped entirely in SQLite mode
  (Non-goals, above).

## Notification event types

`lib/notifications/notify-user.ts` currently only ever sends one event:
`app_updates_available`. Extend the module (not rewrite) with two more
call sites, gated on the new preference toggles:

- **Deployed**: called from `app/api/package/callback/route.ts`'s existing
  `data.status === 'deployed'` branch (right next to the upload_history
  insert this session already touched for the claim-sync fix), only when
  the job originated from an auto-update (`auto_update_history.packaging_job_id`
  match) — manual deploys already have their own dashboard progress bar
  and don't need a redundant notification.
- **Error**: called from the same callback route's `data.status === 'failed'`
  branch, same auto-update-originated scoping.
- Existing **update available** call site in `check-updates.ts` (the
  ported detection loop) unchanged in intent, just gated on the renamed
  `notify_on_update_available` toggle instead of being unconditional.

Each of the three checks `notify_on_<event>` AND (`email_enabled` with SMTP
configured, OR `webhook_enabled`) before sending — channel and event type
are independent toggles, not a single combined setting.

## Notification settings UI

`components/settings/NotificationSettings.tsx` (329 lines today) gets
extended, not replaced: add a webhook on/off toggle next to the existing
email toggle, and three checkboxes for the event types, following the
existing checkbox pattern already in the file (lines ~175, ~253). Backed
by `app/api/notifications/preferences/route.ts`, branched on
`isSqliteMode()` like the webhook/claim routes from this session.

## API routes needing an `isSqliteMode()` branch

All follow the established pattern from this session (standalone SQLite
module + branch, Supabase path untouched):

- `app/api/cron/check-updates/route.ts` — delegates to `runUpdateCheck()`
- `app/api/updates/available/route.ts`, `.../refresh/route.ts`,
  `.../trigger/route.ts`, `.../history/route.ts`
- `app/api/update-policies/route.ts`, `.../[id]/route.ts`
- `app/api/notifications/preferences/route.ts`

## Testing

- Unit-test `runUpdateCheck()`'s comparison/skip logic against an
  in-memory SQLite DB (already the pattern `lib/catalog/snapshot-source.test.ts`
  uses).
- Unit-test the new SQLite auto-update trigger's safety checks
  (rate limits, cooldown, consent-via-token) against a seeded SQLite DB.
- Manual end-to-end: pin an already-deployed app's policy to `auto_update`
  with `delay_days: 0`, bump `latest_version` in the catalog snapshot
  (or wait for a real WinGet update), confirm a new packaging job appears
  without manual action and a webhook notification fires.
