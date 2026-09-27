# Duplicate-Handling Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's binary duplicate-check outcome (skip, or `forceCreate` a real second Intune app) with three real branches: merge into an existing app's assignments, replace the app's content in place, or genuinely duplicate — so redeploying to a different group no longer clutters the tenant with extra Intune app objects.

**Architecture:** All new duplicate-classification logic moves server-side (Next.js, `app/api/intune/apps/deployed/route.ts` + a new merge/replace endpoint), because it needs this app's stored assignment/rule config, which the GitHub Actions PowerShell step (`Check-DuplicateApp.ps1`) never had. The workflow-dispatched packaging path is untouched for the genuinely-new and genuinely-different-rules cases. `UploadCart.tsx`'s existing "already deployed" warning gets a second button next to "Deploy as new app anyway".

**Tech Stack:** Next.js API routes, Microsoft Graph REST (`deviceAppManagement/mobileApps`), existing `lib/intune-api.ts` helpers, SQLite via `lib/db`.

**Spec:** `docs/superpowers/specs/2026-09-27-duplicate-handling-redesign-design.md`

## Global Constraints

- Tenant-wide duplicate match key stays displayName + winget-ID fingerprint (spec non-goal: don't change matching heuristic).
- MSP/multi-tenant handling out of scope (spec non-goal, same standing exclusion as 9b/9c).
- No automatic bulk cleanup of clutter already in the lab tenant from before this ships (spec non-goal).
- Graph's `POST /mobileApps/{id}/assign` **replaces** the full assignment set — it is not additive. Any code calling `assignToGroups` must first fetch existing assignments via `getAppAssignments` and merge, never call it with only the new assignment.
- `forceCreate` behavior (real second app object) must remain exactly as-is for the genuinely-different-rules branch — do not change `Check-DuplicateApp.ps1` or the GitHub Actions workflow in this plan (Task 4 resolves whether classification even reaches the workflow for that branch, but the workflow's own force-create path is untouched).

## Review Focus

- An app match exists but has **no** `intune_app_id` recorded anywhere retrievable (e.g. deployed by another tool, or the `packaging_jobs` row was purged) — merge/replace must fail closed with a clear error, never silently fall through to `forceCreate`.
- Two assignments target the **same group with different intent** (e.g. existing `required`, new `available`) — merging must not silently produce two assignment entries for one group; last-write-wins on intent for an identical `(groupId, type)` pair, explicit in the merge function's test.
- The "add assignment" path is invoked on an app whose Graph object was deleted since the last poll (404 on `getAppAssignments`) — must degrade to the same "source app missing" warning pattern already used by `lib/github-actions.ts`'s "Verify source app still exists" step, not a raw 500.
- User clicks "Add this group to existing app" on an item whose install command or detection rules actually differ from the existing app's — Graph happily merges the assignment but the app's content stays on the old rules, silently wrong. This plan does not add automatic rule-comparison (deliberate v1 scope cut, see Task 6); the mitigation is Task 6's button copy telling the user to check for rule differences before choosing merge vs. separate-app. No test owns this — it's a documented UI-level risk accepted for v1, not a gap to silently ship past.
- `assignToGroups`'s full-replace semantics get called from two different code paths (manual merge endpoint here, and the existing auto-update carry-over flow in `trigger.ts`/`trigger-sqlite.ts`). A true concurrent race (two writers hitting the same app's assignments at once) is accepted as out of scope — this app is single-tenant/single-admin per instance (SQLite mode) — but Task 2's test 1 pins that the merge endpoint always reads-before-writing via `getAppAssignments`, so it at least never blindly overwrites with only the new assignment even sequentially.

---

## Milestone A — Branch 1: merge into existing app's assignments (the "multiple device assignments" ask)

This ships standalone and first, per the user's explicit priority. It needs no resolution of the replace-mechanism open question.

### Task 1: `mergeAssignments` helper + unit tests

**Files:**
- Create: `lib/assignment-merge.ts`
- Test: `lib/assignment-merge.test.ts`

**Interfaces:**
- Consumes: `Win32LobAppAssignment` from `types/intune.ts:220`
- Produces: `mergeAssignments(existing: Win32LobAppAssignment[], incoming: Win32LobAppAssignment[]): Win32LobAppAssignment[]` — used by Task 2's route and nowhere else in this plan.

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/assignment-merge.test.ts
import { describe, it, expect } from 'vitest';
import { mergeAssignments } from './assignment-merge';
import type { Win32LobAppAssignment } from '@/types/intune';

function groupAssignment(groupId: string, intent: Win32LobAppAssignment['intent']): Win32LobAppAssignment {
  return {
    '@odata.type': '#microsoft.graph.mobileAppAssignment',
    intent,
    target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId },
  };
}

