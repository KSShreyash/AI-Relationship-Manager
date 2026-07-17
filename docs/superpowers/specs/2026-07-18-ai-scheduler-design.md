# AI Scheduler — Design

**Date:** 2026-07-18
**Sub-project 5 of 6** in the AI Relationship Manager platform (Foundation → Graph Sync → AI Extraction → Contact Profiles/Dashboard/Planner → **AI Scheduler** → Global Search).

## Context

Every prior sub-project has deferred "creating/writing calendar events or meetings" here by name — Graph Sync's design explicitly calls out that the `/me/onlineMeetings` endpoint is "for *creating* meetings programmatically, which belongs to the AI Scheduler sub-project." Foundation already requested the `Calendars.ReadWrite` and `OnlineMeetings.ReadWrite` OAuth scopes and added a `profiles.timezone` column "for later scheduling features." Contact Profiles/Dashboard/Planner (sub-project 4) gave users a Planner where open action items — including ones like "Schedule a call with Alice" — are visible but inert; this sub-project makes them actionable.

## Goals

- Let the user turn an open action item into a real scheduled meeting: click "Schedule" on it (from either the Planner or a contact's profile), pick a time from AI-suggested open slots computed from their already-synced calendar, choose whether it's a Teams online meeting, and — if the linked contact has a known email — invite them.
- Show a visible "Scheduled: <date/time>" indicator on the action item afterward, so the user doesn't lose track and accidentally re-schedule it, even though the item itself stays open (scheduling a meeting doesn't complete the underlying commitment — the meeting itself hasn't happened yet).

## Non-goals

- No proactive/automatic scheduling — the AI never scans for scheduling intent; the trigger is always the user clicking "Schedule" on an existing action item.
- No editing or canceling a scheduled meeting from within the app — once created, changes happen in Outlook/Teams directly (consistent with this app's broader "AI-authored data, minimal manual editing" pattern established in Contact Profiles/Dashboard/Planner).
- No custom duration/lookahead configuration UI — fixed defaults (30 min, next 14 days, weekday 9am–5pm in the user's stored timezone).
- No scheduling for action items with no linked contact (`contact_id IS NULL`) — you can't schedule "with" nobody, so the Schedule control simply doesn't appear on those items.
- No group/multi-attendee scheduling — one action item maps to at most one contact/attendee.

## Architecture

A new backend service module, `app/services/scheduling.py`, with two responsibilities:

- **Slot suggestion**: reads the user's already-synced `calendar_events` rows for the next 14 days, computes free 30-minute slots within weekday 9am–5pm (in the user's `profiles.timezone`), filtering out anything that overlaps an existing event. No live Graph call needed — this is all local-DB computation, the same spirit as the dashboard's Python-side merge logic from Contact Profiles/Dashboard/Planner.
- **Meeting creation**: calls Graph's calendar-write endpoint to create the event (with the chosen slot, the contact as an attendee when their email is known, and `isOnlineMeeting` set per the user's toggle), then inserts the resulting event into local `calendar_events` and sets the new FK on the action item — all in one transaction, mirroring how AI Extraction writes contacts + action items + `extracted_at` together.

A new router, `app/api/v1/scheduling.py`, mounted at the same `/api/action-items` prefix the existing `action_items.py` router uses (FastAPI supports multiple routers sharing a prefix as long as paths don't collide; this keeps "list/toggle" and "calendar-writes" as separate concerns per file, matching the one-router-per-concern convention already used by `auth.py`/`me.py`/`sync.py`/`extraction.py`/`contacts.py`/`action_items.py`/`dashboard.py`):

- `GET /api/action-items/{id}/schedule-suggestions` → candidate slots
- `POST /api/action-items/{id}/schedule` → creates the meeting

One piece of existing-code cleanup this sub-project makes: the Graph access-token refresh logic (`_refresh_and_persist` in `graph_sync.py`) is currently private to that module. Scheduling needs the same "get a valid access token for this user, refreshing and persisting if needed, marking `needs_reauth` on failure" capability, so it gets extracted into a small shared helper that both `graph_sync.py` and the new `scheduling.py` call, rather than duplicating the refresh/needs_reauth logic.

Frontend: a "Schedule" control appears on any open action item that has a `contact_id` but no `scheduled_calendar_event_id` yet, on both the Planner's item rows and the contact profile page's Open section (both already render the same action-item shape). Clicking it opens a small inline panel on that row — not a page navigation — following the same local-`useState` + `apiFetch` + refetch-on-success pattern every other mutation in this app already uses.

## Data Model

One schema change: `action_items` gains a nullable FK.

```sql
alter table public.action_items
  add column scheduled_calendar_event_id uuid null references public.calendar_events(id);
```

Set once, when scheduling succeeds for that item; never cleared (no cancel/undo in this sub-project, per the non-goals above). No other schema changes — `calendar_events` already has every column needed to store what Graph returns from event creation (`start_time`/`end_time`/`is_online_meeting`/`online_meeting_join_url`/`attendees`), and `profiles.timezone` (already present since Foundation) drives the working-hours window for slot suggestions.

## API Endpoints

All routes require `CurrentUser` and scope by `user_id`; 404 for not-found/not-owned (same indistinguishable pattern as the rest of the app). Both routes additionally 404 when the action item has no `contact_id` — scheduling isn't meaningful without a contact to schedule with.

**`GET /api/action-items/{id}/schedule-suggestions`**
Returns a list of candidate slots: `[{"start": "2026-07-20T14:00:00Z", "end": "2026-07-20T14:30:00Z"}, ...]`, computed as described in Architecture (next 14 days, weekday 9am–5pm in the user's timezone, 30-minute slots, excluding anything overlapping an existing `calendar_events` row for that user). If the item is already scheduled (`scheduled_calendar_event_id` is set), returns 409 rather than suggestions — there's nothing to reschedule in this sub-project.

**`POST /api/action-items/{id}/schedule`**
Body: `{"start": "<iso datetime>", "end": "<iso datetime>", "online_meeting": bool}` (`start`/`end` don't have to be one of the suggested slots — the frontend passes through whatever the user picked, including if they adjusted it; the backend doesn't re-validate against the free/busy computation, since Graph itself is the source of truth for whether the event gets created). Creates the Graph calendar event (with the contact as an attendee if `contact.email_address` is set, `isOnlineMeeting` per the request), inserts the new row into `calendar_events`, sets `action_items.scheduled_calendar_event_id`, and returns the updated action item — in the same shape the planner/contact-profile list endpoints already use, now including `scheduled_calendar_event_id` and enough of the linked calendar event's start time to render "Scheduled: ..." without a second fetch. Also 409 if already scheduled.

## Frontend Pages & Components

Both the Planner's item rows and the contact profile's Open-item rows get the same per-item logic, since both already render the same action-item shape:

- `contact_id` set, `scheduled_calendar_event_id` null → show a "Schedule" button.
- `scheduled_calendar_event_id` set → show "Scheduled: <formatted date/time>" as plain text instead of a button (no edit/cancel control, per the non-goals).
- `contact_id` null → no button, no indicator (unchanged from today).

Clicking "Schedule" expands an inline panel on that row: fetches `GET .../schedule-suggestions` on open, renders each slot as a clickable option plus an "Online meeting" checkbox (default checked, since the Graph scope was provisioned specifically for this), and a "Confirm" action. On confirm, `POST`s the chosen slot, then refetches the underlying list (Planner or contact profile's action-items call) on success — the same no-optimistic-UI, refetch-on-success pattern as the existing done/reopen toggle. On failure, an inline error appears in the panel and it stays open so the user can retry, rather than silently closing.

## Error Handling

- Backend: 404 for not-found/not-owned/no-linked-contact on both new routes; 409 if the item is already scheduled; Graph token refresh failure surfaces as a `needs_reauth` condition the same way `graph_sync.py` already handles it (the shared token-refresh helper carries this behavior over rather than reimplementing it); any other Graph write failure (network, permission, throttling) bubbles up as a generic error rather than silently succeeding.
- Frontend: the scheduling panel shows an inline error and stays open on any failure (suggestions fetch or confirm), so the user doesn't lose their place and can retry without re-triggering the whole flow.

## Testing Strategy

**Backend:** the slot-suggestion function gets direct unit tests against a fixed set of `calendar_events` rows (assert exactly the right free slots come back, boundaries respected) — no Graph mocking needed for that part. Endpoint-level tests for both new routes mock the Graph write call (this project already has `respx` available for mocking `httpx` calls) and hit the real Supabase test DB for the `calendar_events` insert and the `action_items.scheduled_calendar_event_id` update, following the existing `pool`/`test_auth_user` fixture pattern. A dedicated test proves the "invite when email known, plain event when not" branch, and another proves the 409-when-already-scheduled behavior.

**Frontend:** `page.test.tsx` additions on both the Planner and contact-profile pages covering the Schedule button's three states (button / scheduled indicator / hidden), the suggestions panel opening and rendering slots, and the confirm flow's success and failure paths (mocking `apiFetch` as usual).

## Known Limitations (carried forward or newly accepted)

- **No reschedule/cancel from the app**: once scheduled, the only way to change or cancel the meeting is directly in Outlook/Teams. If a user does that externally, `action_items.scheduled_calendar_event_id` still points at a `calendar_events` row that may now be stale or (if the event was deleted) orphaned — acceptable at this app's current single-user scale, revisit if this becomes a real workflow.
- **Suggestions can go stale within a session**: slot suggestions are computed from the last-synced `calendar_events` snapshot, not a live Graph free/busy call. If the user's calendar changed since the last sync (e.g., a meeting added from their phone), a suggested slot could theoretically conflict. Accepted given sync already runs on a regular cadence; not worth a live Graph round-trip for this sub-project's scope.
- **Fixed slot/window parameters**: 30 minutes, 14 days, weekday 9am–5pm are not configurable. Fine for the common relationship-management "quick call" case; would need real settings UI if usage patterns demand otherwise.
