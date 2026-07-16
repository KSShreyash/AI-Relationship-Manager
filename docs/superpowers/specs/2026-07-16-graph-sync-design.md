# Graph Sync — Design Spec

**Date:** 2026-07-16
**Sub-project 2 of 6** in the AI Relationship Manager platform (Foundation → **Graph Sync** → AI Extraction → Contact Profiles/Dashboard/Planner → AI Scheduler → Global Search).

## Context

Foundation (sub-project 1) is live: users sign in with Microsoft (work/school or personal accounts), and the backend holds encrypted, auto-refreshing Graph tokens per user. Nothing has been pulled from Graph yet beyond the one-off `/me` call in `/api/me/graph-status`.

This spec covers ingesting a user's Outlook mail, calendar, and Teams chat into our own Postgres tables, so later sub-projects (AI Extraction, Contact Profiles, Global Search) have real data to work with instead of calling Graph on every read.

## Goals

- Sync email, calendar events (including Teams meeting join info), and Teams chat messages from Microsoft Graph into per-user Postgres tables.
- Full functionality for work/school accounts. For personal Microsoft accounts, any feature Graph doesn't support (chat, online-meeting-specific fields) degrades gracefully to "not available" rather than erroring.
- Efficient incremental sync via Graph delta queries, not full re-fetches.
- Both a periodic background sync and an on-demand "Sync now" action.

## Non-goals (explicitly deferred)

AI extraction/summarization of synced content, contact profile aggregation, dashboard UI beyond what's needed to prove sync works, creating/writing calendar events or meetings (that's AI Scheduler, sub-project 5), webhook/push-based sync (Graph change notifications), full mailbox/chat history backfill.

## Architecture

```
[External free cron: GitHub Actions schedule / cron-job.org]
     | HTTPS, every ~15 min, X-Sync-Secret header
     v
[Render: FastAPI backend]
     |  POST /api/sync/run        -> loops all connected users, syncs each
     |  POST /api/sync/run/me     -> JWT-authenticated, syncs just the caller (dashboard "Sync now" button)
     |  (also invoked once, inline, right after Task 12's token-capture callback)
     v
[Microsoft Graph API]  --delta queries-->  [Supabase Postgres: emails, calendar_events, chat_messages, sync_state]
```

Reuses Foundation's existing pieces: `graph_client.py`'s token refresh, the encrypted `ms_graph_tokens` store, and the `graph_connection_status` / `needs_reauth` mechanism on refresh failure.

## Data Model

Four new tables. Same RLS posture as `ms_graph_tokens`: RLS enabled, zero policies for `anon`/`authenticated` — only the backend's service-role connection reads or writes these. Content is stored as plain Postgres text (not Fernet-encrypted like the tokens): later sub-projects (AI Extraction, Global Search) need to query and full-text-search this content directly, which an app-level-encrypted blob would block. Supabase encrypts data at rest at the infrastructure level regardless.

### `emails`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → `profiles.id` | |
| `graph_message_id` | text | unique per `user_id` |
| `subject` | text | |
| `from_address` | text | |
| `from_name` | text | |
| `to_recipients` | jsonb | |
| `received_at` | timestamptz | |
| `body_text` | text | |
| `synced_at` | timestamptz | |

### `calendar_events`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → `profiles.id` | |
| `graph_event_id` | text | unique per `user_id` |
| `subject` | text | |
| `organizer` | text | |
| `attendees` | jsonb | |
| `start_time`, `end_time` | timestamptz | |
| `is_online_meeting` | boolean | from Graph's `isOnlineMeeting` |
| `online_meeting_join_url` | text, nullable | from Graph's `onlineMeeting.joinUrl` |
| `body_text` | text | |
| `synced_at` | timestamptz | |

### `chat_messages`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → `profiles.id` | |
| `graph_chat_id` | text | |
| `graph_message_id` | text | unique per `user_id` |
| `from_user` | text | |
| `content` | text | |
| `sent_at` | timestamptz | |
| `synced_at` | timestamptz | |

