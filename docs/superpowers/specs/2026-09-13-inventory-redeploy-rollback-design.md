# Inventory Edit-and-Redeploy + Rollback (SQLite Mode)

Status: approved design, not yet planned/implemented.
Backlog ref: `backlog_intuneget_lab_pilot.md` item 6 (supersedes it — see Relationship
to item 6 below), plus the live-test findings from 2026-09-12/13 during item 9b's
end-to-end verification.

## Problem

The update-detection + auto-deploy pipeline shipped 2026-09-12
(`docs/superpowers/specs/2026-09-12-update-detection-autodeploy-design.md`) was
verified live against the real lab tenant on 2026-09-12/13. Two real gaps
surfaced:

1. **`AutoUpdateTriggerSqlite` (`lib/auto-update/trigger-sqlite.ts`) never wires
   Intune app-supersedence or assignment/category carry-over into its
   `triggerPackagingWorkflow()` call**, even though:
   - The Graph mechanism already exists and works
     (`applyAppRelationships()` in `lib/intune-api.ts`, `AppRelationshipType`
     in `types/intune.ts`).
   - The GitHub Actions workflow contract already accepts it in full
     (`assignments`, `categories`, `relationships`, `sourceIntuneAppId`,
     `autoSupersede`, `supersedenceType`, `carryOverAssignments`,
     `removeAssignmentsFromPreviousApp` are all real fields on
     `WorkflowInputs`, dispatched in the `config` group —
     `lib/github-actions.ts:333-349`).
   - The Supabase-mode sibling, `AutoUpdateTrigger`
     (`lib/auto-update/trigger.ts:639-695`), already does exactly this —
     reads `updateInfo.currentIntuneAppId`, computes `autoSupersede` from a
     per-user setting, and passes all of the above.
   - `trigger-sqlite.ts`'s own file docstring says it "Mirrors the
     safety-check logic of AutoUpdateTrigger" — the mirroring stopped short
     of this part.

   **Consequence, confirmed live**: an `auto_update` policy on
   Foxit.FoxitReader created a second, independent Intune Win32LobApp
   instead of superseding the original, and did not carry over the
   original's assignments. Every future auto-update on any app would repeat
   this — real risk to a production tenant.

2. **There is no way to edit a deployed app's settings, or to trigger a
   manual redeploy / roll back to a prior version, from the app the user
   actually looks at day to day**: the Inventory view
   (`components/inventory/InventoryAppDetails.tsx`) is entirely read-only.
   `/dashboard/updates` covers policy (notify/auto_update/pin/ignore) but not
   editing an already-deployed app's assignments, categories, install
   command, detection rules, or rolling back a bad update.

## Goals

1. `AutoUpdateTriggerSqlite` produces an Intune outcome equivalent to the
   Supabase-mode `AutoUpdateTrigger`: the new version supersedes the old
   Win32LobApp (not a duplicate) and carries over assignments/categories.
2. From the Inventory app details panel, for apps IntuneGet itself deployed:
   - Instantly editable: assignments, categories, per-assignment end-user
     notification setting (`showAll`/`showReboot`/`hideAll`), update policy
     (notify/auto_update/pin_version/ignore), deferral (`delay_days`).
   - Editable-with-redeploy: install command, uninstall command, detection
     rules — changing these triggers a full repackage → supersede →
     redeploy, with an explicit confirmation step (never silent).
3. A "Roll back to a prior version" action, sourced from that app's own
   `packaging_jobs` history, reusing the same repackage → supersede →
   redeploy pipeline as a normal update, just pointed at an older version's
   stored config instead of the latest catalog version.

## Non-goals (explicitly cut, revisit only if asked)

- Editing apps IntuneGet did not originally deploy (no `upload_history` row
  to rebuild from) — Inventory view stays fully read-only for those, as
  today.
- A settings UI for `carryOverAssignments`/`autoSupersede` — SQLite mode is
  single-tenant self-hosted with no `user_settings` table; both are simply
  `true` unconditionally for every SQLite-mode redeploy (Supabase mode's
  opt-in-default-false stays as is, unrelated to this work).
- Any change to the Supabase-mode `AutoUpdateTrigger`, its UI, or its
  per-user settings — this spec is SQLite-mode only, matching the parent
  2026-09-12 spec's scope.
- MSP/multi-tenant behavior (same exclusion as the parent spec).
- The two vuln/catalog backlog items raised alongside this work (CVE
  display on `/dashboard/updates`, an "Inventory" category in App Catalog)
  — tracked separately in `backlog_intuneget_lab_pilot.md` items 13-14, not
  designed or scoped here.

