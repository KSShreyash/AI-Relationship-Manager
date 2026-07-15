# Foundation — Design Spec

**Date:** 2026-07-15
**Sub-project 1 of 6** in the AI Relationship Manager platform (Foundation → Graph Sync → AI Extraction → Contact Profiles/Dashboard/Planner → AI Scheduler → Global Search).

## Context

The AI Relationship Manager is an individual productivity tool (not org-wide HR software): each user connects their own Microsoft work/school account and the app manages relationships derived from their own Outlook inbox and Teams chats. There is no organization-level tenancy — data isolation is per-user.

This spec covers only the **Foundation** layer: authentication, the minimal data model needed to support it, and deployment scaffolding. Every later sub-project builds on top of this.

## Goals

- A user can sign in with a Microsoft work/school account (any organization) via a native "Sign in with Microsoft" flow.
- The backend independently holds and refreshes that user's Microsoft Graph delegated token, decoupled from the user's browser session, so background sync (built in a later phase) has something to work with from day one.
- A real, deployed skeleton exists: Next.js frontend on Cloudflare Pages, FastAPI backend on Render, Supabase for Postgres + Auth — proven end-to-end with one real Graph API call.

## Non-goals (explicitly deferred)

Email/Teams sync, OpenAI extraction, contact profiles, dashboard content, AI Planner, AI Scheduler, global search, custom domain + Cloudflare reverse proxy, rate limiting, formal audit-log table. Basic structured request logging is included now since it's cheap.

## Architecture

```
[User Browser]
     | HTTPS
     v
[Cloudflare Pages: Next.js frontend]  (*.pages.dev for now, no custom domain yet)
     |
     | HTTPS — server-side calls only, never from client JS
     v
[Render: FastAPI backend]  (*.onrender.com for now)
     |                                        |
     | service-role, direct Postgres conn    | delegated Graph tokens (MSAL refresh)
     v                                        v
[Supabase: Postgres + Auth]          [Microsoft Graph API / Entra ID]
```

- **Frontend (Next.js on Cloudflare Pages)**: renders UI, never talks to Supabase's data API directly. All app data access goes through server-side calls to the FastAPI backend.
- **Backend (FastAPI on Render)**: sole owner of the Supabase service-role key and the Postgres connection (repository pattern). Verifies the Supabase-issued JWT on every request to identify the user. Owns the Microsoft Graph token store and refresh logic.
- **Supabase**: Postgres for all app data; Auth (via its Azure/Entra OAuth provider) for identity and session/JWT issuance.
- **Microsoft Entra ID**: one multi-tenant app registration ("Accounts in any organizational directory" — work/school only, no personal Microsoft accounts), delegated Graph scopes, consented at sign-in.
- **Cloudflare**: not yet wired as a reverse proxy (no domain owned yet). Adding a custom domain + proxy later is a small follow-up (DNS + one env var), not a redesign.

No custom domain exists yet, so the frontend calls Render's default subdomain directly for now (still server-side only, never exposed to browser JS).

## Data Model

Two tables only — everything else (contacts, emails, tasks) belongs to later sub-projects.

### `profiles`
1:1 with Supabase's `auth.users`.

| column | type | notes |
|---|---|---|
| `id` | uuid, PK | = `auth.users.id` |
| `email` | text | mirrored from Microsoft account at signup |
| `display_name` | text | |
| `avatar_url` | text | nullable |
| `timezone` | text, IANA format (e.g. `America/New_York`) | for later scheduling features |
| `graph_connection_status` | enum: `connected`, `needs_reauth`, `disconnected` | drives UI banner |
| `created_at`, `updated_at` | timestamptz | |

RLS: `authenticated` may `SELECT`/`UPDATE` only their own row (`auth.uid() = id`), with matching `USING` and `WITH CHECK`. Defense-in-depth — primary access path is FastAPI's service-role connection.

### `ms_graph_tokens`
Microsoft Graph delegated tokens, backend-only.

| column | type | notes |
|---|---|---|
| `user_id` | uuid, PK, FK → `profiles.id` | |
| `encrypted_access_token` | text | Fernet-encrypted; key lives only in Render env var |
| `encrypted_refresh_token` | text | Fernet-encrypted; Microsoft rotates this on every refresh |
| `access_token_expires_at` | timestamptz | |
| `scopes` | text[] | granted Graph scopes, for auditing |
| `created_at`, `updated_at` | timestamptz | |

RLS: enabled, **zero policies** granted to `anon`/`authenticated` — only the service-role connection (which bypasses RLS) can ever read or write this table.

Encryption is application-level (Fernet in FastAPI), not Supabase Vault — FastAPI is the only consumer of these tokens, so keeping the trust boundary in one place is simpler than splitting it across Postgres-side Vault and app code.

## Auth Flow