### `sync_state`
| column | type | notes |
|---|---|---|
| `user_id` | uuid, FK → `profiles.id` | |
| `resource_type` | enum: `mail`, `calendar`, `chat` | |
| `delta_link` | text, nullable | Graph's `@odata.deltaLink`. Used for `mail`/`calendar` only — Graph has no delta-query support for chat messages under delegated permissions (see Sync Mechanism); always null for `chat` rows, which instead rely on `last_synced_at` |
| `last_synced_at` | timestamptz | for `mail`/`calendar`, informational (delta link carries the real cursor); for `chat`, this **is** the cursor, used as a `$filter=lastModifiedDateTime gt {value}` bound |
| `status` | enum: `ok`, `not_available`, `error` | `not_available` = Graph confirmed this feature doesn't exist for this account (e.g. chat on a personal MSA); checked before every future attempt so we don't keep hitting an endpoint known to fail |
| PK | `(user_id, resource_type)` | |

"Online meetings" is not a separate sync job — Graph's calendar events already carry Teams join info inline, so it's just columns on `calendar_events`. The dedicated `/me/onlineMeetings` endpoint is for *creating* meetings programmatically, which belongs to the AI Scheduler sub-project, not this read-only phase.

## Sync Mechanism

**Trigger paths**, all calling the same core per-user sync function:
1. **Scheduled:** a free external cron (GitHub Actions schedule or cron-job.org) calls `POST /api/sync/run` every ~15 minutes with a shared-secret header (`X-Sync-Secret`, checked with constant-time comparison against a Render env var — no user JWT exists when an external cron fires this). Loops every `profiles` row with `graph_connection_status = 'connected'`, syncing each in its own try/except so one user's failure doesn't abort the batch.
2. **On-demand:** dashboard's "Sync now" button calls `POST /api/sync/run/me`, JWT-authenticated, syncs only the caller, synchronously, so the UI can show completion immediately.
3. **Immediately after connecting:** one sync runs right after Task 12's callback stores the initial Graph tokens, so the user sees data without waiting for the next cron tick.

**Mail and calendar** (true Graph delta query — supported under delegated permissions for both account types):
1. Check `sync_state` for `(user_id, 'mail'|'calendar')`. If `status = 'not_available'`, skip.
2. Mail: `GET /me/mailFolders/inbox/messages/delta`, first call scoped with `$filter=receivedDateTime ge {30-days-ago}`; subsequent calls just reuse the stored `@odata.deltaLink` verbatim (it already encodes the filter). Calendar: `GET /me/calendarView/delta?startDateTime={30-days-ago}&endDateTime={90-days-ahead}` on first call (calendar view needs a date range, unlike mail); subsequent calls reuse the stored `@odata.deltaLink`.
3. Follow `@odata.nextLink` until the response carries `@odata.deltaLink` (sync complete for this round); upsert each page's results keyed on `graph_message_id`/`graph_event_id` (dedupe on conflict; a `@removed` entry deletes the local row); store the final `@odata.deltaLink`, set `status = 'ok'`.

**Chat has no delta-query support under delegated permissions at all** (Microsoft Graph restricts chat message delta to `Application` permissions only — confirmed directly against current Graph API docs; this is a hard permission-model wall, not a tenant setting). So chat sync instead uses `sync_state.last_synced_at` as a plain timestamp cursor:
1. Check `sync_state` for `(user_id, 'chat')`. If `status = 'not_available'`, skip.
2. `GET /me/chats` to enumerate the user's chats. **For personal Microsoft accounts this call itself fails immediately** (`/me/chats` is "Not supported" for delegated personal-account permissions per Graph's own docs) — catch that, set `status = 'not_available'`, done; no per-chat calls attempted.
3. For each chat (work/school only, by this point): `GET /chats/{chat-id}/messages?$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt {last_synced_at}` (or 30-days-ago on first sync), paginating via `@odata.nextLink` if present.
4. Upsert results keyed on `graph_message_id`; after all chats processed, set `sync_state.last_synced_at = now()`, `status = 'ok'`.