## Relationship to backlog item 6

Item 6 ("Design + implement two distinct duplicate-handling options: Force
replace vs. Force duplicate with different deployment rules") was written
2026-09-12 assuming *no* update-in-place mechanism existed anywhere in the
codebase. Investigation for this spec found that assumption was wrong: the
Graph supersedence mechanism, the workflow-dispatch contract, and a full
working reference implementation (`AutoUpdateTrigger`, Supabase mode) all
already exist — the only real gap is that the SQLite-mode trigger never
calls into it. Goal 1 above *is* item 6's "Force replace" path, at a
fraction of the originally-assumed cost. "Force duplicate with different
deployment rules" (item 6's second option) remains genuinely uncovered by
this spec — a user deliberately wanting two independent Intune apps for the
same winget package (e.g. different assignment groups) still has no UI path
in SQLite mode. That narrower need is left for a future spec if actually
requested; nothing here blocks it.

## Design

### 1. `AutoUpdateTriggerSqlite` supersedence fix

`lib/auto-update/trigger-sqlite.ts`:

- Extend the `UpdateInfo` shape (or add a parameter) so
  `triggerAutoUpdate()` receives `currentIntuneAppId`, sourced from
  `update.intune_app_id` on the `UpdateCheckInsert`/`UpdateCheckRow` passed
  into `runAutoUpdatesForNewDetections()` (`lib/db/sqlite.ts` /
  `update_check_results.intune_app_id` — already populated by
  `runUpdateCheck()`, just unread here today).
- In the `triggerPackagingWorkflow()` call (currently only sets
  `forceCreate`), add:
  - `assignments: JSON.stringify(deploymentConfig.assignments || [])`
  - `categories: JSON.stringify(deploymentConfig.categories || [])`
  - `sourceIntuneAppId: currentIntuneAppId || undefined`
  - `autoSupersede: Boolean(currentIntuneAppId)`
  - `supersedenceType: currentIntuneAppId ? 'update' : undefined`
  - `carryOverAssignments: true`
  - `removeAssignmentsFromPreviousApp: true`
  - `forceCreate` stays `true` (Win32LobApp objects are immutable per
    version in Graph — a "replace" *is* create-new + supersede-old, not a
    PATCH of the existing object; this is not a contradiction with
    superseding).
- No new Graph calls, no workflow-repo changes — this reuses the exact path
  `AutoUpdateTrigger` (Supabase mode) already exercises in production.

### 2. Inventory app details: instant-edit fields

New route: `PATCH /api/intune/apps/[intuneAppId]/edit`, gated to apps with
an `upload_history` row for this tenant (404 otherwise — matches this
spec's non-goal on non-IntuneGet apps).

Body carries the full editable field set; the route diffs it against
current state and applies only the instant-path fields synchronously:

- Assignments/categories/per-assignment `notifications`: existing
  `applyAppCategories`/assignment-update functions in `lib/intune-api.ts`,
  called directly against the live Graph app object. Non-atomic (Graph is
  per-relationship/per-assignment) — the response reports per-field
  success/failure explicitly (extends `applyAppRelationships`'s existing
  console.error-only pattern to also return structured results the UI can
  show, rather than only logging).
- Update policy + `delay_days`: delegates to the already-built
  `sqliteUpdatePolicies.upsert()` (no new DB code).

### 3. Inventory app details: redeploy-triggering fields

Same route, redeploy-path fields (`installCommand`, `uninstallCommand`,
`detectionRules`) are staged, not applied inline. The route:

1. Builds a `DeploymentConfig` from: the edited fields (override) +
   everything else from the app's existing `upload_history` →
   `packaging_jobs` row (unchanged, same source `buildDeploymentConfigForApp`
   already reads).
2. Calls the same fixed `AutoUpdateTriggerSqlite` pipeline (Design 1) with
   this config and the *current* installed version as "from", current
   catalog `latest_version` as "to" (a manual redeploy doesn't necessarily
   change the version — same version with edited install/detection
   settings is a valid case; `classifyUpdateType` already handles
   equal-version diffs as a no-op classification, reuse as-is).
3. Requires the same explicit confirmation UI step described in Design 4;
   never fires from a plain field save.

### 4. UI: `InventoryAppDetails.tsx`

- New "Edit" toggle switches the existing read-only fields to editable
  controls in place (no new page, extends the existing slide-out panel
  pattern used across Inventory/Deployments).
- Instant fields: single "Save" button, one PATCH call, inline per-field
  success/error display from Design 2's structured response.
- Redeploy fields: separate "Package Settings" subsection, its own
  "Save & Redeploy" button. Clicking shows a confirmation dialog stating
  plainly what happens (new packaging job, new Intune app version,
  supersedes the current one, installed devices will re-run install) before
  dispatching. Once dispatched, links to the packaging job's progress using
  the same status UI already used on `/dashboard/uploads` — no new progress
  component.
- Edit toggle only renders for apps with `upload_history` lineage (Design
  2's server-side gate is mirrored client-side to avoid showing an edit
  affordance that will 404).

### 5. Rollback

- New "Version History" section in the app details panel, sourced from
  `packaging_jobs` filtered by `winget_id` + `tenant_id` (no new table,
  already-queryable data).
- Each prior version's row gets a "Roll back to this version" action.
  Confirming reuses Design 3's exact staging/confirm/dispatch flow, with
  the `DeploymentConfig` built from *that older* `packaging_jobs` row's
  `install_command`/`uninstall_command`/`detection_rules`/`installer_url`/
  `installer_sha256`, but *current* assignments/categories (assignments may
  have changed since that version was live; always target current
  assignments, never resurrect stale ones).
- `auto_update_history.update_type` gains a new value, `'rollback'`
  (column is a free-text `TEXT`, no migration needed — `classifyUpdateType`
  gains a rollback-detection branch: target version older than currently
  installed → `'rollback'`, otherwise its existing major/minor/patch
  logic), so rollback events are distinguishable from forward updates in
  any history view.
- Reuses `AutoUpdateTriggerSqlite.checkRateLimits()` unchanged — a rollback
  is just another dispatch through the same trigger, so the existing
  per-tenant/per-hour/per-policy cooldown protections apply automatically
  without new code.

## Error handling

- **Design 1 fix**: no new failure modes — it adds fields to an existing,
  already-tested dispatch call. Existing `auto_update_history` status
  tracking (`packaging` → `completed`/`failed`) already covers a dispatch
  failure after this change same as before.
- **Instant-path partial failure** (Design 2): report exactly which fields
  saved and which didn't; never silently swallow a per-assignment Graph
  failure the way `applyAppRelationships` does today (console.error only).
- **Redeploy-path failure** (Design 3/5): identical to a normal
  auto-update's existing failure path — `auto_update_history` status
  `failed`, error surfaced in the panel, original (pre-redeploy) app
  untouched since supersedence only takes effect on a *successful* new
  deployment.
- **Concurrent dispatch**: the existing cooldown check in
  `checkRateLimits()` naturally prevents a second concurrent
  redeploy/rollback for the same policy; surfaced as "an update is already
  in progress" rather than a silent double-dispatch.

## Testing

- Unit tests for the Design 1 fix: `triggerAutoUpdate()` passes the new
  `WorkflowInputs` fields correctly given a `currentIntuneAppId` present vs.
  absent (first-ever deploy has none).
- Unit tests for the edit route's field-diff/routing logic (instant vs.
  redeploy split) — no need to re-test the underlying Graph/trigger calls
  already covered by Design 1's tests and the existing trigger-sqlite
  suite.
- Unit tests for rollback's version-selection query and the
  `classifyUpdateType` rollback branch.
- Manual E2E verification against the real lab tenant (same method as the
  parent 2026-09-12 spec): confirm a real auto-update now supersedes
  in-place with assignments carried over, confirm an Inventory edit
  round-trips, confirm a rollback redeploys an older version successfully.

## Acceptance criteria

- [ ] A real `auto_update` policy trigger on a previously-deployed app
      supersedes the existing Intune app (single app in Windows apps list
      before and after, not two) and the new version's assignments match
      the original's.
- [ ] Inventory app details panel shows an Edit toggle only for apps with
      upload history; other apps stay fully read-only.
- [ ] Assignment/category/notification/policy/deferral edits save without
      triggering a rebuild.
- [ ] Install command/uninstall command/detection rule edits require
      explicit "Save & Redeploy" confirmation and produce a new packaging
      job + supersedence, same as an auto-update.
- [ ] Rolling back to a prior version redeploys that version's exact
      installer/config with current assignments, and is labeled `rollback`
      in `auto_update_history`.
- [ ] No regression to the Supabase-mode `AutoUpdateTrigger` or its UI —
      this spec touches SQLite-mode code and shared UI components only.

## Review

(to be filled after implementation)
