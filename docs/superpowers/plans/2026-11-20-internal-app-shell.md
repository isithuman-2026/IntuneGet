# Internal App Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make IntuneGet open as an internal tool (front door, mockup-A sign-in, not-authorised screen) and restrict it to allowlisted tenants.

**Architecture:** Server enforces a tenant allowlist inside `parseAccessToken`; a new `/api/auth/access` endpoint tells the client "allowed / not allowed / not signed in"; a client `AccessGate` in the `(app)` area renders nothing until that check passes. The marketing landing moves to `/overview`; `/` becomes a redirect.

**Tech Stack:** Next.js 16 app router, React, MSAL (`@azure/msal-browser`/`@azure/msal-react`), Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-internal-app-shell-design.md`

## Global Constraints

- Env var name: `ALLOWED_TENANT_IDS` (server only, comma-separated GUIDs, case-insensitive, whitespace trimmed). Unset or empty = allow all and `console.warn` once.
- Not-authorised reasons: `"tenant"` (server allowlist) and `"not_assigned"` (Entra `AADSTS50105`).
- Look (mockup A): background `#f4f6f8`; card white, border `#e2e8f0`, radius 12px, max-width 400px; text `#0f172a`, secondary `#475569`; accent `#0e7490`; Inter body, Space Grotesk wordmark; buttons 44px tall; Microsoft four-square logo on the sign-in button.
- Sign-in copy (exact): heading "Sign in"; body "Use your work account. Access is limited to approved administrators in your organisation."; button "Sign in with Microsoft"; footnote "Sign-in is handled by Microsoft Entra ID. IntuneGet never sees your password."; subtitle under wordmark "Internal deployment console".
- Not-authorised copy (exact): heading "You don't have access"; body "You're signed in as {upn}, but this account isn't approved to use IntuneGet. Ask an administrator to add you to the IntuneGet admins group."; buttons "Sign in with a different account", "Sign out".
- `/api/package/callback` and `/api/cron/*` must not change (they do not use `parseAccessToken`).
- AU/NZ English in copy ("organisation").

## Review Focus

- A token from a disallowed tenant that was verified and cached before the allowlist was set: must still be rejected (allowlist applied after the cache, not inside it). Test in Task 1.
- Signed in but not allowed: the gate must show not-authorised, never redirect to sign-in (sign-in loop). Test in Task 3 (`decideGate` 403 case) and Task 4 (sign-in page does not auto-redirect when access is denied).
- `/api/auth/access` network failure or 5xx: show a retryable error state, not not-authorised and not the dashboard. Test in Task 3 (`decideGate` "error").
- Sign out from the not-authorised screen must clear the `msal-auth-hint` cookie (existing `signOut` does) so `/` does not bounce to `/dashboard`. Covered by reusing `signOut` in Task 3; checked live in Task 6.
- `callbackUrl` stays limited to internal paths: reuse the existing `getSafeInternalRedirect`; do not build new redirect parsing. Checked in Task 4 review.

---

### Task 1: Server tenant allowlist

**Files:**
- Modify: `lib/auth-utils.ts` (add exports; change `parseAccessToken` body)
- Test: `lib/__tests__/auth-allowlist.test.ts`

**Interfaces:**
- Produces: `export function isTenantAllowed(tenantId: string, allowList: string | undefined = process.env.ALLOWED_TENANT_IDS): boolean`
- Produces: `export async function verifyTokenIdentity(authHeader: string | null): Promise<TokenUserInfo | null>` (current `parseAccessToken` behaviour, no allowlist)
- Changes: `parseAccessToken(authHeader)` = `verifyTokenIdentity` then returns null when `!isTenantAllowed(info.tenantId)`.

- [ ] **Step 1: Write failing tests**: `isTenantAllowed('A-1', 'a-1, b-2') === true`; `isTenantAllowed('c-3', 'a-1,b-2') === false`; `isTenantAllowed('x', undefined) === true` and `('x', '')` true; `parseAccessToken` with `fetch` stubbed to return `/me` 200 and a token whose payload `tid` is `other`: returns null when `ALLOWED_TENANT_IDS='mine'`, and returns the user when called a second time after setting `ALLOWED_TENANT_IDS='other'` (proves cache is below the allowlist). Build test JWTs as `header.base64url(JSON payload).sig`.
- [ ] **Step 2: Run** `./node_modules/.bin/vitest run lib/__tests__/auth-allowlist.test.ts`. Expected: FAIL (exports missing).
- [ ] **Step 3: Implement** the three functions. Warn once (module-level flag) when the list is unset.
- [ ] **Step 4: Run** the test file and `./node_modules/.bin/vitest run app/api` . Expected: new tests PASS; app/api unchanged from baseline.
- [ ] **Step 5: Commit** `feat: restrict API access to ALLOWED_TENANT_IDS`.

