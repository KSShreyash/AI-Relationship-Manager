# AI Relationship Manager

A web app that connects to your Microsoft 365 account (Outlook mail, Calendar, Teams chat), reads what's going on in your communications, and automatically figures out **who you talk to**, **what you owe them (or they owe you)**, and **when you should meet next** — using an LLM to turn raw messages into structured contacts and action items.

This document explains what the project does, how every piece of it works, and the concepts behind it — written for someone who is new to the codebase (and to some of the underlying technologies) and wants to be able to explain it confidently, e.g. in an interview.

---

## Table of Contents

1. [What the app actually does](#what-the-app-actually-does)
2. [Tech stack at a glance](#tech-stack-at-a-glance)
3. [The three services and how they talk to each other](#the-three-services-and-how-they-talk-to-each-other)
4. [Repository structure](#repository-structure)
5. [Core concepts you need before reading the code](#core-concepts-you-need-before-reading-the-code)
6. [Deep dive: signing in (OAuth flow)](#deep-dive-signing-in-oauth-flow)
7. [Deep dive: syncing data from Microsoft Graph](#deep-dive-syncing-data-from-microsoft-graph)
8. [Deep dive: AI extraction (turning messages into contacts + action items)](#deep-dive-ai-extraction-turning-messages-into-contacts--action-items)
9. [Deep dive: AI Scheduler (booking a meeting)](#deep-dive-ai-scheduler-booking-a-meeting)
10. [Database schema](#database-schema)
11. [Backend API reference](#backend-api-reference)
12. [Frontend pages reference](#frontend-pages-reference)
13. [How it's deployed](#how-its-deployed)
14. [Running it locally](#running-it-locally)
15. [Testing](#testing)
16. [Security notes](#security-notes)
17. [Likely interview questions & how to answer them](#likely-interview-questions--how-to-answer-them)

---

## What the app actually does

From a user's point of view:

1. You sign in with your Microsoft account (personal or work/school).
2. The app pulls your recent emails, calendar events, and Teams chat messages.
3. An AI model reads each message and:
   - Figures out who the "contacts" are (people you email/meet/chat with) and writes a short summary of what's known about each person, updating it every time new information comes in.
   - Extracts **action items** — things you promised to do for someone ("mine"), or things someone promised to do for you ("theirs") — with an optional due date.
4. You get four screens to work with the result:
   - **Dashboard** — connection status, contact/action-item counts, recent activity, manual "Sync now" / "Extract now" buttons.
   - **Contacts** — searchable list of everyone the app has learned about, each with a notes page and their action items.
   - **Planner** — your action items grouped into Overdue / Due this week / Later / No due date, with the ability to mark items done or schedule a meeting for them.
   - **Search** — one search box across both contacts and action items.
5. From a "mine" action item, you can click **Schedule**, and the app suggests free 30-minute slots in your calendar and books the meeting on Microsoft Calendar (optionally as a Teams meeting) for you — this is the "AI Scheduler" part.
6. A background job also does this automatically every 15 minutes for every connected user, so the data stays fresh without you doing anything.

## Tech stack at a glance

| Layer | Technology | Why |
|---|---|---|
| Frontend | **Next.js 16** (App Router) + **React 19** + **TypeScript** | Component-based UI; statically exported (`output: "export"` in `frontend/next.config.ts`) so it can be hosted as plain static files |
| Frontend styling | **Tailwind CSS v4** | Utility-class styling, no separate CSS files per component |
| Frontend hosting | **Cloudflare Pages** | Serves the static export; free, fast CDN |
| Frontend testing | **Vitest** + **React Testing Library** | Unit/component tests that run in a simulated browser (jsdom) |
| Backend | **FastAPI** (Python, async) | The actual API server — all business logic and database access lives here |
| Backend hosting | **Render** (free web service plan) | Runs the FastAPI app with `uvicorn` |
| Backend testing | **pytest** + **pytest-asyncio** + **respx** | Unit tests, including mocking outbound HTTP calls to Microsoft Graph/OpenAI |
| Database | **Postgres**, hosted by **Supabase** | Stores everything: users, tokens, synced emails/events/chats, contacts, action items |
| Auth | **Supabase Auth** using the **Azure AD (Microsoft Entra ID) OAuth provider** | Handles the "Sign in with Microsoft" flow and issues the app's own session tokens |
| External API #1 | **Microsoft Graph API** | Source of truth for mail, calendar, and Teams chat data, and where meetings get created |
| External API #2 | **OpenAI API** (`gpt-4o-mini`) | Reads message content and extracts structured contact notes + action items |
| Token refresh | **MSAL** (Microsoft Authentication Library, Python) | Exchanges a stored refresh token for a new Graph access token when the old one expires |
| Secrets at rest | **Fernet** (symmetric encryption, from the `cryptography` package) | Encrypts Microsoft Graph tokens before storing them in Postgres |
| Automation | **GitHub Actions** (scheduled workflow) | Calls the backend's bulk-sync endpoint every 15 minutes |

## The three services and how they talk to each other

```
┌─────────────────────┐        ┌──────────────────────┐        ┌─────────────────────┐
│   Cloudflare Pages   │        │        Render         │        │      Supabase       │
│  (Next.js static     │  HTTPS │  (FastAPI backend)    │  TCP   │  (Postgres + Auth)  │
│  export - the UI     │───────▶│  ai-relationship-     │───────▶│                     │
│  you interact with)  │        │  manager-api          │        │                     │
└─────────┬────────────┘        └──────────┬────────────┘        └──────────┬──────────┘
          │                                 │                                │
          │ 1. "Sign in with Microsoft"      │ 3. Store/refresh Graph tokens  │
          │    goes through Supabase Auth    │    (encrypted) in Postgres     │
          │    directly (not through Render) │                                │
          │                                 │ 4. Read/write emails,           │
          │ 2. Every other API call          │    calendar_events,             │
          │    (contacts, dashboard,         │    chat_messages, contacts,     │
          │    planner, search, sync,        │    action_items                 │
          │    scheduling) goes to Render,   │                                │
          │    with the Supabase session     │ 5. Calls out to Microsoft       │
          │    JWT as a Bearer token         │    Graph API and OpenAI API     │
          └─────────────────────────────────┴────────────────────────────────┘
```

Three independently-hosted pieces, glued together by two things: a Supabase session **JWT** (frontend → backend auth) and a Microsoft Graph **access/refresh token pair** (backend → Microsoft Graph auth), both of which flow through the backend's Postgres database.

## Repository structure

```
AI Scheduler/
├── frontend/                      Next.js app (static export, deployed to Cloudflare Pages)
│   ├── app/
│   │   ├── (auth)/login/          "Sign in with Microsoft" button
│   │   ├── (auth)/callback/       Where Microsoft/Supabase redirect back to after login
│   │   ├── dashboard/             Home screen after login
│   │   ├── contacts/              Contact list + contacts/view/ for one contact's profile
│   │   ├── planner/               Action items grouped by due date
│   │   ├── search/                Combined contact + action item search
│   │   └── components/            Shared UI (NavBar, ScheduleActionItemPanel)
│   └── lib/
│       ├── api.ts                 apiFetch() - the one function every page uses to call the backend
│       ├── supabase/client.ts     Supabase browser client (used only for auth, never for data)
│       └── graph-scopes.ts        The exact Microsoft Graph permissions the app requests
│
├── backend/                       FastAPI app (deployed to Render)
│   └── app/
│       ├── main.py                App entrypoint - registers all routers + CORS
│       ├── api/v1/                One file per group of endpoints (routers)
│       ├── services/               Business logic (Graph sync, AI extraction, scheduling, token refresh)
│       ├── repositories/           All raw SQL lives here, one file per table
│       ├── core/                  Settings, JWT verification, Fernet encryption helpers
│       └── db/session.py          The asyncpg connection pool
│
├── supabase/migrations/           Every schema change, in order, as plain SQL files
├── render.yaml                    Render's deployment config for the backend (infra-as-code)
├── .github/workflows/
│   └── graph-sync-cron.yml        Scheduled job that triggers the sync for all users every 15 min
└── docs/superpowers/               Design specs and implementation plans written during development
```

## Core concepts you need before reading the code

If any of these are new to you, read this section first — everything else in this README assumes you know them.

**OAuth 2.0 / OIDC ("Sign in with X")** — A protocol that lets your app get permission to act on a user's behalf on another service (here, Microsoft), without ever seeing that user's Microsoft password. The user is redirected to Microsoft's own login page, approves the specific permissions ("scopes") your app is asking for, and Microsoft redirects back with proof of identity plus tokens your app can use to call Microsoft's APIs.

**JWT (JSON Web Token)** — A signed, self-contained token. Once issued, anyone holding the public key (or a JWKS endpoint) can verify it wasn't tampered with, without calling back to whoever issued it. Supabase issues one of these to the browser after login; the backend verifies it on every request instead of asking Supabase "is this token still valid?" over the network.

**Access token vs. refresh token** — An access token is short-lived (here, ~1 hour) and is what you actually attach to API calls. A refresh token is long-lived and is used only to get a *new* access token when the old one expires, without asking the user to log in again.

**Delta query** — Instead of re-downloading someone's entire mailbox every time you sync, Microsoft Graph lets you ask "what changed since I last asked?" via a `delta` endpoint. The first call gives you everything (bounded to a lookback window here); the response includes a `deltaLink` URL you save and use next time — it only returns what's new, changed, or deleted since then.

**Row Level Security (RLS)** — A Postgres feature where the database itself enforces "user A can only see user A's rows," even if the application code has a bug. It matters most when a client talks to the database directly with a low-privilege key. In this app the frontend never talks to Postgres directly (see below), so RLS here is mostly a defense-in-depth safety net rather than the primary access control.

**Background task** — FastAPI's `BackgroundTasks` lets an endpoint return a response to the user immediately while a function keeps running after the response is sent. Used here so that saving your Graph tokens doesn't make you wait for a full mail/calendar/chat sync before your login completes.

**Structured output (LLM)** — Instead of asking an LLM for free-form text and hoping to parse it, you give it a JSON Schema and it's constrained to return exactly that shape. This app uses OpenAI's `strict` JSON-schema mode so extraction results are always valid, parseable JSON.

**Static export** — `output: "export"` in `next.config.ts` makes `next build` produce a folder of plain HTML/CSS/JS with no Node.js server required to run it. Every page in this app is a client component (`'use client'`) that fetches data after the page loads, rather than fetching data on a server before sending HTML — that's *why* this can be a static export at all: there's no server-rendered, per-request data to generate.

## Deep dive: signing in (OAuth flow)

Files: `frontend/app/(auth)/login/page.tsx`, `frontend/app/(auth)/callback/page.tsx`, `frontend/lib/supabase/client.ts`, `backend/app/api/v1/auth.py`, `backend/app/core/deps.py`

Step by step:

1. **User clicks "Sign in with Microsoft"** on the login page. This calls `supabase.auth.signInWithOAuth({ provider: 'azure', options: { scopes: OAUTH_SCOPES, redirectTo: '.../callback' } })`. `OAUTH_SCOPES` (in `frontend/lib/graph-scopes.ts`) is `openid email profile offline_access` plus the actual Microsoft Graph permissions the app needs: `User.Read Mail.Read Chat.Read Calendars.ReadWrite OnlineMeetings.ReadWrite`.
2. The browser is sent to Microsoft's login page. The user authenticates and consents to those permissions.
3. Microsoft redirects the browser to **Supabase's** fixed callback endpoint (`https://<project>.supabase.co/auth/v1/callback` — this is what's registered as the Redirect URI on the Azure App Registration, not our app's own URL). Supabase exchanges the authorization code for Microsoft tokens using the Client ID/Secret configured in the Supabase dashboard's Azure provider settings.
4. Supabase creates its own session for the user and redirects the browser again, this time to **our** app's `redirectTo` (`/callback`), carrying along the Microsoft `provider_token` (Graph access token) and `provider_refresh_token` inside the new Supabase session.
5. Our `CallbackPage` (`frontend/app/(auth)/callback/page.tsx`) calls `supabase.auth.getSession()`, pulls `provider_token`/`provider_refresh_token` off the session, and `POST`s them to our own backend at `/api/auth/graph-tokens`, authenticated with the *Supabase* JWT (`Authorization: Bearer <access_token>`).
6. The backend (`store_graph_tokens` in `backend/app/api/v1/auth.py`) verifies that JWT (see below), encrypts the Graph tokens with Fernet, upserts them into `ms_graph_tokens`, marks the user's profile as `graph_connection_status = 'connected'`, and kicks off a background sync (`sync_user`) so mail/calendar/chat start populating without blocking the response.
7. The browser is sent to `/dashboard`.

**How the backend verifies "is this really a logged-in user?"** (`backend/app/core/deps.py`): every protected endpoint depends on `get_current_user`, which takes the `Authorization: Bearer <token>` header, fetches Supabase's public signing keys from its JWKS endpoint (`/auth/v1/.well-known/jwks.json`), verifies the JWT's signature (ES256, asymmetric — Supabase's newer key system, not the older shared-secret HS256 one), and checks the `aud` claim is `authenticated`. If any of that fails, the request gets a 401. No network call to Supabase happens per-request beyond fetching/caching those public keys — that's the whole point of JWTs.

**Two different tokens, two different jobs** — this trips people up:
- The **Supabase JWT** proves "this HTTP request came from a logged-in user of *our app*." It's what every `/api/...` call sends.
- The **Microsoft Graph access/refresh tokens** prove "this backend is allowed to read *this specific user's* Outlook/Calendar/Teams data." They're stored server-side, encrypted, and never touch the browser again after the callback page hands them off.

## Deep dive: syncing data from Microsoft Graph

Files: `backend/app/services/graph_sync.py`, `backend/app/services/graph_client.py`, `backend/app/services/graph_tokens_service.py`

`sync_user(pool, user_id)` is the entry point. It:

1. Gets a valid access token via `get_valid_access_token` — if the stored token has expired, this transparently calls `refresh_and_persist`, which uses **MSAL**'s `ConfidentialClientApplication.acquire_token_by_refresh_token(...)` to get a new one from Azure AD, then re-encrypts and stores it.
2. Runs `sync_mail`, `sync_calendar`, and `sync_chat` in turn. Each one:
   - Loads its saved `delta_link` from the `sync_state` table (one row per user per resource type), or, on the very first sync, starts from a lookback window (30 days back for mail/calendar/chat; calendar also looks 90 days *forward*).
   - Pages through the Graph delta endpoint, upserting each item into the matching table (`emails`, `calendar_events`, `chat_messages`) and deleting rows Graph reports as removed (`@removed` in the delta payload).
   - Saves the new `deltaLink` for next time.
   - If Graph returns 400/403 for a resource (e.g. a mailbox with no license for that feature), that resource is marked `not_available` and skipped on future syncs rather than retried forever.
3. If any Graph call returns 401 mid-sync, it refreshes the token once and retries that one call — handles the case where the token expired *between* the initial check and the actual request.
4. **Immediately chains into AI extraction** (`extract_user`, capped at `settings.extraction_batch_limit`, default 50) — so every sync pass also processes a bounded chunk of the newly-synced backlog, rather than syncing and extracting being two disconnected steps.

Two ways sync gets triggered:
- **Automatically**, every 15 minutes, via the GitHub Actions cron job hitting `POST /api/sync/run` (see [deployment](#how-its-deployed)) — this iterates every user with `graph_connection_status = 'connected'`.
- **Manually**, via the dashboard's "Sync now" button, which calls `POST /api/sync/run/me` for just the current user.

## Deep dive: AI extraction (turning messages into contacts + action items)

Files: `backend/app/services/ai_extraction.py`, `backend/app/services/openai_client.py`

For each of the three source tables, `extract_user` finds rows where `extracted_at is null` (i.e., not yet processed), oldest first, up to the batch limit, and for each one:

1. **Builds a plain-text version of the message** — HTML is stripped down to text (`_strip_html`), and for calendar events, the organizer + all attendees are merged into one deduplicated participant list (preferring whichever occurrence of a person included their name).
2. **Resolves each participant to an existing contact** (by email if available, else by display name) so the LLM can see what's *already* known about them and be asked to update it rather than duplicate it. The mailbox owner's own email address is filtered out — you're never extracted as your own contact.
3. **Calls OpenAI** (`gpt-4o-mini`) with a prompt containing the message content and the known participants (with their existing notes), and a strict JSON Schema response format requiring:
   - `people`: for each participant ref, an updated, *rewritten* (not appended) notes summary.
   - `action_items`: each with `text`, `direction` (`"mine"` or `"theirs"`), an optional `due_date`, and an optional `participant_ref`.
4. **Writes the result inside a single database transaction**: upserts each contact (creating new ones as needed) and inserts each action item, then marks the source row's `extracted_at = now()` so it's never re-processed.
5. If anything throws for one item, that item is skipped (`continue`) rather than aborting the whole batch — one malformed message shouldn't block the rest of a user's extraction run.

This can also be triggered manually via the dashboard's "Extract now" button (`POST /api/extraction/run/me`), with no batch limit (processes everything pending).

## Deep dive: AI Scheduler (booking a meeting)

Files: `backend/app/services/scheduling.py`, `backend/app/api/v1/scheduling.py`, `frontend/app/components/ScheduleActionItemPanel.tsx`

Only action items linked to a contact, and not already scheduled, can be scheduled (enforced in `_get_schedulable_item`).

1. **Suggesting times** (`GET /api/action-items/{id}/schedule-suggestions` → `suggest_slots`): looks 14 days ahead, in the user's saved IANA timezone (falls back to UTC), generates every 30-minute slot between 9am–5pm on weekdays only, filters out anything that overlaps an existing calendar event (fetched via `CalendarEventsRepository.list_busy_between`), and returns up to 10 suggestions.
2. **Booking it** (`POST /api/action-items/{id}/schedule` → `create_meeting`): builds a Microsoft Graph calendar event payload (subject = the action item's text, optionally `isOnlineMeeting: true` with `onlineMeetingProvider: "teamsForBusiness"` for a Teams link, and the contact as an attendee if we have their email), creates it via the Graph API, saves the resulting event locally, and points the action item's `scheduled_calendar_event_id` at it — all inside one transaction.
3. **Race protection**: if two requests somehow try to schedule the same action item at once, the loser's transaction finds the item already has a `scheduled_calendar_event_id` set and returns `None` rather than silently overwriting the winner's pointer — the Graph meeting the loser created still exists (can't be undone after the fact) but the API returns a `409` instead of reporting false success.

## Database schema

All tables are in the `public` schema, created across the migrations in `supabase/migrations/`, applied in filename order.

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | One row per signed-in user (mirrors `auth.users`) | `id` (= Supabase auth user id), `email`, `timezone`, `graph_connection_status` (`connected` / `needs_reauth` / `disconnected`) |
| `ms_graph_tokens` | Encrypted Microsoft Graph tokens, one row per user | `encrypted_access_token`, `encrypted_refresh_token`, `access_token_expires_at`, `scopes` |
| `emails`, `calendar_events`, `chat_messages` | Raw synced data from Graph | `graph_message_id`/`graph_event_id` (Graph's own ID, for upsert/delete matching), `extracted_at` (null until AI extraction has processed it) |
| `sync_state` | One row per user per resource type (`mail`/`calendar`/`chat`) | `delta_link` (Graph's resume token), `status` (`ok`/`not_available`/`error`) |
| `contacts` | People the AI has learned about | `email_address` or `display_name` (unique per user, whichever is available), `notes` (LLM-synthesized summary) |
| `action_items` | Extracted commitments | `direction` (`mine`/`theirs`), `status` (`open`/`done`), `due_date`, `source_type`/`source_id` (which email/event/chat it came from), `scheduled_calendar_event_id` |

Notes:
- `contacts` and `ms_graph_tokens` explicitly have **no RLS policies** (RLS is enabled but nothing is granted) — only a `service_role`/direct connection (which bypasses RLS entirely) can touch them. This is intentional: the frontend never queries these tables directly.
- `action_items.source_id` isn't a foreign key — it can point into any of three different tables depending on `source_type`, so it's just a plain `uuid`.

## Backend API reference

All routes are prefixed as shown and require a valid Supabase JWT (`Authorization: Bearer ...`) unless noted otherwise.

| Method & path | File | Purpose |
|---|---|---|
| `POST /api/auth/graph-tokens` | `api/v1/auth.py` | Save the Microsoft tokens obtained during OAuth login; kicks off a background sync |
| `GET /api/me/graph-status` | `api/v1/me.py` | Is Microsoft connected? Refreshes the token if needed; calls Graph `/me` to prove the connection actually works |
| `GET /api/dashboard` | `api/v1/dashboard.py` | Contact count, open action item count, merged recent-activity feed |
| `GET /api/contacts?q=` | `api/v1/contacts.py` | List/search contacts |
| `GET /api/contacts/{id}` | `api/v1/contacts.py` | One contact's detail (notes etc.) |
| `GET /api/contacts/{id}/action-items` | `api/v1/contacts.py` | That contact's action items |
| `GET /api/action-items?direction=&include_done=` | `api/v1/action_items.py` | List action items, filterable |
| `PATCH /api/action-items/{id}` | `api/v1/action_items.py` | Toggle `open`/`done` |
| `GET /api/action-items/{id}/schedule-suggestions` | `api/v1/scheduling.py` | Suggested meeting slots |
| `POST /api/action-items/{id}/schedule` | `api/v1/scheduling.py` | Book the meeting on Microsoft Calendar |
| `GET /api/search?q=` | `api/v1/search.py` | Search contacts + action items together |
| `POST /api/sync/run/me` | `api/v1/sync.py` | Manually sync just the current user |
| `POST /api/sync/run` | `api/v1/sync.py` | **No JWT** — instead requires an `X-Sync-Secret` header matching `SYNC_SECRET` (compared with `hmac.compare_digest` to avoid timing attacks). Syncs *every* connected user. This is what the GitHub Actions cron job calls |
| `POST /api/extraction/run/me` | `api/v1/extraction.py` | Manually run AI extraction for the current user, no batch limit |
| `GET /health` | `main.py` | Plain liveness check, no auth |

## Frontend pages reference

| Route | File | What it does |
|---|---|---|
| `/` | `app/page.tsx` | Checks if there's a session; redirects to `/dashboard` or `/login` |
| `/login` | `app/(auth)/login/page.tsx` | "Sign in with Microsoft" button |
| `/callback` | `app/(auth)/callback/page.tsx` | Completes the OAuth flow (see [auth deep dive](#deep-dive-signing-in-oauth-flow)) |
| `/dashboard` | `app/dashboard/page.tsx` | Connection status, stats, recent activity, manual sync/extract triggers |
| `/contacts` | `app/contacts/page.tsx` | Debounced search-as-you-type contact list |
| `/contacts/view?id=` | `app/contacts/view/page.tsx` | One contact's notes + their open/done action items |
| `/planner` | `app/planner/page.tsx` | Action items grouped by due date, with mark-done and schedule controls |
| `/search` | `app/search/page.tsx` | Combined contacts + action items search |

All API calls go through `apiFetch()` (`frontend/lib/api.ts`), which attaches the current Supabase session's access token as a Bearer header and prefixes the path with the configured backend URL (`apiBaseUrl()`, which trims stray whitespace/trailing slash from the `NEXT_PUBLIC_API_BASE_URL` env var — a real bug this app hit in production once).

`NavBar` (`app/components/NavBar.tsx`) renders the left-hand nav on every page except `/`, `/login`, and `/callback`, and handles sign-out (`supabase.auth.signOut()` then redirect to `/login`).

## How it's deployed

- **Frontend → Cloudflare Pages.** `next build` (with `output: "export"`) produces static files; Cloudflare Pages serves them from its CDN. `NEXT_PUBLIC_*` env vars (like `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) are baked into the JS bundle **at build time** — changing them in the Cloudflare dashboard does nothing until the next build/deploy.
- **Backend → Render**, defined as infrastructure-as-code in `render.yaml`: a free-tier Python web service running `uvicorn app.main:app`. Secrets (`DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FERNET_KEY`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, etc.) are `sync: false` (set manually in Render's dashboard, never committed); `CORS_ALLOW_ORIGINS` and `MS_AUTHORITY` are committed directly since they aren't secret.
  - Free-tier caveat: Render spins the service down after ~15 minutes idle and takes tens of seconds to cold-start on the next request.
- **Database + Auth → Supabase**, hosted separately; migrations in `supabase/migrations/` are the source of truth for schema (applied manually/via Supabase CLI — there's no automatic migration-on-deploy step in this repo).
- **Recurring sync → GitHub Actions** (`.github/workflows/graph-sync-cron.yml`): a `schedule: cron: "*/15 * * * *"` workflow that just does one `curl -X POST .../api/sync/run` with the shared `SYNC_SECRET`. This is the entire "background job scheduler" for the app — no separate worker process, queue, or task scheduler service.

## Running it locally

**Backend:**
```bash
cd backend
python -m venv .venv
.venv/Scripts/activate       # or source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cp .env.example .env         # then fill in DATABASE_URL, SUPABASE_URL, secrets, etc.
uvicorn app.main:app --reload
```

**Frontend:**
```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill in NEXT_PUBLIC_* values
npm run dev
```

## Testing

- **Backend**: `cd backend && .venv/Scripts/python.exe -m pytest -q` — unit tests for every repository, service, and endpoint; outbound HTTP (Graph, OpenAI) is mocked with `respx`/fixtures, so tests don't hit real external APIs.
- **Frontend**: `cd frontend && npm test` (Vitest) — component tests using React Testing Library; Supabase client and `apiFetch` are mocked.
- This project was built test-first throughout (see `docs/superpowers/plans/`): a failing test is written before the implementation, then the implementation is added to make it pass.

## Security notes

- Microsoft Graph tokens are **encrypted at rest** with Fernet (`backend/app/core/security.py`) before being stored in Postgres — even with raw database access, tokens aren't usable without `FERNET_KEY`.
- The bulk sync endpoint (`POST /api/sync/run`) isn't protected by user login (there's no logged-in user in a cron job) — it uses a shared secret compared with `hmac.compare_digest` specifically to prevent timing-attack secret recovery.
- The Supabase JWT is verified locally against Supabase's public JWKS keys (asymmetric ES256) rather than by calling Supabase on every request — faster, and doesn't create a hard dependency on Supabase's uptime for every single API call.
- CORS is explicitly restricted to the known frontend origin(s) (`CORS_ALLOW_ORIGINS` in `render.yaml`), not left open (`*`).

## Likely interview questions & how to answer them

**"Walk me through what happens when a user signs in."**
Explain the [OAuth flow](#deep-dive-signing-in-oauth-flow) above in your own words: browser → Microsoft → Supabase's callback → our `/callback` page → our backend's `/api/auth/graph-tokens`. Emphasize the two distinct tokens (Supabase JWT vs. Graph tokens) and why they exist for different purposes.

**"Why is the frontend a static export instead of using Next.js server rendering?"**
Because every page fetches its own data client-side after load (`'use client'` + `useEffect`) rather than needing data at request time on a server — there's nothing for a Node.js server to render ahead of time. That lets it be hosted as static files on a CDN (Cloudflare Pages), which is simpler and cheaper than running a Node server.

**"How do you handle an expired Microsoft Graph token?"**
`get_valid_access_token` checks the stored expiry before every sync/scheduling call; if expired, `refresh_and_persist` uses MSAL to redeem the stored (encrypted) refresh token for a new access token and re-persists both. If the refresh itself fails (e.g., revoked consent), the user's `graph_connection_status` flips to `needs_reauth`, and the frontend surfaces a "reconnect your Microsoft account" prompt instead of a generic error.

**"Why encrypt the tokens instead of just storing them?"**
Defense in depth — a database leak/backup exposure/compromised read-replica wouldn't hand over live Microsoft access on its own, since the tokens are useless without the separate `FERNET_KEY`.

**"What's a delta query, and why use it instead of just re-fetching everything?"**
See [core concepts](#core-concepts-you-need-before-reading-the-code). It's Microsoft Graph's incremental-sync mechanism — you save an opaque `deltaLink` URL and hitting it later returns only what changed, so a sync of a mailbox that hasn't changed since last time is nearly free instead of re-downloading everything.

**"How would this scale to many more users?"**
Weak points today: (1) the connection pool is capped at 5 (`asyncpg.create_pool(..., max_size=5)` in `db/session.py`) — fine for a handful of users, would need raising or pooling (e.g. PgBouncer) at scale; (2) `POST /api/sync/run` syncs every connected user **sequentially in one request** — this would need to become a fan-out (e.g., a real task queue like Celery/RQ, or parallel async tasks with a concurrency limit) rather than a single cron-triggered HTTP call; (3) Render's free tier cold-starts after idle, which is a real latency problem under any real load, let alone increased load.

**"Why does the sync job also run extraction, instead of being separate?"**
Simplicity: one scheduled trigger (`/api/sync/run` every 15 minutes) drives the whole pipeline — sync, then a bounded slice of extraction — rather than needing two independently-scheduled jobs and having to reason about their relative timing. The batch limit (`extraction_batch_limit`) keeps any single run bounded even if there's a large backlog.

**"What happens if the AI gets something wrong — e.g., misattributes an action item?"**
There's no automatic correction today; the user can mark an action item "done" to dismiss it, but there's no edit/reject-and-relearn flow. This is a genuine known gap worth naming if asked "what would you improve" — e.g., a way to correct a contact's notes or delete/reassign a misextracted action item, with that correction fed back in as a signal.

**"Why Row Level Security if the backend bypasses it anyway?"**
Because the backend is the *only* thing that talks to Postgres directly today. RLS is enabled everywhere as a safety net — if a future feature (or a bug) ever let the browser query Supabase's Postgres directly with a low-privileged key, RLS would still contain the blast radius on `profiles` (which does have real per-user policies). It's cheap insurance, not the primary access-control layer here.

**"What was a real production bug you'd point to in this codebase?"**
Two good, concrete ones actually happened during development: (1) the OAuth callback page had no `try/catch` around its token-save request, so a transient network failure left the UI frozen forever on "Finishing sign-in…" instead of showing an error — fixed by wrapping it in `try/catch` plus an `AbortController` timeout. (2) `NEXT_PUBLIC_API_BASE_URL` had a trailing space in its production value; since it's baked into a template literal at build time, every API request's hostname got URL-encoded with a trailing `%20`, causing `net::ERR_NAME_NOT_RESOLVED` — a client-side DNS failure with zero backend log trace, fixed by trimming/normalizing the value in one shared `apiBaseUrl()` helper (`frontend/lib/api.ts`) instead of trusting the raw env var everywhere it's used.
