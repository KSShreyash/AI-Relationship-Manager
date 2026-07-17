# Contact Profiles / Dashboard / Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the AI-extracted `contacts` and `action_items` data through a real UI: a dashboard (stats, activity feed, manual sync/extract triggers), a searchable contact list + profile pages, and an action-item planner.

**Architecture:** Three new FastAPI routers (`contacts.py`, `action_items.py`, `dashboard.py`), each doing `user_id`-scoped queries via new repository methods on the existing `ContactsRepository`/`ActionItemsRepository`. Four frontend pages (rewritten dashboard, new contact list, new contact profile, new planner) follow the existing client-component + `apiFetch` pattern already established by the dashboard placeholder.

**Tech Stack:** FastAPI, asyncpg, pytest + pytest-asyncio, httpx (test client) — backend. Next.js 16 (app router), React 19, Vitest + Testing Library, Tailwind — frontend.

## Global Constraints

- All new backend endpoints require the existing `CurrentUser` dependency (`app.core.deps.get_current_user`) and scope every query by `user_id`; not-found and not-owned both return 404 (never distinguish).
- Return raw dicts (not Pydantic `response_model`s) from endpoints, with raw `uuid.UUID`/`datetime`/`date` values as dict values — FastAPI's `jsonable_encoder` serializes these to string/ISO-format automatically, matching this codebase's existing convention of not using `response_model` anywhere.
- Request body validation uses `Literal` types (e.g. `Literal["open", "done"]`) so FastAPI returns 422 automatically — no manual validation code.
- No pagination anywhere in this plan (contact list, planner, activity feed) — the activity feed is capped at 20 entries via `LIMIT`, everything else returns the full result set. This matches the spec's explicit non-goal.
- Frontend pages are client components (`'use client'`) using `useEffect` + `apiFetch` (from `frontend/lib/api.ts`) with local `useState` for loading/error/data — matching `frontend/app/dashboard/page.tsx`'s existing pattern. No shared types file exists yet in this codebase; each page defines its own local TypeScript types, matching that same file's convention.
- No `next/link` anywhere in this codebase — use plain `<a>` tags for all new navigation.
- No optimistic UI updates — mutations (`PATCH`) always refetch the affected list on success rather than updating local state directly.
- Backend tests hit the real Supabase database (no test database exists for this project) using the existing `pool` and `test_auth_user` fixtures in `backend/tests/conftest.py`; frontend tests mock `apiFetch` via `vi.mock('@/lib/api', ...)`, matching `frontend/app/dashboard/page.test.tsx`.

---

## Task 1: `ContactsRepository` — `get`, `list_for_user`, `list_recent`

**Files:**
- Modify: `backend/app/repositories/contacts.py`
- Test: Create `backend/tests/test_contacts_repository.py`

**Interfaces:**
- Produces: `ContactsRepository.get(user_id: uuid.UUID, contact_id: uuid.UUID) -> asyncpg.Record | None`; `ContactsRepository.list_for_user(user_id: uuid.UUID, search: str | None = None) -> list[asyncpg.Record]` (rows include an extra `open_action_item_count` int column, sorted by `updated_at` desc); `ContactsRepository.list_recent(user_id: uuid.UUID, limit: int) -> list[asyncpg.Record]` (sorted by `updated_at` desc).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_contacts_repository.py`:

```python
import uuid

import pytest

from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository


@pytest.mark.asyncio
async def test_get_returns_contact_owned_by_user(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)
    contact_id = await repo.upsert_by_email(user_id, "alice@example.com", "Alice", "notes")

    found = await repo.get(user_id, contact_id)
    assert found is not None
    assert found["display_name"] == "Alice"


@pytest.mark.asyncio
async def test_get_returns_none_for_missing_contact(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)

    found = await repo.get(user_id, uuid.uuid4())
    assert found is None


@pytest.mark.asyncio
async def test_list_for_user_sorted_by_updated_at_desc_with_open_action_item_count(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)

    older_id = await contacts.upsert_by_email(user_id, "older@example.com", "Older", None)
    await pool.execute(
        "update public.contacts set updated_at = now() - interval '1 day' where id = $1", older_id
    )
    newer_id = await contacts.upsert_by_email(user_id, "newer@example.com", "Newer", None)

    await action_items.insert(
        user_id=user_id, contact_id=newer_id, text="Follow up", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )

    rows = await contacts.list_for_user(user_id)
    assert [row["id"] for row in rows] == [newer_id, older_id]
    assert rows[0]["open_action_item_count"] == 1
    assert rows[1]["open_action_item_count"] == 0


@pytest.mark.asyncio
async def test_list_for_user_search_matches_name_or_email(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)
    await repo.upsert_by_email(user_id, "bob@example.com", "Bob Smith", None)
    await repo.upsert_by_email(user_id, "carol@example.com", "Carol Jones", None)

    by_name = await repo.list_for_user(user_id, search="smith")
    assert len(by_name) == 1
    assert by_name[0]["display_name"] == "Bob Smith"

    by_email = await repo.list_for_user(user_id, search="carol@")
    assert len(by_email) == 1
    assert by_email[0]["display_name"] == "Carol Jones"

    no_match = await repo.list_for_user(user_id, search="nobody")
    assert no_match == []