### Task 2: `/api/auth/access`

**Files:**
- Create: `app/api/auth/access/route.ts`
- Test: `app/api/auth/access/route.test.ts`

**Interfaces:**
- Consumes: `verifyTokenIdentity`, `isTenantAllowed` (Task 1).
- Produces: `GET` → 200 `{ allowed: true, displayName: string | null, upn: string | null }`; 403 `{ allowed: false, reason: 'tenant', upn: string | null }`; 401 `{ error: 'Authentication required' }`.

- [ ] **Step 1: Failing tests** (mock `@/lib/auth-utils`): no identity → 401; identity in allowed tenant → 200 body as above; identity in other tenant → 403 with `reason: 'tenant'` and the upn.
- [ ] **Step 2: Run**, expect FAIL (route missing).
- [ ] **Step 3: Implement.** `upn`/`displayName` come from `TokenUserInfo` (use its email/name fields; read the interface).
- [ ] **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat: add /api/auth/access endpoint`.

### Task 3: Access gate and not-authorised screen

**Files:**
- Create: `lib/access-gate.ts` (pure decision), `hooks/useAccessCheck.ts`, `components/auth/AccessGate.tsx`, `components/auth/NotAuthorised.tsx`, `components/auth/AuthShell.tsx` (the shared mockup-A background + card + wordmark, used by Task 4 too)
- Modify: `app/(app)/dashboard/layout.tsx`, `app/(app)/onboarding/layout.tsx` (create if missing), `app/(app)/msp/layout.tsx`, `app/(app)/redirect/page.tsx` wrap in `AccessGate`
- Test: `lib/__tests__/access-gate.test.ts`

**Interfaces:**
- Produces: `export type GateState = 'loading' | 'signin' | 'denied' | 'error' | 'allowed'`; `export function decideGate(input: { msalReady: boolean; isAuthenticated: boolean; isSigningOut: boolean; accessStatus: number | null; fetchFailed: boolean }): GateState`
- Produces: `useAccessCheck(): { state: GateState; upn: string | null; reason: 'tenant' | 'not_assigned' | null; retry: () => void }` (react-query, key `['auth','access']`, `staleTime` 5 min, calls `/api/auth/access` with `getAccessToken()`)
- Produces: `<AccessGate>{children}</AccessGate>`: `loading` → centred spinner inside `AuthShell`; `signin` → `router.replace('/auth/signin?callbackUrl=' + encodeURIComponent(pathname))`; `denied` → `<NotAuthorised upn reason />`; `error` → message "Couldn't check your access. Try again." + retry button; `allowed` → children.
- Produces: `<NotAuthorised upn={string|null} reason={'tenant'|'not_assigned'} />` with the exact copy from Global Constraints; "Sign in with a different account" calls MSAL `loginPopup({ scopes, prompt: 'select_account' })` (add `signInSelectAccount()` to `useMicrosoftAuth`); "Sign out" calls existing `signOut`.
- Produces: `<AuthShell>{children}</AuthShell>`

- [ ] **Step 1: Failing tests for `decideGate`**: not ready → loading; ready, not authenticated, not signing out → signin; signing out → loading; authenticated, status null → loading; 200 → allowed; 403 → denied; 401 → signin; 500 → error; fetchFailed → error.
- [ ] **Step 2: Run** `./node_modules/.bin/vitest run lib/__tests__/access-gate.test.ts`, expect FAIL.
- [ ] **Step 3: Implement `decideGate`**, then the hook and components. In `dashboard/layout.tsx`, remove its own "not authenticated → push signin" effect (the gate owns that) and keep the onboarding check inside the allowed branch.
- [ ] **Step 4: Run** the test, then `npx tsc --noEmit -p .` filtered to non-test files. Expected: PASS, no new type errors.
- [ ] **Step 5: Commit** `feat: gate app pages on server access check`.

### Task 4: Sign-in page (mockup A)

**Files:**
- Modify: `app/(app)/auth/signin/page.tsx` (replace markup; keep consent verification, timeout and `callbackUrl` logic), `hooks/useMicrosoftAuth.ts`
- Create: `lib/msal-errors.ts`
- Test: `lib/__tests__/msal-errors.test.ts`

**Interfaces:**
- Consumes: `AuthShell`, `NotAuthorised` (Task 3).
- Produces: `export function isNotAssignedError(err: unknown): boolean` (true when `err.errorCode`, `err.subError` or `err.message` contains `AADSTS50105`)
- Changes: `useMicrosoftAuth` exposes `signInError: unknown | null`, set in `signIn`'s catch, cleared on a successful sign-in. `signIn` still returns `Promise<boolean>`.

- [ ] **Step 1: Failing tests**: `isNotAssignedError({ errorCode: 'AADSTS50105' })` true; `({ message: 'AADSTS50105: The signed in user ...' })` true; `(new Error('user_cancelled'))` false; `(null)` false.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement** `isNotAssignedError`, `signInError`, and the page: `AuthShell` + wordmark + subtitle + heading/body + Microsoft button + lock footnote + footer (About link to `/about`, version from `package.json`). When `isNotAssignedError(signInError)` render `<NotAuthorised reason="not_assigned" upn={null} />`. Remove marketing header/footer imports from this page.
- [ ] **Step 4: Run** tests and type-check. Expected: PASS.
- [ ] **Step 5: Commit** `feat: rebuild sign-in page as internal console sign-in`.

### Task 5: Front door, overview, about, no-index

**Files:**
- Create: `app/(marketing)/overview/page.tsx` (move the current `app/(marketing)/page.tsx` content here verbatim, including `revalidate` and JSON-LD)
- Delete: `app/(marketing)/page.tsx` (both route groups cannot own `/`)
- Create: `app/(app)/page.tsx` (inside `(app)` so the MSAL providers are available): renders the `AuthShell` spinner, then MSAL account → `router.replace('/dashboard')`, else `router.replace('/auth/signin')`.
- Modify: `app/(marketing)/about/page.tsx` (fork block at top), `app/robots.ts` (disallow `/` for all agents), `app/layout.tsx` (metadata `robots: { index: false, follow: false }`), the landing `Header` nav (`components/landing/Header*`) to drop Pricing, Blog, Changelog, QA, Apps links
- Test: `app/__tests__/robots.test.ts`

**Interfaces:**
- Consumes: `AuthShell` (Task 3).

- [ ] **Step 1: Failing test**: `robots()` returns rules where every entry disallows `'/'` (no allow for catalog paths).
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement** the moves and edits. Fork block copy: "Self-hosted fork of IntuneGet by Ugur Koc." with links "Upstream project" → `https://github.com/ugurkocde/IntuneGet`, "This fork's source" → `https://github.com/isithuman-2026/IntuneGet`, "Licence: AGPL-3.0" → `/LICENSE` on the fork repo, version, and "Product overview" → `/overview`. Add a "Docs" link to the dashboard sidebar/user menu pointing at `/docs`.
- [ ] **Step 4: Run** `./node_modules/.bin/vitest run` (full). Expected: only the 5 known `lib/github-actions.test.ts` failures. `npm run build` succeeds.
- [ ] **Step 5: Commit** `feat: make / the app front door; move landing to /overview`.

### Task 6: Configure, deploy, verify live

**Files:**
- Modify: `/opt/intuneget/.env` (add `ALLOWED_TENANT_IDS`, value = the tenant id in `upload_history.intune_tenant_id`, set via shell, never echoed), `.env.example` (document `ALLOWED_TENANT_IDS`), `/opt/intuneget/CLAUDE.md` (allowlist, Entra assignment-required step pending, approach B required before production)

- [ ] **Step 1:** Add env var, `docker compose build intuneget && docker compose up -d intuneget`.
- [ ] **Step 2: Verify** with `curl --resolve <app-host>:443:127.0.0.1`: `/` → 200 page with no landing hero text ("Deploy Winget" absent); `/auth/signin` 200 contains "Internal deployment console"; `/overview` 200 contains the hero; `/api/auth/access` without token → 401; `/robots.txt` disallows `/`.
- [ ] **Step 3: Commit and push** fork `main`; `make push` in claude-directives for the CLAUDE.md change.