1. User clicks **"Sign in with Microsoft"** on the Next.js frontend.
2. Frontend calls `supabase.auth.signInWithOAuth({ provider: 'azure', options: { scopes: 'openid email profile offline_access Mail.Read Chat.Read Calendars.ReadWrite OnlineMeetings.ReadWrite User.Read', redirectTo: '.../auth/callback' } })`.
3. Supabase redirects to Microsoft's login page using our Azure app's registered credentials (configured once in Supabase Dashboard → Auth → Providers → Azure).
4. User authenticates with a work/school account and consents to the requested Graph scopes.
5. Microsoft redirects back through Supabase, which creates/updates the `auth.users` row and redirects to our `/auth/callback` page with a session.
6. `/auth/callback` calls `supabase.auth.getSession()` — this response uniquely contains `provider_token` / `provider_refresh_token` (the Microsoft tokens), **only on this initial callback**.
7. Frontend immediately `POST`s those tokens to `FastAPI: POST /api/auth/graph-tokens`, authenticated with the Supabase JWT.
8. FastAPI verifies the JWT, upserts `profiles`, encrypts and stores the Microsoft tokens in `ms_graph_tokens`, sets `graph_connection_status = 'connected'`.
9. From here on the frontend only ever holds a Supabase session JWT (to identify the user to FastAPI) — it never sees Graph tokens again.
10. Every protected FastAPI route runs a `get_current_user` dependency: verifies the Supabase JWT, loads the `profiles` row.
11. Whenever FastAPI needs to call Graph on the user's behalf, it loads `ms_graph_tokens`; if the access token is expired/near-expiry, it uses the refresh token (via MSAL) to get a new pair. Microsoft rotates the refresh token on every use, so the new pair is re-encrypted and stored.
12. If a refresh ever fails (revoked consent, expired inactivity window, password change), FastAPI sets `graph_connection_status = 'needs_reauth'`; the frontend shows a "Reconnect Microsoft account" banner that re-runs steps 1–8.
13. To prove the whole chain works, Foundation includes one real endpoint: `GET /api/me/graph-status`, which uses the stored token to call `GET https://graph.microsoft.com/v1.0/me` and returns the result.

**Risk flag:** some Microsoft 365 tenants restrict `Chat.Read`/Teams scopes behind admin consent — a tenant admin may need to approve the app before Teams sync works for a given user. This is an inherent Graph API/tenant-policy constraint, not something the app design can work around.

## Folder Structure

```
ai-relationship-manager/
├── frontend/                     # Next.js (Cloudflare Pages)
│   ├── app/
│   │   ├── (auth)/login/page.tsx
│   │   ├── (auth)/callback/page.tsx
│   │   ├── dashboard/page.tsx    # placeholder for this phase
│   │   └── layout.tsx
│   ├── lib/
│   │   ├── supabase/client.ts    # browser client — Auth only, no DB calls
│   │   └── api.ts                # fetch wrapper to FastAPI, attaches Supabase JWT
│   └── package.json
│
├── backend/                      # FastAPI (Render)
│   ├── app/
│   │   ├── main.py
│   │   ├── core/{config,security,deps}.py   # settings, JWT verify, Fernet, get_current_user
│   │   ├── api/v1/{auth,me}.py               # POST /auth/graph-tokens, GET /me/graph-status
│   │   ├── db/{session,models}.py            # engine (service role), profiles/ms_graph_tokens
│   │   ├── repositories/{profiles,graph_tokens}.py
│   │   └── services/graph_client.py          # MSAL refresh + Graph calls
│   ├── tests/
│   └── requirements.txt
│
├── supabase/migrations/
├── docs/superpowers/specs/
└── .gitignore
```

## Deployment (Foundation scope)

- **Supabase**: real project, provisioned via the connected Supabase MCP.
- **Azure AD App Registration**: manual, in the Azure Portal — multi-tenant, redirect URI = Supabase's auth callback URL, delegated scopes as listed above.
- **Render**: Web Service built from the `/backend` subdirectory of the monorepo. Env vars: Supabase service-role key, Supabase JWT secret, Fernet key, Azure client id/secret.
- **Cloudflare Pages**: built from `/frontend`, using the free `*.pages.dev` subdomain.
- No Cloudflare reverse proxy yet (no domain owned) — a fast-follow once a domain is available.

## Error Handling

- OAuth denial/state mismatch → frontend shows a retry-able error; no partial user record left behind.
- Graph token refresh failure (revoked/expired) → `graph_connection_status = 'needs_reauth'`, banner prompts reconnect.
- Invalid/expired Supabase JWT on a FastAPI request → `401`; frontend triggers a session refresh or redirect to login.
- Missing/misconfigured Fernet key or Supabase secrets → FastAPI **fails fast at startup**, not on first use.
- Graph API `429`/5xx → surfaced as a clear error; no silent retry loops.

## Testing Strategy

- Backend (pytest + pytest-asyncio): unit tests for Fernet round-trip, JWT verification (valid/expired/malformed), and token-refresh logic (mocked MSAL call, asserting DB rotation and `needs_reauth` on failure).
- One integration test exercising `POST /auth/graph-tokens` → `GET /me/graph-status` against a local Supabase instance with a mocked Graph API.
- Manual acceptance check for this phase: real sign-in with a real Microsoft work account → dashboard placeholder shows "Connected as {email}", backed by a real `/api/me/graph-status` call to Graph.

## Milestones

1. Repo scaffolding + Supabase project provisioned + schema migrated.
2. Azure app registered + Supabase Auth provider configured.
3. Frontend login → callback → FastAPI token capture working end-to-end locally.
4. Token refresh logic + `/me/graph-status` endpoint working.
5. Deployed to Render + Cloudflare Pages, verified end-to-end in production.

## Key Decisions Log

- **Individual tool, not org-wide SaaS** — per-user data isolation, no `org_id` scoping.
- **Work/school Microsoft accounts only** — personal accounts often lack the Graph features (e.g. Teams chat) this app depends on.
- **Real infra provisioned now**, not deferred to a later "deployment" phase — auth needs to be testable against real services from the start.
- **Single monorepo** with `/frontend` and `/backend` — both Render and Cloudflare Pages support deploying from a subdirectory.
- **Hybrid auth (Approach A)**: Supabase Auth's Azure provider handles login/session; FastAPI independently captures and refreshes the Microsoft Graph token for background use. Rejected "Supabase-only" token management because the provider token is only available at sign-in time, which can't support periodic background sync.
- **Frontend never calls Supabase's data API directly** — all app data access goes through FastAPI, which owns the service-role key. RLS remains enabled on every table as defense-in-depth regardless.
