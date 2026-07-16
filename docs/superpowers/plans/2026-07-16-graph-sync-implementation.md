# Graph Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync a signed-in user's Outlook mail, calendar events (including Teams join info), and Teams chat messages from Microsoft Graph into Postgres, incrementally, on both a schedule and on demand.

**Architecture:** A free external cron pings `POST /api/sync/run` (shared-secret auth) every ~15 min, looping every connected user through one shared `sync_user()` orchestrator in `app/services/graph_sync.py`. The same orchestrator is called synchronously by `POST /api/sync/run/me` (JWT auth, dashboard "Sync now" button) and once via a background task right after `POST /api/auth/graph-tokens` completes. Mail and calendar use true Graph delta queries; chat uses timestamp-filtered polling since Graph has no delta support for chat under delegated permissions.

**Tech Stack:** FastAPI, asyncpg, httpx (Graph HTTP calls), pytest + pytest-asyncio + respx (tests), Supabase Postgres, GitHub Actions (external cron).

## Global Constraints

- No `org_id`/tenancy — every table and query is scoped strictly by `user_id` (spec: Context).
- RLS enabled on every new table, **zero policies** for `anon`/`authenticated` — only the backend's service-role connection may read/write (spec: Data Model). Matches the existing `ms_graph_tokens` pattern.
- Synced content (email bodies, chat messages, event bodies) is stored as **plain Postgres text**, not Fernet-encrypted (spec: Data Model) — later sub-projects need to query/search it directly.
- Initial backfill window is the **last 30 days** for mail and chat; calendar additionally looks **90 days ahead** (spec: Sync Mechanism) since upcoming meetings matter as much as past ones.
- Chat has no delta-query support under any delegated permission (confirmed against live Graph API docs) — chat sync always uses `sync_state.last_synced_at` as a timestamp filter, never a delta token.
- Personal Microsoft accounts fail at the very first `GET /me/chats` call — this is expected and must resolve to `sync_state.status = 'not_available'`, never a surfaced error.
- The bulk sync endpoint (`POST /api/sync/run`) is triggered by an external free cron, not a paid Render background worker — Render's free web service spins down when idle, so an HTTP ping both wakes it and triggers the sync.

---

### Task 1: Graph Sync schema migration

**Files:**
- Create: `supabase/migrations/20260716000000_graph_sync_schema.sql`

**Interfaces:**
- Produces: tables `public.emails`, `public.calendar_events`, `public.chat_messages`, `public.sync_state`, all RLS-enabled with zero policies (service-role only).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260716000000_graph_sync_schema.sql

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  graph_message_id text not null,
  subject text,
  from_address text,
  from_name text,
  to_recipients jsonb not null default '[]',
  received_at timestamptz,
  body_text text,
  synced_at timestamptz not null default now(),
  unique (user_id, graph_message_id)
);

alter table public.emails enable row level security;
-- Intentionally no policies: only the service_role connection (bypasses RLS) may touch this table.

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  graph_event_id text not null,
  subject text,
  organizer text,
  attendees jsonb not null default '[]',
  start_time timestamptz,
  end_time timestamptz,
  is_online_meeting boolean not null default false,
  online_meeting_join_url text,
  body_text text,
  synced_at timestamptz not null default now(),
  unique (user_id, graph_event_id)
);

alter table public.calendar_events enable row level security;

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  graph_chat_id text not null,
  graph_message_id text not null,
  from_user text,
  content text,
  sent_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (user_id, graph_message_id)
);

alter table public.chat_messages enable row level security;

create table public.sync_state (
  user_id uuid not null references public.profiles(id) on delete cascade,
  resource_type text not null check (resource_type in ('mail', 'calendar', 'chat')),
  delta_link text,
  last_synced_at timestamptz,
  status text not null default 'ok' check (status in ('ok', 'not_available', 'error')),
  primary key (user_id, resource_type)
);

alter table public.sync_state enable row level security;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` against the project (ref `fmzbuhyguxgxodymmojm`), with `name` = `graph_sync_schema` and the SQL above as `query`.

- [ ] **Step 3: Verify**

Call `mcp__plugin_supabase_supabase__list_tables` for the `public` schema. Expected: `emails`, `calendar_events`, `chat_messages`, `sync_state` all present alongside `profiles` and `ms_graph_tokens`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260716000000_graph_sync_schema.sql
git commit -m "feat: add Graph Sync schema (emails, calendar_events, chat_messages, sync_state)"
```

---

### Task 2: `sync_state` and `emails` repositories

**Files:**
- Create: `backend/app/repositories/sync_state.py`
- Create: `backend/app/repositories/emails.py`
- Test: `backend/tests/test_graph_sync_repositories.py`