@pytest.mark.asyncio
async def test_list_recent_respects_limit(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)
    await repo.upsert_by_email(user_id, "one@example.com", "One", None)
    await repo.upsert_by_email(user_id, "two@example.com", "Two", None)
    await repo.upsert_by_email(user_id, "three@example.com", "Three", None)

    rows = await repo.list_recent(user_id, limit=2)
    assert len(rows) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/test_contacts_repository.py -v`
Expected: FAIL — `AttributeError: 'ContactsRepository' object has no attribute 'get'` (and similar for the other two methods).

- [ ] **Step 3: Implement the three methods**

Add these methods to the `ContactsRepository` class in `backend/app/repositories/contacts.py` (after `upsert_by_display_name`, before `count`):

```python
    async def get(
        self, user_id: uuid.UUID, contact_id: uuid.UUID
    ) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            "select * from public.contacts where id = $1 and user_id = $2",
            contact_id,
            user_id,
        )

    async def list_for_user(
        self, user_id: uuid.UUID, search: str | None = None
    ) -> list[asyncpg.Record]:
        pattern = f"%{search}%" if search else None
        return await self._pool.fetch(
            """
            select c.*,
                   (
                       select count(*) from public.action_items ai
                       where ai.contact_id = c.id and ai.status = 'open'
                   ) as open_action_item_count
            from public.contacts c
            where c.user_id = $1
              and ($2::text is null or c.display_name ilike $2 or c.email_address ilike $2)
            order by c.updated_at desc
            """,
            user_id,
            pattern,
        )

    async def list_recent(self, user_id: uuid.UUID, limit: int) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select * from public.contacts
            where user_id = $1
            order by updated_at desc
            limit $2
            """,
            user_id,
            limit,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/test_contacts_repository.py -v`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add backend/app/repositories/contacts.py backend/tests/test_contacts_repository.py
git commit -m "feat: add ContactsRepository.get/list_for_user/list_recent"
```

---

## Task 2: Migration + `ActionItemsRepository` — `list_for_contact`, `list_for_user`, `update_status`, `count_open`, `list_recent`

**Files:**
- Create: `supabase/migrations/20260717000001_action_items_updated_at.sql`
- Modify: `backend/app/repositories/action_items.py`
- Test: Create `backend/tests/test_action_items_repository.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ActionItemsRepository.list_for_contact(user_id, contact_id) -> list[asyncpg.Record]`; `ActionItemsRepository.list_for_user(user_id, direction: str | None = None, include_done: bool = False) -> list[asyncpg.Record]` (rows include extra `contact_display_name`/`contact_email_address` columns, sorted by `due_date` asc-nulls-last then `created_at` asc); `ActionItemsRepository.update_status(user_id, item_id, status: str) -> asyncpg.Record | None`; `ActionItemsRepository.count_open(user_id) -> int`; `ActionItemsRepository.list_recent(user_id, limit: int) -> list[asyncpg.Record]` (sorted by `created_at` desc).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260717000001_action_items_updated_at.sql`:

```sql
alter table public.action_items
  add column updated_at timestamptz not null default now();
```

- [ ] **Step 2: Apply the migration directly against the database**

There is no linked Supabase MCP project for this repo, so apply it the same way the AI Extraction schema migration was applied — a one-off asyncpg script (run from `backend/`, where `.env` and the installed `app` package live):

```bash
cd backend
python -c "
import asyncio
import asyncpg
from app.core.config import settings

async def main():
    conn = await asyncpg.connect(settings.database_url)
    with open('../supabase/migrations/20260717000001_action_items_updated_at.sql') as f:
        sql = f.read()
    await conn.execute(sql)
    await conn.close()
    print('Migration applied')

asyncio.run(main())
"
```

Expected output: `Migration applied`

- [ ] **Step 3: Verify the column exists**

```bash
python -c "
import asyncio
import asyncpg
from app.core.config import settings

async def main():
    conn = await asyncpg.connect(settings.database_url)
    row = await conn.fetchrow(
        \"select column_name, is_nullable, column_default from information_schema.columns \"
        \"where table_name = 'action_items' and column_name = 'updated_at'\"
    )
    print(dict(row))
    await conn.close()

asyncio.run(main())
"
```

Expected output: `{'column_name': 'updated_at', 'is_nullable': 'NO', 'column_default': 'now()'}`

- [ ] **Step 4: Write the failing repository tests**

Create `backend/tests/test_action_items_repository.py`:

```python
import uuid

import pytest

from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository


@pytest.mark.asyncio
async def test_list_for_contact_returns_only_that_contacts_items(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_a = await contacts.upsert_by_email(user_id, "a@example.com", "A", None)
    contact_b = await contacts.upsert_by_email(user_id, "b@example.com", "B", None)

    await action_items.insert(
        user_id=user_id, contact_id=contact_a, text="For A", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=contact_b, text="For B", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )

    rows = await action_items.list_for_contact(user_id, contact_a)
    assert len(rows) == 1
    assert rows[0]["text"] == "For A"


@pytest.mark.asyncio
async def test_list_for_user_filters_direction_and_excludes_done_by_default(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)

    await action_items.insert(
        user_id=user_id, contact_id=None, text="Mine open", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Theirs open", direction="theirs",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    to_complete = await pool.fetchrow(
        "select id from public.action_items where user_id = $1 and text = $2", user_id, "Mine open"
    )
    await action_items.update_status(user_id, to_complete["id"], "done")

    all_open = await action_items.list_for_user(user_id)
    assert {row["text"] for row in all_open} == {"Theirs open"}

    mine_including_done = await action_items.list_for_user(user_id, direction="mine", include_done=True)
    assert {row["text"] for row in mine_including_done} == {"Mine open"}

    everything = await action_items.list_for_user(user_id, include_done=True)
    assert {row["text"] for row in everything} == {"Mine open", "Theirs open"}


@pytest.mark.asyncio
async def test_list_for_user_embeds_contact_display_fields(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "dana@example.com", "Dana", None)

    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="With contact", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None, text="No contact", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )

    rows = await action_items.list_for_user(user_id)
    by_text = {row["text"]: row for row in rows}
    assert by_text["With contact"]["contact_display_name"] == "Dana"
    assert by_text["With contact"]["contact_email_address"] == "dana@example.com"
    assert by_text["No contact"]["contact_display_name"] is None


@pytest.mark.asyncio
async def test_update_status_sets_status_and_updated_at(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Toggle me", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    before = await pool.fetchrow(
        "select id, updated_at from public.action_items where user_id = $1", user_id
    )

    updated = await action_items.update_status(user_id, before["id"], "done")
    assert updated is not None
    assert updated["status"] == "done"
    assert updated["updated_at"] > before["updated_at"]


@pytest.mark.asyncio
async def test_update_status_returns_none_for_missing_item(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)

    result = await action_items.update_status(user_id, uuid.uuid4(), "done")
    assert result is None


@pytest.mark.asyncio
async def test_count_open_excludes_done_items(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Open one", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Will be done", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    to_complete = await pool.fetchrow(
        "select id from public.action_items where user_id = $1 and text = $2", user_id, "Will be done"
    )
    await action_items.update_status(user_id, to_complete["id"], "done")

    assert await action_items.count_open(user_id) == 1


@pytest.mark.asyncio
async def test_list_recent_sorted_by_created_at_desc_respects_limit(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    for text in ("first", "second", "third"):
        await action_items.insert(
            user_id=user_id, contact_id=None, text=text, direction="mine",
            due_date=None, source_type="email", source_id=uuid.uuid4(),
        )
    await pool.execute(
        "update public.action_items set created_at = now() - interval '2 hours' where text = 'first'"
    )
    await pool.execute(
        "update public.action_items set created_at = now() - interval '1 hour' where text = 'second'"
    )

    rows = await action_items.list_recent(user_id, limit=2)
    assert [row["text"] for row in rows] == ["third", "second"]
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd backend && pytest tests/test_action_items_repository.py -v`
Expected: FAIL — `AttributeError: 'ActionItemsRepository' object has no attribute 'list_for_contact'` (and similarly for the other methods).

- [ ] **Step 6: Implement the five methods**

Add these methods to the `ActionItemsRepository` class in `backend/app/repositories/action_items.py` (after `insert`, before `count`):

```python
    async def list_for_contact(
        self, user_id: uuid.UUID, contact_id: uuid.UUID
    ) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select * from public.action_items
            where user_id = $1 and contact_id = $2
            order by created_at desc
            """,
            user_id,
            contact_id,
        )

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
                   c.email_address as contact_email_address
            from public.action_items ai
            left join public.contacts c on c.id = ai.contact_id
            where ai.user_id = $1
              and ($2::text is null or ai.direction = $2)
              and ($3::boolean or ai.status = 'open')
            order by ai.due_date asc nulls last, ai.created_at asc
            """,
            user_id,
            direction,
            include_done,
        )

    async def update_status(
        self, user_id: uuid.UUID, item_id: uuid.UUID, status: str
    ) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            """
            update public.action_items
            set status = $3, updated_at = now()
            where id = $1 and user_id = $2
            returning *
            """,
            item_id,
            user_id,
            status,
        )

    async def count_open(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.action_items where user_id = $1 and status = 'open'",
            user_id,
        )

    async def list_recent(self, user_id: uuid.UUID, limit: int) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select * from public.action_items
            where user_id = $1
            order by created_at desc
            limit $2
            """,
            user_id,
            limit,
        )
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && pytest tests/test_action_items_repository.py -v`
Expected: PASS (7/7)

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260717000001_action_items_updated_at.sql backend/app/repositories/action_items.py backend/tests/test_action_items_repository.py
git commit -m "feat: add action_items.updated_at column and new ActionItemsRepository query methods"
```

