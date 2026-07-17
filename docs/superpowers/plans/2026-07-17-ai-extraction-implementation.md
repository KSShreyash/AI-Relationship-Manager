# AI Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Graph Sync's raw synced mail/calendar/chat into structured `contacts` (with an LLM-maintained running summary) and `action_items` (commitments, tagged by direction), via OpenAI, processed per-item and incrementally.

**Architecture:** A new `app/services/ai_extraction.py`, structurally parallel to `graph_sync.py`. `extract_user()` is called from inside `sync_user()` right after its three resource syncs (capped), plus gets its own uncapped on-demand endpoint. Participant identity is resolved from Graph's already-synced structured fields before ever calling the LLM — the LLM only interprets content.

**Tech Stack:** FastAPI, asyncpg, OpenAI Python SDK (`AsyncOpenAI`, structured outputs / JSON schema mode, `gpt-4o-mini`).

## Global Constraints

- Contact identity: match by `email_address` when known (mail/calendar); fall back to `display_name` when not (chat-only contacts, "Contacts without email") — never LLM-assisted fuzzy matching.
- Participants are resolved from Graph-synced structured fields (`from_address`, `organizer`/`attendees`, `from_user`) **before** any LLM call — the LLM never decides who's in the conversation.
- Every item's DB writes (contact `notes` upserts + `action_items` inserts + `extracted_at` stamp) happen in **one Postgres transaction** — all-or-nothing, so a crash mid-item never leaves partial state or duplicate `action_items` on retry. The OpenAI call itself happens **before** the transaction opens (a slow/failed LLM call must never hold a DB connection).
- **Per-item isolation is mandatory from the start**: one item's OpenAI call or transaction failure must never abort the batch — skip it (via a bare `except Exception: continue`, matching Graph Sync's own established per-item/per-chat skip pattern, which doesn't log either), leave `extracted_at` null (it retries next run), continue to the next item. This is a direct, deliberate carry-forward from Graph Sync's final review, where the equivalent gaps (`sync_chat` per-chat isolation, `sync_user` per-resource isolation) had to be retrofitted after shipping.
- Content sent to OpenAI is HTML-stripped first (`emails`/`calendar_events` `body_text` currently store raw Graph HTML).
- Automatic path (called from `sync_user`) is capped at `EXTRACTION_BATCH_LIMIT = 50` items per call; the on-demand endpoint (`POST /api/extraction/run/me`) is uncapped (`limit=None`).
- RLS posture on `contacts`/`action_items`: enabled, zero policies — service-role-only access, same as every Graph Sync table.
- OpenAI failures (429, malformed output) never crash the caller: retry once on rate-limit, otherwise the per-item isolation above already covers it.
- A participant whose resolved email matches the user's own `profiles.email` is excluded (never create a "contact" for yourself).

---

### Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/20260717000000_ai_extraction_schema.sql`

**Interfaces:**
- Produces: tables `public.contacts`, `public.action_items`; new nullable `extracted_at` column on `public.emails`, `public.calendar_events`, `public.chat_messages`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260717000000_ai_extraction_schema.sql

alter table public.emails add column extracted_at timestamptz;
alter table public.calendar_events add column extracted_at timestamptz;
alter table public.chat_messages add column extracted_at timestamptz;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  email_address text,
  display_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index contacts_user_email_key
  on public.contacts (user_id, email_address)
  where email_address is not null;

create unique index contacts_user_display_name_key
  on public.contacts (user_id, display_name)
  where email_address is null;

alter table public.contacts enable row level security;
-- Intentionally no policies: only the service_role connection (bypasses RLS) may touch this table.

create table public.action_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  text text not null,
  direction text not null check (direction in ('mine', 'theirs')),
  status text not null default 'open' check (status in ('open', 'done')),
  due_date date,
  source_type text not null check (source_type in ('email', 'calendar_event', 'chat_message')),
  source_id uuid not null,
  created_at timestamptz not null default now()
);

alter table public.action_items enable row level security;
```

- [ ] **Step 2: Apply the migration**

The Supabase MCP connection is not linked to this project (confirmed repeatedly during Graph Sync — `list_projects`/`apply_migration` return permission-denied). Apply directly via `asyncpg` using `backend/.env`'s `DATABASE_URL`, the same pattern used for every Graph Sync migration:

```python
# one-off script, e.g. run via: cd backend && .venv/Scripts/python.exe apply_migration.py
import asyncio
import os
from dotenv import load_dotenv
load_dotenv(os.path.join(os.getcwd(), ".env"))
import asyncpg

async def main():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        with open("../supabase/migrations/20260717000000_ai_extraction_schema.sql") as f:
            sql = f.read()
        await conn.execute(sql)
    finally:
        await conn.close()

asyncio.run(main())
```

- [ ] **Step 3: Verify**

```python
# verify script
rows = await conn.fetch(
    "select table_name from information_schema.tables where table_schema = 'public' "
    "and table_name in ('contacts', 'action_items')"
)
# expect both present
cols = await conn.fetch(
    "select table_name, column_name from information_schema.columns "
    "where table_schema = 'public' and column_name = 'extracted_at'"
)
# expect emails, calendar_events, chat_messages all present
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260717000000_ai_extraction_schema.sql
git commit -m "feat: add AI Extraction schema (contacts, action_items, extracted_at columns)"
```

---

### Task 2: OpenAI config + dependency

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/.env`, `backend/.env.example`
- Modify: `backend/requirements.txt`

**Interfaces:**
- Produces: `settings.openai_api_key: str`, `settings.extraction_batch_limit: int = 50`.

- [ ] **Step 1: Add the settings**

In `backend/app/core/config.py`, add to the `Settings` class:

```python
    sync_secret: str
    openai_api_key: str
    extraction_batch_limit: int = 50
```

- [ ] **Step 2: Add the OpenAI SDK dependency**

In `backend/requirements.txt`, add:

```
openai>=1.50
```