**Interfaces:**
- Consumes: `asyncpg.Pool` (from `app/db/session.py`'s `get_pool()`, same as every other repository).
- Produces:
  - `SyncStateRepository(pool).get(user_id: uuid.UUID, resource_type: str) -> asyncpg.Record | None`
  - `SyncStateRepository(pool).upsert(user_id: uuid.UUID, resource_type: str, delta_link: str | None, status: str) -> None`
  - `EmailsRepository(pool).upsert(user_id: uuid.UUID, graph_message_id: str, subject: str | None, from_address: str | None, from_name: str | None, to_recipients: list[dict], received_at: datetime | None, body_text: str | None) -> None`
  - `EmailsRepository(pool).delete(user_id: uuid.UUID, graph_message_id: str) -> None`
  - `EmailsRepository(pool).count(user_id: uuid.UUID) -> int`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_graph_sync_repositories.py
import uuid
from datetime import datetime, timezone

import pytest

from app.repositories.emails import EmailsRepository
from app.repositories.sync_state import SyncStateRepository


@pytest.mark.asyncio
async def test_sync_state_upsert_and_get(pool, test_auth_user):
    user_id, _ = test_auth_user
    repo = SyncStateRepository(pool)

    assert await repo.get(user_id, "mail") is None

    await repo.upsert(user_id, "mail", delta_link="https://graph/delta?token=abc", status="ok")
    row = await repo.get(user_id, "mail")
    assert row["delta_link"] == "https://graph/delta?token=abc"
    assert row["status"] == "ok"

    await repo.upsert(user_id, "mail", delta_link="https://graph/delta?token=def", status="ok")
    row = await repo.get(user_id, "mail")
    assert row["delta_link"] == "https://graph/delta?token=def"


@pytest.mark.asyncio
async def test_emails_upsert_dedupes_by_graph_message_id(pool, test_auth_user):
    user_id, _ = test_auth_user
    repo = EmailsRepository(pool)

    await repo.upsert(
        user_id=user_id,
        graph_message_id="msg-1",
        subject="Hello",
        from_address="a@example.com",
        from_name="A",
        to_recipients=[{"address": "b@example.com", "name": "B"}],
        received_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
        body_text="Hi there",
    )
    assert await repo.count(user_id) == 1

    await repo.upsert(
        user_id=user_id,
        graph_message_id="msg-1",
        subject="Hello (edited)",
        from_address="a@example.com",
        from_name="A",
        to_recipients=[{"address": "b@example.com", "name": "B"}],
        received_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
        body_text="Hi there, edited",
    )
    assert await repo.count(user_id) == 1


@pytest.mark.asyncio
async def test_emails_delete(pool, test_auth_user):
    user_id, _ = test_auth_user
    repo = EmailsRepository(pool)

    await repo.upsert(
        user_id=user_id,
        graph_message_id="msg-2",
        subject="Bye",
        from_address="a@example.com",
        from_name="A",
        to_recipients=[],
        received_at=None,
        body_text=None,
    )
    assert await repo.count(user_id) == 1

    await repo.delete(user_id, "msg-2")
    assert await repo.count(user_id) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_repositories.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.repositories.sync_state'`

- [ ] **Step 3: Implement `sync_state.py`**

```python
# backend/app/repositories/sync_state.py
import uuid

import asyncpg


class SyncStateRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def get(self, user_id: uuid.UUID, resource_type: str) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            "select * from public.sync_state where user_id = $1 and resource_type = $2",
            user_id,
            resource_type,
        )

    async def upsert(
        self,
        user_id: uuid.UUID,
        resource_type: str,
        delta_link: str | None,
        status: str,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.sync_state (user_id, resource_type, delta_link, last_synced_at, status)
            values ($1, $2, $3, now(), $4)
            on conflict (user_id, resource_type) do update
            set delta_link = excluded.delta_link,
                last_synced_at = now(),
                status = excluded.status
            """,
            user_id,
            resource_type,
            delta_link,
            status,
        )
```

- [ ] **Step 4: Implement `emails.py`**

```python
# backend/app/repositories/emails.py
import json
import uuid
from datetime import datetime

import asyncpg


class EmailsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        graph_message_id: str,
        subject: str | None,
        from_address: str | None,
        from_name: str | None,
        to_recipients: list[dict],
        received_at: datetime | None,
        body_text: str | None,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.emails
                (user_id, graph_message_id, subject, from_address, from_name,
                 to_recipients, received_at, body_text, synced_at)
            values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
            on conflict (user_id, graph_message_id) do update
            set subject = excluded.subject,
                from_address = excluded.from_address,
                from_name = excluded.from_name,
                to_recipients = excluded.to_recipients,
                received_at = excluded.received_at,
                body_text = excluded.body_text,
                synced_at = now()
            """,
            user_id,
            graph_message_id,
            subject,
            from_address,
            from_name,
            json.dumps(to_recipients),
            received_at,
            body_text,
        )

    async def delete(self, user_id: uuid.UUID, graph_message_id: str) -> None:
        await self._pool.execute(
            "delete from public.emails where user_id = $1 and graph_message_id = $2",
            user_id,
            graph_message_id,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.emails where user_id = $1",
            user_id,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_repositories.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/repositories/sync_state.py backend/app/repositories/emails.py backend/tests/test_graph_sync_repositories.py
git commit -m "feat: add sync_state and emails repositories"
```

---

### Task 3: `calendar_events` and `chat_messages` repositories

**Files:**
- Create: `backend/app/repositories/calendar_events.py`
- Create: `backend/app/repositories/chat_messages.py`
- Test: Modify `backend/tests/test_graph_sync_repositories.py` (append)

**Interfaces:**
- Consumes: `asyncpg.Pool`.
- Produces:
  - `CalendarEventsRepository(pool).upsert(user_id, graph_event_id, subject, organizer, attendees: list[dict], start_time, end_time, is_online_meeting: bool, online_meeting_join_url: str | None, body_text) -> None`
  - `CalendarEventsRepository(pool).delete(user_id, graph_event_id) -> None`
  - `CalendarEventsRepository(pool).count(user_id) -> int`
  - `ChatMessagesRepository(pool).upsert(user_id, graph_chat_id, graph_message_id, from_user, content, sent_at) -> None`
  - `ChatMessagesRepository(pool).count(user_id) -> int`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_graph_sync_repositories.py
from app.repositories.calendar_events import CalendarEventsRepository
from app.repositories.chat_messages import ChatMessagesRepository


@pytest.mark.asyncio
async def test_calendar_events_upsert_dedupes_by_graph_event_id(pool, test_auth_user):
    user_id, _ = test_auth_user
    repo = CalendarEventsRepository(pool)

    await repo.upsert(
        user_id=user_id,
        graph_event_id="evt-1",
        subject="Standup",
        organizer="a@example.com",
        attendees=[{"address": "b@example.com", "name": "B"}],
        start_time=datetime(2026, 7, 1, 9, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 1, 9, 30, tzinfo=timezone.utc),
        is_online_meeting=True,
        online_meeting_join_url="https://teams.microsoft.com/l/meetup-join/xyz",
        body_text="Daily sync",
    )
    assert await repo.count(user_id) == 1

    await repo.upsert(
        user_id=user_id,
        graph_event_id="evt-1",
        subject="Standup (moved)",
        organizer="a@example.com",
        attendees=[{"address": "b@example.com", "name": "B"}],
        start_time=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 1, 10, 30, tzinfo=timezone.utc),
        is_online_meeting=True,
        online_meeting_join_url="https://teams.microsoft.com/l/meetup-join/xyz",
        body_text="Daily sync",
    )
    assert await repo.count(user_id) == 1


@pytest.mark.asyncio
async def test_calendar_events_delete(pool, test_auth_user):
    user_id, _ = test_auth_user
    repo = CalendarEventsRepository(pool)

    await repo.upsert(
        user_id=user_id,
        graph_event_id="evt-2",
        subject="Cancelled meeting",
        organizer="a@example.com",
        attendees=[],
        start_time=None,
        end_time=None,
        is_online_meeting=False,
        online_meeting_join_url=None,
        body_text=None,
    )
    assert await repo.count(user_id) == 1

    await repo.delete(user_id, "evt-2")
    assert await repo.count(user_id) == 0


@pytest.mark.asyncio
async def test_chat_messages_upsert_dedupes_by_graph_message_id(pool, test_auth_user):
    user_id, _ = test_auth_user
    repo = ChatMessagesRepository(pool)

    await repo.upsert(
        user_id=user_id,
        graph_chat_id="19:abc@thread.v2",
        graph_message_id="chat-msg-1",
        from_user="Alice",
        content="Hey there",
        sent_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )
    assert await repo.count(user_id) == 1

    await repo.upsert(
        user_id=user_id,
        graph_chat_id="19:abc@thread.v2",
        graph_message_id="chat-msg-1",
        from_user="Alice",
        content="Hey there (edited)",
        sent_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )
    assert await repo.count(user_id) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_repositories.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.repositories.calendar_events'`

- [ ] **Step 3: Implement `calendar_events.py`**

```python
# backend/app/repositories/calendar_events.py
import json
import uuid
from datetime import datetime

import asyncpg


class CalendarEventsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

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
    ) -> None:
        await self._pool.execute(
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

    async def delete(self, user_id: uuid.UUID, graph_event_id: str) -> None:
        await self._pool.execute(
            "delete from public.calendar_events where user_id = $1 and graph_event_id = $2",
            user_id,
            graph_event_id,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.calendar_events where user_id = $1",
            user_id,
        )
```

- [ ] **Step 4: Implement `chat_messages.py`**

