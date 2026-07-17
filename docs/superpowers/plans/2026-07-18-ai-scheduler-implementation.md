# AI Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user turn an open action item with a linked contact into a real Microsoft Graph calendar event (optionally a Teams meeting, optionally inviting the contact), choosing from AI-suggested open time slots computed from their already-synced calendar.

**Architecture:** A new backend service (`app/services/scheduling.py`) computes free 30-minute slots from the local `calendar_events` table and, on confirmation, calls Microsoft Graph to create the event before writing it back locally in one transaction. A new router exposes this as two endpoints mounted at the existing `/api/action-items` prefix. Two existing frontend pages (Planner, contact profile) get a shared "Schedule" panel component.

**Tech Stack:** FastAPI + asyncpg (backend), Next.js + Vitest/RTL (frontend), Microsoft Graph REST API via `httpx`, `msal` for token refresh, Python's `zoneinfo` (stdlib) + `tzdata` (new dependency) for IANA timezone math.

## Global Constraints

- Endpoints return raw Python dicts (never `response_model=`) containing raw `uuid.UUID`/`datetime`/`date` values directly — FastAPI's `jsonable_encoder` serializes them automatically. No manual `.isoformat()`/`str()` anywhere in new router or service code.
- Every route uses the existing `CurrentUser` dependency; all queries scoped by `user_id`. 404 for not-found/not-owned/no-linked-contact (indistinguishable, matching the existing pattern). New for this sub-project: 409 when an action item is already scheduled, and 409 when the user's Microsoft Graph connection needs reconnecting (`get_valid_access_token` returns `None`) — both are real "cannot proceed" conditions distinct from 404.
- No pagination anywhere. Slot suggestions are capped at a fixed `MAX_SUGGESTIONS = 10` constant (not offset pagination), matching this app's established "cap with a constant" pattern (e.g. the dashboard's activity feed).
- No optimistic UI: the scheduling confirm action awaits the POST response, then calls the page's existing refetch (`load()`), same as every other mutation in this app. On failure, an inline error is shown and the panel stays open.
- Fixed scheduling parameters, not user-configurable: `SLOT_MINUTES = 30`, `LOOKAHEAD_DAYS = 14`, work window `WORK_START_HOUR = 9` to `WORK_END_HOUR = 17` in the user's `profiles.timezone` (defaulting to `"UTC"` when that column is `NULL` — confirmed via `supabase/migrations/20260715000000_foundation_schema.sql:8` that `timezone` has no default and nothing in this codebase currently sets it, so treat it as commonly unset).
- `zoneinfo.ZoneInfo` requires the `tzdata` PyPI package on this Windows dev machine (verified directly: `ZoneInfo("America/New_York")` raises `ZoneInfoNotFoundError` without it — Windows doesn't ship IANA tzdata the way Linux does). `tzdata` must be added to `backend/requirements.txt` and installed into `backend/.venv` as part of Task 5.
- Backend tests hit the real Supabase test DB via the existing `pool`/`test_auth_user`/`test_auth_user_2` fixtures (`backend/tests/conftest.py`). Graph HTTP calls are mocked with `respx` (already a real, used dependency — see `backend/tests/test_graph_client.py`), not `unittest.mock.patch` on `httpx` internals.
- Frontend tests mock `apiFetch` via `vi.mock('@/lib/api', ...)` with `vi.hoisted`, matching every existing page test. The new scheduling UI has no debounce/timer logic, so — unlike the Planner and contact-list pages — its tests do **not** need `vi.useFakeTimers()`, `fireEvent` workarounds, or the `toFake: ['Date']` scoping documented in `frontend/AGENTS.md`. Use plain `fireEvent`/`waitFor` from `@testing-library/react`.
- No `next/link` anywhere in this codebase — plain `<a href="...">` only (not directly relevant here; the new UI has no new navigation).
- The external Graph call in `scheduling.create_meeting` must complete fully *before* any database transaction begins (same hard guarantee already followed by `ai_extraction.py`'s OpenAI call and `graph_sync.py`'s Graph reads) — never hold a DB connection open across the network call.

---

### Task 1: Extract shared Graph token-refresh helper

**Files:**
- Create: `backend/app/services/graph_tokens_service.py`
- Modify: `backend/app/services/graph_sync.py`
- Modify: `backend/tests/test_graph_sync_service.py`
- Test: `backend/tests/test_graph_tokens_service.py`

**Interfaces:**
- Consumes: `app.repositories.graph_tokens.GraphTokensRepository` (existing), `app.repositories.profiles.ProfilesRepository` (existing), `app.core.security.decrypt_token`/`encrypt_token` (existing), `app.services.graph_client.refresh_access_token`/`GraphRefreshError` (existing).
- Produces: `refresh_and_persist(pool: asyncpg.Pool, user_id: uuid.UUID) -> str | None` and `get_valid_access_token(pool: asyncpg.Pool, user_id: uuid.UUID) -> str | None`, both in `app.services.graph_tokens_service`. Task 6 (scheduling's `create_meeting`) consumes both of these directly.

This is a **behavior-preserving refactor** of already-tested code: `graph_sync.py`'s private `_refresh_and_persist` function and the inline expiry-check at the top of `sync_user` move into a new shared module, unchanged in logic, so `scheduling.py` (Task 6) can reuse the exact same "get a valid access token, refreshing and marking `needs_reauth` on failure" behavior without duplicating it.

- [ ] **Step 1: Create the new shared module**

Create `backend/app/services/graph_tokens_service.py`:

```python
import uuid
from datetime import datetime, timezone

import asyncpg
from starlette.concurrency import run_in_threadpool

from app.core.security import decrypt_token, encrypt_token
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.graph_client import GraphRefreshError, refresh_access_token


async def refresh_and_persist(pool: asyncpg.Pool, user_id: uuid.UUID) -> str | None:
    tokens_repo = GraphTokensRepository(pool)
    profiles_repo = ProfilesRepository(pool)

    token_row = await tokens_repo.get(user_id)
    if token_row is None:
        return None

    refresh_token = decrypt_token(token_row["encrypted_refresh_token"])
    try:
        refreshed = await run_in_threadpool(
            refresh_access_token, refresh_token, scopes=token_row["scopes"]
        )
    except GraphRefreshError:
        await profiles_repo.set_graph_connection_status(user_id, "needs_reauth")
        return None

    await tokens_repo.upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token(refreshed["access_token"]),
        encrypted_refresh_token=encrypt_token(refreshed["refresh_token"]),
        access_token_expires_at=refreshed["expires_at"],
        scopes=token_row["scopes"],
    )
    return refreshed["access_token"]


async def get_valid_access_token(pool: asyncpg.Pool, user_id: uuid.UUID) -> str | None:
    tokens_repo = GraphTokensRepository(pool)
    token_row = await tokens_repo.get(user_id)
    if token_row is None:
        return None

    if token_row["access_token_expires_at"] <= datetime.now(timezone.utc):
        return await refresh_and_persist(pool, user_id)

    return decrypt_token(token_row["encrypted_access_token"])
```

- [ ] **Step 2: Refactor `graph_sync.py` to use the shared module**

In `backend/app/services/graph_sync.py`, replace the import block (currently lines 1-19) with:

```python
import re
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx

from app.core.config import settings
from app.repositories.calendar_events import CalendarEventsRepository
from app.repositories.chat_messages import ChatMessagesRepository
from app.repositories.emails import EmailsRepository
from app.repositories.sync_state import SyncStateRepository
from app.services import graph_client
from app.services.ai_extraction import extract_user
from app.services.graph_tokens_service import get_valid_access_token, refresh_and_persist
```

Delete the entire `_refresh_and_persist` function (currently lines 189-213 — the function starting `async def _refresh_and_persist(pool: asyncpg.Pool, user_id: uuid.UUID) -> str | None:` through its closing `return refreshed["access_token"]`).

Replace the body of `sync_user` (currently starting `async def sync_user(pool: asyncpg.Pool, user_id: uuid.UUID) -> None:`) with:

```python
async def sync_user(pool: asyncpg.Pool, user_id: uuid.UUID) -> None:
    access_token = await get_valid_access_token(pool, user_id)
    if access_token is None:
        return

    errors: list[Exception] = []
    for sync_fn in (sync_mail, sync_calendar, sync_chat):
        try:
            await sync_fn(pool, user_id, access_token)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                access_token = await refresh_and_persist(pool, user_id)
                if access_token is None:
                    return
                try:
                    await sync_fn(pool, user_id, access_token)
                except Exception as retry_exc:
                    errors.append(retry_exc)
            else:
                errors.append(exc)
        except Exception as exc:
            errors.append(exc)

    try:
        await extract_user(pool, user_id, settings.extraction_batch_limit)
    except Exception:
        pass

    if errors:
        raise errors[0]
```

This is byte-for-byte the same logic as before — only the token-fetch/refresh lines at the top changed from inline code to a call to `get_valid_access_token`, and the mid-loop refresh call from `_refresh_and_persist` to `refresh_and_persist`.

- [ ] **Step 3: Update the 4 existing test patches**

In `backend/tests/test_graph_sync_service.py`, these tests currently patch `app.services.graph_sync.refresh_access_token` — that name no longer exists in `graph_sync.py`'s namespace after Step 2, so every occurrence must change to `app.services.graph_tokens_service.refresh_access_token`:

- `test_sync_user_refreshes_expired_token_first` (patch at what is currently line 411)
- `test_sync_user_sets_needs_reauth_on_refresh_failure` (currently line 434)
- `test_sync_user_recovers_from_401_mid_sync_by_refreshing` (currently line 480)
- `test_sync_user_sets_needs_reauth_when_401_mid_sync_refresh_fails` (currently line 507)

Find every line matching `patch("app.services.graph_sync.refresh_access_token"` in this file and change `graph_sync` to `graph_tokens_service` — e.g.:

```python
with patch("app.services.graph_tokens_service.refresh_access_token", return_value=refreshed), \
```

Do not change anything else in these tests — the assertions, fixtures, and other patches (`app.services.graph_sync.sync_mail`, etc.) stay exactly as they are, since `sync_mail`/`sync_calendar`/`sync_chat` still live in `graph_sync.py`.

- [ ] **Step 4: Run the updated graph_sync tests**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_graph_sync_service.py -v`
Expected: all tests PASS (same count as before this task — this is a refactor, not new behavior).

- [ ] **Step 5: Write focused tests for the new shared module**

Create `backend/tests/test_graph_tokens_service.py`:

```python
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.core.security import decrypt_token, encrypt_token
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.graph_tokens_service import get_valid_access_token


@pytest.mark.asyncio
async def test_get_valid_access_token_returns_none_when_no_connection(pool, test_auth_user):
    user_id, _ = test_auth_user

    result = await get_valid_access_token(pool, user_id)

    assert result is None


@pytest.mark.asyncio
async def test_get_valid_access_token_returns_decrypted_token_when_not_expired(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("still-valid"),
        encrypted_refresh_token=encrypt_token("refresh-token"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Mail.Read"],
    )

    result = await get_valid_access_token(pool, user_id)

    assert result == "still-valid"


@pytest.mark.asyncio
async def test_get_valid_access_token_refreshes_when_expired(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("expired"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        scopes=["Mail.Read"],
    )
    refreshed = {
        "access_token": "brand-new",
        "refresh_token": "brand-new-refresh",
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
    }

    with patch("app.services.graph_tokens_service.refresh_access_token", return_value=refreshed):
        result = await get_valid_access_token(pool, user_id)

    assert result == "brand-new"
    row = await GraphTokensRepository(pool).get(user_id)
    assert decrypt_token(row["encrypted_access_token"]) == "brand-new"
```

- [ ] **Step 6: Run the new tests**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_graph_tokens_service.py -v`
Expected: PASS (3/3)

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all tests pass, no regressions (baseline before this task: 127 passed).

- [ ] **Step 8: Commit**

```bash
git add backend/app/services/graph_tokens_service.py backend/app/services/graph_sync.py backend/tests/test_graph_sync_service.py backend/tests/test_graph_tokens_service.py
git commit -m "refactor: extract shared Graph token-refresh helper from graph_sync"
```

---

### Task 2: Migration + repository additions for scheduling

**Files:**
- Create: `supabase/migrations/20260718000000_action_items_scheduled_calendar_event_id.sql`
- Modify: `backend/app/repositories/action_items.py`
- Modify: `backend/app/repositories/calendar_events.py`
- Test: `backend/tests/test_action_items_repository.py`
- Test: `backend/tests/test_calendar_events_repository.py` (create if it doesn't already exist — check first; `CalendarEventsRepository` tests currently live in `backend/tests/test_graph_sync_repositories.py`, so add there instead if that's the existing home)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `ActionItemsRepository.get(user_id, item_id) -> asyncpg.Record | None` (joined with contacts + calendar_events), `ActionItemsRepository.set_scheduled_calendar_event_id(user_id, item_id, calendar_event_id, conn=None) -> asyncpg.Record | None` (same joined shape), `CalendarEventsRepository.upsert(...) -> uuid.UUID` (now returns the row id; gains an optional `conn` param), `CalendarEventsRepository.list_busy_between(user_id, start, end) -> list[asyncpg.Record]`. Tasks 3, 6, and 7 all consume these.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260718000000_action_items_scheduled_calendar_event_id.sql`:

```sql
alter table public.action_items
  add column scheduled_calendar_event_id uuid null references public.calendar_events(id);
```

- [ ] **Step 2: Apply the migration**

This project has no linked Supabase MCP project (established in the prior sub-project) — apply it the same way: a one-off script using `backend/.venv/Scripts/python.exe` (bare `python` on this machine's PATH lacks `asyncpg`). Create a temporary file (e.g. `backend/apply_migration.py`, deleted after use — do not commit it):

```python
import asyncio
import pathlib

import asyncpg

from app.core.config import settings


async def main():
    sql = pathlib.Path("../supabase/migrations/20260718000000_action_items_scheduled_calendar_event_id.sql").read_text()
    conn = await asyncpg.connect(settings.database_url)
    try:
        await conn.execute(sql)
        row = await conn.fetchrow(
            "select is_nullable, column_default from information_schema.columns "
            "where table_name = 'action_items' and column_name = 'scheduled_calendar_event_id'"
        )
        print(dict(row))
    finally:
        await conn.close()


asyncio.run(main())
```

Run: `cd backend && .venv/Scripts/python.exe apply_migration.py`
Expected output: `{'is_nullable': 'YES', 'column_default': None}`. Then delete `backend/apply_migration.py`.

- [ ] **Step 3: Write failing repository tests**

Add to `backend/tests/test_action_items_repository.py`:

```python
@pytest.mark.asyncio
async def test_get_returns_item_joined_with_contact_and_schedule(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)

    row = await action_items.get(user_id, item_row["id"])

    assert row["text"] == "Call Gina"
    assert row["contact_id"] == contact_id
    assert row["contact_display_name"] == "Gina"
    assert row["contact_email_address"] == "gina@example.com"
    assert row["scheduled_calendar_event_id"] is None
    assert row["scheduled_start_time"] is None


@pytest.mark.asyncio
async def test_get_returns_none_for_missing_or_foreign_item(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=other_user_id, contact_id=None, text="Not yours", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    foreign_item = await pool.fetchrow("select id from public.action_items where user_id = $1", other_user_id)

    assert await action_items.get(user_id, uuid.uuid4()) is None
    assert await action_items.get(user_id, foreign_item["id"]) is None


@pytest.mark.asyncio
async def test_set_scheduled_calendar_event_id_returns_joined_row(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    calendar_events = CalendarEventsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)
    calendar_event_id = await calendar_events.upsert(
        user_id=user_id, graph_event_id="evt-new", subject="Call Gina", organizer=None,
        attendees=[], start_time=datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc),
        is_online_meeting=False, online_meeting_join_url=None, body_text=None,
    )

    updated = await action_items.set_scheduled_calendar_event_id(user_id, item_row["id"], calendar_event_id)

    assert updated["scheduled_calendar_event_id"] == calendar_event_id
    assert updated["scheduled_start_time"] == datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc)
    assert updated["contact_display_name"] == "Gina"


@pytest.mark.asyncio
async def test_set_scheduled_calendar_event_id_returns_none_for_foreign_item(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    action_items = ActionItemsRepository(pool)
    calendar_events = CalendarEventsRepository(pool)
    await action_items.insert(
        user_id=other_user_id, contact_id=None, text="Not yours", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    foreign_item = await pool.fetchrow("select id from public.action_items where user_id = $1", other_user_id)
    calendar_event_id = await calendar_events.upsert(
        user_id=other_user_id, graph_event_id="evt-x", subject=None, organizer=None,
        attendees=[], start_time=None, end_time=None,
        is_online_meeting=False, online_meeting_join_url=None, body_text=None,
    )

    result = await action_items.set_scheduled_calendar_event_id(user_id, foreign_item["id"], calendar_event_id)

    assert result is None
```

Add the necessary new imports to the top of `backend/tests/test_action_items_repository.py` if not already present: `from datetime import datetime, timezone`, `from app.repositories.calendar_events import CalendarEventsRepository`.

Add to `backend/tests/test_graph_sync_repositories.py` (where `CalendarEventsRepository` tests already live):

```python
@pytest.mark.asyncio
async def test_calendar_events_upsert_returns_row_id(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = CalendarEventsRepository(pool)

    event_id = await repo.upsert(
        user_id=user_id, graph_event_id="evt-return-id", subject="Test", organizer=None,
        attendees=[], start_time=None, end_time=None,
        is_online_meeting=False, online_meeting_join_url=None, body_text=None,
    )

    row = await pool.fetchrow("select id from public.calendar_events where user_id = $1 and graph_event_id = $2", user_id, "evt-return-id")
    assert event_id == row["id"]


@pytest.mark.asyncio
async def test_calendar_events_list_busy_between_excludes_events_outside_range(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = CalendarEventsRepository(pool)
    await repo.upsert(
        user_id=user_id, graph_event_id="evt-in-range", subject="In range", organizer=None,
        attendees=[], start_time=datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc),
        is_online_meeting=False, online_meeting_join_url=None, body_text=None,
    )
    await repo.upsert(
        user_id=user_id, graph_event_id="evt-out-of-range", subject="Out of range", organizer=None,
        attendees=[], start_time=datetime(2026, 8, 1, 14, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 8, 1, 14, 30, tzinfo=timezone.utc),
        is_online_meeting=False, online_meeting_join_url=None, body_text=None,
    )

    busy = await repo.list_busy_between(
        user_id, datetime(2026, 7, 19, tzinfo=timezone.utc), datetime(2026, 7, 21, tzinfo=timezone.utc)
    )

    assert len(busy) == 1
    assert busy[0]["start_time"] == datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc)
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_action_items_repository.py tests/test_graph_sync_repositories.py -v`
Expected: FAIL — `get`/`set_scheduled_calendar_event_id`/`list_busy_between` don't exist yet; `upsert` doesn't accept `conn` and returns `None`.

- [ ] **Step 5: Implement the repository changes**

In `backend/app/repositories/action_items.py`, add two new methods (place them near `update_status`, which they resemble):

```python
    async def get(self, user_id: uuid.UUID, item_id: uuid.UUID) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            """
            select ai.*,
                   c.display_name as contact_display_name,
                   c.email_address as contact_email_address,
                   ce.start_time as scheduled_start_time
            from public.action_items ai
            left join public.contacts c on c.id = ai.contact_id
            left join public.calendar_events ce on ce.id = ai.scheduled_calendar_event_id
            where ai.id = $1 and ai.user_id = $2
            """,
            item_id,
            user_id,
        )

    async def set_scheduled_calendar_event_id(
        self,
        user_id: uuid.UUID,
        item_id: uuid.UUID,
        calendar_event_id: uuid.UUID,
        conn: asyncpg.Connection | None = None,
    ) -> asyncpg.Record | None:
        executor = conn or self._pool
        return await executor.fetchrow(
            """
            with updated as (
                update public.action_items
                set scheduled_calendar_event_id = $3
                where id = $1 and user_id = $2
                returning *
            )
            select updated.*,
                   c.display_name as contact_display_name,
                   c.email_address as contact_email_address,
                   ce.start_time as scheduled_start_time
            from updated
            left join public.contacts c on c.id = updated.contact_id
            left join public.calendar_events ce on ce.id = updated.scheduled_calendar_event_id
            """,
            item_id,
            user_id,
            calendar_event_id,
        )
```

Also update `list_for_user` and `list_for_contact` in the same file to expose `scheduled_start_time` (the new `scheduled_calendar_event_id` column is already included automatically via `ai.*`/`select *`):

Replace `list_for_user`'s query with:

```python
    async def list_for_user(
        self,
        user_id: uuid.UUID,
        direction: str | None = None,
        include_done: bool = False,
    ) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select ai.*,
                   c.display_name as contact_display_name,
                   c.email_address as contact_email_address,
                   ce.start_time as scheduled_start_time
            from public.action_items ai
            left join public.contacts c on c.id = ai.contact_id
            left join public.calendar_events ce on ce.id = ai.scheduled_calendar_event_id
            where ai.user_id = $1
              and ($2::text is null or ai.direction = $2)
              and ($3::boolean or ai.status = 'open')
            order by ai.due_date asc nulls last, ai.created_at asc
            """,
            user_id,
            direction,
            include_done,
        )
```

Replace `list_for_contact`'s query with:

```python
    async def list_for_contact(
        self, user_id: uuid.UUID, contact_id: uuid.UUID
    ) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select ai.*, ce.start_time as scheduled_start_time
            from public.action_items ai
            left join public.calendar_events ce on ce.id = ai.scheduled_calendar_event_id
            where ai.user_id = $1 and ai.contact_id = $2
            order by ai.created_at desc
            """,
            user_id,
            contact_id,
        )
```

In `backend/app/repositories/calendar_events.py`, replace the `upsert` method with:

```python
    async def upsert(
        self,
        user_id: uuid.UUID,
        graph_event_id: str,
        subject: str | None,
        organizer: str | None,
        attendees: list[dict],
        start_time: datetime | None,
        end_time: datetime | None,
        is_online_meeting: bool,
        online_meeting_join_url: str | None,
        body_text: str | None,
        conn: asyncpg.Connection | None = None,
    ) -> uuid.UUID:
        executor = conn or self._pool
        row = await executor.fetchrow(
            """
            insert into public.calendar_events
                (user_id, graph_event_id, subject, organizer, attendees,
                 start_time, end_time, is_online_meeting, online_meeting_join_url,
                 body_text, synced_at)
            values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, now())
            on conflict (user_id, graph_event_id) do update
            set subject = excluded.subject,
                organizer = excluded.organizer,
                attendees = excluded.attendees,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                is_online_meeting = excluded.is_online_meeting,
                online_meeting_join_url = excluded.online_meeting_join_url,
                body_text = excluded.body_text,
                synced_at = now()
            returning id
            """,
            user_id,
            graph_event_id,
            subject,
            organizer,
            json.dumps(attendees),
            start_time,
            end_time,
            is_online_meeting,
            online_meeting_join_url,
            body_text,
        )
        return row["id"]
```

Add a new method to the same class:

```python
    async def list_busy_between(
        self, user_id: uuid.UUID, start: datetime, end: datetime
    ) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select start_time, end_time from public.calendar_events
            where user_id = $1
              and start_time is not null and end_time is not null
              and start_time < $3 and end_time > $2
            """,
            user_id,
            start,
            end,
        )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_action_items_repository.py tests/test_graph_sync_repositories.py -v`
Expected: PASS (all new tests; existing tests in both files still pass unchanged).

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260718000000_action_items_scheduled_calendar_event_id.sql backend/app/repositories/action_items.py backend/app/repositories/calendar_events.py backend/tests/test_action_items_repository.py backend/tests/test_graph_sync_repositories.py
git commit -m "feat: add action_items.scheduled_calendar_event_id and supporting repository methods"
```

---

### Task 3: Expose scheduled fields on existing read endpoints

**Files:**
- Modify: `backend/app/api/v1/action_items.py`
- Modify: `backend/app/api/v1/contacts.py`
- Test: `backend/tests/test_action_items_endpoint.py`
- Test: `backend/tests/test_contacts_endpoint.py`

**Interfaces:**
- Consumes: `ActionItemsRepository.list_for_user`/`list_for_contact` (Task 2, now returning `scheduled_start_time`).
- Produces: `GET /api/action-items` and `GET /api/contacts/{id}/action-items` responses now include `scheduled_calendar_event_id` and `scheduled_start_time` on every item. Tasks 8-9 (frontend) consume these two fields directly.

- [ ] **Step 1: Write failing endpoint tests**

Add to `backend/tests/test_action_items_endpoint.py`:

```python
@pytest.mark.asyncio
async def test_list_action_items_includes_scheduled_fields(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    calendar_events = CalendarEventsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)
    calendar_event_id = await calendar_events.upsert(
        user_id=user_id, graph_event_id="evt-1", subject="Call Gina", organizer=None,
        attendees=[], start_time=datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc),
        is_online_meeting=False, online_meeting_join_url=None, body_text=None,
    )
    await action_items.set_scheduled_calendar_event_id(user_id, item_row["id"], calendar_event_id)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/action-items")

        body = response.json()
        assert body[0]["scheduled_calendar_event_id"] == str(calendar_event_id)
        assert body[0]["scheduled_start_time"] == "2026-07-20T14:00:00+00:00"
    finally:
        app.dependency_overrides.clear()
```

Add the necessary imports at the top of `backend/tests/test_action_items_endpoint.py` if not already present: `from datetime import datetime, timezone`, `from app.repositories.calendar_events import CalendarEventsRepository`.

Add to `backend/tests/test_contacts_endpoint.py`:

```python
@pytest.mark.asyncio
async def test_list_contact_action_items_includes_scheduled_fields(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    calendar_events = CalendarEventsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)
    calendar_event_id = await calendar_events.upsert(
        user_id=user_id, graph_event_id="evt-2", subject="Call Gina", organizer=None,
        attendees=[], start_time=datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc),
        is_online_meeting=False, online_meeting_join_url=None, body_text=None,
    )
    await action_items.set_scheduled_calendar_event_id(user_id, item_row["id"], calendar_event_id)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/contacts/{contact_id}/action-items")

        body = response.json()
        assert body[0]["scheduled_calendar_event_id"] == str(calendar_event_id)
        assert body[0]["scheduled_start_time"] == "2026-07-20T14:00:00+00:00"
    finally:
        app.dependency_overrides.clear()
```

Add the necessary imports at the top of `backend/tests/test_contacts_endpoint.py` if not already present: `from datetime import datetime, timezone`, `from app.repositories.calendar_events import CalendarEventsRepository`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_action_items_endpoint.py tests/test_contacts_endpoint.py -v`
Expected: FAIL — the two new assertions find `KeyError` (fields not in the response yet).

- [ ] **Step 3: Update the serializers**

In `backend/app/api/v1/action_items.py`, replace the `_serialize` function with:

```python
def _serialize(row) -> dict:
    contact = None
    if row["contact_id"] is not None:
        contact = {
            "id": row["contact_id"],
            "display_name": row["contact_display_name"],
            "email_address": row["contact_email_address"],
        }
    return {
        "id": row["id"],
        "text": row["text"],
        "direction": row["direction"],
        "status": row["status"],
        "due_date": row["due_date"],
        "contact": contact,
        "scheduled_calendar_event_id": row["scheduled_calendar_event_id"],
        "scheduled_start_time": row["scheduled_start_time"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
```

(`_serialize_plain`, used only by the existing `PATCH /api/action-items/{id}`, is untouched — that endpoint's response shape is out of scope for this sub-project.)

In `backend/app/api/v1/contacts.py`, replace the `_action_item` function with:

```python
def _action_item(row) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "direction": row["direction"],
        "status": row["status"],
        "due_date": row["due_date"],
        "source_type": row["source_type"],
        "scheduled_calendar_event_id": row["scheduled_calendar_event_id"],
        "scheduled_start_time": row["scheduled_start_time"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_action_items_endpoint.py tests/test_contacts_endpoint.py -v`
Expected: PASS (all tests in both files, including every pre-existing one — adding fields to a dict response doesn't break tests that only assert specific keys).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v1/action_items.py backend/app/api/v1/contacts.py backend/tests/test_action_items_endpoint.py backend/tests/test_contacts_endpoint.py
git commit -m "feat: expose scheduled_calendar_event_id and scheduled_start_time on action-item read endpoints"
```

---

### Task 4: Graph calendar-event creation client function

**Files:**
- Modify: `backend/app/services/graph_client.py`
- Test: `backend/tests/test_graph_client.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `create_calendar_event(access_token: str, payload: dict) -> dict` in `app.services.graph_client`. Task 6 consumes this.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_graph_client.py`:

```python
@pytest.mark.asyncio
@respx.mock
async def test_create_calendar_event_posts_payload_and_returns_json():
    route = respx.post("https://graph.microsoft.com/v1.0/me/events").mock(
        return_value=Response(201, json={"id": "graph-evt-1", "subject": "Call Gina"})
    )

    result = await create_calendar_event("access-token", {"subject": "Call Gina"})

    assert result == {"id": "graph-evt-1", "subject": "Call Gina"}
    assert route.calls.last.request.headers["Authorization"] == "Bearer access-token"
    assert json.loads(route.calls.last.request.content) == {"subject": "Call Gina"}


@pytest.mark.asyncio
@respx.mock
async def test_create_calendar_event_raises_on_error_status():
    respx.post("https://graph.microsoft.com/v1.0/me/events").mock(return_value=Response(403))

    with pytest.raises(httpx.HTTPStatusError):
        await create_calendar_event("access-token", {"subject": "Call Gina"})
```

Add the necessary imports at the top of `backend/tests/test_graph_client.py` if not already present: `import json`, `import httpx`, and add `create_calendar_event` to the existing `from app.services.graph_client import ...` line.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_graph_client.py -v`
Expected: FAIL — `ImportError: cannot import name 'create_calendar_event'`.

- [ ] **Step 3: Implement the function**

In `backend/app/services/graph_client.py`, add (near `get_me`, which it resembles):

```python
async def create_calendar_event(access_token: str, payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{GRAPH_BASE_URL}/me/events",
            headers={"Authorization": f"Bearer {access_token}"},
            json=payload,
        )
    response.raise_for_status()
    return response.json()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_graph_client.py -v`
Expected: PASS (2 new tests, plus all existing tests in the file still passing).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/graph_client.py backend/tests/test_graph_client.py
git commit -m "feat: add Graph create_calendar_event client function"
```

---

### Task 5: Slot-suggestion algorithm

**Files:**
- Create: `backend/app/services/scheduling.py`
- Modify: `backend/requirements.txt`
- Test: `backend/tests/test_scheduling_service.py`

**Interfaces:**
- Consumes: nothing new (pure function — no DB, no Graph).
- Produces: `suggest_slots(now_utc: datetime, timezone_name: str | None, busy: list[tuple[datetime, datetime]]) -> list[dict]` (each dict: `{"start": datetime, "end": datetime}`, both UTC-aware) in `app.services.scheduling`, plus module constants `SLOT_MINUTES`, `LOOKAHEAD_DAYS`, `WORK_START_HOUR`, `WORK_END_HOUR`, `MAX_SUGGESTIONS`. Task 7 (router) consumes this function and its constants.

- [ ] **Step 1: Add the `tzdata` dependency**

Add `tzdata` on its own line to `backend/requirements.txt` (any position is fine; match the file's existing style — one package per line, no pinned version unless the file already pins others, in which case match that style). Then install it:

Run: `cd backend && .venv/Scripts/python.exe -m pip install tzdata`

This is required because `zoneinfo.ZoneInfo("America/New_York")` (or any non-UTC IANA zone) raises `ZoneInfoNotFoundError` on this Windows dev machine without it — verified directly before writing this plan. `ZoneInfo("UTC")` works without `tzdata` since it's a special-cased no-op zone, but any real IANA zone name needs the package.

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_scheduling_service.py`:

```python
from datetime import datetime, timezone

from app.services.scheduling import MAX_SUGGESTIONS, suggest_slots


def test_suggest_slots_empty_calendar_starts_at_current_time_and_caps_at_max():
    now_utc = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)  # Monday 1pm UTC

    slots = suggest_slots(now_utc, None, [])

    assert len(slots) == MAX_SUGGESTIONS
    assert slots[0]["start"] == datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)
    assert slots[0]["end"] == datetime(2026, 7, 20, 13, 30, tzinfo=timezone.utc)
    assert slots[7]["start"] == datetime(2026, 7, 20, 16, 30, tzinfo=timezone.utc)
    assert slots[8]["start"] == datetime(2026, 7, 21, 9, 0, tzinfo=timezone.utc)


def test_suggest_slots_excludes_busy_interval():
    now_utc = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)
    busy = [(datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc), datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc))]

    slots = suggest_slots(now_utc, None, busy)

    starts = [s["start"] for s in slots]
    assert datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc) not in starts
    assert len(slots) == MAX_SUGGESTIONS


def test_suggest_slots_skips_weekend():
    now_utc = datetime(2026, 7, 17, 16, 45, tzinfo=timezone.utc)  # Friday 4:45pm UTC, past the last slot

    slots = suggest_slots(now_utc, None, [])

    assert slots[0]["start"] == datetime(2026, 7, 20, 9, 0, tzinfo=timezone.utc)  # Monday, not Sat/Sun


def test_suggest_slots_respects_timezone():
    now_utc = datetime(2026, 7, 20, 10, 0, tzinfo=timezone.utc)  # 6am EDT, before the 9am local work window

    slots = suggest_slots(now_utc, "America/New_York", [])

    assert slots[0]["start"] == datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)  # 9am EDT == 1pm UTC


def test_suggest_slots_defaults_to_utc_when_timezone_name_is_none():
    now_utc = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)

    with_none = suggest_slots(now_utc, None, [])
    with_utc = suggest_slots(now_utc, "UTC", [])

    assert with_none == with_utc
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_scheduling_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.scheduling'`.

- [ ] **Step 4: Implement `suggest_slots`**

Create `backend/app/services/scheduling.py`:

```python
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

SLOT_MINUTES = 30
LOOKAHEAD_DAYS = 14
WORK_START_HOUR = 9
WORK_END_HOUR = 17
MAX_SUGGESTIONS = 10


def suggest_slots(
    now_utc: datetime,
    timezone_name: str | None,
    busy: list[tuple[datetime, datetime]],
) -> list[dict]:
    tz = ZoneInfo(timezone_name) if timezone_name else ZoneInfo("UTC")
    local_now = now_utc.astimezone(tz)

    slots: list[dict] = []
    for day_offset in range(LOOKAHEAD_DAYS):
        current_date = (local_now + timedelta(days=day_offset)).date()
        if current_date.weekday() >= 5:
            continue

        slot_start = datetime.combine(current_date, time(WORK_START_HOUR, 0), tzinfo=tz)
        day_end = datetime.combine(current_date, time(WORK_END_HOUR, 0), tzinfo=tz)

        while slot_start + timedelta(minutes=SLOT_MINUTES) <= day_end:
            slot_end = slot_start + timedelta(minutes=SLOT_MINUTES)
            if slot_start >= local_now and not _overlaps_any(slot_start, slot_end, busy):
                slots.append({
                    "start": slot_start.astimezone(timezone.utc),
                    "end": slot_end.astimezone(timezone.utc),
                })
                if len(slots) >= MAX_SUGGESTIONS:
                    return slots
            slot_start += timedelta(minutes=SLOT_MINUTES)

    return slots


def _overlaps_any(
    start: datetime, end: datetime, busy: list[tuple[datetime, datetime]]
) -> bool:
    return any(start < busy_end and end > busy_start for busy_start, busy_end in busy)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_scheduling_service.py -v`
Expected: PASS (5/5). These exact expected values were verified by running this algorithm directly before writing this plan — if any assertion fails, the bug is in the implementation transcription, not the expected values.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/scheduling.py backend/requirements.txt backend/tests/test_scheduling_service.py
git commit -m "feat: add suggest_slots free/busy computation"
```

---

### Task 6: Meeting-creation orchestration

**Files:**
- Modify: `backend/app/services/scheduling.py`
- Test: `backend/tests/test_scheduling_service.py`

**Interfaces:**
- Consumes: `get_valid_access_token`/`refresh_and_persist` (Task 1), `ActionItemsRepository.set_scheduled_calendar_event_id` (Task 2), `CalendarEventsRepository.upsert` (Task 2), `graph_client.create_calendar_event` (Task 4).
- Produces: `create_meeting(pool, user_id, item_id, item_text, start, end, online_meeting, contact_email, contact_display_name) -> asyncpg.Record | None` in `app.services.scheduling`. Task 7 (router) consumes this.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_scheduling_service.py`:

```python
import uuid
from unittest.mock import patch

import httpx
import pytest
import respx
from httpx import Response

from app.core.security import encrypt_token
from app.repositories.action_items import ActionItemsRepository
from app.repositories.calendar_events import CalendarEventsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.scheduling import create_meeting


async def _seed_item_and_token(pool, user_id, email, contact_email=None):
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("valid-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Calendars.ReadWrite"],
    )
    contact_id = None
    if contact_email:
        contact_id = await ContactsRepository(pool).upsert_by_email(user_id, contact_email, "Gina", None)
    await ActionItemsRepository(pool).insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)
    return item_row["id"]


@pytest.mark.asyncio
@respx.mock
async def test_create_meeting_invites_attendee_when_email_known(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_item_and_token(pool, user_id, email, contact_email="gina@example.com")
    route = respx.post("https://graph.microsoft.com/v1.0/me/events").mock(
        return_value=Response(201, json={
            "id": "graph-evt-1", "subject": "Call Gina", "organizer": None, "attendees": [],
            "isOnlineMeeting": True, "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/x"},
        })
    )
    start = datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc)
    end = datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc)

    result = await create_meeting(
        pool, user_id, item_id, item_text="Call Gina", start=start, end=end,
        online_meeting=True, contact_email="gina@example.com", contact_display_name="Gina",
    )

    assert result["scheduled_calendar_event_id"] is not None
    sent_body = json.loads(route.calls.last.request.content)
    assert sent_body["attendees"] == [{"emailAddress": {"address": "gina@example.com", "name": "Gina"}, "type": "required"}]
    assert sent_body["isOnlineMeeting"] is True
    assert sent_body["onlineMeetingProvider"] == "teamsForBusiness"
    row = await pool.fetchrow(
        "select * from public.calendar_events where user_id = $1 and graph_event_id = $2", user_id, "graph-evt-1"
    )
    assert row["online_meeting_join_url"] == "https://teams.microsoft.com/l/x"


@pytest.mark.asyncio
@respx.mock
async def test_create_meeting_no_attendee_when_email_unknown(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_item_and_token(pool, user_id, email, contact_email=None)
    route = respx.post("https://graph.microsoft.com/v1.0/me/events").mock(
        return_value=Response(201, json={"id": "graph-evt-2", "subject": "Call Gina", "isOnlineMeeting": False})
    )
    start = datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc)
    end = datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc)

    await create_meeting(
        pool, user_id, item_id, item_text="Call Gina", start=start, end=end,
        online_meeting=False, contact_email=None, contact_display_name=None,
    )

    sent_body = json.loads(route.calls.last.request.content)
    assert "attendees" not in sent_body
    assert sent_body["isOnlineMeeting"] is False
    assert "onlineMeetingProvider" not in sent_body


@pytest.mark.asyncio
async def test_create_meeting_returns_none_when_no_graph_connection(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contact_id = await ContactsRepository(pool).upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await ActionItemsRepository(pool).insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)
    start = datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc)
    end = datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc)

    result = await create_meeting(
        pool, user_id, item_row["id"], item_text="Call Gina", start=start, end=end,
        online_meeting=False, contact_email="gina@example.com", contact_display_name="Gina",
    )

    assert result is None


@pytest.mark.asyncio
@respx.mock
async def test_create_meeting_retries_once_on_401(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_item_and_token(pool, user_id, email, contact_email="gina@example.com")
    route = respx.post("https://graph.microsoft.com/v1.0/me/events")
    route.side_effect = [
        Response(401),
        Response(201, json={"id": "graph-evt-3", "subject": "Call Gina", "isOnlineMeeting": False}),
    ]
    refreshed = {
        "access_token": "refreshed-access",
        "refresh_token": "refreshed-refresh",
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    start = datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc)
    end = datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc)

    with patch("app.services.graph_tokens_service.refresh_access_token", return_value=refreshed):
        result = await create_meeting(
            pool, user_id, item_id, item_text="Call Gina", start=start, end=end,
            online_meeting=False, contact_email="gina@example.com", contact_display_name="Gina",
        )

    assert result["scheduled_calendar_event_id"] is not None
    assert route.call_count == 2
```

Add `import json` and `from datetime import timedelta` alongside the existing `from datetime import datetime, timezone` at the top of the file if not already present (the top-level test functions from Task 5 only need `datetime, timezone`; these new ones need `timedelta` too — consolidate into one import line).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_scheduling_service.py -v`
Expected: FAIL — `ImportError: cannot import name 'create_meeting'`.

- [ ] **Step 3: Implement `create_meeting`**

Append to `backend/app/services/scheduling.py` (add these imports to the top of the file, alongside the existing `datetime`/`zoneinfo` imports):

```python
import uuid

import asyncpg
import httpx

from app.repositories.action_items import ActionItemsRepository
from app.repositories.calendar_events import CalendarEventsRepository
from app.services import graph_client
from app.services.graph_tokens_service import get_valid_access_token, refresh_and_persist
```

Then add the function itself:

```python
def _graph_datetime(dt: datetime) -> dict:
    naive_utc = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return {"dateTime": naive_utc.isoformat(), "timeZone": "UTC"}


async def create_meeting(
    pool: asyncpg.Pool,
    user_id: uuid.UUID,
    item_id: uuid.UUID,
    item_text: str,
    start: datetime,
    end: datetime,
    online_meeting: bool,
    contact_email: str | None,
    contact_display_name: str | None,
) -> asyncpg.Record | None:
    access_token = await get_valid_access_token(pool, user_id)
    if access_token is None:
        return None

    payload: dict = {
        "subject": item_text,
        "start": _graph_datetime(start),
        "end": _graph_datetime(end),
        "isOnlineMeeting": online_meeting,
    }
    if online_meeting:
        payload["onlineMeetingProvider"] = "teamsForBusiness"
    if contact_email:
        payload["attendees"] = [{
            "emailAddress": {"address": contact_email, "name": contact_display_name or contact_email},
            "type": "required",
        }]

    try:
        graph_event = await graph_client.create_calendar_event(access_token, payload)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 401:
            access_token = await refresh_and_persist(pool, user_id)
            if access_token is None:
                return None
            graph_event = await graph_client.create_calendar_event(access_token, payload)
        else:
            raise

    online_meeting_info = graph_event.get("onlineMeeting") or {}
    async with pool.acquire() as conn:
        async with conn.transaction():
            calendar_event_id = await CalendarEventsRepository(pool).upsert(
                user_id=user_id,
                graph_event_id=graph_event["id"],
                subject=graph_event.get("subject"),
                organizer=((graph_event.get("organizer") or {}).get("emailAddress") or {}).get("address"),
                attendees=[(a.get("emailAddress") or {}) for a in graph_event.get("attendees", [])],
                start_time=start,
                end_time=end,
                is_online_meeting=graph_event.get("isOnlineMeeting", False),
                online_meeting_join_url=online_meeting_info.get("joinUrl"),
                body_text=None,
                conn=conn,
            )
            updated_item = await ActionItemsRepository(pool).set_scheduled_calendar_event_id(
                user_id, item_id, calendar_event_id, conn=conn,
            )

    return updated_item
```

Note the `create_calendar_event`/DB-write ordering: the Graph call (and its 401-retry) completes entirely before `pool.acquire()` is ever called — no database connection is held open across the external HTTP call, matching the Global Constraints guarantee.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_scheduling_service.py -v`
Expected: PASS (all tests in the file — the 5 from Task 5 plus the 4 new ones here).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/scheduling.py backend/tests/test_scheduling_service.py
git commit -m "feat: add create_meeting orchestration for AI Scheduler"
```

---

### Task 7: Scheduling router

**Files:**
- Create: `backend/app/api/v1/scheduling.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_scheduling_endpoint.py`

**Interfaces:**
- Consumes: `ActionItemsRepository.get` (Task 2), `ProfilesRepository.get` (existing), `CalendarEventsRepository.list_busy_between` (Task 2), `scheduling.suggest_slots`/`scheduling.create_meeting` (Tasks 5-6).
- Produces: `router` (prefix `/api/action-items`, mounted alongside the existing `action_items.router` on the same prefix). Routes: `GET /api/action-items/{item_id}/schedule-suggestions`, `POST /api/action-items/{item_id}/schedule`. Nothing later consumes this (last backend task).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_scheduling_endpoint.py`:

```python
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

from app.core.deps import CurrentUser, get_current_user
from app.core.security import encrypt_token
from app.main import app
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository

GRAPH_EVENTS_URL = "https://graph.microsoft.com/v1.0/me/events"


def _override_auth(user_id, email):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)


async def _seed_connected_user_with_item(pool, user_id, email, with_contact=True):
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("valid-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Calendars.ReadWrite"],
    )
    contact_id = None
    if with_contact:
        contact_id = await ContactsRepository(pool).upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await ActionItemsRepository(pool).insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)
    return item_row["id"]


@pytest.mark.asyncio
async def test_schedule_suggestions_returns_slots(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_connected_user_with_item(pool, user_id, email)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/action-items/{item_id}/schedule-suggestions")

        assert response.status_code == 200
        assert len(response.json()) > 0
        assert "start" in response.json()[0]
        assert "end" in response.json()[0]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_schedule_suggestions_404_when_no_contact(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_connected_user_with_item(pool, user_id, email, with_contact=False)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/action-items/{item_id}/schedule-suggestions")

        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_schedule_suggestions_404_for_foreign_item(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    other_item_id = await _seed_connected_user_with_item(pool, other_user_id, other_email)
    await ProfilesRepository(pool).upsert(user_id, email)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/action-items/{other_item_id}/schedule-suggestions")

        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
@respx.mock
async def test_schedule_creates_meeting_end_to_end(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_connected_user_with_item(pool, user_id, email)
    respx.post(GRAPH_EVENTS_URL).mock(
        return_value=Response(201, json={
            "id": "graph-evt-e2e", "subject": "Call Gina",
            "attendees": [{"emailAddress": {"address": "gina@example.com", "name": "Gina"}}],
            "isOnlineMeeting": True, "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/e2e"},
        })
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/action-items/{item_id}/schedule",
                json={
                    "start": "2026-07-20T14:00:00Z",
                    "end": "2026-07-20T14:30:00Z",
                    "online_meeting": True,
                },
            )

        assert response.status_code == 200
        body = response.json()
        assert body["scheduled_calendar_event_id"] is not None
        assert body["scheduled_start_time"] == "2026-07-20T14:00:00+00:00"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
@respx.mock
async def test_schedule_409_when_already_scheduled(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_connected_user_with_item(pool, user_id, email)
    respx.post(GRAPH_EVENTS_URL).mock(
        return_value=Response(201, json={"id": "graph-evt-dupe", "subject": "Call Gina", "isOnlineMeeting": False})
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            first = await client.post(
                f"/api/action-items/{item_id}/schedule",
                json={"start": "2026-07-20T14:00:00Z", "end": "2026-07-20T14:30:00Z", "online_meeting": False},
            )
            assert first.status_code == 200

            second = await client.post(
                f"/api/action-items/{item_id}/schedule",
                json={"start": "2026-07-21T14:00:00Z", "end": "2026-07-21T14:30:00Z", "online_meeting": False},
            )

        assert second.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_schedule_409_when_needs_reauth(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contact_id = await ContactsRepository(pool).upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await ActionItemsRepository(pool).insert(
        user_id=user_id, contact_id=contact_id, text="Call Gina", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow("select id from public.action_items where user_id = $1", user_id)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/action-items/{item_row['id']}/schedule",
                json={"start": "2026-07-20T14:00:00Z", "end": "2026-07-20T14:30:00Z", "online_meeting": False},
            )

        assert response.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_schedule_rejects_malformed_body(pool, test_auth_user):
    user_id, email = test_auth_user
    item_id = await _seed_connected_user_with_item(pool, user_id, email)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/action-items/{item_id}/schedule",
                json={"start": "not-a-date", "end": "2026-07-20T14:30:00Z", "online_meeting": False},
            )

        assert response.status_code == 422
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_scheduling_endpoint.py -v`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Implement the router**

Create `backend/app/api/v1/scheduling.py`:

```python
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository
from app.repositories.calendar_events import CalendarEventsRepository
from app.repositories.profiles import ProfilesRepository
from app.services import scheduling

router = APIRouter(prefix="/api/action-items", tags=["scheduling"])


class ScheduleActionItem(BaseModel):
    start: datetime
    end: datetime
    online_meeting: bool


def _serialize(row) -> dict:
    contact = None
    if row["contact_id"] is not None:
        contact = {
            "id": row["contact_id"],
            "display_name": row["contact_display_name"],
            "email_address": row["contact_email_address"],
        }
    return {
        "id": row["id"],
        "text": row["text"],
        "direction": row["direction"],
        "status": row["status"],
        "due_date": row["due_date"],
        "contact": contact,
        "scheduled_calendar_event_id": row["scheduled_calendar_event_id"],
        "scheduled_start_time": row["scheduled_start_time"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def _get_schedulable_item(pool, user_id: uuid.UUID, item_id: uuid.UUID):
    item = await ActionItemsRepository(pool).get(user_id, item_id)
    if item is None or item["contact_id"] is None:
        raise HTTPException(status_code=404, detail="Action item not found")
    if item["scheduled_calendar_event_id"] is not None:
        raise HTTPException(status_code=409, detail="Action item is already scheduled")
    return item


@router.get("/{item_id}/schedule-suggestions")
async def get_schedule_suggestions(
    item_id: uuid.UUID, current_user: CurrentUser = Depends(get_current_user)
):
    pool = await get_pool()
    await _get_schedulable_item(pool, current_user.user_id, item_id)

    profile = await ProfilesRepository(pool).get(current_user.user_id)
    timezone_name = profile["timezone"] if profile else None

    now_utc = datetime.now(timezone.utc)
    busy_rows = await CalendarEventsRepository(pool).list_busy_between(
        current_user.user_id, now_utc, now_utc + timedelta(days=scheduling.LOOKAHEAD_DAYS)
    )
    busy = [(row["start_time"], row["end_time"]) for row in busy_rows]

    return scheduling.suggest_slots(now_utc, timezone_name, busy)


@router.post("/{item_id}/schedule")
async def schedule_action_item(
    item_id: uuid.UUID,
    body: ScheduleActionItem,
    current_user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    item = await _get_schedulable_item(pool, current_user.user_id, item_id)

    try:
        updated = await scheduling.create_meeting(
            pool,
            current_user.user_id,
            item_id,
            item_text=item["text"],
            start=body.start,
            end=body.end,
            online_meeting=body.online_meeting,
            contact_email=item["contact_email_address"],
            contact_display_name=item["contact_display_name"],
        )
    except httpx.HTTPStatusError:
        raise HTTPException(status_code=502, detail="Failed to create the meeting. Please try again.")

    if updated is None:
        raise HTTPException(status_code=409, detail="Microsoft account needs to be reconnected")

    return _serialize(updated)
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, change the import to:

```python
from app.api.v1 import action_items, auth, contacts, dashboard, extraction, me, scheduling, sync
```

Add, after `app.include_router(me.router)`:

```python
app.include_router(scheduling.router)
```

(full ordering: `action_items`, `auth`, `contacts`, `dashboard`, `me`, `scheduling`, `sync`, `extraction`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_scheduling_endpoint.py -v`
Expected: PASS (7/7)

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions. This is the last backend task — record the final pass count for the whole-branch review later.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v1/scheduling.py backend/app/main.py backend/tests/test_scheduling_endpoint.py
git commit -m "feat: add GET schedule-suggestions and POST schedule endpoints"
```

---

### Task 8: Shared scheduling panel component + Planner integration

**Files:**
- Create: `frontend/app/components/ScheduleActionItemPanel.tsx`
- Create: `frontend/app/components/ScheduleActionItemPanel.test.tsx`
- Modify: `frontend/app/planner/page.tsx`
- Modify: `frontend/app/planner/page.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (`frontend/lib/api.ts`), `GET /api/action-items/{id}/schedule-suggestions` and `POST /api/action-items/{id}/schedule` (Task 7).
- Produces: `ScheduleActionItemPanel` React component, default export from `frontend/app/components/ScheduleActionItemPanel.tsx`, props `{ itemId: string, scheduledCalendarEventId: string | null, scheduledStartTime: string | null, contact: { id: string; display_name: string | null; email_address: string | null } | null, onScheduled: () => void }`. Task 9 (contact-profile page) imports and reuses this same component.

- [ ] **Step 1: Write the failing component test**

Create `frontend/app/components/ScheduleActionItemPanel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import ScheduleActionItemPanel from './ScheduleActionItemPanel'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const CONTACT = { id: 'c1', display_name: 'Gina', email_address: 'gina@example.com' }

describe('ScheduleActionItemPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('renders nothing when there is no linked contact', () => {
    const { container } = render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={null} onScheduled={vi.fn()}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('shows a scheduled indicator instead of a button when already scheduled', () => {
    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId="evt-1" scheduledStartTime="2026-07-20T14:00:00Z"
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )

    expect(screen.getByText(/scheduled/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /schedule/i })).not.toBeInTheDocument()
  })

  it('fetches and shows suggested slots when Schedule is clicked', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }])
    )

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items/item-1/schedule-suggestions'))
    expect(await screen.findByRole('button', { name: /2026/i })).toBeInTheDocument()
  })

  it('confirms a slot and calls onScheduled on success', async () => {
    const onScheduled = vi.fn()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ status: 'ok' }))
      return Promise.resolve(jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }]))
    })

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={onScheduled}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))
    const slotButton = await screen.findByRole('button', { name: /2026/i })
    fireEvent.click(slotButton)

    await waitFor(() => expect(onScheduled).toHaveBeenCalled())
    expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items/item-1/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z', online_meeting: true }),
    })
  })

  it('shows an inline error and keeps the panel open when confirming fails', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response(null, { status: 502 }))
      return Promise.resolve(jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }]))
    })

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))
    const slotButton = await screen.findByRole('button', { name: /2026/i })
    fireEvent.click(slotButton)

    await waitFor(() => expect(screen.getByText(/could not schedule/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /2026/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/components/ScheduleActionItemPanel.test.tsx`
Expected: FAIL — `Cannot find module './ScheduleActionItemPanel'`.

- [ ] **Step 3: Implement the component**

Create `frontend/app/components/ScheduleActionItemPanel.tsx`:

```tsx
'use client'

import { useState } from 'react'

import { apiFetch } from '@/lib/api'

type Contact = { id: string; display_name: string | null; email_address: string | null }
type Slot = { start: string; end: string }

type ScheduleActionItemPanelProps = {
  itemId: string
  scheduledCalendarEventId: string | null
  scheduledStartTime: string | null
  contact: Contact | null
  onScheduled: () => void
}

export default function ScheduleActionItemPanel({
  itemId,
  scheduledCalendarEventId,
  scheduledStartTime,
  contact,
  onScheduled,
}: ScheduleActionItemPanelProps) {
  const [open, setOpen] = useState(false)
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [onlineMeeting, setOnlineMeeting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  if (!contact) return null

  if (scheduledCalendarEventId) {
    return (
      <span className="ml-2 text-gray-600">
        Scheduled: {scheduledStartTime ? new Date(scheduledStartTime).toLocaleString() : 'yes'}
      </span>
    )
  }

  async function openPanel() {
    setOpen(true)
    setError(null)
    setSlots(null)
    const response = await apiFetch(`/api/action-items/${itemId}/schedule-suggestions`)
    if (!response.ok) {
      setError('Could not load suggested times. Please try again.')
      return
    }
    setSlots(await response.json())
  }

  async function confirm(slot: Slot) {
    setError(null)
    const response = await apiFetch(`/api/action-items/${itemId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: slot.start, end: slot.end, online_meeting: onlineMeeting }),
    })
    if (!response.ok) {
      setError('Could not schedule that meeting. Please try again.')
      return
    }
    setOpen(false)
    onScheduled()
  }

  if (!open) {
    return (
      <button onClick={openPanel} className="ml-2 underline">
        Schedule
      </button>
    )
  }

  return (
    <span className="ml-2 inline-block">
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {slots === null ? (
        <span>Loading suggestions…</span>
      ) : slots.length === 0 ? (
        <span>No open slots found.</span>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={onlineMeeting}
              onChange={(e) => setOnlineMeeting(e.target.checked)}
            />
            {' '}Online meeting
          </label>
          <ul>
            {slots.map((slot) => (
              <li key={slot.start}>
                <button onClick={() => confirm(slot)}>
                  {new Date(slot.start).toLocaleString()}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </span>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/components/ScheduleActionItemPanel.test.tsx`
Expected: PASS (5/5)

- [ ] **Step 5: Write the failing Planner integration test**

Add to `frontend/app/planner/page.test.tsx`:

```tsx
it('shows a Schedule control on open items with a contact and hides it once scheduled', async () => {
  apiFetchMock.mockResolvedValue(jsonResponse([
    {
      id: '10', text: 'Call Gina', direction: 'mine', status: 'open', due_date: null,
      contact: { id: 'c1', display_name: 'Gina', email_address: 'gina@example.com' },
      scheduled_calendar_event_id: null, scheduled_start_time: null,
      created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    },
    {
      id: '11', text: 'Already booked', direction: 'mine', status: 'open', due_date: null,
      contact: { id: 'c2', display_name: 'Bob', email_address: 'bob@example.com' },
      scheduled_calendar_event_id: 'evt-1', scheduled_start_time: '2026-07-22T14:00:00Z',
      created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    },
  ]))

  render(<PlannerPage />)

  await waitFor(() => expect(screen.getByText('Call Gina')).toBeInTheDocument())
  expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument()
  expect(screen.getByText(/scheduled:/i)).toBeInTheDocument()
})
```

This test needs no fake timers and no `fireEvent`-for-`userEvent` substitution — it doesn't touch the debounce/date-grouping logic the rest of this file's tests are careful about, since `daysFromNow` isn't exercised (both items have `due_date: null`).

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd frontend && npx vitest run app/planner/page.test.tsx`
Expected: FAIL — no "Schedule" button or "Scheduled:" text found yet.

- [ ] **Step 7: Integrate the component into the Planner page**

In `frontend/app/planner/page.tsx`, add the import at the top:

```tsx
import ScheduleActionItemPanel from '@/app/components/ScheduleActionItemPanel'
```

Update the `ActionItem` type to add two fields (insert after `contact`):

```tsx
type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  contact: { id: string; display_name: string | null; email_address: string | null } | null
  scheduled_calendar_event_id: string | null
  scheduled_start_time: string | null
  created_at: string
  updated_at: string
}
```

Replace `renderItem` with:

```tsx
  function renderItem(item: ActionItem) {
    return (
      <li key={item.id}>
        {item.text}
        {item.contact && ` — ${item.contact.display_name ?? item.contact.email_address}`}
        <button onClick={() => toggleDone(item)} className="ml-2 underline">
          {item.status === 'open' ? 'Mark done' : 'Reopen'}
        </button>
        {item.status === 'open' && (
          <ScheduleActionItemPanel
            itemId={item.id}
            scheduledCalendarEventId={item.scheduled_calendar_event_id}
            scheduledStartTime={item.scheduled_start_time}
            contact={item.contact}
            onScheduled={load}
          />
        )}
      </li>
    )
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd frontend && npx vitest run app/planner/page.test.tsx`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 9: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: all pass, no regressions.

- [ ] **Step 10: Commit**

```bash
git add frontend/app/components/ScheduleActionItemPanel.tsx frontend/app/components/ScheduleActionItemPanel.test.tsx frontend/app/planner/page.tsx frontend/app/planner/page.test.tsx
git commit -m "feat: add ScheduleActionItemPanel and wire it into the Planner page"
```

---

### Task 9: Contact profile page integration

**Files:**
- Modify: `frontend/app/contacts/[id]/page.tsx`
- Modify: `frontend/app/contacts/[id]/page.test.tsx`

**Interfaces:**
- Consumes: `ScheduleActionItemPanel` (Task 8).
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/contacts/[id]/page.test.tsx`:

```tsx
it('shows a Schedule control on open items and a scheduled indicator once scheduled', async () => {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/api/contacts/contact-1') {
      return Promise.resolve(jsonResponse({
        id: 'contact-1', email_address: 'alice@example.com', display_name: 'Alice',
        notes: 'Works at Acme.', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-17T00:00:00Z',
      }))
    }
    if (path === '/api/contacts/contact-1/action-items') {
      return Promise.resolve(jsonResponse([
        {
          id: 'ai-1', text: 'Send the deck', direction: 'mine', status: 'open', due_date: null,
          source_type: 'email', scheduled_calendar_event_id: null, scheduled_start_time: null,
          created_at: '2026-07-17T00:00:00Z', updated_at: '2026-07-17T00:00:00Z',
        },
        {
          id: 'ai-2', text: 'Already booked', direction: 'mine', status: 'open', due_date: null,
          source_type: 'email', scheduled_calendar_event_id: 'evt-1', scheduled_start_time: '2026-07-22T14:00:00Z',
          created_at: '2026-07-16T00:00:00Z', updated_at: '2026-07-16T00:00:00Z',
        },
      ]))
    }
    throw new Error(`Unexpected path: ${path}`)
  })

  render(<ContactProfilePage />)

  await waitFor(() => expect(screen.getByText('Send the deck')).toBeInTheDocument())
  expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument()
  expect(screen.getByText(/scheduled:/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run "app/contacts/[id]/page.test.tsx"`
Expected: FAIL — no "Schedule" button or "Scheduled:" text found yet.

- [ ] **Step 3: Integrate the component into the contact profile page**

In `frontend/app/contacts/[id]/page.tsx`, add the import at the top:

```tsx
import ScheduleActionItemPanel from '@/app/components/ScheduleActionItemPanel'
```

Update the `ActionItem` type to add two fields (insert after `source_type`):

```tsx
type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  source_type: string
  scheduled_calendar_event_id: string | null
  scheduled_start_time: string | null
  created_at: string
  updated_at: string
}
```

Refactor the data-loading `useEffect` into a `useCallback`, so scheduling success can trigger the same reload other pages already use — replace:

```tsx
  useEffect(() => {
    async function load() {
      const contactResponse = await apiFetch(`/api/contacts/${id}`)
      if (contactResponse.status === 404) {
        setState({ state: 'not_found' })
        return
      }
      if (!contactResponse.ok) {
        setState({ state: 'error' })
        return
      }
      const contact = await contactResponse.json()

      const actionItemsResponse = await apiFetch(`/api/contacts/${id}/action-items`)
      if (!actionItemsResponse.ok) {
        setState({ state: 'error' })
        return
      }
      const actionItems = await actionItemsResponse.json()

      setState({ state: 'ready', contact, actionItems })
    }

    load()
  }, [id])
```

with:

```tsx
  const load = useCallback(async () => {
    const contactResponse = await apiFetch(`/api/contacts/${id}`)
    if (contactResponse.status === 404) {
      setState({ state: 'not_found' })
      return
    }
    if (!contactResponse.ok) {
      setState({ state: 'error' })
      return
    }
    const contact = await contactResponse.json()

    const actionItemsResponse = await apiFetch(`/api/contacts/${id}/action-items`)
    if (!actionItemsResponse.ok) {
      setState({ state: 'error' })
      return
    }
    const actionItems = await actionItemsResponse.json()

    setState({ state: 'ready', contact, actionItems })
  }, [id])

  useEffect(() => {
    load()
  }, [load])
```

Update the import line at the top of the file from `import { useEffect, useState } from 'react'` to `import { useCallback, useEffect, useState } from 'react'`.

Replace the Open section's `<ul>` with:

```tsx
      <h2 className="mt-6 text-lg">Open</h2>
      {openItems.length === 0 ? (
        <p>Nothing open.</p>
      ) : (
        <ul>
          {openItems.map((item) => (
            <li key={item.id}>
              {item.text}
              <ScheduleActionItemPanel
                itemId={item.id}
                scheduledCalendarEventId={item.scheduled_calendar_event_id}
                scheduledStartTime={item.scheduled_start_time}
                contact={contact}
                onScheduled={load}
              />
            </li>
          ))}
        </ul>
      )}
```

(The Done section stays untouched — no scheduling control there, per the "open action items only" scope.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run "app/contacts/[id]/page.test.tsx"`
Expected: PASS (all tests in the file — the two pre-existing ones plus the new one; the pre-existing happy-path test's mock data has no `scheduled_calendar_event_id` field, which the component treats as falsy/not-scheduled, so it still passes unchanged).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/contacts/[id]/page.tsx frontend/app/contacts/[id]/page.test.tsx
git commit -m "feat: wire ScheduleActionItemPanel into the contact profile page"
```

---

## Final Verification

After all 9 tasks are complete:

- [ ] Run the full backend suite: `cd backend && .venv/Scripts/python.exe -m pytest -q` — expect all tests passing.
- [ ] Run the full frontend suite: `cd frontend && npx vitest run` — expect all tests passing.
- [ ] Manually start both dev servers and click through: open an action item with a linked contact on the Planner, click Schedule, confirm a suggested slot with "Online meeting" checked, verify the item shows "Scheduled: ..." afterward on both the Planner and that contact's profile page, and (if a real Microsoft account is connected) verify the event actually appears in Outlook/Teams with a join link.