Then `cd backend && .venv/Scripts/pip install -r requirements.txt`.

- [ ] **Step 3: Obtain a real OpenAI API key (manual, user)**

This is a real secret from an external service, not something that can be generated locally. Go to https://platform.openai.com/api-keys, create a new secret key.

- [ ] **Step 4: Add to `.env` / `.env.example`**

Add the real key to `backend/.env` (gitignored):
```
OPENAI_API_KEY=<the real key from platform.openai.com>
```

Add the placeholder to `backend/.env.example`:
```
OPENAI_API_KEY=
```

- [ ] **Step 5: Verify the app still starts (fail-fast check)**

Run: `cd backend && .venv/Scripts/python.exe -c "from app.core.config import settings; print('ok' if settings.openai_api_key else 'missing')"`
Expected: prints `ok`

- [ ] **Step 6: Commit** (only the tracked files — `.env` is gitignored)

```bash
git add backend/app/core/config.py backend/.env.example backend/requirements.txt
git commit -m "feat: add OpenAI config for AI Extraction"
```

---

### Task 3: `ContactsRepository` and `ActionItemsRepository`

**Files:**
- Create: `backend/app/repositories/contacts.py`
- Create: `backend/app/repositories/action_items.py`
- Test: Create `backend/tests/test_ai_extraction_repositories.py`

**Interfaces:**
- Produces:
  - `ContactsRepository(pool).get_by_email(user_id, email_address, conn=None) -> asyncpg.Record | None`
  - `ContactsRepository(pool).get_by_display_name(user_id, display_name, conn=None) -> asyncpg.Record | None`
  - `ContactsRepository(pool).upsert_by_email(user_id, email_address, display_name, notes, conn=None) -> uuid.UUID`
  - `ContactsRepository(pool).upsert_by_display_name(user_id, display_name, notes, conn=None) -> uuid.UUID`
  - `ContactsRepository(pool).count(user_id) -> int`
  - `ActionItemsRepository(pool).insert(user_id, contact_id, text, direction, due_date, source_type, source_id, conn=None) -> None`
  - `ActionItemsRepository(pool).count(user_id) -> int`
  - Every method accepts an optional `conn: asyncpg.Connection | None = None` — when given, writes go through that connection (for atomic multi-step transactions in Task 5); when omitted, they go through `self._pool` directly, same as every existing repository in this codebase.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_ai_extraction_repositories.py
import uuid

import pytest

from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository


@pytest.mark.asyncio
async def test_contacts_upsert_by_email_creates_and_dedupes(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)

    contact_id = await repo.upsert_by_email(user_id, "alice@example.com", "Alice", "Works at Acme")
    assert await repo.count(user_id) == 1

    contact_id_2 = await repo.upsert_by_email(user_id, "alice@example.com", "Alice", "Works at Acme, VP now")
    assert await repo.count(user_id) == 1
    assert contact_id == contact_id_2

    row = await pool.fetchrow("select notes from public.contacts where id = $1", contact_id)
    assert row["notes"] == "Works at Acme, VP now"


@pytest.mark.asyncio
async def test_contacts_upsert_by_display_name_creates_and_dedupes(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)

    contact_id = await repo.upsert_by_display_name(user_id, "Bob", "Chatted about the project")
    assert await repo.count(user_id) == 1

    contact_id_2 = await repo.upsert_by_display_name(user_id, "Bob", "Chatted about the project again")
    assert await repo.count(user_id) == 1
    assert contact_id == contact_id_2

    row = await pool.fetchrow("select email_address, notes from public.contacts where id = $1", contact_id)
    assert row["email_address"] is None
    assert row["notes"] == "Chatted about the project again"


@pytest.mark.asyncio
async def test_contacts_email_and_no_email_contacts_are_independent(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)

    await repo.upsert_by_email(user_id, "carol@example.com", "Carol", "notes A")
    await repo.upsert_by_display_name(user_id, "Dave", "notes B")
    await repo.upsert_by_display_name(user_id, "Eve", "notes C")

    assert await repo.count(user_id) == 3


@pytest.mark.asyncio
async def test_contacts_get_by_email_and_display_name(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)

    await repo.upsert_by_email(user_id, "frank@example.com", "Frank", "notes")
    await repo.upsert_by_display_name(user_id, "Grace", "notes")

    found = await repo.get_by_email(user_id, "frank@example.com")
    assert found is not None
    assert found["display_name"] == "Frank"

    missing = await repo.get_by_email(user_id, "nobody@example.com")
    assert missing is None

    found2 = await repo.get_by_display_name(user_id, "Grace")
    assert found2 is not None

    missing2 = await repo.get_by_display_name(user_id, "Nobody")
    assert missing2 is None


@pytest.mark.asyncio
async def test_action_items_insert_and_count(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "henry@example.com", "Henry", None)

    repo = ActionItemsRepository(pool)
    await repo.insert(
        user_id=user_id,
        contact_id=contact_id,
        text="Send the deck",
        direction="mine",
        due_date=None,
        source_type="email",
        source_id=uuid.uuid4(),
    )
    assert await repo.count(user_id) == 1


@pytest.mark.asyncio
async def test_action_items_insert_with_null_contact_id(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)

    repo = ActionItemsRepository(pool)
    await repo.insert(
        user_id=user_id,
        contact_id=None,
        text="Follow up on something",
        direction="theirs",
        due_date=None,
        source_type="chat_message",
        source_id=uuid.uuid4(),
    )
    assert await repo.count(user_id) == 1

    row = await pool.fetchrow("select contact_id, status from public.action_items where user_id = $1", user_id)
    assert row["contact_id"] is None
    assert row["status"] == "open"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_ai_extraction_repositories.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.repositories.contacts'`

- [ ] **Step 3: Implement `ContactsRepository`**