---

## Task 3: `contacts.py` router — list, detail, action-items

**Files:**
- Create: `backend/app/api/v1/contacts.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/conftest.py` (add a second test-user fixture, needed for the cross-user 404 test)
- Test: Create `backend/tests/test_contacts_endpoint.py`

**Interfaces:**
- Consumes: `ContactsRepository.get`/`list_for_user` (Task 1), `ActionItemsRepository.list_for_contact` (Task 2), `CurrentUser`/`get_current_user` (`app.core.deps`), `get_pool` (`app.db.session`).
- Produces: `router` (FastAPI `APIRouter`, prefix `/api/contacts`) registered in `main.py`. Routes: `GET /api/contacts?q=`, `GET /api/contacts/{contact_id}`, `GET /api/contacts/{contact_id}/action-items`.

- [ ] **Step 1: Add a second test-user fixture**

`contacts.user_id` has a foreign key to `profiles.id`, which itself has a foreign key to `auth.users.id` — so a "contact owned by another user" test needs a second *real* Supabase auth user, not a fabricated UUID. Add this fixture to `backend/tests/conftest.py`, right after the existing `test_auth_user` fixture (same body, so it can be requested independently and yields an unrelated second user):

```python
@pytest_asyncio.fixture
async def test_auth_user_2():
    async with httpx.AsyncClient(
        base_url=settings.supabase_url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
        },
    ) as client:
        email = f"test-{uuid.uuid4()}@example.com"
        response = await client.post(
            "/auth/v1/admin/users",
            json={"email": email, "email_confirm": True},
        )
        response.raise_for_status()
        user_id = response.json()["id"]

        yield uuid.UUID(user_id), email

        await client.delete(f"/auth/v1/admin/users/{user_id}")
```

- [ ] **Step 2: Write the failing endpoint tests**

Create `backend/tests/test_contacts_endpoint.py`:

```python
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository


def _override_auth(user_id, email):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)


@pytest.mark.asyncio
async def test_list_contacts_returns_current_users_contacts(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await ContactsRepository(pool).upsert_by_email(user_id, "alice@example.com", "Alice", "notes")
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/contacts")

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 1
        assert body[0]["display_name"] == "Alice"
        assert body[0]["open_action_item_count"] == 0
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_contacts_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/contacts")

    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_list_contacts_search_filters_by_query_param(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    await contacts.upsert_by_email(user_id, "bob@example.com", "Bob Smith", None)
    await contacts.upsert_by_email(user_id, "carol@example.com", "Carol Jones", None)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/contacts", params={"q": "smith"})

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 1
        assert body[0]["display_name"] == "Bob Smith"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_get_contact_returns_detail(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contact_id = await ContactsRepository(pool).upsert_by_email(user_id, "dana@example.com", "Dana", "Some notes")
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/contacts/{contact_id}")

        assert response.status_code == 200
        body = response.json()
        assert body["id"] == str(contact_id)
        assert body["notes"] == "Some notes"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_get_contact_404_for_missing_contact(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/contacts/{uuid.uuid4()}")

        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_get_contact_404_for_contact_owned_by_another_user(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    contact_id = await ContactsRepository(pool).upsert_by_email(other_user_id, "eve@example.com", "Eve", None)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/contacts/{contact_id}")

        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_contact_action_items_returns_items_for_that_contact(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "frank@example.com", "Frank", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Send the deck", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/contacts/{contact_id}/action-items")

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 1
        assert body[0]["text"] == "Send the deck"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_contact_action_items_404_for_missing_contact(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/contacts/{uuid.uuid4()}/action-items")

        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && pytest tests/test_contacts_endpoint.py -v`