```python
# backend/app/repositories/chat_messages.py
import uuid
from datetime import datetime

import asyncpg


class ChatMessagesRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        graph_chat_id: str,
        graph_message_id: str,
        from_user: str | None,
        content: str | None,
        sent_at: datetime | None,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.chat_messages
                (user_id, graph_chat_id, graph_message_id, from_user, content, sent_at, synced_at)
            values ($1, $2, $3, $4, $5, $6, now())
            on conflict (user_id, graph_message_id) do update
            set from_user = excluded.from_user,
                content = excluded.content,
                sent_at = excluded.sent_at,
                synced_at = now()
            """,
            user_id,
            graph_chat_id,
            graph_message_id,
            from_user,
            content,
            sent_at,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.chat_messages where user_id = $1",
            user_id,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_repositories.py -v`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/repositories/calendar_events.py backend/app/repositories/chat_messages.py backend/tests/test_graph_sync_repositories.py
git commit -m "feat: add calendar_events and chat_messages repositories"
```

---

### Task 4: Graph client — mail and calendar delta helpers

**Files:**
- Modify: `backend/app/services/graph_client.py`
- Test: Create `backend/tests/test_graph_sync_client.py`

**Interfaces:**
- Consumes: `GRAPH_BASE_URL` (already defined in `graph_client.py`).
- Produces:
  - `mail_delta_url(since: datetime) -> str`
  - `calendar_delta_url(start: datetime, end: datetime) -> str`
  - `async def fetch_delta_page(access_token: str, url: str) -> dict` — returns `{"items": list[dict], "next_link": str | None, "delta_link": str | None}`
  - `async def _get_json(client: httpx.AsyncClient, url: str, headers: dict) -> dict` (internal, retries once on 429 honoring `Retry-After`)

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_graph_sync_client.py
from datetime import datetime, timezone

import pytest
import respx
from httpx import Response

from app.services.graph_client import calendar_delta_url, fetch_delta_page, mail_delta_url


def test_mail_delta_url_scopes_to_inbox_and_since():
    since = datetime(2026, 6, 16, tzinfo=timezone.utc)
    url = mail_delta_url(since)
    assert url == (
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"
        "?$filter=receivedDateTime ge 2026-06-16T00:00:00Z"
    )


def test_calendar_delta_url_includes_date_range():
    start = datetime(2026, 6, 16, tzinfo=timezone.utc)
    end = datetime(2026, 10, 14, tzinfo=timezone.utc)
    url = calendar_delta_url(start, end)
    assert url == (
        "https://graph.microsoft.com/v1.0/me/calendarView/delta"
        "?startDateTime=2026-06-16T00:00:00Z&endDateTime=2026-10-14T00:00:00Z"
    )


@pytest.mark.asyncio
@respx.mock
async def test_fetch_delta_page_returns_items_and_links():
    respx.get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta").mock(
        return_value=Response(
            200,
            json={
                "value": [{"id": "msg-1", "subject": "Hi"}],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc",
            },
        )
    )

    result = await fetch_delta_page(
        "access-token", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"
    )

    assert result["items"] == [{"id": "msg-1", "subject": "Hi"}]
    assert result["next_link"] == "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc"
    assert result["delta_link"] is None


@pytest.mark.asyncio
@respx.mock
async def test_fetch_delta_page_retries_once_on_429():
    route = respx.get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta").mock(
        side_effect=[
            Response(429, headers={"Retry-After": "0"}),
            Response(200, json={"value": [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?$deltatoken=done"}),
        ]
    )

    result = await fetch_delta_page(
        "access-token", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"
    )

    assert route.call_count == 2
    assert result["delta_link"] == "https://graph.microsoft.com/v1.0/delta?$deltatoken=done"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_client.py -v`
Expected: FAIL with `ImportError: cannot import name 'mail_delta_url' from 'app.services.graph_client'`

- [ ] **Step 3: Implement the helpers**

Append to `backend/app/services/graph_client.py` (keep the existing `GRAPH_BASE_URL`, `GraphRefreshError`, `_confidential_client`, `refresh_access_token`, `get_me` as-is):

```python
import asyncio


async def _get_json(client: httpx.AsyncClient, url: str, headers: dict) -> dict:
    response = await client.get(url, headers=headers)
    if response.status_code == 429:
        retry_after = float(response.headers.get("Retry-After", "1"))
        await asyncio.sleep(retry_after)
        response = await client.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


def mail_delta_url(since: datetime) -> str:
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{GRAPH_BASE_URL}/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime ge {since_str}"


def calendar_delta_url(start: datetime, end: datetime) -> str:
    start_str = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    end_str = end.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{GRAPH_BASE_URL}/me/calendarView/delta?startDateTime={start_str}&endDateTime={end_str}"


async def fetch_delta_page(access_token: str, url: str) -> dict:
    async with httpx.AsyncClient() as client:
        body = await _get_json(client, url, {"Authorization": f"Bearer {access_token}"})
    return {
        "items": body.get("value", []),
        "next_link": body.get("@odata.nextLink"),
        "delta_link": body.get("@odata.deltaLink"),
    }
```

Note: `datetime` is already imported at the top of `graph_client.py` (`from datetime import datetime, timedelta, timezone`) — no new import needed there, only `asyncio`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_client.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full backend suite to confirm no regressions**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: all tests pass (16 from Foundation + 6 from Tasks 2-3 + 4 new from this task = 26)

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/graph_client.py backend/tests/test_graph_sync_client.py
git commit -m "feat: add mail/calendar delta query helpers to graph_client"
```

---

### Task 5: Graph client — chat helpers

**Files:**
- Modify: `backend/app/services/graph_client.py`
- Test: Modify `backend/tests/test_graph_sync_client.py` (append)

**Interfaces:**
- Consumes: `_get_json` (Task 4), `GRAPH_BASE_URL`.
- Produces:
  - `chat_messages_url(chat_id: str, since: datetime) -> str`
  - `async def list_chats(access_token: str) -> list[dict]` — raises `httpx.HTTPStatusError` on failure (e.g. 403 for personal accounts)
  - `async def fetch_chat_messages_page(access_token: str, url: str) -> dict` — returns `{"items": list[dict], "next_link": str | None}`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_graph_sync_client.py
from app.services.graph_client import chat_messages_url, fetch_chat_messages_page, list_chats


def test_chat_messages_url_includes_filter_and_orderby():
    since = datetime(2026, 6, 16, tzinfo=timezone.utc)
    url = chat_messages_url("19:abc@thread.v2", since)
    assert url == (
        "https://graph.microsoft.com/v1.0/chats/19:abc@thread.v2/messages"
        "?$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt 2026-06-16T00:00:00Z"
    )


@pytest.mark.asyncio
@respx.mock
async def test_list_chats_follows_pagination():
    respx.get("https://graph.microsoft.com/v1.0/me/chats").mock(
        return_value=Response(
            200,
            json={
                "value": [{"id": "chat-1"}],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=abc",
            },
        )
    )
    respx.get("https://graph.microsoft.com/v1.0/me/chats?$skiptoken=abc").mock(
        return_value=Response(200, json={"value": [{"id": "chat-2"}]})
    )

    chats = await list_chats("access-token")

    assert chats == [{"id": "chat-1"}, {"id": "chat-2"}]


@pytest.mark.asyncio
@respx.mock
async def test_list_chats_raises_on_forbidden_personal_account():
    respx.get("https://graph.microsoft.com/v1.0/me/chats").mock(return_value=Response(403))

    with pytest.raises(Exception):
        await list_chats("access-token")


@pytest.mark.asyncio
@respx.mock
async def test_fetch_chat_messages_page_returns_items_and_next_link():
    respx.get("https://graph.microsoft.com/v1.0/chats/19:abc@thread.v2/messages").mock(
        return_value=Response(200, json={"value": [{"id": "chat-msg-1"}]})
    )

    result = await fetch_chat_messages_page(
        "access-token", "https://graph.microsoft.com/v1.0/chats/19:abc@thread.v2/messages"
    )

    assert result["items"] == [{"id": "chat-msg-1"}]
    assert result["next_link"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_client.py -v`