describe('mergeAssignments', () => {
  it('keeps existing assignments untouched when incoming targets a new group', () => {
    const existing = [groupAssignment('group-a', 'required')];
    const incoming = [groupAssignment('group-b', 'available')];
    const result = mergeAssignments(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([existing[0], incoming[0]]));
  });

  it('last-write-wins on intent when group id and target type match', () => {
    const existing = [groupAssignment('group-a', 'required')];
    const incoming = [groupAssignment('group-a', 'available')];
    const result = mergeAssignments(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].intent).toBe('available');
  });

  it('treats allDevices/allUsers targets as their own singleton key, not group-keyed', () => {
    const existing: Win32LobAppAssignment[] = [
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'required', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } },
    ];
    const incoming: Win32LobAppAssignment[] = [
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allUsersAssignmentTarget' } },
    ];
    const result = mergeAssignments(existing, incoming);
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/assignment-merge.test.ts`
Expected: FAIL — `Cannot find module './assignment-merge'`

- [ ] **Step 3: Implement `mergeAssignments`**

```typescript
// lib/assignment-merge.ts
import type { Win32LobAppAssignment } from '@/types/intune';

/**
 * Key an assignment by target type + groupId (group/exclusionGroup) or by
 * target type alone (allDevices/allUsers are singletons). Two assignments
 * with the same key are the "same slot" — incoming wins.
 */
function assignmentKey(a: Win32LobAppAssignment): string {
  const odataType = a.target['@odata.type'];
  if (odataType === '#microsoft.graph.groupAssignmentTarget' || odataType === '#microsoft.graph.exclusionGroupAssignmentTarget') {
    return `${odataType}:${a.target.groupId}`;
  }
  return odataType;
}

/**
 * Merge incoming assignments into an existing set, keyed by target. Graph's
 * POST .../assign replaces the full set, so any caller adding one
 * assignment must merge with the current set first or it silently deletes
 * every other assignment on the app.
 */
export function mergeAssignments(
  existing: Win32LobAppAssignment[],
  incoming: Win32LobAppAssignment[]
): Win32LobAppAssignment[] {
  const merged = new Map<string, Win32LobAppAssignment>();
  for (const a of existing) merged.set(assignmentKey(a), a);
  for (const a of incoming) merged.set(assignmentKey(a), a);
  return Array.from(merged.values());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/assignment-merge.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add lib/assignment-merge.ts lib/assignment-merge.test.ts
git commit -m "feat: add assignment-merge helper for in-place duplicate-app assignment"
```

---

### Task 2: `POST /api/intune/apps/[appId]/merge-assignment` route

**Files:**
- Create: `app/api/intune/apps/[appId]/merge-assignment/route.ts`
- Test: `app/api/intune/apps/[appId]/merge-assignment/route.test.ts`

**Interfaces:**
- Consumes: `mergeAssignments` (Task 1), `getAppAssignments`/`assignToGroups`/`convertToGraphAssignments` from `lib/intune-api.ts:406,628,706`, `parseAccessToken` from `lib/auth-utils`.
- Produces: `POST` handler returning `{ success: true, assignmentCount: number }` on 200, `{ error: string }` on 4xx/5xx. Consumed by Task 3's UI button.

- [ ] **Step 1: Write the failing test**

```typescript
// app/api/intune/apps/[appId]/merge-assignment/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import * as intuneApi from '@/lib/intune-api';
import * as authUtils from '@/lib/auth-utils';

vi.mock('@/lib/intune-api');
vi.mock('@/lib/auth-utils');

function makeRequest(body: unknown, appId: string) {
  return new Request(`http://localhost/api/intune/apps/${appId}/merge-assignment`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/intune/apps/[appId]/merge-assignment', () => {
  beforeEach(() => {
    vi.mocked(authUtils.parseAccessToken).mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@b.com' } as never);
  });

  it('merges the incoming assignment with existing ones and calls assignToGroups with the union', async () => {
    vi.mocked(intuneApi.getAppAssignments).mockResolvedValue([
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'required', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'existing-group' } },
    ]);
    vi.mocked(intuneApi.assignToGroups).mockResolvedValue(undefined);

    const req = makeRequest(
      { accessToken: 'graph-token', assignment: { type: 'group', groupId: 'new-group', intent: 'available' } },
      'app-123'
    );
    const res = await POST(req, { params: Promise.resolve({ appId: 'app-123' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, assignmentCount: 2 });
    expect(intuneApi.assignToGroups).toHaveBeenCalledWith(
      'graph-token',
      'app-123',
      expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ groupId: 'existing-group' }) }),
        expect.objectContaining({ target: expect.objectContaining({ groupId: 'new-group' }) }),
      ])
    );
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authUtils.parseAccessToken).mockResolvedValue(null);
    const req = makeRequest({ accessToken: 'x', assignment: { type: 'group', groupId: 'g', intent: 'required' } }, 'app-123');
    const res = await POST(req, { params: Promise.resolve({ appId: 'app-123' }) });
    expect(res.status).toBe(401);
  });

  it('returns 502 with a clear message when the target app no longer exists', async () => {
    vi.mocked(intuneApi.getAppAssignments).mockRejectedValue(new Error('Failed to get app assignments'));
    const req = makeRequest({ accessToken: 'graph-token', assignment: { type: 'group', groupId: 'g', intent: 'required' } }, 'app-123');
    const res = await POST(req, { params: Promise.resolve({ appId: 'app-123' }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/no longer exists|could not be reached/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/intune/apps/[appId]/merge-assignment/route.test.ts`
Expected: FAIL — route module doesn't exist

- [ ] **Step 3: Implement the route**

```typescript
// app/api/intune/apps/[appId]/merge-assignment/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { getAppAssignments, assignToGroups, convertToGraphAssignments } from '@/lib/intune-api';
import type { PackageAssignment } from '@/types/upload';

interface MergeAssignmentBody {
  accessToken: string; // Graph access token (caller already has it via MSAL)
  assignment: PackageAssignment;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const { appId } = await params;
  const body = (await request.json()) as MergeAssignmentBody;

  if (!body.accessToken || !body.assignment) {
    return NextResponse.json({ error: 'accessToken and assignment are required' }, { status: 400 });
  }

  try {
    const existing = await getAppAssignments(body.accessToken, appId);
    const incoming = convertToGraphAssignments([body.assignment]);
    const { mergeAssignments } = await import('@/lib/assignment-merge');
    const merged = mergeAssignments(existing, incoming);

    await assignToGroups(body.accessToken, appId, merged);

    return NextResponse.json({ success: true, assignmentCount: merged.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Could not update assignments on the existing app (${appId}) — it may no longer exist in Intune: ${message}` },
      { status: 502 }
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/intune/apps/[appId]/merge-assignment/route.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add app/api/intune/apps/[appId]/merge-assignment/route.ts app/api/intune/apps/[appId]/merge-assignment/route.test.ts
git commit -m "feat: add merge-assignment route to add a target group to an existing Intune app"
```

---

### Task 3: Surface `intuneAppId` in the deployed-apps lookup + wire UI button

**Files:**
- Modify: `app/api/intune/apps/deployed/route.ts:11-14,29-40` (add `intuneAppId` to the `TenantJobRow`/response shape from `getDatabase().jobs.getByTenantId`)
- Modify: `components/UploadCart.tsx:109,138-152,471-491`
- Test: `app/api/intune/apps/deployed/route.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: Task 2's `POST /api/intune/apps/[appId]/merge-assignment`.
- Produces: `tenantDeployedBy` state in `UploadCart.tsx` becomes `Map<string, { deployedBy: string | null; intuneAppId: string | null }>` — no other file in this plan reads this state.

- [ ] **Step 1: Write the failing test for the route change**

Add to `app/api/intune/apps/deployed/route.test.ts`:

```typescript
it('includes intuneAppId in tenant-scope deployments', async () => {
  // existing test setup already seeds a deployed job fixture in this file —
  // extend that fixture's expected shape:
  const response = await GET(makeRequest({ scope: 'tenant' }));
  const body = await response.json();
  expect(body.tenantDeployments[0]).toHaveProperty('intuneAppId');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/intune/apps/deployed/route.test.ts`
Expected: FAIL — `intuneAppId` undefined on the returned object

- [ ] **Step 3: Implement the route change**

In `app/api/intune/apps/deployed/route.ts`, change the SQLite branch's map (around line 33-34):

```typescript
        const tenantDeployments = jobs
          .filter((job) => job.status === 'deployed')
          .map((job) => ({
            wingetId: job.winget_id,
            deployedBy: job.user_email,
            intuneAppId: job.intune_app_id ?? null,
          }));
```

Apply the equivalent change to the Supabase branch further down in the same file (same `.map` shape, same three fields).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/intune/apps/deployed/route.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the UI**

In `components/UploadCart.tsx`, change the state type (line 109) and the fetch mapping (lines 138-152):

```typescript
  const [tenantDeployedBy, setTenantDeployedBy] = useState<
    Map<string, { deployedBy: string | null; intuneAppId: string | null }>
  >(new Map());
```

```typescript
        const data = await response.json();
        const map = new Map<string, { deployedBy: string | null; intuneAppId: string | null }>();
        for (const d of (data.tenantDeployments || []) as { wingetId: string; deployedBy: string | null; intuneAppId: string | null }[]) {
          map.set(d.wingetId, { deployedBy: d.deployedBy, intuneAppId: d.intuneAppId });
        }
        if (!cancelled) setTenantDeployedBy(map);
```

Add a `mergingAssignment` busy-state and a second button next to "Deploy as new app anyway" (around line 471-491):

```typescript
                      {tenantDeployedBy.has(item.wingetId) && !item.forceCreate && (
                        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-500/20 dark:bg-amber-500/10">
                          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                          <div className="text-xs flex-1">
                            <p className="font-medium text-amber-900 dark:text-amber-300">Already deployed in this tenant</p>
                            <p className="mt-0.5 text-amber-800 dark:text-amber-200/80">
                              {tenantDeployedBy.get(item.wingetId)?.deployedBy
                                ? `Deployed by ${tenantDeployedBy.get(item.wingetId)?.deployedBy}.`
                                : 'Already deployed by someone in this tenant.'}{' '}
                              Deploying again is skipped unless you add this group to the existing app, or deploy as a new app.
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-3">
                              {tenantDeployedBy.get(item.wingetId)?.intuneAppId && (
                                <button
                                  onClick={() => mergeAssignmentIntoExistingApp(item)}
                                  disabled={isDeploying || mergingAssignmentIds.has(item.id)}
                                  className="font-medium text-amber-800 underline underline-offset-2 transition-colors hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:opacity-50 dark:text-amber-300 dark:hover:text-amber-200 dark:focus-visible:ring-amber-400 dark:focus-visible:ring-offset-bg-elevated"
                                >
                                  {mergingAssignmentIds.has(item.id) ? 'Adding group…' : 'Add this group to existing app'}
                                </button>
                              )}
                              <button
                                onClick={() => updateItem(item.id, { forceCreate: true })}
                                disabled={isDeploying}
                                className="font-medium text-amber-800 underline underline-offset-2 transition-colors hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:opacity-50 dark:text-amber-300 dark:hover:text-amber-200 dark:focus-visible:ring-amber-400 dark:focus-visible:ring-offset-bg-elevated"
                              >
                                Deploy as new app anyway
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
```

Add the handler and its state near the other cart handlers (co-located with `getAccessToken`/`updateItem` usage already in this file):

```typescript
  const [mergingAssignmentIds, setMergingAssignmentIds] = useState<Set<string>>(new Set());

  async function mergeAssignmentIntoExistingApp(item: CartItem) {
    const entry = tenantDeployedBy.get(item.wingetId);
    if (!entry?.intuneAppId || !isWin32CartItem(item)) return;
    setMergingAssignmentIds((prev) => new Set(prev).add(item.id));
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) return;
      const response = await fetch(`/api/intune/apps/${entry.intuneAppId}/merge-assignment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken,
          assignment: item.assignments?.[0] ?? { type: 'allDevices', intent: 'required' },
        }),
      });
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error);
      }
      removeItem(item.id);
    } catch (err) {
      // Non-fatal: leave the cart item in place, existing item-level error
      // surfaces (hasFailedQaForItem pattern above) already show a message
      // area per item; reuse it rather than adding a new one for this case.
      console.error('Failed to merge assignment into existing app:', err);
    } finally {
      setMergingAssignmentIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }
```

- [ ] **Step 6: Run the full test suite for touched files**

Run: `npx vitest run app/api/intune/apps/deployed/route.test.ts lib/assignment-merge.test.ts app/api/intune/apps/[appId]/merge-assignment/route.test.ts`
Expected: all PASS

- [ ] **Step 7: Run `tsc` to catch type errors in `UploadCart.tsx`**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 8: Commit**

```bash
git add app/api/intune/apps/deployed/route.ts app/api/intune/apps/deployed/route.test.ts components/UploadCart.tsx
git commit -m "feat: let a redeploy add a target group to an existing app instead of duplicating it"
```

---

## Milestone B — Branches 2 & 3: replace-in-place and narrowed force-duplicate

Blocked on the spec's open question 1 (replace mechanism). Task 4 resolves it with a live test before any code depends on the answer.

### Task 4: Spike — verify `committedContentVersion` PATCH against the lab tenant

This is a research task, not a shippable code change. Its output decides Task 5/6's design, so it runs before them and produces a written decision, not a diff.

**Files:**
- Create: `docs/superpowers/sdd/2026-09-27-duplicate-handling-redesign/content-version-patch-spike.md` (decision record only, not a `.ts` file)

- [ ] **Step 1: Pick a disposable test app already in the lab tenant**

Use the existing VS Code auto-update test app referenced in the 9c ledger (real `supersededAppCount`/`supersedingAppCount` verified live 2026-09-13) — same tenant, already known-good for this kind of live Graph test. Confirm its current `id` and `committedContentVersion` via:

```
GET https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/{id}?$select=id,committedContentVersion,displayVersion
```

- [ ] **Step 2: Attempt the documented in-place content update flow**

Against that same app id:
1. `POST .../mobileApps/{id}/contentVersions` with an empty body — confirm a new content version is created.
2. `POST .../contentVersions/{contentVersionId}/files` with a small test `mobileAppContentFile` body — confirm a SAS upload URI comes back.
3. Upload a trivial `.intunewin` (or the same payload the real app was built from, if available) to that SAS URI, then `POST .../files/{fileId}/commit` with encryption info.
4. `PATCH .../mobileApps/{id}` with `{ "@odata.type": "#microsoft.graph.win32LobApp", "committedContentVersion": "<new version id>" }`.

Record the raw HTTP status and body of every step, success or failure, in the decision record file.

- [ ] **Step 3: Confirm no new app object was created and assignments survived**

```
GET https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/{id}/assignments
```

Compare against the assignments recorded before Step 2. Confirm the app `id` is unchanged and `committedContentVersion` reflects the new version.

- [ ] **Step 4: Write the decision record**

In `content-version-patch-spike.md`, state plainly: did the full flow succeed against this tenant's real `win32LobApp`? If yes, Task 5 implements true in-place replace (no old-app retirement needed — go straight to it, skip Task 5's fallback branch). If it failed at any step (matching the immutability assumption in the 9c design doc), Task 5 implements `supersedenceType: 'replace'` instead, and Task 6's retirement-policy question becomes live.

- [ ] **Step 5: Commit the decision record**

```bash
git add docs/superpowers/sdd/2026-09-27-duplicate-handling-redesign/content-version-patch-spike.md
git commit -m "docs: record content-version PATCH spike result, decide replace mechanism"
```

---

### Task 5: Implement the chosen replace mechanism

**This task has two possible implementations depending on Task 4's result — write only the branch the decision record selected.**

**Files:**
- Modify: `lib/intune-api.ts` (new exported function, alongside `applyAppRelationships` at line 792, or alongside `assignToGroups` at line 406)
- Test: `lib/intune-api.test.ts` (existing file — extend, or create if it doesn't exist yet: check with `ls lib/intune-api.test.ts` before starting)

**Interfaces:**
- Produces: either `replaceAppContentInPlace(accessToken, appId, content): Promise<void>` (content-version path) or `replaceAppViaSupersedence(accessToken, oldAppId, newAppId): Promise<void>` (wraps `applyAppRelationships` with `supersedenceType: 'replace'`) — Task 6's retirement logic (if needed) consumes whichever one Task 4 selected.

**If Task 4 selected content-version PATCH:**

- [ ] **Step 1: Write the failing test**

```typescript
// lib/intune-api.test.ts (add to existing file, or new file)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { replaceAppContentInPlace } from './intune-api';

describe('replaceAppContentInPlace', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a content version, uploads, commits, then PATCHes committedContentVersion', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cv-1' }), { status: 201 })) // POST contentVersions
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-1', azureStorageUri: 'https://sas.example/upload' }), { status: 201 })) // POST files
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // upload to SAS
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // commit
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // PATCH committedContentVersion

    await replaceAppContentInPlace('token', 'app-1', {
      fileName: 'app.intunewin',
      fileSize: 100,
      fileSizeEncrypted: 110,
      manifest: 'base64manifest',
      encryptionInfo: { encryptionKey: 'k', macKey: 'm', initializationVector: 'iv', mac: 'mac', profileIdentifier: 'ProfileVersion1', fileDigest: 'd', fileDigestAlgorithm: 'SHA256' },
      uploadBuffer: Buffer.from('fake-payload'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const patchCall = fetchMock.mock.calls[4];
    expect(patchCall[0]).toContain('/mobileApps/app-1');
    expect(JSON.parse(patchCall[1]!.body as string)).toMatchObject({ committedContentVersion: 'cv-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/intune-api.test.ts -t replaceAppContentInPlace`
Expected: FAIL — `replaceAppContentInPlace` not exported

- [ ] **Step 3: Implement, using the exact request shapes recorded in Task 4's decision record**

Write `replaceAppContentInPlace` in `lib/intune-api.ts` following the four-call sequence validated live in Task 4 — copy the exact body shapes from that spike's recorded requests (don't re-derive them from docs; use what was proven to work against the real tenant).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/intune-api.test.ts -t replaceAppContentInPlace`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/intune-api.ts lib/intune-api.test.ts
git commit -m "feat: add in-place content replace for win32LobApp via committedContentVersion"
```

**If Task 4 selected `supersedenceType: 'replace'` instead:**

- [ ] **Step 1: Write the failing test**

```typescript
// lib/auto-update/trigger.test.ts (extend existing test file for this call site)
import { describe, it, expect } from 'vitest';
// Locate the existing test that asserts supersedenceType: 'update' at
// createPackagingJob (see lib/auto-update/__tests__/trigger.test.ts:927) and
// add a sibling test for the replace path:

it('sets supersedenceType to replace when the update policy requests in-place replace', async () => {
  // Arrange a policy with deployment_config.replaceInPlace = true (new field,
  // see Step 3) instead of the default auto-supersede config.
  // Assert jobData.package_config.supersedenceType === 'replace'.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/auto-update/__tests__/trigger.test.ts -t "replace"`
Expected: FAIL

- [ ] **Step 3: Implement**

In `lib/auto-update/trigger.ts` (around line 692, and the equivalent in `lib/auto-update/trigger-sqlite.ts:179`), change:

```typescript
        supersedenceType: autoSupersede ? 'update' : undefined,
```

to read a new `config.replaceInPlace` flag (default `false`, preserving today's `'update'` behavior everywhere it isn't explicitly set):

```typescript
        supersedenceType: autoSupersede ? (config.replaceInPlace ? 'replace' : 'update') : undefined,
```

Add `replaceInPlace?: boolean;` to the `DeploymentConfig` type in `types/update-policies.ts` alongside the existing `assignmentMigration` field (line 47 area).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/auto-update/__tests__/trigger.test.ts -t "replace"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/auto-update/trigger.ts lib/auto-update/trigger-sqlite.ts types/update-policies.ts lib/auto-update/__tests__/trigger.test.ts
git commit -m "feat: allow update policies to request Graph supersedenceType replace"
```

---

### Task 6: Narrow `forceCreate`'s UI copy to the genuinely-different-rules case

**Files:**
- Modify: `components/UploadCart.tsx` (the warning block updated in Task 3)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — copy-only change, no new function signatures.

- [ ] **Step 1: Update the button label and helper text**

In the same warning block touched by Task 3, change the "Deploy as new app anyway" button's surrounding text to make clear it's for real rule differences, now that "Add this group to existing app" exists for the common case:

```typescript
                              Deploying again is skipped unless the two versions actually need different detection rules, install behavior, or device requirements — then choose:
```

and rename the button label from `Deploy as new app anyway` to `Deploy as separate app (different rules)`.

- [ ] **Step 2: Manual verification**

Run: `npm run dev`, open the app, add an already-tenant-deployed winget package to the cart, confirm both buttons render with the new copy and the merge button still calls the Task 2 route correctly (re-run the Task 3 flow once by hand).

- [ ] **Step 3: Commit**

```bash
git add components/UploadCart.tsx
git commit -m "docs: clarify force-create copy now that assignment-merge covers the common duplicate case"
```

---

## Backlogged (not in this plan)

- **Old-app retirement policy** (spec open question 3): only relevant if Task 4 selects `supersedenceType: 'replace'` (content-version PATCH needs no retirement — same app object throughout). If relevant, backlog as its own follow-up plan once Task 4's result is known: decide auto-delete-after-N-days vs. Inventory-UI legacy filter, gated on a device-install-completion check so nothing deletes an app a device is still mid-migration on.
- **Bulk cleanup of existing clutter** in the lab tenant from before this ships — explicit spec non-goal, one-time manual task for boss, not automated.