```python
# backend/app/repositories/contacts.py
import uuid

import asyncpg


class ContactsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def get_by_email(
        self, user_id: uuid.UUID, email_address: str, conn: asyncpg.Connection | None = None
    ) -> asyncpg.Record | None:
        executor = conn or self._pool
        return await executor.fetchrow(
            "select * from public.contacts where user_id = $1 and email_address = $2",
            user_id,
            email_address,
        )

    async def get_by_display_name(
        self, user_id: uuid.UUID, display_name: str, conn: asyncpg.Connection | None = None
    ) -> asyncpg.Record | None:
        executor = conn or self._pool
        return await executor.fetchrow(
            "select * from public.contacts where user_id = $1 and display_name = $2 and email_address is null",
            user_id,
            display_name,
        )

    async def upsert_by_email(
        self,
        user_id: uuid.UUID,
        email_address: str,
        display_name: str | None,
        notes: str | None,
        conn: asyncpg.Connection | None = None,
    ) -> uuid.UUID:
        executor = conn or self._pool
        row = await executor.fetchrow(
            """
            insert into public.contacts (user_id, email_address, display_name, notes, updated_at)
            values ($1, $2, $3, $4, now())
            on conflict (user_id, email_address) where email_address is not null do update
            set display_name = coalesce(excluded.display_name, public.contacts.display_name),
                notes = excluded.notes,
                updated_at = now()
            returning id
            """,
            user_id,
            email_address,
            display_name,
            notes,
        )
        return row["id"]

    async def upsert_by_display_name(
        self,
        user_id: uuid.UUID,
        display_name: str,
        notes: str | None,
        conn: asyncpg.Connection | None = None,
    ) -> uuid.UUID:
        executor = conn or self._pool
        row = await executor.fetchrow(
            """
            insert into public.contacts (user_id, email_address, display_name, notes, updated_at)
            values ($1, null, $2, $3, now())
            on conflict (user_id, display_name) where email_address is null do update
            set notes = excluded.notes,
                updated_at = now()
            returning id
            """,
            user_id,
            display_name,
            notes,
        )
        return row["id"]

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.contacts where user_id = $1",
            user_id,
        )
```

- [ ] **Step 4: Implement `ActionItemsRepository`**

```python
# backend/app/repositories/action_items.py
import uuid
from datetime import date

import asyncpg


class ActionItemsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def insert(
        self,
        user_id: uuid.UUID,
        contact_id: uuid.UUID | None,
        text: str,
        direction: str,
        due_date: date | None,
        source_type: str,
        source_id: uuid.UUID,
        conn: asyncpg.Connection | None = None,
    ) -> None:
        executor = conn or self._pool
        await executor.execute(
            """
            insert into public.action_items
                (user_id, contact_id, text, direction, status, due_date, source_type, source_id)
            values ($1, $2, $3, $4, 'open', $5, $6, $7)
            """,
            user_id,
            contact_id,
            text,
            direction,
            due_date,
            source_type,
            source_id,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.action_items where user_id = $1",
            user_id,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_ai_extraction_repositories.py -v`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/repositories/contacts.py backend/app/repositories/action_items.py backend/tests/test_ai_extraction_repositories.py
git commit -m "feat: add ContactsRepository and ActionItemsRepository"
```

---

### Task 4: OpenAI client wrapper

**Files:**
- Create: `backend/app/services/openai_client.py`
- Test: Create `backend/tests/test_openai_client.py`

**Interfaces:**
- Consumes: `settings.openai_api_key` (Task 2).
- Produces: `async def extract(content: str, participants: list[dict]) -> dict` — `participants` is `[{"ref": str, "email": str|None, "name": str|None, "notes": str|None}, ...]`; returns `{"people": [{"ref": str, "notes": str}], "action_items": [{"text": str, "direction": "mine"|"theirs", "due_date": str|None, "participant_ref": str|None}]}`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_openai_client.py
import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from openai import RateLimitError

from app.services.openai_client import extract


def _mock_response(payload: dict) -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=json.dumps(payload)))]
    return response


def _rate_limit_error() -> RateLimitError:
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    response = httpx.Response(429, request=request, json={"error": {"message": "rate limited"}})
    return RateLimitError("rate limited", response=response, body=None)


@pytest.mark.asyncio
async def test_extract_returns_parsed_json():
    payload = {"people": [{"ref": "p0", "notes": "Works at Acme"}], "action_items": []}
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=_mock_response(payload))

    with patch("app.services.openai_client._client", return_value=mock_client):
        result = await extract(
            "Hi, I work at Acme.",
            [{"ref": "p0", "email": "a@example.com", "name": None, "notes": None}],
        )

    assert result == payload
    mock_client.chat.completions.create.assert_called_once()
    _, kwargs = mock_client.chat.completions.create.call_args
    assert kwargs["model"] == "gpt-4o-mini"
    assert "response_format" in kwargs


@pytest.mark.asyncio
async def test_extract_retries_once_on_rate_limit():
    payload = {"people": [], "action_items": []}
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(
        side_effect=[_rate_limit_error(), _mock_response(payload)]
    )

    with patch("app.services.openai_client._client", return_value=mock_client), \
         patch("app.services.openai_client.asyncio.sleep", new=AsyncMock()):
        result = await extract("content", [])

    assert result == payload
    assert mock_client.chat.completions.create.call_count == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_openai_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.openai_client'`

- [ ] **Step 3: Implement `openai_client.py`**

