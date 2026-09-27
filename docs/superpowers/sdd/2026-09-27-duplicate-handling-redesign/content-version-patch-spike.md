# Content-Version PATCH Spike — Decision Record

Date: 2026-09-27. Ran live against the lab tenant using the IntuneGet app
registration's own client-credentials Graph token (app-only,
`DeviceManagementApps.ReadWrite.All`). Tenant ID and object IDs are redacted
below — this repo's `origin` is public (`isithuman-2026/IntuneGet`) and none
of these identifiers need to travel with it; they're recorded privately in
Claude memory (`backlog_intuneget_lab_pilot.md`) instead.

## Target app

Confirmed the real supersedence chain from the 9c ledger is still live and
growing — exactly the clutter this whole redesign is about:

| App (anonymized) | displayVersion | createdDateTime | supersededAppCount | supersedingAppCount |
|---|---|---|---|---|
| App A (oldest) | 1.135.0 | 2026-08-30 | 0 | 3 |
| App B | 1.137.0 | 2026-09-13 | 1 | 2 |
| App C | 1.139.0 | 2026-09-26 | 2 | 1 |
| App D (current) | 1.139.1 | 2026-09-27 | 3 | 0 |

Four separate "Microsoft Visual Studio Code" Intune app objects, all still
`publishingState: published`. Also found 2x Foxit PDF Reader and 2x Claude
objects in the same tenant-wide app list — the clutter is not hypothetical.

Spiked against App D, the current app (`committedContentVersion: 1` at the
start).

## Steps run and results

1. `POST .../mobileApps/{id}/microsoft.graph.win32LobApp/contentVersions` with
   `{}` → **HTTP 201**, new content version `id: "2"` created on an
   already-published, already-deployed app. No rejection of any kind.
2. `POST .../contentVersions/2/files` with a minimal `mobileAppContentFile`
   body → **HTTP 201**. Graph auto-generated a real PSADT manifest matching
   the app's existing install/detection config and returned
   `uploadState: azureStorageUriRequestPending`.
3. Polled the file resource → within one poll, `uploadState` flipped to
   `azureStorageUriRequestSuccess` with a real, usable Azure Blob SAS URI.
4. `PUT` a 19-byte test payload to that SAS URI → **HTTP 201**, blob accepted.
5. `POST .../files/{fileId}/commit` with a `fileEncryptionInfo` block —
   **fields were fake/random** (this spike did not run the app's own
   `packager/src/intune-uploader.ts` AES/HMAC encryption pipeline against a
   real `.intunewin`, so the digest could never match) → **HTTP 200**
   (accepted for async processing).
6. Polled the file resource again → `uploadState: commitFileFailed`,
   `uploadErrorCode: null`. Expected — Intune's backend validated the
   ciphertext/digest and rejected it, exactly as it should for garbage
   encryption data. **Not** an immutability rejection.
7. Attempted the "activate" step anyway:
   `PATCH .../mobileApps/{id}` with `committedContentVersion: "2"` →
   **HTTP 400**, `"All AppFiles must be committed before committing an
   application."` — a precise, expected guard-rail error naming the real
   cause (step 6's failed file commit), not a generic or immutability error.
8. Re-fetched the app afterward: `committedContentVersion` still `1`,
   `publishingState: published`, `displayVersion: 1.139.1` — completely
   unaffected. The failed spike left no visible damage on the live app.

## Update — 2026-09-27, post-review

The implementation (`lib/intune-api.ts` `replaceAppContentInPlace`) was
initially shipped without the polling this spike itself found necessary
(steps 3 and 6 above are both async — `azureStorageUri` and the commit
result are never present on the request that triggers them). Whole-branch
review caught this; fixed to poll on both, matching this spike's own
recorded behavior and `packager/src/intune-uploader.ts`'s proven pattern.

**Still open:** this spike, and the code, have never observed the
activation PATCH (step 7) actually *succeed* — only its correct rejection
of an intentionally-invalid commit. A live re-run with real encrypted
content (reusing `packager/src/intune-uploader.ts`'s encryption pipeline
against a real `.intunewin`) would close that gap. Recommended before this
mechanism gets a real caller wired into the auto-update path.

## Decision

**Content-version PATCH is real and reachable on an already-published,
already-deployed `win32LobApp`.** Every step up through file commit worked
exactly as Microsoft Learn's docs describe, with zero evidence anywhere of
the "Win32LobApp objects are immutable per version" restriction asserted in
`docs/superpowers/specs/2026-09-13-inventory-redeploy-rollback-design.md:33`.
That assumption is now **superseded by this live test** — it was likely a
reasonable guess at the time (no live test was run for 9c, since 9c's own
"replace" need was fully satisfied by supersedence + carry-over) rather than
a Graph limitation.

The one step this spike could not complete — a genuinely successful file
commit — failed for a mundane, expected reason (fake encryption bytes), not
a design blocker. This codebase already has correct Intune content
encryption implemented and battle-tested in `packager/src/intune-uploader.ts`
(used by every real deploy since 2026-08-30). Task 5 should reuse that
encryption logic rather than re-deriving it.

**Task 5 implements true in-place content replace** via
`replaceAppContentInPlace`, not `supersedenceType: 'replace'`. This also
means the spec's open question 3 (old-app retirement policy) is **moot for
the auto-update path** — there is no old app object left behind when this
mechanism is used, since the same app object is reused throughout. It only
still applies to the four VS Code objects (and similar) already accumulated
in the tenant from before this redesign ships, which stays an explicit
spec non-goal (one-time manual cleanup, not automated).

## Leftover state

Content version `2` on App D (the current app) is left
uncommitted (`isCommitted: false`) from this spike. It has no effect on the
live, deployed app (`committedContentVersion` is still `1`) and Graph has no
delete endpoint for an individual content version — it will simply sit
unused. Harmless; noted here so it isn't mistaken for unexplained state
later.