Expected: FAIL with `ImportError: cannot import name 'chat_messages_url' from 'app.services.graph_client'`

- [ ] **Step 3: Implement the helpers**

Append to `backend/app/services/graph_client.py`:

```python
def chat_messages_url(chat_id: str, since: datetime) -> str:
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        f"{GRAPH_BASE_URL}/chats/{chat_id}/messages"
        f"?$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt {since_str}"
    )


async def list_chats(access_token: str) -> list[dict]:
    chats: list[dict] = []
    url = f"{GRAPH_BASE_URL}/me/chats"
    async with httpx.AsyncClient() as client:
        while url:
            body = await _get_json(client, url, {"Authorization": f"Bearer {access_token}"})
            chats.extend(body.get("value", []))
            url = body.get("@odata.nextLink")
    return chats


async def fetch_chat_messages_page(access_token: str, url: str) -> dict:
    async with httpx.AsyncClient() as client:
        body = await _get_json(client, url, {"Authorization": f"Bearer {access_token}"})
    return {
        "items": body.get("value", []),
        "next_link": body.get("@odata.nextLink"),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_client.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/graph_client.py backend/tests/test_graph_sync_client.py
git commit -m "feat: add chat listing and message-page helpers to graph_client"
```

---

### Task 6: `sync_mail` service function

**Files:**
- Create: `backend/app/services/graph_sync.py`
- Test: Create `backend/tests/test_graph_sync_service.py`

**Interfaces:**
- Consumes: `graph_client.mail_delta_url`, `graph_client.fetch_delta_page` (Task 4), `SyncStateRepository`, `EmailsRepository` (Task 2).
- Produces:
  - `BACKFILL_DAYS = 30` (module constant, reused by Tasks 7 and 8)
  - `_parse_graph_datetime(value: str | None) -> datetime | None` (module-private helper, reused by Tasks 7 and 8)
  - `async def sync_mail(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_graph_sync_service.py
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import httpx
import pytest

from app.repositories.emails import EmailsRepository
from app.repositories.sync_state import SyncStateRepository
from app.services.graph_sync import _parse_graph_datetime, sync_mail


def test_parse_graph_datetime_handles_z_suffix():
    assert _parse_graph_datetime("2026-07-01T12:00:00Z") == datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_graph_datetime_handles_naive_utc_no_z():
    assert _parse_graph_datetime("2026-07-01T12:00:00.0000000") == datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_graph_datetime_truncates_seven_digit_fraction():
    result = _parse_graph_datetime("2026-07-01T12:00:00.1234567Z")
    assert result.microsecond == 123456


def test_parse_graph_datetime_handles_none():
    assert _parse_graph_datetime(None) is None


@pytest.mark.asyncio
async def test_sync_mail_upserts_and_stores_delta_link(pool, test_auth_user):
    user_id, _ = test_auth_user
    page = {
        "items": [
            {
                "id": "msg-1",
                "subject": "Hello",
                "sender": {"emailAddress": {"address": "a@example.com", "name": "A"}},
                "toRecipients": [{"emailAddress": {"address": "b@example.com", "name": "B"}}],
                "receivedDateTime": "2026-07-01T12:00:00Z",
                "body": {"content": "Hi there"},
            }
        ],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/delta?$deltatoken=abc",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page):
        await sync_mail(pool, user_id, "access-token")

    assert await EmailsRepository(pool).count(user_id) == 1
    state = await SyncStateRepository(pool).get(user_id, "mail")
    assert state["delta_link"] == "https://graph.microsoft.com/v1.0/delta?$deltatoken=abc"
    assert state["status"] == "ok"


@pytest.mark.asyncio
async def test_sync_mail_resumes_from_stored_delta_link(pool, test_auth_user):
    user_id, _ = test_auth_user
    await SyncStateRepository(pool).upsert(user_id, "mail", "https://graph.microsoft.com/v1.0/delta?$deltatoken=prev", "ok")

    page = {"items": [], "next_link": None, "delta_link": "https://graph.microsoft.com/v1.0/delta?$deltatoken=next"}
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page) as mock_fetch:
        await sync_mail(pool, user_id, "access-token")

    mock_fetch.assert_called_once_with("access-token", "https://graph.microsoft.com/v1.0/delta?$deltatoken=prev")


@pytest.mark.asyncio
async def test_sync_mail_handles_removed_items(pool, test_auth_user):
    user_id, _ = test_auth_user
    await EmailsRepository(pool).upsert(
        user_id=user_id,
        graph_message_id="msg-to-remove",
        subject="Old",
        from_address="a@example.com",
        from_name="A",
        to_recipients=[],
        received_at=None,
        body_text=None,
    )

    page = {
        "items": [{"id": "msg-to-remove", "@removed": {"reason": "deleted"}}],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/delta?$deltatoken=abc",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page):
        await sync_mail(pool, user_id, "access-token")

    assert await EmailsRepository(pool).count(user_id) == 0


@pytest.mark.asyncio
async def test_sync_mail_sets_not_available_on_403(pool, test_auth_user):
    user_id, _ = test_auth_user
    request = httpx.Request("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta")
    error = httpx.HTTPStatusError("forbidden", request=request, response=httpx.Response(403, request=request))

    with patch("app.services.graph_sync.graph_client.fetch_delta_page", side_effect=error):
        await sync_mail(pool, user_id, "access-token")

    state = await SyncStateRepository(pool).get(user_id, "mail")
    assert state["status"] == "not_available"


@pytest.mark.asyncio
async def test_sync_mail_skips_when_already_not_available(pool, test_auth_user):
    user_id, _ = test_auth_user
    await SyncStateRepository(pool).upsert(user_id, "mail", None, "not_available")

    with patch("app.services.graph_sync.graph_client.fetch_delta_page") as mock_fetch:
        await sync_mail(pool, user_id, "access-token")

    mock_fetch.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.graph_sync'`

- [ ] **Step 3: Implement `graph_sync.py`**

```python
# backend/app/services/graph_sync.py
import re
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx

from app.repositories.emails import EmailsRepository
from app.repositories.sync_state import SyncStateRepository
from app.services import graph_client

BACKFILL_DAYS = 30

_FRACTION_RE = re.compile(r"(\.\d{7,})")


def _parse_graph_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.replace("Z", "+00:00")
    match = _FRACTION_RE.search(value)
    if match:
        value = value.replace(match.group(1), match.group(1)[:7])
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


async def sync_mail(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None:
    sync_state = SyncStateRepository(pool)
    emails = EmailsRepository(pool)

    state = await sync_state.get(user_id, "mail")
    if state is not None and state["status"] == "not_available":
        return

    url = (
        state["delta_link"]
        if state and state["delta_link"]
        else graph_client.mail_delta_url(datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS))
    )

    try:
        delta_link = None
        while True:
            page = await graph_client.fetch_delta_page(access_token, url)
            for item in page["items"]:
                if "@removed" in item:
                    await emails.delete(user_id, item["id"])
                    continue
                sender = (item.get("sender") or {}).get("emailAddress") or {}
                await emails.upsert(
                    user_id=user_id,
                    graph_message_id=item["id"],
                    subject=item.get("subject"),
                    from_address=sender.get("address"),
                    from_name=sender.get("name"),
                    to_recipients=[
                        (r.get("emailAddress") or {}) for r in item.get("toRecipients", [])
                    ],
                    received_at=_parse_graph_datetime(item.get("receivedDateTime")),
                    body_text=(item.get("body") or {}).get("content"),
                )
            if page["delta_link"]:
                delta_link = page["delta_link"]
                break
            url = page["next_link"]
        await sync_state.upsert(user_id, "mail", delta_link, "ok")
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (400, 403):
            await sync_state.upsert(user_id, "mail", None, "not_available")
        else:
            raise
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/graph_sync.py backend/tests/test_graph_sync_service.py
git commit -m "feat: add sync_mail service function"
```

