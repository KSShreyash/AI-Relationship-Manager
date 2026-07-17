# Contact Profiles / Dashboard / Planner — Design

Sub-project 4 of 6 on the platform roadmap (after Foundation, Graph Sync, and AI Extraction). This is the first sub-project to expose the AI-extracted `contacts` and `action_items` data to the user through an actual UI — until now, that data has only been reachable by querying the database directly.

## Goals

- Give the user a real dashboard: connection status, summary stats, a merged recent-activity feed, and manual "Sync now" / "Extract now" triggers.
- Give the user a searchable contact list and a per-contact profile page (AI-synthesized notes + that contact's action items).
- Give the user a planner: all action items across contacts, grouped by due date, filterable by commitment direction, with the ability to mark items done/reopen them.

## Non-goals

- No manual creation/editing of contacts or action item text — both remain AI-authored; the only user-initiated write in this sub-project is toggling an action item's `status`.
- No deduplication/clustering of near-duplicate action items extracted from the same thread (a known, accepted gap carried over from AI Extraction — see Known Limitations).
- No pagination anywhere (contact list, planner, activity feed) — data volumes are small at the current single-user personal-app scale. The activity feed is simply capped at 20 entries.
- No rendering of raw source emails/events/chats on the contact profile page — only the AI-synthesized notes and action items, avoiding the raw-HTML-at-rest gap noted from AI Extraction.

## Architecture

Three new FastAPI routers, following the existing one-router-per-concern convention (`auth.py`, `me.py`, `sync.py`, `extraction.py`):

- **`contacts.py`** — list, single-contact detail, and that contact's action items.
- **`action_items.py`** — planner listing (with filters) and the status-toggle mutation.
- **`dashboard.py`** — the aggregate: stats plus a merged recent-activity feed.

Every route uses the existing `CurrentUser` dependency and filters all queries by `user_id`, returning 404 when a resource doesn't belong to the caller — the same manual-authorization pattern already used throughout this codebase (RLS is enabled on `contacts`/`action_items`, but the backend connects with a privileged connection and enforces ownership itself, exactly as `ContactsRepository`/`ActionItemsRepository` do today).

Four frontend pages, all following the pattern established by the existing dashboard placeholder (client component, `useEffect` + `apiFetch`, local loading/error state, a co-located `page.test.tsx` mocking `apiFetch`):

- `app/dashboard/page.tsx` (rewritten)
- `app/contacts/page.tsx` (new)
- `app/contacts/[id]/page.tsx` (new)
- `app/planner/page.tsx` (new)

A minimal shared nav (Dashboard / Contacts / Planner) is added to `layout.tsx` using plain `<a>` tags — this codebase does not use `next/link` anywhere (likely tied to the unusual Next.js version flagged in `frontend/AGENTS.md`), so the new nav follows that existing convention rather than introducing a new one. No active-route highlighting — kept simple.

One schema change: `action_items` gains an `updated_at` column. This was flagged as a known gap during AI Extraction's final review specifically because a Planner UI would need it once users could toggle status — this sub-project is exactly that UI, so it's added here rather than deferred further.

## Data Model

```sql
alter table public.action_items
  add column updated_at timestamptz not null default now();
```

Existing rows get `now()` as their `updated_at` at migration time — a one-time cosmetic effect (pre-existing items look "just updated"), not a functional issue. The status-toggle endpoint sets `updated_at = now()` explicitly on every write, the same way `contacts.updated_at` is already maintained by the extraction pipeline.

No other schema changes. `contacts` and the rest of `action_items` already carry everything these views need: the nullable `email_address`/`display_name` pair (for the "Contacts without email" case), `notes`, `direction`, `status`, `due_date`, and `contact_id`.

## API Endpoints

All routes require `CurrentUser`. All lookups filter by `user_id`; not-found and not-owned are indistinguishable (both return 404).

**`GET /api/contacts?q=<search>`**
List, sorted by `updated_at` desc. Each row: `id`, `email_address`, `display_name`, `open_action_item_count`, `updated_at`. `q` is optional and filters by case-insensitive match against `display_name` or `email_address`.

**`GET /api/contacts/{id}`**
Single contact: `id`, `email_address`, `display_name`, `notes`, `created_at`, `updated_at`. 404 if not found/not owned.

**`GET /api/contacts/{id}/action-items`**
That contact's action items — both `open` and `done` (the profile page splits them client-side into two sections). Sorted by `created_at` desc. 404 if the contact isn't found/owned.

**`GET /api/action-items?direction=<mine|theirs>&include_done=<bool>`**
Planner listing across all of the user's contacts. Each item embeds a small `contact` object (`id`, `display_name`, `email_address`) or `null` when the action item has no resolved contact (the participant didn't match any contact record). Sorted by `due_date` asc-nulls-last, then `created_at` asc. `include_done` defaults to `false`. `direction` is optional; omitted means both.

