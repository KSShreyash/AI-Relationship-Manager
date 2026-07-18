# Global Search — Design

**Date:** 2026-07-18
**Sub-project 6 of 6** in the AI Relationship Manager platform (Foundation → Graph Sync → AI Extraction → Contact Profiles/Dashboard/Planner → AI Scheduler → **Global Search**). This is the final sub-project on the current roadmap.

## Context

Every prior sub-project has deferred "search" by name. AI Extraction's non-goals explicitly named this sub-project as owning "semantic search over extracted content." Graph Sync's design spec went further and shaped its own data model around it: emails/calendar events/chat messages are stored as plain Postgres text rather than app-level-encrypted, specifically because "later sub-projects (AI Extraction, Global Search) need to query and full-text-search this content directly." This sub-project resolves that groundwork into an actual search feature.

## Goals

- Give the user a single search page (`/search`, linked from the shared nav) where typing a query live-searches across their contacts (name, email, notes) and action items (text), showing results grouped into two sections, each ranked by full-text relevance.
- Each contact result links to that contact's profile page; each action item result shows its linked contact (if any) as a link to that contact's profile, but the action item itself isn't a separate navigation target — search is for finding things, not a second place to manage them (status toggle, scheduling, etc. stay on the Planner/contact profile).

## Non-goals

- No semantic/embeddings-based search — Postgres full-text search only (`websearch_to_tsquery`), computed at query time with no new schema/migration. No new infrastructure (no vector extension, no embeddings pipeline, no per-item OpenAI cost). This is a deliberate scope choice for a personal single-user app, not an oversight — true semantic search remains a plausible future enhancement if search quality ever demands it.
- No search over raw source content (emails/calendar events/chat messages) — only the AI-synthesized layer (contacts, action items), consistent with this app's established pattern (set in Contact Profiles/Dashboard/Planner) of never rendering raw source content directly, and avoiding the still-unresolved raw-HTML-at-rest gap on `body_text` columns.
- No pagination — each section capped at a fixed count (20), matching this app's existing "cap with a constant" pattern (e.g. the dashboard's activity feed).
- No management actions from search results (no inline status toggle, no scheduling) — results are read-only previews with links out to the pages that already own that functionality.

## Architecture

A new backend router, `app/api/v1/search.py`, following the established one-router-per-concern convention (`auth.py`, `me.py`, `sync.py`, `extraction.py`, `contacts.py`, `action_items.py`, `dashboard.py`, `scheduling.py`). It exposes a single endpoint (`GET /api/search?q=<query>`) that runs two independent full-text queries — one against `contacts` (matching `display_name`, `email_address`, `notes`), one against `action_items` (matching `text`) — each using Postgres's `websearch_to_tsquery('english', q)` against a `to_tsvector('english', ...)` expression built at query time from the relevant columns, ranked by `ts_rank`. This mirrors the dashboard's existing pattern of a dedicated backend aggregate endpoint rather than client-side stitching, and needs no schema migration — the tsvector is computed inline in the query, not stored.

One new frontend page, `app/search/page.tsx`, following the exact conventions established by every other page in this app (client component, local `useState`, `apiFetch`, a co-located `page.test.tsx` mocking `apiFetch`). It reuses the debounced-search + stale-response-guard pattern already built and tested on the Contacts list page (a 300ms debounce, a `useRef` request counter). The shared nav (`layout.tsx`) gains a fourth link, "Search" → `/search`, alongside the existing Dashboard/Contacts/Planner links — same plain `<a>` tag style, no active-route highlighting, consistent with the nav's current "kept simple" design.

## Data Model

No schema changes. Full-text matching is computed at query time via `to_tsvector('english', ...)` over existing columns — no new column, no migration, no index. Acceptable at personal single-user scale; a GIN-indexed generated tsvector column is a plausible future-work item if search performance ever becomes a real concern (it currently won't, at this data volume).

## API Endpoints

**`GET /api/search?q=<query>`**
Requires `CurrentUser`, scoped by `user_id` on both underlying queries. An empty or missing `q` returns `{"contacts": [], "action_items": []}` immediately without querying the database (a blank search is meaningless for full-text search, and this avoids a wasted query on page load). Otherwise:

- `contacts`: up to 20 rows from `public.contacts` where `user_id` matches and `to_tsvector('english', coalesce(display_name,'') || ' ' || coalesce(email_address,'') || ' ' || coalesce(notes,''))` matches `websearch_to_tsquery('english', q)`, ordered by `ts_rank` descending. Each row: `id`, `display_name`, `email_address`, `notes` (for a short preview snippet).
- `action_items`: up to 20 rows from `public.action_items` where `user_id` matches and `to_tsvector('english', text)` matches the query, ordered by `ts_rank` descending. Each row: `id`, `text`, `direction`, `status`, `due_date`, and — reusing the same nested-contact shape already established on the Planner/action-items endpoints — a `contact` object (`id`, `display_name`, `email_address`) or `null`.

## Frontend Pages & Components

**Search page** (`app/search/page.tsx`, new): a search input (debounced 300ms, request-counter stale-response guard, matching the Contacts page's proven pattern), and two sections below it — "Contacts" and "Action Items" — each rendered only once a non-empty query has been searched. Empty-query state shows a prompt ("Type to search your contacts and action items."). A searched-but-empty result shows section-specific empty copy ("No matching contacts.", "No matching action items."). Each contact result is a link (`<a href="/contacts/{id}">`) showing name/email and a short notes preview. Each action item result shows its text, and — if it has a linked contact — that contact's name as a link to their profile page; unlinked items just show their text with no link.

**Nav** (`app/layout.tsx`, modified): adds a "Search" link (`<a href="/search">`) to the existing shared nav, after the existing three links.

## Error Handling

- Backend: `q` is an optional string query param; a missing or empty `q` is treated as "no query" (returns empty results, not a 422). `websearch_to_tsquery` is used specifically because it accepts arbitrary free-text input without throwing on unbalanced quotes or malformed boolean syntax (unlike `to_tsquery`), so no separate input-validation step is needed for the query text itself. Any other failure is a normal 5xx, unhandled specially.
- Frontend: a failed fetch shows an inline error message and leaves the previous results in place (matching the Contacts page's existing failure-handling posture).

## Testing Strategy

**Backend:** repository/endpoint tests proving relevance ranking behaves sensibly (an exact-phrase match ranks above a partial match), ownership scoping (a search never returns another user's contacts/action items), the 20-item cap, and the empty-query short-circuit (asserting no query is issued to Postgres — or just that empty results come back instantly).

**Frontend:** a `page.test.tsx` covering loading/empty/results/error states for both sections, plus a dedicated debounce + stale-response test mirroring the Contacts page's existing one (typing a partial query then completing it, asserting only the later query's results are shown).

## Known Limitations (carried forward or newly accepted)

- **No semantic search**: paraphrased or conceptually-related queries that don't share keywords with the target content won't match. Accepted tradeoff for zero new infrastructure at this app's scale; embeddings-based search remains a plausible future enhancement.
- **No raw-source search**: emails/calendar events/chat messages remain unsearchable directly — only what the AI has already synthesized into contact notes and action items. This is consistent with (not a new instance of) the raw-HTML-at-rest gap noted since AI Extraction's closure; still unresolved for any sub-project that might want to render or search raw source content directly.
- **No index on the computed tsvector expression**: full sequential scan per search at query time. Fine at personal single-user data volumes; would need a stored, indexed tsvector column if this ever needs to scale.
- **This is the last sub-project on the current roadmap** — no further deferred-to-later-sub-project items remain to track forward.