```python
# backend/app/services/openai_client.py
import asyncio
import json

from openai import AsyncOpenAI, RateLimitError

from app.core.config import settings

MODEL = "gpt-4o-mini"

_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "extraction_result",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "people": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ref": {"type": "string"},
                            "notes": {"type": "string"},
                        },
                        "required": ["ref", "notes"],
                        "additionalProperties": False,
                    },
                },
                "action_items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string"},
                            "direction": {"type": "string", "enum": ["mine", "theirs"]},
                            "due_date": {"type": ["string", "null"]},
                            "participant_ref": {"type": ["string", "null"]},
                        },
                        "required": ["text", "direction", "due_date", "participant_ref"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["people", "action_items"],
            "additionalProperties": False,
        },
    },
}


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key)


def _build_prompt(content: str, participants: list[dict]) -> str:
    participant_lines = "\n".join(
        f"- {p['ref']}: {p.get('name') or p.get('email') or 'unknown'}"
        f" (existing notes: {p.get('notes') or 'none'})"
        for p in participants
    )
    return (
        "You are extracting relationship facts and action items from a piece of "
        "communication (email, calendar event, or chat message) for a personal "
        "relationship-management tool.\n\n"
        f"Known participants:\n{participant_lines}\n\n"
        f"Content:\n{content}\n\n"
        "For each participant, write an updated 'notes' field: a short, synthesized "
        "summary of what's known about them, incorporating any new information from "
        "this content into their existing notes (rewrite for clarity, don't just "
        "append). If nothing new is learned about a participant, return their notes "
        "unchanged (or an empty string if they had none).\n\n"
        "Also extract any action items/commitments mentioned: things the user (the "
        "mailbox owner) will do for someone ('mine'), or things someone else "
        "committed to do for the user ('theirs'). Include participant_ref (matching "
        "one of the refs above) when the item clearly relates to one participant, "
        "else null. Include due_date (YYYY-MM-DD) only if stated or clearly implied, "
        "else null. Return an empty action_items list if there are none."
    )


async def extract(content: str, participants: list[dict]) -> dict:
    prompt = _build_prompt(content, participants)
    messages = [{"role": "user", "content": prompt}]
    client = _client()
    try:
        response = await client.chat.completions.create(
            model=MODEL, messages=messages, response_format=_SCHEMA
        )
    except RateLimitError:
        await asyncio.sleep(5)
        response = await client.chat.completions.create(
            model=MODEL, messages=messages, response_format=_SCHEMA
        )
    return json.loads(response.choices[0].message.content)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_openai_client.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/openai_client.py backend/tests/test_openai_client.py
git commit -m "feat: add OpenAI client wrapper for structured extraction"
```

---

### Task 5: `ai_extraction.py` core — HTML stripping, due-date parsing, `_process_item`

**Files:**
- Create: `backend/app/services/ai_extraction.py`
- Test: Create `backend/tests/test_ai_extraction_service.py`

**Interfaces:**
- Consumes: `openai_client.extract` (Task 4), `ContactsRepository`, `ActionItemsRepository` (Task 3).
- Produces:
  - `_strip_html(value: str | None) -> str | None` (module-private, reused by Task 6)
  - `_parse_due_date(value: str | None) -> date | None` (module-private, reused by Task 6)
  - `async def _process_item(pool, user_id, source_type, source_id, content, participants, own_email) -> None` (module-private, reused by Task 6) — `participants: list[tuple[str | None, str | None]]` of `(email_address, display_name)` pairs.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_ai_extraction_service.py
import uuid
from unittest.mock import patch

import pytest

from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository
from app.services.ai_extraction import _parse_due_date, _process_item, _strip_html


def test_strip_html_removes_tags_and_unescapes_entities():
    assert _strip_html("<p>Hi &amp; welcome</p>") == "Hi & welcome"


def test_strip_html_handles_none():
    assert _strip_html(None) is None


def test_strip_html_collapses_whitespace():
    assert _strip_html("<div>a</div>\n\n<div>b</div>") == "a b"


def test_parse_due_date_valid_iso():
    assert _parse_due_date("2026-08-01").isoformat() == "2026-08-01"


def test_parse_due_date_none_and_invalid():
    assert _parse_due_date(None) is None
    assert _parse_due_date("not-a-date") is None


@pytest.mark.asyncio
async def test_process_item_creates_contact_and_action_item(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)

    result = {
        "people": [{"ref": "p0", "notes": "Works at Acme"}],
        "action_items": [
            {"text": "Send the deck", "direction": "mine", "due_date": "2026-08-01", "participant_ref": "p0"}
        ],
    }
    source_id = uuid.uuid4()

    with patch("app.services.ai_extraction.openai_client.extract", return_value=result):
        await _process_item(
            pool, user_id, "email", source_id, "content",
            [("alice@example.com", "Alice")], own_email=email,
        )

    assert await ContactsRepository(pool).count(user_id) == 1
    assert await ActionItemsRepository(pool).count(user_id) == 1

    contact = await ContactsRepository(pool).get_by_email(user_id, "alice@example.com")
    assert contact["notes"] == "Works at Acme"

    item = await pool.fetchrow(
        "select contact_id, due_date, source_type, source_id from public.action_items where user_id = $1",
        user_id,
    )
    assert item["contact_id"] == contact["id"]
    assert item["due_date"].isoformat() == "2026-08-01"
    assert item["source_type"] == "email"
    assert item["source_id"] == source_id