**`PATCH /api/action-items/{id}`**
Body: `{"status": "open" | "done"}` (`Literal` type — FastAPI returns 422 for anything else automatically). Stamps `updated_at = now()`. Returns the updated item. 404 if not found/not owned.

**`GET /api/dashboard`**
Returns `contact_count`, `open_action_item_count`, and `activity`: the 20 most recent events merged from contacts (by `updated_at`) and action items (by `created_at`), computed via two simple queries plus a Python-side merge (no SQL `UNION` needed). Each activity entry is tagged `contact_updated` or `action_item_created` with the relevant display fields (contact name/email, or action item text/direction/contact).

## Frontend Pages & Components

**Dashboard** (`app/dashboard/page.tsx`, rewritten) — keeps the existing connection-status block, adds two stat numbers (contact count, open action item count), "Sync now" / "Extract now" buttons that `POST` to the existing `/api/sync/run/me` and `/api/extraction/run/me` (disabled while in flight, refetch dashboard data on success, inline error + re-enable on failure), and the activity feed as a simple timestamped list.

**Contact list** (`app/contacts/page.tsx`) — a search input, debounced ~300ms before triggering a refetch, and a list of rows (name-or-email, open action item count) each linking to `/contacts/{id}`. Each fetch is tagged with a request counter so a stale (out-of-order) response from an earlier keystroke never overwrites a newer one.

**Contact profile** (`app/contacts/[id]/page.tsx`) — fetches the contact detail and its action items in parallel; renders the freeform notes, then an "Open" section and a "Done" section (split client-side from the single action-items response). A 404 renders an inline "Contact not found" message (no forced redirect — consistent with how `needs_reauth` is already handled on the dashboard).

**Planner** (`app/planner/page.tsx`) — a direction filter (All / Mine / Theirs) and a "show completed" checkbox drive the query params on refetch. Open items are grouped client-side into Overdue / Due this week / Later / No due date by comparing `due_date` to today. When "show completed" is on, done items appear in a separate "Completed" section below the date groups, not mixed into them. Each row has a done/reopen control that `PATCH`es the item then refetches the list (no optimistic UI — consistent with the rest of this app not having any yet).

Empty states get specific copy rather than a blank screen: "No contacts yet — sync and extract to get started," "Nothing due," "No recent activity."

## Error Handling

- Backend: 404 for any not-found-or-not-owned lookup; 422 automatic via `Literal["open", "done"]` validation on the `PATCH` body; auth failures flow through the existing `CurrentUser` dependency unchanged.
- Frontend: sync/extract button failures show an inline error and re-enable the button (no silent failure); the done/reopen control shows an inline error on `PATCH` failure without changing the displayed state; the contact-list search guards against out-of-order responses via a request counter.

## Testing Strategy

**Backend:** repository-level tests for the new list/get/update queries (ownership filtering, search matching, `updated_at` stamping on status change) plus endpoint-level tests per router (auth required, happy path, 404 on cross-user access) — the same real-database pattern the existing suite already uses, with test rows scoped to a known test user and cleaned up the same way existing tests do.

**Frontend:** a `page.test.tsx` per page mocking `apiFetch`, covering loading/success/error/empty states. The contact-list search debounce gets a dedicated test that resolves two mocked fetches out of order and asserts the UI reflects the later (not earlier) query, proving the stale-response guard actually works.

## Known Limitations (carried forward or newly accepted)

- **Near-duplicate action items**: per-item extraction can produce multiple action items for the same real-world commitment mentioned across a thread. This sub-project displays them as-is; clustering/deduplication is deferred (a semantically-aware dedup would need embedding similarity or an LLM pass — a larger feature than this sub-project's scope).
- **No pagination**: acceptable at current single-user scale; will need revisiting if contact/action-item volume grows substantially.
- **Raw HTML at rest**: `body_text` columns on `emails`/`calendar_events` remain raw HTML (only stripped in-flight during extraction) — irrelevant here since this sub-project never renders source content, but still an open item for any future sub-project that does.