**Graceful degradation, generalized:** any 403/400 Graph returns for a feature it doesn't support on this account (chat/`/me/chats` on personal MSAs being the concrete case here) sets `sync_state.status = 'not_available'` for that resource and moves on — not surfaced as a user-facing error, that section just doesn't populate.

## Error Handling

- **429 (rate limited):** honor `Retry-After`, retry once with backoff; if still failing, leave state unchanged and retry next scheduled run — no silent infinite retry loops.
- **401 mid-sync (expired token):** reuse `graph_client.py`'s `refresh_access_token`; if refresh itself fails, set `graph_connection_status = 'needs_reauth'` (same mechanism `/api/me/graph-status` already uses) and stop that user's sync for this run.
- **403/400 indicating a genuinely unsupported feature:** `sync_state.status = 'not_available'` — expected, not an error.
- **Partial batch failure:** each user's sync is isolated in the bulk loop; one user's exception is logged and doesn't stop the rest.
- **`/api/sync/run` auth:** wrong/missing shared secret → 401, nothing executes.

## Testing Strategy

- Delta sync logic (mocked Graph client): first sync with no `delta_link` uses the 30-day window; subsequent sync resumes from stored `delta_link`; upserts dedupe correctly, no duplicate rows on re-sync.
- Graceful degradation: mocked 403 on `/me/chats` sets `sync_state.status = 'not_available'` without raising.
- Mid-sync token expiry: mocked refresh failure sets `graph_connection_status = 'needs_reauth'` and stops cleanly.
- Per-user isolation: one user's sync throwing doesn't stop other users' syncs in the same batch run.
- `/api/sync/run` auth: missing/wrong `X-Sync-Secret` → 401.
- Manual acceptance check: connect a real work/school account, trigger `/api/sync/run/me`, verify rows land in `emails`, `calendar_events`, `chat_messages`. Separately, verify a personal account populates `emails`/`calendar_events` while `chat_messages` stays empty with `sync_state.status = 'not_available'` for chat.

## Key Decisions Log

- **Delta-query polling, not full re-fetch or webhooks** — real efficiency gains over re-fetching everything each run, without the complexity of Graph subscription webhooks (public callback endpoint, renewal every ~3 days) this stage of the product doesn't need yet.
- **Chat sync uses timestamp-filtered polling, not delta query** — verified directly against current Graph API docs that chat message delta (`chats-getAllMessages: delta`) is unsupported for *any* delegated permission (work/school or personal), only `Application` permissions get it, which this app doesn't use. `/me/chats` itself is also "Not supported" for delegated personal-account permissions, meaning personal-account chat sync fails at the very first call, deterministically — not an occasional tenant-policy edge case.
- **Personal accounts get graceful per-feature degradation, not a hard account-type gate** — detected via the actual Graph error at call time (`sync_state.status = 'not_available'`) rather than pre-guessing capabilities from account type, since that also correctly handles tenant-policy edge cases on work/school accounts.
- **Content stored as plain Postgres text, not Fernet-encrypted** — later sub-projects need to query/search this content directly; RLS zero-policy + service-role-only access is the same defense-in-depth model already used for `ms_graph_tokens`, and Supabase encrypts at rest at the infrastructure level regardless.
- **"Online meetings" folded into `calendar_events`, no separate table** — Graph exposes Teams join info inline on calendar events; the dedicated online-meetings endpoint is for creating meetings, which is AI Scheduler's job later, not this read-only sync phase.
- **Free external cron instead of a paid Render background worker** — Render's free web service spins down when idle; an external HTTP ping both wakes it and triggers sync, at zero cost.
