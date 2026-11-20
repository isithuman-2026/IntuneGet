> [!IMPORTANT]
> **This is a fork.** IntuneGet is created and maintained by Ugur Koc: **[ugurkocde/IntuneGet](https://github.com/ugurkocde/IntuneGet)**.
> All credit for the original project goes to its authors and contributors. For the hosted service at [intuneget.com](https://intuneget.com), mainline releases and support, use the upstream project.

<div align="center">

<img src="public/logo-512.png" alt="IntuneGet Logo" width="120" height="120" />

# IntuneGet (self-hosted fork)

**Deploy Winget apps to Microsoft Intune, self-hosted on SQLite.**

</div>

This fork runs IntuneGet as a single self-hosted container on SQLite (`DATABASE_MODE=sqlite`) with no Supabase dependency, packaging through GitHub Actions. It adds update automation, rollback and safer assignment handling for admins who run it for their own tenant. It is a lab pilot, not a supported distribution.

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Upstream](https://img.shields.io/badge/upstream-ugurkocde%2FIntuneGet-555555?style=flat-square&logo=github)](https://github.com/ugurkocde/IntuneGet)

---

## What's different in this fork

### Self-hosted SQLite mode

- SQLite branches for user settings, notification preferences, update policies and update history, so these work without Supabase
- In-process 24-hour scheduler for update detection
- Webhook notifications for deployed, failed and update-available events; duplicate webhook URLs are rejected
- Routes that called Supabase unconditionally (job cancel and dismiss, ESP profile listing, the QA gate) now check for it first
- The GitHub Actions status callback can be exposed on its own path behind an access-controlled tunnel, so the app needs no public DNS

### Updates and rollback

| Stage | Behaviour |
|:------|:----------|
| Detect | Daily check against the catalog for newer versions of deployed apps |
| Update | Auto-update packages the new version and supersedes the previous Intune app |
| Carry over | Assignments move from the copy that actually holds them, keeping their notification and delivery settings |
| Keep | The newest superseded version stays in Intune, unassigned (`AUTO_PRUNE_KEEP_PREVIOUS`, default 1) |
| Prune | Older superseded copies are deleted once no devices have them, after a grace period (`AUTO_PRUNE_OLD_APPS`, opt-in) |
| Roll back | Moves assignments back to a kept copy, or repackages the older version when no copy is kept; the UI warns that some apps cannot downgrade |

### Assignments and deployment defaults

- Per-user default assignments are prefilled on every new deployment
- New apps allow uninstall from Company Portal for *available* assignments; this can be toggled per app
- Redeploying an app that already exists merges the assignments into it instead of creating a duplicate
- Auto-prune removes only the supersedence link to the app it deletes; dependencies stay intact

### Inventory editing

- Edit assignments, categories, update policy and delay on a deployed app without repackaging
- Change install and uninstall commands or detection rules with a confirmed redeploy
- Version history with rollback

### Status

A lab pilot, deliberately behind upstream: it does not include upstream changes made after it forked. Some upstream features (for example the Discovered Apps claim flow) have no SQLite equivalent yet.

---

## Features

### For IT Admins

- **Curated App Catalog** - Browse 10,000+ applications from the Winget repository, ready for Intune deployment
- **One-Click Deployment** - Deploy apps directly to your Microsoft Intune tenant
- **Real-Time Status** - Track deployment progress with live updates
- **Pre-Configured Detection Rules** - Skip the manual configuration
- **Community Ratings** - See how other admins rate apps before deploying
- **App Suggestions** - Suggest and vote on new apps for the catalog
- **In-App Notifications** - Get notified about deployment status, app updates, and community activity
- **PSADT v4 Support** - Deploy apps with PowerShell App Deployment Toolkit v4 UI elements (dialogs, balloon tips, process handling)

### For Managed Service Providers

- **Multi-Tenant Support** - Works with any Microsoft Entra ID tenant
- **MSP Mode** - Manage multiple client tenants from a single interface
- **Tenant Isolation** - Each client's data remains completely separate
- **Batch Deployments** - Deploy a single app across multiple tenants simultaneously with configurable concurrency
- **Team Management** - Invite members, assign roles (Owner, Admin, Operator, Viewer), manage access with role-based permissions
- **Webhook Integrations** - Configure event-driven webhooks for Slack, Teams, Discord, or custom endpoints with delivery logging and retry
- **Audit Logging** - Comprehensive audit trail with IP/user agent tracking and a dedicated log viewer
- **Advanced Reporting** - Cross-tenant deployment trends, success rate analytics, export to CSV/JSON/PDF

### For Self-Hosters

- **Multiple Database Options** - Supabase Cloud, self-hosted Supabase, or SQLite
- **Flexible Packaging** - GitHub Actions or local Windows packager
- **Air-Gapped Support** - Run entirely on-premises with no external dependencies
- **Full Source Access** - Audit, modify, and extend as needed

---

## Quick Start

```bash
git clone https://github.com/isithuman-2026/IntuneGet.git
cd IntuneGet
cp .env.example .env.local
# Set DATABASE_MODE=sqlite, PACKAGER_MODE=github and your Entra app registration
docker-compose up -d
```

The packaging workflow (`.github/workflows-reference/package-intunewin.yml`) must be copied into a **private** repository that the app dispatches to, so tenant IDs stay out of public workflow logs. See the [Self-Hosting Guide](docs/SELF_HOSTING.md) for the full set of settings.

The sections below are upstream's documentation and describe the upstream project.

---

## Architecture

```mermaid
flowchart TB
    subgraph Frontend
        A[Next.js App]
    end

    subgraph Auth
        B[Microsoft Entra ID]
    end

    subgraph Backend
        C[Supabase]
        D[(PostgreSQL)]
        I[Notifications]
    end

    subgraph Packaging
        E[GitHub Actions]
        F[Windows Runner]
        G[IntuneWin Tool]
    end

    subgraph Microsoft
        H[Intune API]
    end

    subgraph External
        J[Webhooks - Slack/Teams/Discord]
    end

    A -->|MSAL Auth| B
    A -->|Real-time Updates| C
    C --- D
    I --- D
    I -->|Deliver| J
    A -->|Trigger Workflow| E
    E --> F
    F --> G
    G -->|Upload Package| H
    A -->|Deploy App| H
```

| Component | Technology | Purpose |
|-----------|------------|---------|
| Frontend | Next.js 14, React, TypeScript | Web application and UI |
| Database | Supabase (PostgreSQL) | App catalog, deployment status, real-time subscriptions |
| Authentication | MSAL | Microsoft Entra ID integration (multi-tenant) |
| Packaging | GitHub Actions | Windows runner for .intunewin file generation |
| Deployment | Intune Graph API | Application deployment to tenants |
| Notifications | In-app, Email, Webhooks | Deployment events, community updates, team activity |
| Community | Ratings, Suggestions, Voting | Community-driven app catalog feedback |

---

<details>
<summary><h2>Self-Hosting Options</h2></summary>

IntuneGet is designed for flexibility. Choose the deployment model that fits your organization.

### Deployment Options

| Option | Best For | Complexity |
|--------|----------|------------|
| **Docker Compose** | Production self-hosting | Low |
| **Vercel** | Quick deployment, serverless | Low |
| **Full Self-Hosted** | Air-gapped environments, maximum control | Medium |

### Database Options

| Option | Description | Use Case |
|--------|-------------|----------|
| **Supabase Cloud** | Managed PostgreSQL with real-time | Fastest setup, hosted version |
| **Self-Hosted Supabase** | Full Supabase stack on your infrastructure | Enterprise, compliance requirements |
| **SQLite** | Single-file database | Development, small deployments |

### Packaging Options

| Option | Description | Use Case |
|--------|-------------|----------|
| **GitHub Actions** | Cloud-based Windows runner | Default, no infrastructure needed |
| **Local Packager** | npm package for on-premises | Air-gapped, compliance requirements |

See [Database Setup](docs/DATABASE_SETUP.md) and [GitHub Actions Setup](docs/GITHUB_ACTIONS_SETUP.md) for configuration details.

</details>

<details>
<summary><h2>Security</h2></summary>

IntuneGet is built with security as a core principle.

### Multi-Repository Design

- **Source Code** (this repo) - Fully open source, transparent, and auditable
- **Workflow Execution** - Runs in a private repository to protect tenant information
- **Tenant Isolation** - Tenant IDs are masked in logs and never visible in public workflow runs

### Data Handling

- **No Data Storage** - IntuneGet does not store your application binaries or tenant credentials
- **HMAC-SHA256 Verification** - All callbacks are cryptographically signed
- **Token Handling** - Access tokens are never persisted and expire after use
- **Rate Limiting** - API endpoints are protected by rate limiting
- **Role-Based Access Control** - MSP features use granular permissions with four role levels (Owner, Admin, Operator, Viewer)

### Audit Logging

- All MSP operations are logged with IP address, user agent, and timestamp
- Dedicated log viewer for reviewing team and deployment activity

### Air-Gapped Support

For organizations with strict compliance requirements:
- Run the local packager on your own Windows infrastructure
- Use self-hosted Supabase or SQLite
- No external network calls required

See [SECURITY.md](SECURITY.md) for our complete security policy.

</details>

<details>
<summary><h2>Tech Stack</h2></summary>

| Category | Technology |
|----------|------------|
| **Frontend** | [Next.js 14](https://nextjs.org/) with App Router |
| **Language** | [TypeScript](https://www.typescriptlang.org/) |
| **UI Components** | [shadcn/ui](https://ui.shadcn.com/) |
| **Styling** | [Tailwind CSS](https://tailwindcss.com/) |
| **Database** | [Supabase](https://supabase.com/) (PostgreSQL) |
| **Authentication** | [MSAL](https://github.com/AzureAD/microsoft-authentication-library-for-js) (Microsoft Entra ID) |
| **State Management** | [Zustand](https://zustand-demo.pmnd.rs/) + [TanStack Query](https://tanstack.com/query) |
| **Animations** | [Framer Motion](https://www.framer.com/motion/) |
| **Deployment** | [Vercel](https://vercel.com/), Docker |

</details>

---

## Documentation

| Document | Description |
|----------|-------------|
| [Self-Hosting Guide](docs/SELF_HOSTING.md) | Complete guide for self-hosting IntuneGet |
| [Azure AD Setup](docs/AZURE_AD_SETUP.md) | Configure Microsoft Entra ID app registration |
| [GitHub Actions Setup](docs/GITHUB_ACTIONS_SETUP.md) | Set up the packaging pipeline |
| [Database Setup](docs/DATABASE_SETUP.md) | Supabase configuration options |
| [Development Guide](docs/DEVELOPMENT.md) | Local development setup |
| [Environment Reference](docs/ENV_REFERENCE.md) | Full env var matrix by deployment mode |
| [API Reference](docs/API_REFERENCE.md) | Endpoint overview by feature area |
| [SCCM Migration Guide](docs/FEATURES_SCCM.md) | SCCM import, matching, and migration flow |
| [Updates and Policy Guide](docs/FEATURES_UPDATES.md) | Auto-update policies, triggers, and history |
| [Inventory/Reports/Uploads Guide](docs/FEATURES_INVENTORY_AND_REPORTS.md) | Operational dashboard feature docs |
| [Authentication Architecture](docs/authentication-architecture.md) | MSAL, admin consent, and service principal flow |
| [Documentation Audit](docs/DOCUMENTATION_AUDIT.md) | Coverage and remaining documentation gaps |

---

## How It Compares

| Capability | Traditional | IntuneGet |
|:-----------|:----------:|:---------:|
| **Curated app catalog** | -- | Yes |
| **One-click deployment** | -- | Yes |
| **Automated cloud packaging** | -- | Yes |
| **Pre-configured detection rules** | -- | Yes |
| **Direct deployment to tenant** | -- | Yes |
| **Multi-app batch deploy** | -- | Yes |
| **Multi-tenant batch deployment** | -- | Yes |
| **Role-based team management** | -- | Yes |
| **Community ratings and suggestions** | -- | Yes |
| **Webhook notifications** | -- | Yes |
| **Self-hosting support** | -- | Yes |

---

## Contributing

Changes that are useful beyond this fork should go to the upstream project: see [ugurkocde/IntuneGet](https://github.com/ugurkocde/IntuneGet) and its [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE), the same as upstream. The original work is copyright its authors; this fork's changes are released under the same licence.

- Self-host for internal business use
- Modify for personal or internal use
- Network service modifications must be open-sourced

---

<div align="center">

Based on **[IntuneGet](https://github.com/ugurkocde/IntuneGet)** by Ugur Koc and contributors.

</div>