@pytest.mark.asyncio
async def test_process_item_marks_extracted(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    row = await pool.fetchrow(
        "insert into public.emails (user_id, graph_message_id) values ($1, $2) returning id",
        user_id, "msg-1",
    )
    source_id = row["id"]

    result = {"people": [], "action_items": []}
    with patch("app.services.ai_extraction.openai_client.extract", return_value=result):
        await _process_item(pool, user_id, "email", source_id, "content", [], own_email=email)

    row = await pool.fetchrow("select extracted_at from public.emails where id = $1", source_id)
    assert row["extracted_at"] is not None


@pytest.mark.asyncio
async def test_process_item_uses_display_name_when_no_email(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)

    result = {"people": [{"ref": "p0", "notes": "Chatted about launch"}], "action_items": []}
    with patch("app.services.ai_extraction.openai_client.extract", return_value=result):
        await _process_item(
            pool, user_id, "chat_message", uuid.uuid4(), "content",
            [(None, "Bob")], own_email=email,
        )

    contact = await ContactsRepository(pool).get_by_display_name(user_id, "Bob")
    assert contact is not None
    assert contact["email_address"] is None
    assert contact["notes"] == "Chatted about launch"


@pytest.mark.asyncio
async def test_process_item_excludes_own_email_from_participants(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)

    with patch("app.services.ai_extraction.openai_client.extract") as mock_extract:
        mock_extract.return_value = {"people": [], "action_items": []}
        await _process_item(
            pool, user_id, "calendar_event", uuid.uuid4(), "content",
            [(email, "Me"), ("other@example.com", "Other")], own_email=email,
        )

    call_args = mock_extract.call_args[0]
    participants_arg = call_args[1]
    assert all(p["email"] != email for p in participants_arg)
    assert any(p["email"] == "other@example.com" for p in participants_arg)


@pytest.mark.asyncio
async def test_process_item_no_participants_skips_openai_but_still_marks_extracted(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    row = await pool.fetchrow(
        "insert into public.emails (user_id, graph_message_id) values ($1, $2) returning id",
        user_id, "msg-2",
    )
    source_id = row["id"]

    with patch("app.services.ai_extraction.openai_client.extract") as mock_extract:
        await _process_item(pool, user_id, "email", source_id, "content", [], own_email=email)

    mock_extract.assert_not_called()
    row = await pool.fetchrow("select extracted_at from public.emails where id = $1", source_id)
    assert row["extracted_at"] is not None


@pytest.mark.asyncio
async def test_process_item_rolls_back_on_action_item_failure(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    row = await pool.fetchrow(
        "insert into public.emails (user_id, graph_message_id) values ($1, $2) returning id",
        user_id, "msg-3",
    )
    source_id = row["id"]

    result = {
        "people": [{"ref": "p0", "notes": "notes"}],
        "action_items": [
            # invalid direction violates the action_items check constraint,
            # forcing the transaction to fail after the contact upsert already ran
            {"text": "bad", "direction": "not-a-real-direction", "due_date": None, "participant_ref": "p0"}
        ],
    }

    with patch("app.services.ai_extraction.openai_client.extract", return_value=result):
        with pytest.raises(Exception):
            await _process_item(
                pool, user_id, "email", source_id, "content",
                [("carl@example.com", "Carl")], own_email=email,
            )

    # Nothing committed: no contact, no action item, extracted_at still null
    assert await ContactsRepository(pool).count(user_id) == 0
    assert await ActionItemsRepository(pool).count(user_id) == 0
    row = await pool.fetchrow("select extracted_at from public.emails where id = $1", source_id)
    assert row["extracted_at"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_ai_extraction_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.ai_extraction'`

- [ ] **Step 3: Implement the core of `ai_extraction.py`**

```python
# backend/app/services/ai_extraction.py
import re
import uuid
from datetime import date
from html import unescape

import asyncpg

from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository
from app.services import openai_client

EXTRACTION_BATCH_LIMIT = 50
_UNBOUNDED = 1_000_000

_TABLES = {
    "email": "emails",
    "calendar_event": "calendar_events",
    "chat_message": "chat_messages",
}


def _strip_html(value: str | None) -> str | None:
    if not value:
        return value
    text = re.sub(r"<[^>]+>", " ", value)
    text = unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _parse_due_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


async def _process_item(
    pool: asyncpg.Pool,
    user_id: uuid.UUID,
    source_type: str,
    source_id: uuid.UUID,
    content: str,
    participants: list[tuple[str | None, str | None]],
    own_email: str | None,
) -> None:
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)

    resolved: list[dict] = []
    for i, (email_address, display_name) in enumerate(participants):
        if email_address and own_email and email_address.lower() == own_email.lower():
            continue
        if not email_address and not display_name:
            continue
        ref = f"p{i}"
        if email_address:
            existing = await contacts.get_by_email(user_id, email_address)
        else:
            existing = await contacts.get_by_display_name(user_id, display_name)
        resolved.append(
            {
                "ref": ref,
                "email": email_address,
                "name": display_name or (existing["display_name"] if existing else None),
                "notes": existing["notes"] if existing else None,
            }
        )

    if resolved:
        result = await openai_client.extract(content, resolved)
    else:
        result = {"people": [], "action_items": []}

    table = _TABLES[source_type]
    async with pool.acquire() as conn:
        async with conn.transaction():
            ref_to_contact_id: dict[str, uuid.UUID] = {}
            for person in result.get("people", []):
                match = next((p for p in resolved if p["ref"] == person["ref"]), None)
                if match is None:
                    continue
                if match["email"]:
                    contact_id = await contacts.upsert_by_email(
                        user_id, match["email"], match["name"], person["notes"], conn=conn
                    )
                else:
                    contact_id = await contacts.upsert_by_display_name(
                        user_id, match["name"], person["notes"], conn=conn
                    )
                ref_to_contact_id[match["ref"]] = contact_id

            for item in result.get("action_items", []):
                contact_id = ref_to_contact_id.get(item.get("participant_ref"))
                await action_items.insert(
                    user_id=user_id,
                    contact_id=contact_id,
                    text=item["text"],
                    direction=item["direction"],
                    due_date=_parse_due_date(item.get("due_date")),
                    source_type=source_type,
                    source_id=source_id,
                    conn=conn,
                )

            await conn.execute(
                f"update public.{table} set extracted_at = now() where id = $1",
                source_id,
            )
```

Note: `_process_item`'s test for rollback (`test_process_item_rolls_back_on_action_item_failure`) relies on the `action_items.direction` check constraint from Task 1's migration to force a mid-transaction failure — no application-level validation is added for this, the DB constraint is the enforcement.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_ai_extraction_service.py -v`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/ai_extraction.py backend/tests/test_ai_extraction_service.py
git commit -m "feat: add ai_extraction core (HTML stripping, due-date parsing, _process_item)"
```

---

### Task 6: Per-source scan functions + `extract_user` orchestrator

**Files:**
- Modify: `backend/app/services/ai_extraction.py`
- Test: Modify `backend/tests/test_ai_extraction_service.py` (append)

**Interfaces:**
- Consumes: `_process_item`, `_strip_html` (Task 5).
- Produces: `async def extract_user(pool: asyncpg.Pool, user_id: uuid.UUID, limit: int | None) -> None`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_ai_extraction_service.py
import json as json_module

from app.services.ai_extraction import extract_user


@pytest.mark.asyncio
async def test_extract_user_processes_pending_email(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    row = await pool.fetchrow(
        "insert into public.emails (user_id, graph_message_id, from_address, subject, body_text) "
        "values ($1, $2, $3, $4, $5) returning id",
        user_id, "msg-x", "irene@example.com", "Hello", "<p>Hi there</p>",
    )

    result = {"people": [{"ref": "p0", "notes": "Said hi"}], "action_items": []}
    with patch("app.services.ai_extraction.openai_client.extract", return_value=result) as mock_extract:
        await extract_user(pool, user_id, limit=10)

    mock_extract.assert_called_once()
    content_arg = mock_extract.call_args[0][0]
    assert "<p>" not in content_arg  # HTML was stripped before reaching the LLM
    assert await ContactsRepository(pool).count(user_id) == 1

    updated = await pool.fetchrow("select extracted_at from public.emails where id = $1", row["id"])
    assert updated["extracted_at"] is not None


@pytest.mark.asyncio
async def test_extract_user_processes_calendar_event_with_multiple_attendees(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await pool.execute(
        "insert into public.calendar_events (user_id, graph_event_id, organizer, attendees, subject, body_text) "
        "values ($1, $2, $3, $4::jsonb, $5, $6)",
        user_id, "evt-x", "jane@example.com",
        json_module.dumps([{"address": "jane@example.com", "name": "Jane"}, {"address": "kyle@example.com", "name": "Kyle"}]),
        "Sync", "Weekly sync",
    )

    result = {"people": [], "action_items": []}
    with patch("app.services.ai_extraction.openai_client.extract", return_value=result) as mock_extract:
        await extract_user(pool, user_id, limit=10)

    mock_extract.assert_called_once()
    participants_arg = mock_extract.call_args[0][1]
    # organizer (jane) also appears in attendees - must be deduped to one
    # participant ref, not two, even though the raw data mentions her twice.
    assert len(participants_arg) == 2
    jane = next(p for p in participants_arg if p["email"] == "jane@example.com")
    assert jane["name"] == "Jane"
    assert any(p["email"] == "kyle@example.com" for p in participants_arg)


@pytest.mark.asyncio
async def test_extract_user_processes_chat_message_by_display_name(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await pool.execute(
        "insert into public.chat_messages (user_id, graph_chat_id, graph_message_id, from_user, content) "
        "values ($1, $2, $3, $4, $5)",
        user_id, "chat-1", "cm-1", "Laura", "Can you send that file?",
    )

    result = {"people": [{"ref": "p0", "notes": "Asked for a file"}], "action_items": []}
    with patch("app.services.ai_extraction.openai_client.extract", return_value=result):
        await extract_user(pool, user_id, limit=10)

    contact = await ContactsRepository(pool).get_by_display_name(user_id, "Laura")
    assert contact is not None


@pytest.mark.asyncio
async def test_extract_user_respects_limit_across_tables(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    for i in range(3):
        await pool.execute(
            "insert into public.emails (user_id, graph_message_id, from_address, subject, body_text) "
            "values ($1, $2, $3, $4, $5)",
            user_id, f"msg-limit-{i}", f"person{i}@example.com", "Hi", "content",
        )

    result = {"people": [], "action_items": []}
    with patch("app.services.ai_extraction.openai_client.extract", return_value=result) as mock_extract:
        await extract_user(pool, user_id, limit=2)

    assert mock_extract.call_count == 2
    remaining = await pool.fetchval(
        "select count(*) from public.emails where user_id = $1 and extracted_at is null", user_id
    )
    assert remaining == 1


@pytest.mark.asyncio
async def test_extract_user_unbounded_processes_everything(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    for i in range(3):
        await pool.execute(
            "insert into public.emails (user_id, graph_message_id, from_address, subject, body_text) "
            "values ($1, $2, $3, $4, $5)",
            user_id, f"msg-unbounded-{i}", f"person{i}@example.com", "Hi", "content",
        )

    result = {"people": [], "action_items": []}
    with patch("app.services.ai_extraction.openai_client.extract", return_value=result):
        await extract_user(pool, user_id, limit=None)

    remaining = await pool.fetchval(
        "select count(*) from public.emails where user_id = $1 and extracted_at is null", user_id
    )
    assert remaining == 0


@pytest.mark.asyncio
async def test_extract_user_isolates_per_item_failures(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await pool.execute(
        "insert into public.emails (user_id, graph_message_id, from_address, subject, body_text) "
        "values ($1, $2, $3, $4, $5)",
        user_id, "msg-fail", "fail@example.com", "Hi", "content",
    )
    await pool.execute(
        "insert into public.emails (user_id, graph_message_id, from_address, subject, body_text) "
        "values ($1, $2, $3, $4, $5)",
        user_id, "msg-ok", "ok@example.com", "Hi", "content",
    )

    async def fake_extract(content, participants):
        if participants[0]["email"] == "fail@example.com":
            raise RuntimeError("boom")
        return {"people": [], "action_items": []}

    with patch("app.services.ai_extraction.openai_client.extract", side_effect=fake_extract):
        await extract_user(pool, user_id, limit=10)

    failed_row = await pool.fetchrow(
        "select extracted_at from public.emails where user_id = $1 and graph_message_id = $2", user_id, "msg-fail"
    )
    ok_row = await pool.fetchrow(
        "select extracted_at from public.emails where user_id = $1 and graph_message_id = $2", user_id, "msg-ok"
    )
    assert failed_row["extracted_at"] is None
    assert ok_row["extracted_at"] is not None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_ai_extraction_service.py -v`
Expected: FAIL with `ImportError: cannot import name 'extract_user' from 'app.services.ai_extraction'`

- [ ] **Step 3: Implement the scan functions and `extract_user`**

Append to `backend/app/services/ai_extraction.py`:

```python
async def _extract_pending_emails(
    pool: asyncpg.Pool, user_id: uuid.UUID, own_email: str | None, limit: int | None
) -> int:
    rows = await pool.fetch(
        "select id, from_address, subject, body_text from public.emails "
        "where user_id = $1 and extracted_at is null "
        "order by received_at asc nulls last limit $2",
        user_id,
        limit if limit is not None else _UNBOUNDED,
    )
    processed = 0
    for row in rows:
        content = f"Subject: {row['subject'] or ''}\n\n{_strip_html(row['body_text']) or ''}"
        try:
            await _process_item(
                pool, user_id, "email", row["id"], content,
                [(row["from_address"], None)], own_email,
            )
        except Exception:
            continue
        processed += 1
    return processed


async def _extract_pending_calendar_events(
    pool: asyncpg.Pool, user_id: uuid.UUID, own_email: str | None, limit: int | None
) -> int:
    import json

    rows = await pool.fetch(
        "select id, organizer, attendees, subject, body_text from public.calendar_events "
        "where user_id = $1 and extracted_at is null "
        "order by start_time asc nulls last limit $2",
        user_id,
        limit if limit is not None else _UNBOUNDED,
    )
    processed = 0
    for row in rows:
        content = f"Subject: {row['subject'] or ''}\n\n{_strip_html(row['body_text']) or ''}"

        raw_people: list[tuple[str | None, str | None]] = []
        if row["organizer"]:
            raw_people.append((row["organizer"], None))
        attendees = json.loads(row["attendees"]) if row["attendees"] else []
        for attendee in attendees:
            attendee_email = attendee.get("address")
            attendee_name = attendee.get("name")
            if attendee_email or attendee_name:
                raw_people.append((attendee_email, attendee_name))

        # Dedupe: the organizer is frequently also present in the attendees
        # list, and would otherwise produce two participant refs for the
        # same person - harmless (both resolve/upsert to the same contact
        # row) but wasteful and confusing to include twice in the LLM
        # prompt. Prefer whichever occurrence has a name.
        by_email: dict[str, tuple[str | None, str | None]] = {}
        no_email: list[tuple[str | None, str | None]] = []
        for person_email, person_name in raw_people:
            if person_email:
                key = person_email.lower()
                current = by_email.get(key)
                if current is None or (person_name and not current[1]):
                    by_email[key] = (person_email, person_name)
            elif not any(existing_name == person_name for _, existing_name in no_email):
                no_email.append((None, person_name))
        participants = list(by_email.values()) + no_email

        try:
            await _process_item(pool, user_id, "calendar_event", row["id"], content, participants, own_email)
        except Exception:
            continue
        processed += 1
    return processed


async def _extract_pending_chat_messages(
    pool: asyncpg.Pool, user_id: uuid.UUID, own_email: str | None, limit: int | None
) -> int:
    rows = await pool.fetch(
        "select id, from_user, content from public.chat_messages "
        "where user_id = $1 and extracted_at is null "
        "order by sent_at asc nulls last limit $2",
        user_id,
        limit if limit is not None else _UNBOUNDED,
    )
    processed = 0
    for row in rows:
        content = _strip_html(row["content"]) or ""
        try:
            await _process_item(
                pool, user_id, "chat_message", row["id"], content,
                [(None, row["from_user"])], own_email,
            )
        except Exception:
            continue
        processed += 1
    return processed


async def extract_user(pool: asyncpg.Pool, user_id: uuid.UUID, limit: int | None) -> None:
    profile = await ProfilesRepository(pool).get(user_id)
    own_email = profile["email"] if profile else None

    remaining = limit
    for scan_fn in (_extract_pending_emails, _extract_pending_calendar_events, _extract_pending_chat_messages):
        if remaining is not None and remaining <= 0:
            break
        processed = await scan_fn(pool, user_id, own_email, remaining)
        if remaining is not None:
            remaining -= processed
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_ai_extraction_service.py -v`
Expected: PASS (17 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all tests pass (63 baseline + 6 from Task 3 + 2 from Task 4 + 17 from Tasks 5-6 = 88)

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/ai_extraction.py backend/tests/test_ai_extraction_service.py
git commit -m "feat: add extract_user orchestrator with per-item isolation and capping"
```

---

### Task 7: Wire `extract_user` into Graph Sync's `sync_user`

**Files:**
- Modify: `backend/app/services/graph_sync.py`
- Test: Modify `backend/tests/test_graph_sync_service.py` (append)

**Interfaces:**
- Consumes: `extract_user` (Task 6), `settings.extraction_batch_limit` (Task 2).
- Produces: `sync_user` now also runs extraction after its own three resource syncs, capped, with extraction failures never propagating out of `sync_user`.

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```python
# append to backend/tests/test_graph_sync_service.py


@pytest.mark.asyncio
async def test_sync_user_runs_extraction_after_sync(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("valid-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Mail.Read"],
    )

    with patch("app.services.graph_sync.sync_mail"), \
         patch("app.services.graph_sync.sync_calendar"), \
         patch("app.services.graph_sync.sync_chat"), \
         patch("app.services.graph_sync.extract_user") as mock_extract_user:
        await sync_user(pool, user_id)

    mock_extract_user.assert_called_once()
    call_args = mock_extract_user.call_args[0]
    assert call_args[0] is pool
    assert call_args[1] == user_id


@pytest.mark.asyncio
async def test_sync_user_extraction_failure_does_not_propagate(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("valid-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Mail.Read"],
    )

    with patch("app.services.graph_sync.sync_mail"), \
         patch("app.services.graph_sync.sync_calendar"), \
         patch("app.services.graph_sync.sync_chat"), \
         patch("app.services.graph_sync.extract_user", side_effect=RuntimeError("extraction boom")):
        await sync_user(pool, user_id)  # must not raise


@pytest.mark.asyncio
async def test_sync_user_still_attempts_extraction_when_a_resource_sync_fails(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("valid-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Mail.Read"],
    )

    with patch("app.services.graph_sync.sync_mail", side_effect=RuntimeError("mail boom")), \
         patch("app.services.graph_sync.sync_calendar"), \
         patch("app.services.graph_sync.sync_chat"), \
         patch("app.services.graph_sync.extract_user") as mock_extract_user:
        with pytest.raises(RuntimeError, match="mail boom"):
            await sync_user(pool, user_id)

    mock_extract_user.assert_called_once()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_graph_sync_service.py -v`
Expected: FAIL — `test_sync_user_runs_extraction_after_sync` fails with `AttributeError` (no `extract_user` attribute on `app.services.graph_sync`), the other two fail similarly.

- [ ] **Step 3: Wire the call**

In `backend/app/services/graph_sync.py`, add the import at the top alongside the existing ones:

```python
from app.core.config import settings
from app.services.ai_extraction import extract_user
```

Modify `sync_user`'s tail — replace:

```python
    if errors:
        raise errors[0]
```

with:

```python
    try:
        await extract_user(pool, user_id, settings.extraction_batch_limit)
    except Exception:
        pass

    if errors:
        raise errors[0]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_graph_sync_service.py -v`
Expected: PASS (30 tests: 27 existing + 3 new)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all tests pass (88 from Task 6 + 3 new = 91)

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/graph_sync.py backend/tests/test_graph_sync_service.py
git commit -m "feat: run capped extraction after each Graph sync"
```

---

### Task 8: `POST /api/extraction/run/me` — on-demand, uncapped extraction endpoint

**Files:**
- Create: `backend/app/api/v1/extraction.py`
- Modify: `backend/app/main.py`
- Test: Create `backend/tests/test_extraction_endpoint.py`

**Interfaces:**
- Consumes: `extract_user` (Task 6), `get_current_user`/`CurrentUser` (existing).
- Produces: `router` (`APIRouter(prefix="/api/extraction", tags=["extraction"])`) with `POST /api/extraction/run/me`, registered in `main.py`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_extraction_endpoint.py
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app


@pytest.mark.asyncio
async def test_run_me_calls_extract_user_uncapped_for_current_user(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    try:
        with patch("app.api.v1.extraction.extract_user", new=AsyncMock()) as mock_extract_user:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post("/api/extraction/run/me")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        mock_extract_user.assert_called_once()
        called_user_id = mock_extract_user.call_args[0][1]
        called_limit = mock_extract_user.call_args[0][2]
        assert called_user_id == user_id
        assert called_limit is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_run_me_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/extraction/run/me")

    assert response.status_code in (401, 403)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_extraction_endpoint.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api.v1.extraction'`

- [ ] **Step 3: Implement the endpoint**

```python
# backend/app/api/v1/extraction.py
from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.services.ai_extraction import extract_user

router = APIRouter(prefix="/api/extraction", tags=["extraction"])


@router.post("/run/me")
async def run_my_extraction(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    await extract_user(pool, current_user.user_id, None)
    return {"status": "ok"}
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, change:

```python
from app.api.v1 import auth, me, sync
```

to:

```python
from app.api.v1 import auth, extraction, me, sync
```

and add, alongside the existing `app.include_router(...)` calls:

```python
app.include_router(extraction.router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_extraction_endpoint.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all tests pass (91 from Task 7 + 2 new = 93)

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v1/extraction.py backend/app/main.py backend/tests/test_extraction_endpoint.py
git commit -m "feat: add POST /api/extraction/run/me on-demand extraction endpoint"
```

---

### Task 9: Manual acceptance verification

**Files:** none (manual verification only)

**Interfaces:** exercises the full extraction chain built in Tasks 1-8 against real synced data.

- [ ] **Step 1: Deploy and configure production**

Push to `main`, let Render redeploy. Add `OPENAI_API_KEY` and confirm `EXTRACTION_BATCH_LIMIT` (defaults to 50, no action needed) in Render's environment variables for the backend service.

- [ ] **Step 2: Trigger on-demand extraction for the already-connected personal account**

```bash
curl -X POST https://ai-relationship-manager-api.onrender.com/api/extraction/run/me \
  -H "Authorization: Bearer <that user's Supabase access token>"
```

Expected: `{"status": "ok"}`.

- [ ] **Step 3: Verify rows landed, via direct asyncpg query (same pattern as Graph Sync's own manual verification)**

```sql
select count(*) from public.contacts where user_id = '<user-id>';
select email_address, display_name, notes from public.contacts where user_id = '<user-id>';
select count(*) from public.action_items where user_id = '<user-id>';
select text, direction, due_date, source_type from public.action_items where user_id = '<user-id>';
```

Expected: contacts populated for real senders/attendees from the synced mail/calendar; `notes` fields read as plausible, coherent summaries; any real commitments found in that content show up as `action_items` with sensible `direction`.

- [ ] **Step 4: Verify the "Contacts without email" case**

Given this personal account's chat sync reports `not_available` (verified during Graph Sync), there won't be real chat data to test the display-name-only contact path live. Confirmed instead by Task 6's unit tests (`test_extract_user_processes_chat_message_by_display_name`) — note this explicitly as a gap analogous to Graph Sync's own unverified-work/school-account gap, not a blocker.

- [ ] **Step 5: Verify the automatic post-sync path**

Trigger a regular sync (`POST /api/sync/run/me`) after adding a few more days of mailbox activity (or re-run against existing unextracted rows, if any land from the normal ~15-minute cron), confirm `extracted_at` advances on previously-null rows without a separate manual extraction call.

No commit for this task (verification only). Once complete, update `.superpowers/sdd/progress.md` with a summary entry for AI Extraction, matching the ledger style used for Graph Sync.