---

### Task 7: `sync_calendar` service function

**Files:**
- Modify: `backend/app/services/graph_sync.py`
- Test: Modify `backend/tests/test_graph_sync_service.py` (append)

**Interfaces:**
- Consumes: `graph_client.calendar_delta_url`, `graph_client.fetch_delta_page` (Task 4), `_parse_graph_datetime`, `BACKFILL_DAYS` (Task 6), `SyncStateRepository`, `CalendarEventsRepository` (Task 3).
- Produces:
  - `CALENDAR_LOOKAHEAD_DAYS = 90` (module constant)
  - `async def sync_calendar(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_graph_sync_service.py
from app.repositories.calendar_events import CalendarEventsRepository
from app.services.graph_sync import sync_calendar


@pytest.mark.asyncio
async def test_sync_calendar_upserts_with_online_meeting_info(pool, test_auth_user):
    user_id, _ = test_auth_user
    page = {
        "items": [
            {
                "id": "evt-1",
                "subject": "Standup",
                "organizer": {"emailAddress": {"address": "a@example.com"}},
                "attendees": [{"emailAddress": {"address": "b@example.com", "name": "B"}}],
                "start": {"dateTime": "2026-07-01T09:00:00.0000000", "timeZone": "UTC"},
                "end": {"dateTime": "2026-07-01T09:30:00.0000000", "timeZone": "UTC"},
                "isOnlineMeeting": True,
                "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/meetup-join/xyz"},
                "body": {"content": "Daily sync"},
            }
        ],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=abc",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page):
        await sync_calendar(pool, user_id, "access-token")

    assert await CalendarEventsRepository(pool).count(user_id) == 1
    state = await SyncStateRepository(pool).get(user_id, "calendar")
    assert state["status"] == "ok"


@pytest.mark.asyncio
async def test_sync_calendar_first_sync_uses_backfill_and_lookahead_window(pool, test_auth_user):
    user_id, _ = test_auth_user
    page = {"items": [], "next_link": None, "delta_link": "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=abc"}

    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page), \
         patch("app.services.graph_sync.graph_client.calendar_delta_url") as mock_url:
        mock_url.return_value = "https://graph.microsoft.com/v1.0/me/calendarView/delta?start=x&end=y"
        await sync_calendar(pool, user_id, "access-token")

    assert mock_url.call_count == 1
    start_arg, end_arg = mock_url.call_args[0]
    assert (end_arg - start_arg).days > 100  # spans BACKFILL_DAYS behind + CALENDAR_LOOKAHEAD_DAYS ahead


@pytest.mark.asyncio
async def test_sync_calendar_sets_not_available_on_403(pool, test_auth_user):
    user_id, _ = test_auth_user
    request = httpx.Request("GET", "https://graph.microsoft.com/v1.0/me/calendarView/delta")
    error = httpx.HTTPStatusError("forbidden", request=request, response=httpx.Response(403, request=request))

    with patch("app.services.graph_sync.graph_client.fetch_delta_page", side_effect=error):
        await sync_calendar(pool, user_id, "access-token")

    state = await SyncStateRepository(pool).get(user_id, "calendar")
    assert state["status"] == "not_available"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: FAIL with `ImportError: cannot import name 'sync_calendar' from 'app.services.graph_sync'`

- [ ] **Step 3: Implement `sync_calendar`**

Append to `backend/app/services/graph_sync.py` (add the import at the top alongside the existing `EmailsRepository` import):

```python
from app.repositories.calendar_events import CalendarEventsRepository

CALENDAR_LOOKAHEAD_DAYS = 90


