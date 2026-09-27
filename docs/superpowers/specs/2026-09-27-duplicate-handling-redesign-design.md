# Duplicate-Handling Redesign (Intune App Clutter)

Status: design only, not yet planned/implemented.
Backlog ref: `backlog_intuneget_lab_pilot.md` item 6.

## Problem

Every redeploy of an already-deployed app creates Intune clutter. Confirmed
by reading the actual duplicate-check logic (`Check-DuplicateApp.ps1`,
pinned upstream commit `9214e4b5b71508bfba9aa1a2d4de5c3c771d3fea`, fetched
2026-09-27 since it isn't checked out locally — the private workflows repo
pins and vendors this one script from `ugurkocde/IntuneGet` at build time):

- Match key is **tenant-wide `displayName` (case-insensitive) + a
  `Winget: <id>` / `Source: IntuneGet.com` fingerprint in the description**.
  Nothing about assignments, target group, or deployment rules factors in.
- Outcome is **binary**: if a match is found, the run is always skipped
  (`duplicate_skipped` callback) *unless* `forceCreate` is set, in which
  case the duplicate check is skipped entirely and a brand-new Intune app
  object is always created — no partial path exists.
- Confirmed live (memory, 2026-09-12): a forced Teams redeploy landed a
  genuinely separate App ID from the original. `forceCreate` never updates
  or supersedes anything; it just makes a second object every time.

Separately, `Intune` (`mobileAppAssignment`) already supports **multiple
assignments on one app object** — different target groups, install
intents, and filters can coexist on a single app. So most of today's
`forceCreate`-driven duplication is unnecessary: redeploying "the same app,
different group" doesn't need a second Intune app at all.

Two Graph mechanisms are already partially wired but unused for this case:

- **`mobileAppSupersedence` relationship**, `supersedenceType: 'replace'`
  — exists end-to-end in the type system (`intune-api.ts`,
  `DependencyConfig.tsx`, `intune-uploader.ts`) and is Graph-native
  "replace this app" semantics, but every auto-update call site
  (`trigger.ts:692`, `trigger-sqlite.ts:179`) hardcodes `'update'`.
  `'replace'` is only reachable today via the manual dependency-config UI.
- **`win32LobApp.committedContentVersion` content-version PATCH** — Graph
  docs confirm this is a real, supported in-place content update (POST a
  new `contentVersions` entry, upload, PATCH `committedContentVersion` to
  activate; metadata PATCHes separately on the same app object; verified
  2026-09-27 via Microsoft Learn: `win32LobApp`/`mobileAppContent` resource
  docs + `Update-MgDeviceAppManagementMobileAppAsWin32LobAppContentVersion`).
  **This conflicts with an explicit prior decision** in
  `docs/superpowers/plans/2026-09-13-inventory-redeploy-rollback.md:33`:
  "Win32LobApp objects are immutable per version in Graph: 'replace in
  place' is implemented as create-new + supersede-old ... never a PATCH of
  the existing app object's package." That decision predates this spec and
  needs to be revisited — resolve before planning (see Open questions).

## Goals

1. Stop creating a new Intune app object when the only thing that changed
   is *who gets it* — add/update assignments on the existing matched app
   instead.
2. Give the duplicate-found path a genuine "replace" option using
   Graph-native supersedence (`supersedenceType: 'replace'`) or true
   content-version PATCH (pending the open question below), so a same-app
   version bump doesn't leave the old object behind uncleaned.
3. Keep `forceCreate`/"duplicate with different rules" as a real, narrower
   third option — only for genuinely different detection rules, install
   command, or device requirements, not for assignment-only differences.
4. Old superseded app objects don't accumulate indefinitely with no
   lifecycle — either retired, or clearly surfaced as inactive/legacy in
   the Inventory UI, so the Intune console list doesn't grow unbounded.

## Proposed design — three branches replacing today's binary check

`Check-DuplicateApp.ps1` (or its Next.js-side equivalent — see open
question on where this logic should live) classifies a match into:

1. **Same app, same rules, different/additional target group** — no new
   Intune app. Add a `mobileAppAssignment` to the existing matched app.
   Not handled at all today; this is the main clutter source given the
   memory context ("different deployment assignments" was the trigger
   for this whole investigation).
2. **Same app, new version, same rules** — replace in place. Either
   `supersedenceType: 'replace'` (already plumbed, just needs selecting)
   or content-version PATCH (pending the open question), retiring the old
   object rather than leaving it superseded-but-present forever.
3. **Genuinely different rules** (detection, install command, device
   requirements) — keep today's `forceCreate` behavior: real second app
   object. This is the only case where duplication is actually correct.

## Non-goals (for this spec)

- MSP / multi-tenant duplicate handling — out of scope, same standing
  exclusion as 9b/9c.
- Automatic bulk cleanup of *existing* clutter already in the lab tenant
  from before this redesign ships — one-time manual cleanup, not a
  feature.
- Changing the name+fingerprint matching heuristic itself (still tenant-
  wide displayName + winget-ID fingerprint) — only what happens *after*
  a match is found.

## Open questions — resolve before writing the implementation plan

1. **Replace mechanism**: `supersedenceType: 'replace'` (simpler, already
   half-wired, but still leaves two app objects — old one just marked
   superseded, not removed, so branch 4's clutter concern isn't fully
   solved) vs. true `committedContentVersion` PATCH (genuinely single
   object, no old-app retirement needed, but contradicts the 9c design
   doc's stated Graph-immutability assumption — needs a live test against
   the lab tenant to confirm content-version PATCH actually works for a
   `win32LobApp` created by this pipeline, not just docs theory).
2. **Where does branch classification happen?** Today's duplicate check
   runs inside the GitHub Actions PowerShell step
   (`Check-DuplicateApp.ps1`), which only has Graph app-list data, not
   this app's own assignment/policy state. Comparing "are the rules
   actually the same" may need the classification to move server-side
   (Next.js, has full DB context) before the workflow is even dispatched,
   with the workflow just executing the chosen branch.
3. **Old-app retirement policy** (branch 4): auto-delete after N days post-
   supersedence (needs a device-install-completion check first, don't
   delete out from under a device still mid-migration), or leave the
   Graph object alone and just filter/badge it as legacy in Inventory?
   Decide based on answer to question 1 — if content-version PATCH works,
   this question may be moot for the auto-update path (branch 2) and only
   applies to genuinely-superseded historical apps.

## Related

- `backlog_intuneget_lab_pilot.md` item 6 (original ask, now superseded by
  this spec's three-branch model — the original two-option "force
  replace / force duplicate" framing didn't account for assignment-only
  changes)
- `docs/superpowers/specs/2026-09-13-inventory-redeploy-rollback-design.md`
  — where the create-new+supersede pattern and the Graph-immutability
  assumption (question 1) were first established
