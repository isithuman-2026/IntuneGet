# Internal app shell: front door, sign-in, access control

Date: 2026-11-20. Status: approved, implementation paused (backlog).

## Intent

IntuneGet in this fork is an internal admin tool for one organisation, being hardened now for production use later. It currently opens on upstream's marketing landing page and lets any Microsoft work account sign in. It should open like a working SaaS tool: straight to sign-in or the dashboard, with a plain professional sign-in page, and only approved administrators of the organisation's own tenant able to use it.

## Goals

- `/` is the front door: signed out goes to sign-in, signed in goes to the dashboard.
- Upstream's landing page content moves off `/` to `/overview`, linked from `/about`.
- Sign-in page matches mockup A (centred card): https://claude.ai/artifact/KwPNruvwYVFvm3ZWzESfR7#artboard-Main
- A "not authorised" screen matches https://claude.ai/artifact/KwPNruvwYVFvm3ZWzESfR7#artboard-AccessDenied
- Only users from allowlisted tenants can use any API; only users assigned to the Entra app can sign in at all.
- App pages render nothing (no shell, no data) until sign-in and the access check have both passed.

## Non-goals

- Renaming or rebranding: the name stays IntuneGet.
- Server-side session cookies (approach B). Required before production use; tracked separately.
- Authelia or Cloudflare Access in front of the app (decided against).
- Redesigning the dashboard itself.
- Per-feature roles (viewer vs operator). Everyone allowed in is an admin.

## Anti-goals

- A sign-in loop: a signed-in but unauthorised user must land on the not-authorised screen, never bounce back to sign-in.
- Locking out the packaging callback: `/api/package/callback` uses its own shared-secret auth and must keep working.
- Silently trusting the browser: the allowlist is enforced on the server; the client only decides what to show.

## Constraints

- Sign-in is client-side MSAL (`lib/msal-config.ts`, authority `/organizations`, token cache in localStorage). The access token's audience is Microsoft Graph, so it carries no app roles; the server verifies it by calling Graph `/me` (`lib/auth-utils.ts::verifyTokenWithGraph`) and reads `tid` from it.
- `parseAccessToken` is the single choke point for 91 API routes.
- `proxy.ts` gates `/dashboard*` on the `msal-auth-hint` cookie, which any client can set. It is a convenience redirect, not security.
- AGPL-3.0: the about page must keep the licence and a link to this fork's source, and credit upstream.

## Approaches considered

- **A. Tenant allowlist on the server + Entra "assignment required" + client gate (chosen).** Little code, closes both real gaps (any tenant can sign in; any user in the tenant can deploy). App pages' JavaScript is still served to anyone, but carries no data.
- **B. A plus a signed HttpOnly session cookie checked by `proxy.ts`.** App pages never served unauthenticated. More code to maintain (issue, expiry, rotation, logout). Chosen for before production, not now.
- **C. Cloudflare Access in front with Entra as identity provider.** Strong with little app code, but ties the app to Cloudflare and still needs A's checks inside. Not chosen.

## Design

### Access control

1. `ALLOWED_TENANT_IDS` (server env, comma-separated GUIDs). In `verifyTokenWithGraph`, after reading `tid`, return null when the list is set and `tid` is not in it. Every API then answers 401 for that user, exactly as for a bad token.
   - Unset: log a startup warning and allow all (keeps upstream behaviour for others; this instance sets it).
   - The cache in `verifyTokenWithGraph` must not let a disallowed token through.
2. `GET /api/auth/access`: verifies the token with Graph, returns `{ allowed: true, displayName, upn }` or 403 `{ allowed: false, upn, reason: "tenant" }`. This is the one endpoint the client uses to tell "not signed in" (401) from "signed in but not allowed" (403). It must not go through the allowlist rejection in `parseAccessToken` (it needs the identity to show it).
3. Entra (manual tenant change, not code): on the IntuneGet enterprise application set "Assignment required = Yes" and assign the admins group. Unassigned users then fail at Microsoft with `AADSTS50105`; the sign-in page must recognise that error code from the MSAL redirect and show the not-authorised screen with reason "not assigned". Documented as a setup step in `/opt/intuneget/CLAUDE.md`; done via the tenant-ops repo, not this app.

### Front door and pages

- `/`: no marketing content. Client component: if an MSAL account exists, go to `/dashboard`, else `/auth/signin`. A server-side redirect on the `msal-auth-hint` cookie is fine as a fast path, the client check is the truth.
- `/auth/signin`: rebuilt to mockup A. Keeps existing MSAL sign-in logic and `callbackUrl` handling. Shows the version (from `package.json`) and an About link. No marketing header or footer.
- Not-authorised screen: shown by sign-in for `AADSTS50105`, and by the app gate on a 403 from `/api/auth/access`. Shows the signed-in UPN, "Sign in with a different account" (MSAL `prompt: select_account`), and "Sign out".
- App gate: in the `(app)` layout, wrap the dashboard area in a guard that renders a neutral loading state until MSAL has an account and `/api/auth/access` returned allowed; 401 goes to sign-in with `callbackUrl`, 403 to not-authorised. The guard applies to `/dashboard`, `/onboarding`, `/msp`, `/redirect`; not to `/auth/*`.
- `/overview`: upstream's former landing page content, moved unchanged (header, hero, sections).
- `/about`: keep upstream's page; add at the top a short block: "Self-hosted fork of IntuneGet by Ugur Koc", links to upstream and to this fork's source, licence AGPL-3.0, version, and a link to `/overview`.
- Marketing navigation: header links to pricing, blog, changelog, QA and apps are removed from the pages that remain reachable. The routes themselves stay (no deletion), but `robots.ts` disallows everything and pages carry `noindex`, since this is an internal instance.
- Docs (`/docs/*`) stay reachable and get a link from the dashboard's user menu or sidebar.

### Look

Mockup A tokens: background `#f4f6f8`, card white with `#e2e8f0` border and 12 px radius, text `#0f172a` / secondary `#475569`, accent teal `#0e7490`, Inter body, Space Grotesk for the wordmark, 44 px button height, Microsoft four-square logo on the sign-in button. Use the app's existing Tailwind tokens where they match; add only what's missing.

## Testing

- Unit: `verifyTokenWithGraph` allowlist (allowed tid passes, other tid null, unset list allows, cache does not bypass).
- Route: `/api/auth/access` returns 200 / 403 / 401 for allowed / other tenant / bad token.
- Sign-in page: `AADSTS50105` in the redirect error shows the not-authorised screen.
- Gate: 401 redirects to sign-in, 403 shows not-authorised, allowed renders children; nothing of the dashboard renders before the check.
- Live, via the `--resolve` trick: `/` redirects; `/auth/signin` renders; an API call with no token is 401.

## Left to the builder

- Component structure, file names, and how the guard shares the access result with the rest of the app (context or react-query).
- Exact loading-state visuals (a centred spinner on the sign-in background is fine).
- Whether `/` redirect is server, client, or both, as long as the client check is the source of truth.

## Calls made without asking (check these)

- Unset `ALLOWED_TENANT_IDS` allows everyone, with a warning, rather than failing closed. This instance will set it.
- The landing page goes to `/overview` rather than replacing `/about`.
- Marketing routes are de-linked and `noindex`ed, not deleted, to keep upstream merges simple.
- "Sign in with a different account" uses MSAL's account picker.