Expected: FAIL — 404 errors (route doesn't exist yet) on every request.

- [ ] **Step 4: Implement the router**

Create `backend/app/api/v1/contacts.py`:

```python
import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository

router = APIRouter(prefix="/api/contacts", tags=["contacts"])


def _contact_summary(row) -> dict:
    return {
        "id": row["id"],
        "email_address": row["email_address"],
        "display_name": row["display_name"],
        "open_action_item_count": row["open_action_item_count"],
        "updated_at": row["updated_at"],
    }


def _contact_detail(row) -> dict:
    return {
        "id": row["id"],
        "email_address": row["email_address"],
        "display_name": row["display_name"],
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _action_item(row) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "direction": row["direction"],
        "status": row["status"],
        "due_date": row["due_date"],
        "source_type": row["source_type"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("")
async def list_contacts(
    q: str | None = None, current_user: CurrentUser = Depends(get_current_user)
):
    pool = await get_pool()
    rows = await ContactsRepository(pool).list_for_user(current_user.user_id, search=q)
    return [_contact_summary(row) for row in rows]


@router.get("/{contact_id}")
async def get_contact(
    contact_id: uuid.UUID, current_user: CurrentUser = Depends(get_current_user)
):
    pool = await get_pool()
    row = await ContactsRepository(pool).get(current_user.user_id, contact_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    return _contact_detail(row)


@router.get("/{contact_id}/action-items")
async def list_contact_action_items(
    contact_id: uuid.UUID, current_user: CurrentUser = Depends(get_current_user)
):
    pool = await get_pool()
    contact_row = await ContactsRepository(pool).get(current_user.user_id, contact_id)
    if contact_row is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    rows = await ActionItemsRepository(pool).list_for_contact(current_user.user_id, contact_id)
    return [_action_item(row) for row in rows]
```

- [ ] **Step 5: Register the router**

In `backend/app/main.py`, change:

```python
from app.api.v1 import auth, extraction, me, sync
```

to:

```python
from app.api.v1 import auth, contacts, extraction, me, sync
```

and after `app.include_router(auth.router)`, add:

```python
app.include_router(contacts.router)
```

(full ordering becomes: `auth`, `contacts`, `me`, `sync`, `extraction` — alphabetical by the existing convention).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && pytest tests/test_contacts_endpoint.py -v`
Expected: PASS (8/8)

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && pytest -v`
Expected: all tests pass (no regressions).

- [ ] **Step 8: Commit**

```bash
git add backend/app/api/v1/contacts.py backend/app/main.py backend/tests/conftest.py backend/tests/test_contacts_endpoint.py
git commit -m "feat: add GET /api/contacts, /api/contacts/{id}, /api/contacts/{id}/action-items"
```

---

## Task 4: `action_items.py` router — planner listing + status toggle

**Files:**
- Create: `backend/app/api/v1/action_items.py`
- Modify: `backend/app/main.py`
- Test: Create `backend/tests/test_action_items_endpoint.py`

**Interfaces:**
- Consumes: `ActionItemsRepository.list_for_user`/`update_status` (Task 2), `CurrentUser`/`get_current_user`, `get_pool`.
- Produces: `router` (prefix `/api/action-items`) registered in `main.py`. Routes: `GET /api/action-items?direction=&include_done=`, `PATCH /api/action-items/{item_id}`.

- [ ] **Step 1: Write the failing endpoint tests**

Create `backend/tests/test_action_items_endpoint.py`:

```python
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository


def _override_auth(user_id, email):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)


@pytest.mark.asyncio
async def test_list_action_items_defaults_to_open_only(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Open item", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Will be done", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    to_complete = await pool.fetchrow(
        "select id from public.action_items where user_id = $1 and text = $2", user_id, "Will be done"
    )
    await action_items.update_status(user_id, to_complete["id"], "done")
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/action-items")

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 1
        assert body[0]["text"] == "Open item"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_action_items_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/action-items")

    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_list_action_items_filters_by_direction_and_include_done(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Mine", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Theirs", direction="theirs",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    to_complete = await pool.fetchrow(
        "select id from public.action_items where user_id = $1 and text = $2", user_id, "Mine"
    )
    await action_items.update_status(user_id, to_complete["id"], "done")
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            theirs_only = await client.get("/api/action-items", params={"direction": "theirs"})
            mine_with_done = await client.get(
                "/api/action-items", params={"direction": "mine", "include_done": "true"}
            )
            invalid_direction = await client.get("/api/action-items", params={"direction": "bogus"})

        assert {row["text"] for row in theirs_only.json()} == {"Theirs"}
        assert {row["text"] for row in mine_with_done.json()} == {"Mine"}
        assert invalid_direction.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_action_items_embeds_contact_or_null(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="With contact", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None, text="No contact", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/action-items")

        by_text = {row["text"]: row for row in response.json()}
        assert by_text["With contact"]["contact"] == {
            "id": str(contact_id), "display_name": "Gina", "email_address": "gina@example.com",
        }
        assert by_text["No contact"]["contact"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_patch_action_item_updates_status(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Toggle me", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow(
        "select id from public.action_items where user_id = $1", user_id
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.patch(
                f"/api/action-items/{item_row['id']}", json={"status": "done"}
            )

        assert response.status_code == 200
        assert response.json()["status"] == "done"
        assert await action_items.count_open(user_id) == 0
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_patch_action_item_rejects_invalid_status(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Toggle me", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow(
        "select id from public.action_items where user_id = $1", user_id
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.patch(
                f"/api/action-items/{item_row['id']}", json={"status": "bogus"}
            )

        assert response.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_patch_action_item_404_for_missing_item(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.patch(
                f"/api/action-items/{uuid.uuid4()}", json={"status": "done"}
            )

        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/test_action_items_endpoint.py -v`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Implement the router**

Create `backend/app/api/v1/action_items.py`:

```python
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository

router = APIRouter(prefix="/api/action-items", tags=["action-items"])


class UpdateActionItemStatus(BaseModel):
    status: Literal["open", "done"]


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
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _serialize_plain(row) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "direction": row["direction"],
        "status": row["status"],
        "due_date": row["due_date"],
        "contact_id": row["contact_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("")
async def list_action_items(
    direction: Literal["mine", "theirs"] | None = None,
    include_done: bool = False,
    current_user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    rows = await ActionItemsRepository(pool).list_for_user(
        current_user.user_id, direction=direction, include_done=include_done
    )
    return [_serialize(row) for row in rows]


@router.patch("/{item_id}")
async def update_action_item_status(
    item_id: uuid.UUID,
    body: UpdateActionItemStatus,
    current_user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    row = await ActionItemsRepository(pool).update_status(
        current_user.user_id, item_id, body.status
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Action item not found")
    return _serialize_plain(row)
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, change the import to:

```python
from app.api.v1 import action_items, auth, contacts, extraction, me, sync
```

and add, after `app.include_router(auth.router)`:

```python
app.include_router(action_items.router)
```

(full ordering: `action_items`, `auth`, `contacts`, `me`, `sync`, `extraction`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && pytest tests/test_action_items_endpoint.py -v`
Expected: PASS (7/7)

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && pytest -v`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v1/action_items.py backend/app/main.py backend/tests/test_action_items_endpoint.py
git commit -m "feat: add GET /api/action-items and PATCH /api/action-items/{id}"
```

---

## Task 5: `dashboard.py` router — stats + merged activity feed

**Files:**
- Create: `backend/app/api/v1/dashboard.py`
- Modify: `backend/app/main.py`
- Test: Create `backend/tests/test_dashboard_endpoint.py`

**Interfaces:**
- Consumes: `ContactsRepository.count`/`list_recent` (existing/Task 1), `ActionItemsRepository.count_open`/`list_recent` (Task 2).
- Produces: `router` (prefix `/api/dashboard`). Route: `GET /api/dashboard` → `{"contact_count": int, "open_action_item_count": int, "activity": [...]}`.

- [ ] **Step 1: Write the failing endpoint tests**

Create `backend/tests/test_dashboard_endpoint.py`:

```python
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository


def _override_auth(user_id, email):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)


@pytest.mark.asyncio
async def test_dashboard_returns_counts_and_merged_activity(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)

    contact_id = await contacts.upsert_by_email(user_id, "helen@example.com", "Helen", None)
    await pool.execute(
        "update public.contacts set updated_at = now() - interval '2 hours' where id = $1", contact_id
    )
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Recent action item", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    to_complete = await pool.fetchrow(
        "select id from public.action_items where user_id = $1", user_id
    )
    await action_items.update_status(user_id, to_complete["id"], "done")
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/dashboard")

        assert response.status_code == 200
        body = response.json()
        assert body["contact_count"] == 1
        assert body["open_action_item_count"] == 0
        assert len(body["activity"]) == 2
        assert body["activity"][0]["type"] == "action_item_created"
        assert body["activity"][0]["text"] == "Recent action item"
        assert body["activity"][1]["type"] == "contact_updated"
        assert body["activity"][1]["display_name"] == "Helen"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_dashboard_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/dashboard")

    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_dashboard_activity_capped_at_20(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    for i in range(25):
        await action_items.insert(
            user_id=user_id, contact_id=None, text=f"Item {i}", direction="mine",
            due_date=None, source_type="email", source_id=uuid.uuid4(),
        )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/dashboard")

        assert len(response.json()["activity"]) == 20
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/test_dashboard_endpoint.py -v`
Expected: FAIL — 404s (route doesn't exist yet).

- [ ] **Step 3: Implement the router**

Create `backend/app/api/v1/dashboard.py`:

```python
from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

_ACTIVITY_LIMIT = 20


def _merge_activity(contact_rows, action_item_rows, limit: int) -> list[dict]:
    events = []
    for row in contact_rows:
        events.append({
            "type": "contact_updated",
            "id": row["id"],
            "timestamp": row["updated_at"],
            "display_name": row["display_name"],
            "email_address": row["email_address"],
        })
    for row in action_item_rows:
        events.append({
            "type": "action_item_created",
            "id": row["id"],
            "timestamp": row["created_at"],
            "text": row["text"],
            "direction": row["direction"],
        })
    events.sort(key=lambda e: e["timestamp"], reverse=True)
    return events[:limit]


@router.get("")
async def get_dashboard(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    contacts_repo = ContactsRepository(pool)
    action_items_repo = ActionItemsRepository(pool)

    contact_count = await contacts_repo.count(current_user.user_id)
    open_action_item_count = await action_items_repo.count_open(current_user.user_id)
    recent_contacts = await contacts_repo.list_recent(current_user.user_id, _ACTIVITY_LIMIT)
    recent_action_items = await action_items_repo.list_recent(current_user.user_id, _ACTIVITY_LIMIT)

    return {
        "contact_count": contact_count,
        "open_action_item_count": open_action_item_count,
        "activity": _merge_activity(recent_contacts, recent_action_items, _ACTIVITY_LIMIT),
    }
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, change the import to:

```python
from app.api.v1 import action_items, auth, contacts, dashboard, extraction, me, sync
```

and add, after `app.include_router(contacts.router)`:

```python
app.include_router(dashboard.router)
```

(full ordering: `action_items`, `auth`, `contacts`, `dashboard`, `me`, `sync`, `extraction`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && pytest tests/test_dashboard_endpoint.py -v`
Expected: PASS (3/3)

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && pytest -v`
Expected: all tests pass. This is the last backend task — record the final pass count for the whole-branch review later.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v1/dashboard.py backend/app/main.py backend/tests/test_dashboard_endpoint.py
git commit -m "feat: add GET /api/dashboard aggregate endpoint"
```

---

## Task 6: Shared nav + dashboard page rewrite

**Files:**
- Modify: `frontend/app/layout.tsx`
- Modify: `frontend/app/dashboard/page.tsx`
- Modify: `frontend/app/dashboard/page.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (`frontend/lib/api.ts`), `GET /api/dashboard` (Task 5), `POST /api/sync/run/me` (existing), `POST /api/extraction/run/me` (existing).
- Produces: nothing consumed by later tasks (Tasks 7-9 build their own pages independently) — but the nav markup added to `layout.tsx` is shared by all pages built in Tasks 7-9, so its `<a>` hrefs (`/dashboard`, `/contacts`, `/planner`) must stay exactly as written here.

- [ ] **Step 1: Add the shared nav to the root layout**

Replace the body of `frontend/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="flex gap-4 border-b border-gray-200 px-6 py-3">
          <a href="/dashboard">Dashboard</a>
          <a href="/contacts">Contacts</a>
          <a href="/planner">Planner</a>
        </nav>
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Write the failing test for the rewritten dashboard**

Replace `frontend/app/dashboard/page.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import DashboardPage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const DASHBOARD_BODY = {
  contact_count: 3,
  open_action_item_count: 2,
  activity: [
    { type: 'action_item_created', id: 'a1', timestamp: '2026-07-17T10:00:00Z', text: 'Send the deck', direction: 'mine' },
    { type: 'contact_updated', id: 'c1', timestamp: '2026-07-17T09:00:00Z', display_name: 'Helen', email_address: 'helen@example.com' },
  ],
}

describe('DashboardPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('shows connection status, stats, and activity feed', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)

    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('Send the deck')).toBeInTheDocument()
    expect(screen.getByText(/Helen/)).toBeInTheDocument()
  })

  it('shows a reconnect prompt on 409 needs_reauth', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(new Response(null, { status: 409 }))
      }
      return Promise.resolve(jsonResponse(DASHBOARD_BODY))
    })

    render(<DashboardPage />)

    await waitFor(() =>
      expect(screen.getByText(/reconnect your microsoft account/i)).toBeInTheDocument()
    )
  })

  it('triggers a sync and refetches the dashboard on success', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/sync/run/me' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ status: 'ok' }))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /sync now/i }))

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/sync/run/me', { method: 'POST' })
    )
  })

  it('shows an inline error and re-enables the button when sync fails', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/sync/run/me' && init?.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())

    const button = screen.getByRole('button', { name: /sync now/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(button).not.toBeDisabled()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run app/dashboard/page.test.tsx`
Expected: FAIL — the current page has no stats/activity/buttons to find.

- [ ] **Step 4: Rewrite the dashboard page**

Replace `frontend/app/dashboard/page.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'

import { apiFetch } from '@/lib/api'

type GraphStatus =
  | { state: 'loading' }
  | { state: 'connected'; email: string }
  | { state: 'needs_reauth' }
  | { state: 'error' }

type ActivityEntry =
  | { type: 'contact_updated'; id: string; timestamp: string; display_name: string | null; email_address: string | null }
  | { type: 'action_item_created'; id: string; timestamp: string; text: string; direction: 'mine' | 'theirs' }

type DashboardData = {
  contact_count: number
  open_action_item_count: number
  activity: ActivityEntry[]
}

export default function DashboardPage() {
  const [status, setStatus] = useState<GraphStatus>({ state: 'loading' })
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [pending, setPending] = useState<'sync' | 'extract' | null>(null)

  const loadStatus = useCallback(async () => {
    const response = await apiFetch('/api/me/graph-status')

    if (response.status === 409) {
      setStatus({ state: 'needs_reauth' })
      return
    }
    if (!response.ok) {
      setStatus({ state: 'error' })
      return
    }

    const body = await response.json()
    setStatus({
      state: 'connected',
      email: body.graph_me?.mail ?? body.graph_me?.userPrincipalName,
    })
  }, [])

  const loadDashboard = useCallback(async () => {
    const response = await apiFetch('/api/dashboard')
    if (!response.ok) return
    setDashboard(await response.json())
  }, [])

  useEffect(() => {
    loadStatus()
    loadDashboard()
  }, [loadStatus, loadDashboard])

  async function runTrigger(kind: 'sync' | 'extract') {
    setPending(kind)
    setTriggerError(null)
    const path = kind === 'sync' ? '/api/sync/run/me' : '/api/extraction/run/me'
    const response = await apiFetch(path, { method: 'POST' })
    setPending(null)
    if (!response.ok) {
      setTriggerError('Something went wrong running that. Please try again.')
      return
    }
    await loadDashboard()
  }

  if (status.state === 'loading') return <p>Loading…</p>

  if (status.state === 'needs_reauth') {
    return (
      <p>
        Your Microsoft connection expired.{' '}
        <a href="/login">Reconnect your Microsoft account</a>.
      </p>
    )
  }

  if (status.state === 'error') {
    return <p role="alert">Something went wrong loading your account.</p>
  }

  return (
    <div className="p-6">
      <p>Connected as {status.email}</p>

      <div className="mt-4 flex gap-3">
        <button
          onClick={() => runTrigger('sync')}
          disabled={pending !== null}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          Sync now
        </button>
        <button
          onClick={() => runTrigger('extract')}
          disabled={pending !== null}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          Extract now
        </button>
      </div>

      {triggerError && <p role="alert" className="mt-2 text-red-600">{triggerError}</p>}

      {dashboard && (
        <>
          <div className="mt-6 flex gap-6">
            <div>
              <p className="text-2xl">{dashboard.contact_count}</p>
              <p>Contacts</p>
            </div>
            <div>
              <p className="text-2xl">{dashboard.open_action_item_count}</p>
              <p>Open action items</p>
            </div>
          </div>

          <h2 className="mt-6 text-lg">Recent activity</h2>
          {dashboard.activity.length === 0 ? (
            <p>No recent activity.</p>
          ) : (
            <ul className="mt-2">
              {dashboard.activity.map((entry) => (
                <li key={`${entry.type}-${entry.id}`}>
                  {entry.type === 'contact_updated'
                    ? `Updated contact: ${entry.display_name ?? entry.email_address}`
                    : `New action item (${entry.direction}): ${entry.text}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run app/dashboard/page.test.tsx`
Expected: PASS (4/4)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/layout.tsx frontend/app/dashboard/page.tsx frontend/app/dashboard/page.test.tsx
git commit -m "feat: rewrite dashboard with stats, activity feed, and sync/extract triggers"
```

---

## Task 7: Contact list page

**Files:**
- Create: `frontend/app/contacts/page.tsx`
- Create: `frontend/app/contacts/page.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `GET /api/contacts?q=` (Task 3), the nav's `/contacts` link (Task 6).
- Produces: nothing consumed by later tasks — Task 8 (`/contacts/[id]`) is a sibling route, not a dependent.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/contacts/page.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import ContactsPage from './page'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('ContactsPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('renders contacts sorted by recency with their open action item count', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([
        { id: '1', email_address: 'alice@example.com', display_name: 'Alice', open_action_item_count: 2, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )

    render(<ContactsPage />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText(/2/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /alice/i })).toHaveAttribute('href', '/contacts/1')
  })

  it('shows an empty state when there are no contacts', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse([]))

    render(<ContactsPage />)

    await waitFor(() =>
      expect(screen.getByText(/no contacts yet/i)).toBeInTheDocument()
    )
  })

  it('debounces search input and ignores a stale out-of-order response', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ delay: null })

    let resolveFirst: (value: Response) => void = () => {}
    let resolveSecond: (value: Response) => void = () => {}
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse([])) // initial load
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // "sm" search
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve })) // "smi" search

    render(<ContactsPage />)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))

    const input = screen.getByPlaceholderText(/search/i)
    await user.type(input, 'sm')
    await vi.advanceTimersByTimeAsync(300)
    await user.type(input, 'i')
    await vi.advanceTimersByTimeAsync(300)

    // Later request ("smi") resolves first, earlier request ("sm") resolves second (stale).
    resolveSecond(
      jsonResponse([
        { id: '2', email_address: 'smith@example.com', display_name: 'Smith', open_action_item_count: 0, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )
    await vi.waitFor(() => expect(screen.getByText('Smith')).toBeInTheDocument())

    resolveFirst(
      jsonResponse([
        { id: '3', email_address: 'smiley@example.com', display_name: 'Smiley', open_action_item_count: 0, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('Smith')).toBeInTheDocument()
    expect(screen.queryByText('Smiley')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/contacts/page.test.tsx`
Expected: FAIL — `Cannot find module './page'`.

- [ ] **Step 3: Implement the page**

Create `frontend/app/contacts/page.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'

import { apiFetch } from '@/lib/api'

type Contact = {
  id: string
  email_address: string | null
  display_name: string | null
  open_action_item_count: number
  updated_at: string
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [search, setSearch] = useState('')
  const requestId = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      const thisRequest = ++requestId.current
      const query = search ? `?q=${encodeURIComponent(search)}` : ''
      apiFetch(`/api/contacts${query}`).then(async (response) => {
        if (!response.ok) return
        const body = await response.json()
        if (thisRequest === requestId.current) {
          setContacts(body)
        }
      })
    }, 300)

    return () => clearTimeout(timer)
  }, [search])

  return (
    <div className="p-6">
      <input
        type="text"
        placeholder="Search contacts…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="rounded border border-gray-300 px-3 py-2"
      />

      {contacts === null ? (
        <p className="mt-4">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="mt-4">No contacts yet — sync and extract to get started.</p>
      ) : (
        <ul className="mt-4">
          {contacts.map((contact) => (
            <li key={contact.id}>
              <a href={`/contacts/${contact.id}`}>
                {contact.display_name ?? contact.email_address}
              </a>
              {' — '}
              {contact.open_action_item_count} open action item
              {contact.open_action_item_count === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/contacts/page.test.tsx`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/contacts/page.tsx frontend/app/contacts/page.test.tsx
git commit -m "feat: add searchable contact list page"
```

---

## Task 8: Contact profile page

**Files:**
- Create: `frontend/app/contacts/[id]/page.tsx`
- Create: `frontend/app/contacts/[id]/page.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `GET /api/contacts/{id}` and `GET /api/contacts/{id}/action-items` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/contacts/[id]/page.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, useParamsMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  useParamsMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useParams: useParamsMock }))