async def sync_calendar(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None:
    sync_state = SyncStateRepository(pool)
    events = CalendarEventsRepository(pool)

    state = await sync_state.get(user_id, "calendar")
    if state is not None and state["status"] == "not_available":
        return

    if state and state["delta_link"]:
        url = state["delta_link"]
    else:
        now = datetime.now(timezone.utc)
        url = graph_client.calendar_delta_url(
            now - timedelta(days=BACKFILL_DAYS),
            now + timedelta(days=CALENDAR_LOOKAHEAD_DAYS),
        )

    try:
        delta_link = None
        while True:
            page = await graph_client.fetch_delta_page(access_token, url)
            for item in page["items"]:
                if "@removed" in item:
                    await events.delete(user_id, item["id"])
                    continue
                online_meeting = item.get("onlineMeeting") or {}
                await events.upsert(
                    user_id=user_id,
                    graph_event_id=item["id"],
                    subject=item.get("subject"),
                    organizer=((item.get("organizer") or {}).get("emailAddress") or {}).get("address"),
                    attendees=[
                        (a.get("emailAddress") or {}) for a in item.get("attendees", [])
                    ],
                    start_time=_parse_graph_datetime((item.get("start") or {}).get("dateTime")),
                    end_time=_parse_graph_datetime((item.get("end") or {}).get("dateTime")),
                    is_online_meeting=item.get("isOnlineMeeting", False),
                    online_meeting_join_url=online_meeting.get("joinUrl"),
                    body_text=(item.get("body") or {}).get("content"),
                )
            if page["delta_link"]:
                delta_link = page["delta_link"]
                break
            url = page["next_link"]
        await sync_state.upsert(user_id, "calendar", delta_link, "ok")
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (400, 403):
            await sync_state.upsert(user_id, "calendar", None, "not_available")
        else:
            raise
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/graph_sync.py backend/tests/test_graph_sync_service.py
git commit -m "feat: add sync_calendar service function"
```

---

### Task 8: `sync_chat` service function

**Files:**
- Modify: `backend/app/services/graph_sync.py`
- Test: Modify `backend/tests/test_graph_sync_service.py` (append)

**Interfaces:**
- Consumes: `graph_client.list_chats`, `graph_client.chat_messages_url`, `graph_client.fetch_chat_messages_page` (Task 5), `_parse_graph_datetime`, `BACKFILL_DAYS` (Task 6), `SyncStateRepository`, `ChatMessagesRepository` (Task 3).
- Produces: `async def sync_chat(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_graph_sync_service.py
from app.repositories.chat_messages import ChatMessagesRepository
from app.services.graph_sync import sync_chat


@pytest.mark.asyncio
async def test_sync_chat_upserts_messages_across_chats(pool, test_auth_user):
    user_id, _ = test_auth_user
    chats = [{"id": "chat-1"}, {"id": "chat-2"}]
    page = {
        "items": [
            {
                "id": "chat-msg-1",
                "from": {"user": {"displayName": "Alice"}},
                "body": {"content": "Hey"},
                "createdDateTime": "2026-07-01T12:00:00Z",
            }
        ],
        "next_link": None,
    }
    with patch("app.services.graph_sync.graph_client.list_chats", return_value=chats), \
         patch("app.services.graph_sync.graph_client.fetch_chat_messages_page", return_value=page):
        await sync_chat(pool, user_id, "access-token")

    assert await ChatMessagesRepository(pool).count(user_id) == 2  # one message per chat
    state = await SyncStateRepository(pool).get(user_id, "chat")
    assert state["status"] == "ok"
    assert state["delta_link"] is None


@pytest.mark.asyncio
async def test_sync_chat_sets_not_available_when_list_chats_forbidden(pool, test_auth_user):
    user_id, _ = test_auth_user
    request = httpx.Request("GET", "https://graph.microsoft.com/v1.0/me/chats")
    error = httpx.HTTPStatusError("forbidden", request=request, response=httpx.Response(403, request=request))

    with patch("app.services.graph_sync.graph_client.list_chats", side_effect=error), \
         patch("app.services.graph_sync.graph_client.fetch_chat_messages_page") as mock_messages:
        await sync_chat(pool, user_id, "access-token")

    mock_messages.assert_not_called()
    state = await SyncStateRepository(pool).get(user_id, "chat")
    assert state["status"] == "not_available"


@pytest.mark.asyncio
async def test_sync_chat_skips_when_already_not_available(pool, test_auth_user):
    user_id, _ = test_auth_user
    await SyncStateRepository(pool).upsert(user_id, "chat", None, "not_available")

    with patch("app.services.graph_sync.graph_client.list_chats") as mock_list:
        await sync_chat(pool, user_id, "access-token")

    mock_list.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: FAIL with `ImportError: cannot import name 'sync_chat' from 'app.services.graph_sync'`

- [ ] **Step 3: Implement `sync_chat`**

Append to `backend/app/services/graph_sync.py` (add the import at the top alongside `CalendarEventsRepository`):

```python
from app.repositories.chat_messages import ChatMessagesRepository


async def sync_chat(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None:
    sync_state = SyncStateRepository(pool)
    messages = ChatMessagesRepository(pool)

    state = await sync_state.get(user_id, "chat")
    if state is not None and state["status"] == "not_available":
        return

    since = (
        state["last_synced_at"]
        if state and state["last_synced_at"]
        else datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS)
    )

    try:
        chats = await graph_client.list_chats(access_token)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (400, 403):
            await sync_state.upsert(user_id, "chat", None, "not_available")
            return
        raise

    for chat in chats:
        chat_id = chat["id"]
        url = graph_client.chat_messages_url(chat_id, since)
        while url:
            page = await graph_client.fetch_chat_messages_page(access_token, url)
            for item in page["items"]:
                from_user = (item.get("from") or {}).get("user") or {}
                await messages.upsert(
                    user_id=user_id,
                    graph_chat_id=chat_id,
                    graph_message_id=item["id"],
                    from_user=from_user.get("displayName"),
                    content=(item.get("body") or {}).get("content"),
                    sent_at=_parse_graph_datetime(item.get("createdDateTime")),
                )
            url = page["next_link"]

    await sync_state.upsert(user_id, "chat", None, "ok")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/graph_sync.py backend/tests/test_graph_sync_service.py
git commit -m "feat: add sync_chat service function"
```

---

### Task 9: `sync_user` orchestrator

**Files:**
- Modify: `backend/app/services/graph_sync.py`
- Test: Modify `backend/tests/test_graph_sync_service.py` (append)

**Interfaces:**
- Consumes: `sync_mail`, `sync_calendar`, `sync_chat` (Tasks 6-8); `GraphTokensRepository`, `ProfilesRepository` (existing); `graph_client.refresh_access_token`, `GraphRefreshError` (existing); `app.core.security.encrypt_token`/`decrypt_token` (existing); `starlette.concurrency.run_in_threadpool` (existing pattern from `app/api/v1/me.py`).
- Produces: `async def sync_user(pool: asyncpg.Pool, user_id: uuid.UUID) -> None`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_graph_sync_service.py
from datetime import timedelta

from app.core.security import encrypt_token
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.graph_client import GraphRefreshError
from app.services.graph_sync import sync_user


@pytest.mark.asyncio
async def test_sync_user_runs_all_three_resources(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("valid-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Mail.Read", "Calendars.ReadWrite", "Chat.Read"],
    )

    with patch("app.services.graph_sync.sync_mail") as mock_mail, \
         patch("app.services.graph_sync.sync_calendar") as mock_calendar, \
         patch("app.services.graph_sync.sync_chat") as mock_chat:
        mock_mail.return_value = None
        mock_calendar.return_value = None
        mock_chat.return_value = None
        await sync_user(pool, user_id)

    mock_mail.assert_called_once_with(pool, user_id, "valid-access")
    mock_calendar.assert_called_once_with(pool, user_id, "valid-access")
    mock_chat.assert_called_once_with(pool, user_id, "valid-access")


@pytest.mark.asyncio
async def test_sync_user_refreshes_expired_token_first(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("expired-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        scopes=["Mail.Read"],
    )
    refreshed = {
        "access_token": "new-access",
        "refresh_token": "new-refresh",
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
    }

    with patch("app.services.graph_sync.refresh_access_token", return_value=refreshed), \
         patch("app.services.graph_sync.sync_mail") as mock_mail, \
         patch("app.services.graph_sync.sync_calendar"), \
         patch("app.services.graph_sync.sync_chat"):
        await sync_user(pool, user_id)

    mock_mail.assert_called_once_with(pool, user_id, "new-access")
    row = await GraphTokensRepository(pool).get(user_id)
    from app.core.security import decrypt_token
    assert decrypt_token(row["encrypted_access_token"]) == "new-access"


@pytest.mark.asyncio
async def test_sync_user_sets_needs_reauth_on_refresh_failure(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("expired-access"),
        encrypted_refresh_token=encrypt_token("dead-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        scopes=["Mail.Read"],
    )

    with patch("app.services.graph_sync.refresh_access_token", side_effect=GraphRefreshError("expired")), \
         patch("app.services.graph_sync.sync_mail") as mock_mail:
        await sync_user(pool, user_id)

    mock_mail.assert_not_called()
    profile = await ProfilesRepository(pool).get(user_id)
    assert profile["graph_connection_status"] == "needs_reauth"


@pytest.mark.asyncio
async def test_sync_user_noop_when_not_connected(pool, test_auth_user):
    user_id, _ = test_auth_user

    with patch("app.services.graph_sync.sync_mail") as mock_mail:
        await sync_user(pool, user_id)

    mock_mail.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: FAIL with `ImportError: cannot import name 'sync_user' from 'app.services.graph_sync'`

- [ ] **Step 3: Implement `sync_user`**

Add these imports at the top of `backend/app/services/graph_sync.py` (alongside the existing repository imports) and the function at the end:

```python
from starlette.concurrency import run_in_threadpool

from app.core.security import decrypt_token, encrypt_token
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.graph_client import GraphRefreshError, refresh_access_token


async def sync_user(pool: asyncpg.Pool, user_id: uuid.UUID) -> None:
    tokens_repo = GraphTokensRepository(pool)
    profiles_repo = ProfilesRepository(pool)

    token_row = await tokens_repo.get(user_id)
    if token_row is None:
        return

    access_token = decrypt_token(token_row["encrypted_access_token"])

    if token_row["access_token_expires_at"] <= datetime.now(timezone.utc):
        refresh_token = decrypt_token(token_row["encrypted_refresh_token"])
        try:
            refreshed = await run_in_threadpool(
                refresh_access_token, refresh_token, scopes=token_row["scopes"]
            )
        except GraphRefreshError:
            await profiles_repo.set_graph_connection_status(user_id, "needs_reauth")
            return

        await tokens_repo.upsert(
            user_id=user_id,
            encrypted_access_token=encrypt_token(refreshed["access_token"]),
            encrypted_refresh_token=encrypt_token(refreshed["refresh_token"]),
            access_token_expires_at=refreshed["expires_at"],
            scopes=token_row["scopes"],
        )
        access_token = refreshed["access_token"]

    await sync_mail(pool, user_id, access_token)
    await sync_calendar(pool, user_id, access_token)
    await sync_chat(pool, user_id, access_token)
```

Note: this mirrors `app/api/v1/me.py`'s existing refresh-on-expiry pattern exactly, reusing the same repositories and encryption helpers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_graph_sync_service.py -v`
Expected: PASS (19 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: all tests pass (26 from Task 4 + 4 from Task 5 + 19 from Tasks 6-9 = 49)

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/graph_sync.py backend/tests/test_graph_sync_service.py
git commit -m "feat: add sync_user orchestrator"
```

---

### Task 10: Shared-secret config for the bulk sync endpoint

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/.env`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: `settings.sync_secret: str`, consumed by Task 12's bulk endpoint.

- [ ] **Step 1: Add the setting**

In `backend/app/core/config.py`, add `sync_secret: str` to the `Settings` class (no default — fail-fast like the other required secrets):

```python
    ms_authority: str = "https://login.microsoftonline.com/common"
    cors_allow_origins: str = "http://localhost:3000"
    sync_secret: str
```

- [ ] **Step 2: Generate a real secret and add it to `.env`**

Run: `python -c "import secrets; print(secrets.token_urlsafe(32))"`

Add the output to `backend/.env`:
```
SYNC_SECRET=<generated value>
```

- [ ] **Step 3: Add the placeholder to `.env.example`**

```
SYNC_SECRET=
```

- [ ] **Step 4: Verify the app still starts (fail-fast check)**

Run: `cd backend && .venv/Scripts/python -c "from app.core.config import settings; print('ok' if settings.sync_secret else 'missing')"`
Expected: prints `ok`

- [ ] **Step 5: Commit** (only the tracked files — `.env` is gitignored)

```bash
git add backend/app/core/config.py backend/.env.example
git commit -m "feat: add SYNC_SECRET config for the bulk sync endpoint"
```

---

### Task 11: `POST /api/sync/run/me` — on-demand sync endpoint

**Files:**
- Create: `backend/app/api/v1/sync.py`
- Modify: `backend/app/main.py`
- Test: Create `backend/tests/test_sync_endpoint.py`

**Interfaces:**
- Consumes: `sync_user` (Task 9), `get_current_user`/`CurrentUser` (existing, from `app.core.deps`).
- Produces: `router` (`APIRouter(prefix="/api/sync", tags=["sync"])`) with `POST /api/sync/run/me`, registered in `main.py`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_sync_endpoint.py
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app


@pytest.mark.asyncio
async def test_run_me_calls_sync_user_for_current_user(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    with patch("app.api.v1.sync.sync_user", new=AsyncMock()) as mock_sync_user:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/sync/run/me")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    mock_sync_user.assert_called_once()
    called_user_id = mock_sync_user.call_args[0][1]
    assert called_user_id == user_id

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_run_me_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/sync/run/me")

    assert response.status_code in (401, 403)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_sync_endpoint.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api.v1.sync'`

- [ ] **Step 3: Implement the endpoint**

```python
# backend/app/api/v1/sync.py
from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.services.graph_sync import sync_user

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("/run/me")
async def run_my_sync(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    await sync_user(pool, current_user.user_id)
    return {"status": "ok"}
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, add the import and registration alongside the existing routers:

```python
from app.api.v1 import auth, me, sync
```

```python
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(sync.router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_sync_endpoint.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v1/sync.py backend/app/main.py backend/tests/test_sync_endpoint.py
git commit -m "feat: add POST /api/sync/run/me on-demand sync endpoint"
```

---

### Task 12: `POST /api/sync/run` — bulk scheduled sync endpoint

**Files:**
- Modify: `backend/app/api/v1/sync.py`
- Modify: `backend/app/repositories/profiles.py`
- Test: Modify `backend/tests/test_sync_endpoint.py` (append)

**Interfaces:**
- Consumes: `sync_user` (Task 9), `settings.sync_secret` (Task 10).
- Produces:
  - `ProfilesRepository(pool).list_connected() -> list[asyncpg.Record]`
  - `POST /api/sync/run` — header `X-Sync-Secret`, loops every connected user, returns `{"synced": int, "failed": int}`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_sync_endpoint.py
from app.core.config import settings
from app.repositories.profiles import ProfilesRepository


@pytest.mark.asyncio
async def test_run_bulk_requires_correct_secret(pool):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/sync/run", headers={"X-Sync-Secret": "wrong"})

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_run_bulk_syncs_all_connected_users_with_isolation(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).set_graph_connection_status(user_id, "connected")

    async def fake_sync_user(pool_arg, uid):
        if uid == user_id:
            raise RuntimeError("boom")

    with patch("app.api.v1.sync.sync_user", side_effect=fake_sync_user):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/sync/run", headers={"X-Sync-Secret": settings.sync_secret}
            )

    assert response.status_code == 200
    body = response.json()
    assert body["failed"] >= 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_sync_endpoint.py -v`
Expected: FAIL with 404 (route doesn't exist yet) on both new tests

- [ ] **Step 3: Add `list_connected` to `ProfilesRepository`**

In `backend/app/repositories/profiles.py`, add this method to the existing class:

```python
    async def list_connected(self) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            "select * from public.profiles where graph_connection_status = 'connected'"
        )
```

- [ ] **Step 4: Implement the bulk endpoint**

Append to `backend/app/api/v1/sync.py` (add the new imports at the top):

```python
import hmac

from fastapi import Header, HTTPException, status

from app.core.config import settings
from app.repositories.profiles import ProfilesRepository


@router.post("/run")
async def run_bulk_sync(x_sync_secret: str = Header(...)):
    if not hmac.compare_digest(x_sync_secret, settings.sync_secret):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid sync secret")

    pool = await get_pool()
    profiles = await ProfilesRepository(pool).list_connected()

    synced = 0
    failed = 0
    for profile in profiles:
        try:
            await sync_user(pool, profile["id"])
            synced += 1
        except Exception:
            failed += 1

    return {"synced": synced, "failed": failed}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_sync_endpoint.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: all tests pass (49 from Task 9 + 2 from Task 11 + 2 new from this task = 53)

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v1/sync.py backend/app/repositories/profiles.py backend/tests/test_sync_endpoint.py
git commit -m "feat: add POST /api/sync/run bulk scheduled sync endpoint"
```

---

### Task 13: Trigger sync immediately after connecting

**Files:**
- Modify: `backend/app/api/v1/auth.py`
- Test: Modify `backend/tests/test_auth_endpoint.py` (append)

**Interfaces:**
- Consumes: `sync_user` (Task 9).
- Produces: `POST /api/auth/graph-tokens` now schedules a background sync after storing tokens, via FastAPI's `BackgroundTasks` (so the response to the frontend isn't delayed by a full sync).

- [ ] **Step 1: Write the failing test (append to the existing file)**

```python
# append to backend/tests/test_auth_endpoint.py
from unittest.mock import AsyncMock, patch


@pytest.mark.asyncio
async def test_store_graph_tokens_schedules_sync(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    with patch("app.api.v1.auth.sync_user", new=AsyncMock()) as mock_sync_user:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/auth/graph-tokens",
                json={
                    "provider_token": "access-123",
                    "provider_refresh_token": "refresh-456",
                    "expires_in": 3600,
                    "scopes": ["Mail.Read"],
                },
            )

    assert response.status_code == 204
    mock_sync_user.assert_called_once()
    called_user_id = mock_sync_user.call_args[0][1]
    assert called_user_id == user_id

    app.dependency_overrides.clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_auth_endpoint.py -v`
Expected: FAIL — `mock_sync_user.assert_called_once()` fails because nothing is patched at `app.api.v1.auth.sync_user` yet (no such name in that module)

- [ ] **Step 3: Wire the background sync**

Modify `backend/app/api/v1/auth.py`:

```python
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends

from app.core.deps import CurrentUser, get_current_user
from app.core.security import encrypt_token
from app.db.session import get_pool
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.schemas.auth import GraphTokensIn
from app.services.graph_sync import sync_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/graph-tokens", status_code=204)
async def store_graph_tokens(
    body: GraphTokensIn,
    background_tasks: BackgroundTasks,
    current_user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    profiles = ProfilesRepository(pool)
    tokens = GraphTokensRepository(pool)

    await profiles.upsert(current_user.user_id, current_user.email)
    await tokens.upsert(
        user_id=current_user.user_id,
        encrypted_access_token=encrypt_token(body.provider_token),
        encrypted_refresh_token=encrypt_token(body.provider_refresh_token),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(seconds=body.expires_in),
        scopes=body.scopes,
    )
    await profiles.set_graph_connection_status(current_user.user_id, "connected")
    background_tasks.add_task(sync_user, pool, current_user.user_id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_auth_endpoint.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: all tests pass (53 from Task 12 + 1 new from this task = 54)

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v1/auth.py backend/tests/test_auth_endpoint.py
git commit -m "feat: trigger a background sync immediately after connecting Microsoft account"
```

---

### Task 14: External cron workflow

**Files:**
- Create: `.github/workflows/graph-sync-cron.yml`

**Interfaces:**
- Produces: a GitHub Actions scheduled workflow that calls `POST https://ai-relationship-manager-api.onrender.com/api/sync/run` every 15 minutes.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/graph-sync-cron.yml
name: Graph Sync Cron

on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch: {}

jobs:
  trigger-sync:
    runs-on: ubuntu-latest
    steps:
      - name: Call sync endpoint
        run: |
          curl -sf -X POST "https://ai-relationship-manager-api.onrender.com/api/sync/run" \
            -H "X-Sync-Secret: ${{ secrets.SYNC_SECRET }}"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/graph-sync-cron.yml
git commit -m "chore: add external cron workflow to trigger periodic Graph sync"
git push
```

- [ ] **Step 3: Add the secret in GitHub (manual, user)**

GitHub repo → Settings → Secrets and variables → Actions → New repository secret. Name: `SYNC_SECRET`. Value: the same value already in `backend/.env`'s `SYNC_SECRET`.

- [ ] **Step 4: Add the secret in Render (manual, user)**

Render Dashboard → `ai-relationship-manager-api` service → Environment → add `SYNC_SECRET` with the same value.

- [ ] **Step 5: Verify (manual, user)**

GitHub repo → Actions → "Graph Sync Cron" → Run workflow (uses `workflow_dispatch` for an immediate manual test rather than waiting 15 minutes). Expected: green checkmark, no `curl` error (the `-f` flag fails the step on a non-2xx response).

---

### Task 15: Manual acceptance verification

**Files:** none (manual verification only)

**Interfaces:** exercises the full sync chain built in Tasks 1-14 against real Microsoft accounts.

- [ ] **Step 1: Verify sync for a work/school account**

With the backend running (locally or against the deployed Render URL) and a work/school Microsoft account already connected (from Foundation's Task 14), call the on-demand endpoint:

```bash
curl -X POST https://ai-relationship-manager-api.onrender.com/api/sync/run/me \
  -H "Authorization: Bearer <that user's Supabase access token>"
```

Expected: `{"status": "ok"}`.

- [ ] **Step 2: Verify rows landed, via Supabase**

Call `mcp__plugin_supabase_supabase__execute_sql` (or the same direct-`asyncpg` approach used in Foundation's Task 14) against:

```sql
select count(*) from public.emails where user_id = '<work-account-user-id>';
select count(*) from public.calendar_events where user_id = '<work-account-user-id>';
select count(*) from public.chat_messages where user_id = '<work-account-user-id>';
select resource_type, status from public.sync_state where user_id = '<work-account-user-id>';
```

Expected: non-zero counts for mail and calendar (assuming the mailbox/calendar has activity in the last 30 days); `sync_state` shows `status = 'ok'` for all three resource types (chat only if the tenant's admin consent allows `Chat.Read` — see the Foundation spec's risk flag).

- [ ] **Step 3: Verify graceful degradation for a personal account**

Repeat Steps 1-2 for the personal Microsoft account connected in Foundation's Task 14 (`kumarshreyash2504@outlook.com`).

Expected: `emails` and `calendar_events` populate normally; `chat_messages` stays empty; `sync_state` shows `status = 'not_available'` for `chat` and `status = 'ok'` for `mail`/`calendar`.

- [ ] **Step 4: Verify the bulk endpoint end-to-end**

Trigger the GitHub Actions workflow manually (Task 14, Step 5) or wait for its next scheduled run, then re-check `sync_state.last_synced_at` for both test users — expect it to have advanced past the timestamp from Steps 1-3.

No commit for this task (verification only). Once complete, update `.superpowers/sdd/progress.md` with a summary entry for Graph Sync, matching the ledger style used throughout Foundation.

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1), sync trigger paths — scheduled/on-demand/post-connect (Tasks 12, 11, 13), delta mechanics for mail/calendar (Tasks 4, 6, 7), timestamp-filtered chat mechanics (Tasks 5, 8), graceful degradation (Tasks 6-8, verified live in Task 15), error handling — 429 retry (Task 4's `_get_json`), token refresh + `needs_reauth` (Task 9), per-user batch isolation (Task 12), shared-secret auth (Tasks 10, 12) — all covered. Testing strategy's every listed case has a corresponding task-level test.
- **Placeholder scan:** no TBD/TODO; every step ships real, complete code.
- **Type consistency:** `sync_mail`/`sync_calendar`/`sync_chat`/`sync_user` all take `(pool: asyncpg.Pool, user_id: uuid.UUID, ...)` consistently; `fetch_delta_page`/`fetch_chat_messages_page` both return the `{"items", "next_link", ...}` shape consumed identically in Tasks 6-8; `SyncStateRepository.upsert(user_id, resource_type, delta_link, status)` signature matches every call site across Tasks 6-9.