import ContactProfilePage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('ContactProfilePage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    useParamsMock.mockReturnValue({ id: 'contact-1' })
  })

  it('renders notes and splits action items into open and done sections', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/contacts/contact-1') {
        return Promise.resolve(jsonResponse({
          id: 'contact-1', email_address: 'alice@example.com', display_name: 'Alice',
          notes: 'Works at Acme.', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-17T00:00:00Z',
        }))
      }
      if (path === '/api/contacts/contact-1/action-items') {
        return Promise.resolve(jsonResponse([
          { id: 'ai-1', text: 'Send the deck', direction: 'mine', status: 'open', due_date: null, source_type: 'email', created_at: '2026-07-17T00:00:00Z', updated_at: '2026-07-17T00:00:00Z' },
          { id: 'ai-2', text: 'Follow up call', direction: 'theirs', status: 'done', due_date: null, source_type: 'email', created_at: '2026-07-16T00:00:00Z', updated_at: '2026-07-16T00:00:00Z' },
        ]))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<ContactProfilePage />)

    await waitFor(() => expect(screen.getByText('Works at Acme.')).toBeInTheDocument())
    expect(screen.getByText('Send the deck')).toBeInTheDocument()
    expect(screen.getByText('Follow up call')).toBeInTheDocument()
  })

  it('shows a not-found message on 404', async () => {
    apiFetchMock.mockResolvedValue(new Response(null, { status: 404 }))

    render(<ContactProfilePage />)

    await waitFor(() => expect(screen.getByText(/contact not found/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run "app/contacts/[id]/page.test.tsx"`
Expected: FAIL — `Cannot find module './page'`.

- [ ] **Step 3: Implement the page**

Create `frontend/app/contacts/[id]/page.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

import { apiFetch } from '@/lib/api'

type ContactDetail = {
  id: string
  email_address: string | null
  display_name: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  source_type: string
  created_at: string
  updated_at: string
}

type State =
  | { state: 'loading' }
  | { state: 'not_found' }
  | { state: 'error' }
  | { state: 'ready'; contact: ContactDetail; actionItems: ActionItem[] }

export default function ContactProfilePage() {
  const { id } = useParams<{ id: string }>()
  const [state, setState] = useState<State>({ state: 'loading' })

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

  if (state.state === 'loading') return <p>Loading…</p>
  if (state.state === 'not_found') return <p>Contact not found.</p>
  if (state.state === 'error') return <p role="alert">Something went wrong loading this contact.</p>

  const { contact, actionItems } = state
  const openItems = actionItems.filter((item) => item.status === 'open')
  const doneItems = actionItems.filter((item) => item.status === 'done')

  return (
    <div className="p-6">
      <h1 className="text-xl">{contact.display_name ?? contact.email_address}</h1>
      {contact.email_address && <p>{contact.email_address}</p>}
      <p className="mt-4">{contact.notes ?? 'No notes yet.'}</p>

      <h2 className="mt-6 text-lg">Open</h2>
      {openItems.length === 0 ? (
        <p>Nothing open.</p>
      ) : (
        <ul>
          {openItems.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ul>
      )}

      <h2 className="mt-6 text-lg">Done</h2>
      {doneItems.length === 0 ? (
        <p>Nothing done yet.</p>
      ) : (
        <ul>
          {doneItems.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run "app/contacts/[id]/page.test.tsx"`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/contacts/[id]/page.tsx" "frontend/app/contacts/[id]/page.test.tsx"
git commit -m "feat: add contact profile page with notes and open/done action items"
```

---

## Task 9: Planner page

**Files:**
- Create: `frontend/app/planner/page.tsx`
- Create: `frontend/app/planner/page.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `GET /api/action-items?direction=&include_done=` and `PATCH /api/action-items/{id}` (Task 4).
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/planner/page.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import PlannerPage from './page'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

const TODAY = new Date('2026-07-17T12:00:00Z')

const ITEMS = [
  { id: '1', text: 'Overdue task', direction: 'mine', status: 'open', due_date: '2026-07-10', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: '2', text: 'Due this week', direction: 'theirs', status: 'open', due_date: '2026-07-19', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: '3', text: 'No due date task', direction: 'mine', status: 'open', due_date: null, contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
]

describe('PlannerPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
    apiFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('groups open items into Overdue, Due this week, and No due date sections', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(ITEMS))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())
    expect(screen.getByText('Due this week')).toBeInTheDocument()
    expect(screen.getByText('No due date task')).toBeInTheDocument()
  })

  it('refetches with include_done=true when the show-completed toggle is checked', async () => {
    const user = userEvent.setup({ delay: null })
    apiFetchMock.mockResolvedValue(jsonResponse(ITEMS))

    render(<PlannerPage />)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())

    await user.click(screen.getByRole('checkbox', { name: /show completed/i }))

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith('/api/action-items?include_done=true')
    )
  })

  it('marks an item done and refetches the list', async () => {
    const user = userEvent.setup({ delay: null })
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...ITEMS[0], status: 'done' }))
      }
      return Promise.resolve(jsonResponse(ITEMS))
    })

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())

    await user.click(screen.getAllByRole('button', { name: /mark done/i })[0])

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items/1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      })
    )
  })

  it('shows an inline error and leaves the item unchanged when the PATCH fails', async () => {
    const user = userEvent.setup({ delay: null })
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      return Promise.resolve(jsonResponse(ITEMS))
    })

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())

    await user.click(screen.getAllByRole('button', { name: /mark done/i })[0])

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(screen.getByText('Overdue task')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/planner/page.test.tsx`
Expected: FAIL — `Cannot find module './page'`.

- [ ] **Step 3: Implement the page**

Create `frontend/app/planner/page.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'

import { apiFetch } from '@/lib/api'

type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  contact: { id: string; display_name: string | null; email_address: string | null } | null
  created_at: string
  updated_at: string
}

type Direction = 'all' | 'mine' | 'theirs'

function daysFromNow(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00Z')
  const today = new Date()
  const startOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  return Math.round((due.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24))
}

export default function PlannerPage() {
  const [items, setItems] = useState<ActionItem[]>([])
  const [direction, setDirection] = useState<Direction>('all')
  const [includeDone, setIncludeDone] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (direction !== 'all') params.set('direction', direction)
    if (includeDone) params.set('include_done', 'true')
    const query = params.toString()
    const response = await apiFetch(`/api/action-items${query ? `?${query}` : ''}`)
    if (!response.ok) return
    setItems(await response.json())
  }, [direction, includeDone])

  useEffect(() => {
    load()
  }, [load])

  async function toggleDone(item: ActionItem) {
    setToggleError(null)
    const nextStatus = item.status === 'open' ? 'done' : 'open'
    const response = await apiFetch(`/api/action-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    })
    if (!response.ok) {
      setToggleError('Something went wrong updating that item. Please try again.')
      return
    }
    await load()
  }

  const openItems = items.filter((item) => item.status === 'open')
  const doneItems = items.filter((item) => item.status === 'done')

  const overdue = openItems.filter((item) => item.due_date && daysFromNow(item.due_date) < 0)
  const dueThisWeek = openItems.filter((item) => item.due_date && daysFromNow(item.due_date) >= 0 && daysFromNow(item.due_date) <= 7)
  const later = openItems.filter((item) => item.due_date && daysFromNow(item.due_date) > 7)
  const noDueDate = openItems.filter((item) => !item.due_date)

  function renderItem(item: ActionItem) {
    return (
      <li key={item.id}>
        {item.text}
        {item.contact && ` — ${item.contact.display_name ?? item.contact.email_address}`}
        <button onClick={() => toggleDone(item)} className="ml-2 underline">
          {item.status === 'open' ? 'Mark done' : 'Reopen'}
        </button>
      </li>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-4">
        <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
          <option value="all">All</option>
          <option value="mine">Mine</option>
          <option value="theirs">Theirs</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={includeDone}
            onChange={(e) => setIncludeDone(e.target.checked)}
          />
          {' '}Show completed
        </label>
      </div>

      {toggleError && <p role="alert" className="mt-2 text-red-600">{toggleError}</p>}

      {items.length === 0 ? (
        <p className="mt-4">Nothing due.</p>
      ) : (
        <>
          {overdue.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Overdue</h2>
              <ul>{overdue.map(renderItem)}</ul>
            </>
          )}
          {dueThisWeek.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Due this week</h2>
              <ul>{dueThisWeek.map(renderItem)}</ul>
            </>
          )}
          {later.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Later</h2>
              <ul>{later.map(renderItem)}</ul>
            </>
          )}
          {noDueDate.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">No due date</h2>
              <ul>{noDueDate.map(renderItem)}</ul>
            </>
          )}
          {includeDone && doneItems.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Completed</h2>
              <ul>{doneItems.map(renderItem)}</ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/planner/page.test.tsx`
Expected: PASS (4/4)

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: all tests pass (no regressions in `login`, `callback`, `dashboard`, `contacts`, `contacts/[id]` tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/planner/page.tsx frontend/app/planner/page.test.tsx
git commit -m "feat: add planner page grouped by due date with direction filter and done toggle"
```

---

## Final Verification

After all 9 tasks are complete:

- [ ] Run the full backend suite: `cd backend && pytest -v` — expect all tests passing.
- [ ] Run the full frontend suite: `cd frontend && npx vitest run` — expect all tests passing.
- [ ] Manually start both dev servers (`npm run dev` in `frontend/`, backend's existing run command) and click through: Dashboard → Contacts → a contact profile → Planner → mark an item done → confirm it disappears from the open view and reappears under "Completed" with "show completed" checked.
