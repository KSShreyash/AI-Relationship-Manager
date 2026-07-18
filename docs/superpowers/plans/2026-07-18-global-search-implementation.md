# Global Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user search across their contacts and action items from a single page, using Postgres full-text search, with results grouped by type and ranked by relevance.

**Architecture:** A new backend router (`GET /api/search?q=`) runs two independent full-text queries (one per repository) using Postgres's `websearch_to_tsquery`/`ts_rank`, computed at query time with no schema migration. A new frontend page reuses the debounced-search + stale-response-guard pattern already built and tested on the Contacts list page.

**Tech Stack:** FastAPI + asyncpg (backend, Postgres full-text search built-ins — no new extension), Next.js + Vitest/RTL (frontend).

## Global Constraints

- Endpoints return raw Python dicts (never `response_model=`) containing raw `uuid.UUID`/`date` values directly — FastAPI's `jsonable_encoder` serializes them automatically. No manual `.isoformat()`/`str()` anywhere in new router code.
- Every route uses the existing `CurrentUser` dependency; all queries scoped by `user_id`.
- No pagination — each result section capped at a fixed `RESULT_LIMIT = 20` constant, not offset pagination.
- No new schema, no migration — full-text matching uses `to_tsvector('english', ...)` computed inline in the query against existing columns.
- `websearch_to_tsquery` (not `to_tsquery`/`plainto_tsquery`) is used specifically because it accepts arbitrary free-text user input without throwing on unbalanced quotes or malformed boolean syntax — no separate input-validation step is needed for the query text itself.
- An empty or missing `q` returns `{"contacts": [], "action_items": []}` immediately, without querying the database.
- Backend tests hit the real Supabase test DB via the existing `pool`/`test_auth_user`/`test_auth_user_2` fixtures (`backend/tests/conftest.py`).
- Frontend tests mock `apiFetch` via `vi.mock('@/lib/api', ...)` with `vi.hoisted`, matching every existing page test. This page has debounce logic (like the Contacts list page) but no date-dependent logic, so its tests need `vi.useFakeTimers()`/`vi.advanceTimersByTimeAsync()` for the debounce timing and `fireEvent` (not `userEvent`) for any interaction, per the documented gotchas in `frontend/AGENTS.md` — but do NOT need the `toFake: ['Date']` scoping (no `Date`-dependent logic on this page at all, so a bare `vi.useFakeTimers()` is correct here, matching the Contacts page's own test, not the Planner page's `Date`-scoped variant).
- No `next/link` — plain `<a href="...">` only, matching this codebase's established convention.

---

### Task 1: Repository search methods

**Files:**
- Modify: `backend/app/repositories/contacts.py`
- Modify: `backend/app/repositories/action_items.py`
- Test: `backend/tests/test_contacts_repository.py`
- Test: `backend/tests/test_action_items_repository.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ContactsRepository.search(user_id: uuid.UUID, query: str, limit: int) -> list[asyncpg.Record]` and `ActionItemsRepository.search(user_id: uuid.UUID, query: str, limit: int) -> list[asyncpg.Record]`. Task 2 (router) consumes both.

- [ ] **Step 1: Write the failing repository tests**

Add to `backend/tests/test_contacts_repository.py`:

```python
@pytest.mark.asyncio
async def test_search_ranks_more_term_occurrences_higher(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)
    await repo.upsert_by_email(
        user_id, "alice@example.com", "Alice Johnson", "Talked about budget planning once"
    )
    await repo.upsert_by_email(
        user_id, "bob@example.com", "Bob Smith",
        "Budget is the main topic, budget budget budget, always about the budget",
    )

    results = await repo.search(user_id, "budget", 20)

    assert len(results) == 2
    assert results[0]["display_name"] == "Bob Smith"
    assert results[1]["display_name"] == "Alice Johnson"


@pytest.mark.asyncio
async def test_search_matches_display_name_email_and_notes(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)
    await repo.upsert_by_email(user_id, "zephyr@example.com", "Regular Name", None)
    await repo.upsert_by_email(user_id, "regular@example.com", "Zephyr Name", None)
    await repo.upsert_by_email(user_id, "regular2@example.com", "Regular Name Two", "mentions zephyr here")

    results = await repo.search(user_id, "zephyr", 20)

    assert {row["email_address"] for row in results} == {
        "zephyr@example.com", "regular@example.com", "regular2@example.com",
    }


@pytest.mark.asyncio
async def test_search_excludes_other_users_contacts(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    repo = ContactsRepository(pool)
    await repo.upsert_by_email(user_id, "mine@example.com", "Findable Mine", None)
    await repo.upsert_by_email(other_user_id, "theirs@example.com", "Findable Theirs", None)

    results = await repo.search(user_id, "findable", 20)

    assert len(results) == 1
    assert results[0]["email_address"] == "mine@example.com"


@pytest.mark.asyncio
async def test_search_respects_limit(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    repo = ContactsRepository(pool)
    for i in range(25):
        await repo.upsert_by_email(user_id, f"person{i}@example.com", f"Capped Person {i}", None)

    results = await repo.search(user_id, "capped", 20)

    assert len(results) == 20
```

Add to `backend/tests/test_action_items_repository.py` (add `from app.repositories.contacts import ContactsRepository` to the imports if not already present):

```python
@pytest.mark.asyncio
async def test_search_ranks_more_term_occurrences_higher(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Discuss the roadmap once", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None,
        text="Roadmap roadmap roadmap - the roadmap is the main topic, always roadmap",
        direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
    )

    results = await action_items.search(user_id, "roadmap", 20)

    assert len(results) == 2
    assert "always roadmap" in results[0]["text"]
    assert "once" in results[1]["text"]


@pytest.mark.asyncio
async def test_search_embeds_contact_or_null(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "gina@example.com", "Gina", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Unique term alpha with contact",
        direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Unique term alpha without contact",
        direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
    )

    results = await action_items.search(user_id, "alpha", 20)

    by_text = {row["text"]: row for row in results}
    assert by_text["Unique term alpha with contact"]["contact_display_name"] == "Gina"
    assert by_text["Unique term alpha without contact"]["contact_id"] is None


@pytest.mark.asyncio
async def test_search_excludes_other_users_action_items(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Findable mine item",
        direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=other_user_id, contact_id=None, text="Findable theirs item",
        direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
    )

    results = await action_items.search(user_id, "findable", 20)

    assert len(results) == 1
    assert results[0]["text"] == "Findable mine item"


@pytest.mark.asyncio
async def test_search_respects_limit(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    for i in range(25):
        await action_items.insert(
            user_id=user_id, contact_id=None, text=f"Cappeditem number {i}",
            direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
        )

    results = await action_items.search(user_id, "cappeditem", 20)

    assert len(results) == 20
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_contacts_repository.py tests/test_action_items_repository.py -v`
Expected: FAIL — `AttributeError: 'ContactsRepository' object has no attribute 'search'` (and same for `ActionItemsRepository`).

- [ ] **Step 3: Implement the repository methods**

In `backend/app/repositories/contacts.py`, add (place it near `list_for_user`, which it resembles):

```python
    async def search(
        self, user_id: uuid.UUID, query: str, limit: int
    ) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select *,
                   ts_rank(
                       to_tsvector('english',
                           coalesce(display_name, '') || ' ' ||
                           replace(coalesce(email_address, ''), '@', ' ') || ' ' ||
                           coalesce(notes, '')
                       ),
                       websearch_to_tsquery('english', $2)
                   ) as rank
            from public.contacts
            where user_id = $1
              and to_tsvector('english',
                      coalesce(display_name, '') || ' ' ||
                      replace(coalesce(email_address, ''), '@', ' ') || ' ' ||
                      coalesce(notes, '')
                  ) @@ websearch_to_tsquery('english', $2)
            order by rank desc
            limit $3
            """,
            user_id,
            query,
            limit,
        )
```

Note the `replace(coalesce(email_address, ''), '@', ' ')` — verified directly against the live database before this plan was written: Postgres's `to_tsvector` treats an email-shaped string (`zephyr@example.com`) as a single indivisible lexeme, so searching for just `zephyr` would never match it without first replacing `@` with a space to split it into separate, matchable words (`zephyr` / `example.com`). Without this, only a search for the complete email address would ever match.

In `backend/app/repositories/action_items.py`, add (place it near `list_for_user`, which it resembles):

```python
    async def search(
        self, user_id: uuid.UUID, query: str, limit: int
    ) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            select ai.*,
                   c.display_name as contact_display_name,
                   c.email_address as contact_email_address,
                   ts_rank(to_tsvector('english', ai.text), websearch_to_tsquery('english', $2)) as rank
            from public.action_items ai
            left join public.contacts c on c.id = ai.contact_id
            where ai.user_id = $1
              and to_tsvector('english', ai.text) @@ websearch_to_tsquery('english', $2)
            order by rank desc
            limit $3
            """,
            user_id,
            query,
            limit,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_contacts_repository.py tests/test_action_items_repository.py -v`
Expected: PASS (8 new tests; all pre-existing tests in both files still pass unchanged).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions (baseline: 158 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/app/repositories/contacts.py backend/app/repositories/action_items.py backend/tests/test_contacts_repository.py backend/tests/test_action_items_repository.py
git commit -m "feat: add full-text search methods to ContactsRepository and ActionItemsRepository"
```

---

### Task 2: Search router

**Files:**
- Create: `backend/app/api/v1/search.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_search_endpoint.py`

**Interfaces:**
- Consumes: `ContactsRepository.search`/`ActionItemsRepository.search` (Task 1).
- Produces: `router` (prefix `/api/search`). Route: `GET /api/search?q=` → `{"contacts": [...], "action_items": [...]}`. Nothing later consumes this directly (Task 3 calls the HTTP endpoint, not Python code).

- [ ] **Step 1: Write the failing endpoint tests**

Create `backend/tests/test_search_endpoint.py`:

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
async def test_search_returns_both_result_types(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)
    contact_id = await contacts.upsert_by_email(user_id, "gina@example.com", "Gina Marconi", None)
    await action_items.insert(
        user_id=user_id, contact_id=contact_id, text="Follow up with Marconi about the deck",
        direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/search", params={"q": "marconi"})

        assert response.status_code == 200
        body = response.json()
        assert len(body["contacts"]) == 1
        assert body["contacts"][0]["display_name"] == "Gina Marconi"
        assert len(body["action_items"]) == 1
        assert body["action_items"][0]["contact"] == {
            "id": str(contact_id), "display_name": "Gina Marconi", "email_address": "gina@example.com",
        }
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_search_action_item_contact_is_null_when_unlinked(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Standalone unlinkeditem task",
        direction="mine", due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/search", params={"q": "unlinkeditem"})

        assert response.json()["action_items"][0]["contact"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_search_empty_query_returns_empty_results_without_error(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            no_param = await client.get("/api/search")
            empty_param = await client.get("/api/search", params={"q": ""})

        assert no_param.json() == {"contacts": [], "action_items": []}
        assert empty_param.json() == {"contacts": [], "action_items": []}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_search_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/search", params={"q": "anything"})

    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_search_excludes_other_users_results(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    await ContactsRepository(pool).upsert_by_email(other_user_id, "notmine@example.com", "Uniqueperson Foreign", None)
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/search", params={"q": "uniqueperson"})

        assert response.json() == {"contacts": [], "action_items": []}
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_search_endpoint.py -v`
Expected: FAIL — 404s (route doesn't exist yet).

- [ ] **Step 3: Implement the router**

Create `backend/app/api/v1/search.py`:

```python
from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository

router = APIRouter(prefix="/api/search", tags=["search"])

RESULT_LIMIT = 20


def _serialize_contact(row) -> dict:
    return {
        "id": row["id"],
        "display_name": row["display_name"],
        "email_address": row["email_address"],
        "notes": row["notes"],
    }


def _serialize_action_item(row) -> dict:
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
    }


@router.get("")
async def search(q: str | None = None, current_user: CurrentUser = Depends(get_current_user)):
    if not q:
        return {"contacts": [], "action_items": []}

    pool = await get_pool()
    contact_rows = await ContactsRepository(pool).search(current_user.user_id, q, RESULT_LIMIT)
    action_item_rows = await ActionItemsRepository(pool).search(current_user.user_id, q, RESULT_LIMIT)

    return {
        "contacts": [_serialize_contact(row) for row in contact_rows],
        "action_items": [_serialize_action_item(row) for row in action_item_rows],
    }
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, change the import to:

```python
from app.api.v1 import action_items, auth, contacts, dashboard, extraction, me, scheduling, search, sync
```

Add, after `app.include_router(scheduling.router)`:

```python
app.include_router(search.router)
```

(full ordering: `action_items`, `auth`, `contacts`, `dashboard`, `me`, `scheduling`, `search`, `sync`, `extraction`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_search_endpoint.py -v`
Expected: PASS (5/5)

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: all pass, no regressions. This is the last backend task — record the final pass count for the whole-branch review later.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v1/search.py backend/app/main.py backend/tests/test_search_endpoint.py
git commit -m "feat: add GET /api/search endpoint"
```

---

### Task 3: Search page + nav link

**Files:**
- Create: `frontend/app/search/page.tsx`
- Create: `frontend/app/search/page.test.tsx`
- Modify: `frontend/app/layout.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `GET /api/search?q=` (Task 2).
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/search/page.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import SearchPage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('SearchPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('shows a prompt before any query is typed', () => {
    render(<SearchPage />)

    expect(screen.getByText(/type to search/i)).toBeInTheDocument()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('debounces the query and shows grouped results', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        contacts: [
          { id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com', notes: 'Discussed the budget' },
        ],
        action_items: [
          { id: 'a1', text: 'Follow up with Alice', direction: 'mine', status: 'open', due_date: null,
            contact: { id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com' } },
        ],
      })
    )

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/search?q=alice')
    expect(await screen.findByRole('link', { name: /alice johnson/i })).toHaveAttribute('href', '/contacts/c1')
    expect(screen.getByText(/follow up with alice/i)).toBeInTheDocument()
    expect(screen.getByText(/discussed the budget/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows empty-state copy per section when a search returns nothing', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(jsonResponse({ contacts: [], action_items: [] }))

    render(<SearchPage />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'nomatch' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(await screen.findByText(/no matching contacts/i)).toBeInTheDocument()
    expect(screen.getByText(/no matching action items/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows an inline error and keeps prior results on failure', async () => {
    vi.useFakeTimers()
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({
        contacts: [{ id: 'c1', display_name: 'Kept Contact', email_address: null, notes: null }],
        action_items: [],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'kept' } })
    await vi.advanceTimersByTimeAsync(300)
    await screen.findByText('Kept Contact')

    fireEvent.change(input, { target: { value: 'kept2' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    expect(screen.getByText('Kept Contact')).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('debounces search input and ignores a stale out-of-order response', async () => {
    vi.useFakeTimers()

    let resolveFirst: (value: Response) => void = () => {}
    let resolveSecond: (value: Response) => void = () => {}
    apiFetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // "sm"
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve })) // "smi"

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'sm' } })
    await vi.advanceTimersByTimeAsync(300)
    fireEvent.change(input, { target: { value: 'smi' } })
    await vi.advanceTimersByTimeAsync(300)

    resolveSecond(jsonResponse({
      contacts: [{ id: '2', display_name: 'Smith', email_address: null, notes: null }],
      action_items: [],
    }))
    await vi.waitFor(() => expect(screen.getByText('Smith')).toBeInTheDocument())

    resolveFirst(jsonResponse({
      contacts: [{ id: '3', display_name: 'Smiley', email_address: null, notes: null }],
      action_items: [],
    }))
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('Smith')).toBeInTheDocument()
    expect(screen.queryByText('Smiley')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/search/page.test.tsx`
Expected: FAIL — `Cannot find module './page'`.

- [ ] **Step 3: Implement the page**

Create `frontend/app/search/page.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'

import { apiFetch } from '@/lib/api'

type Contact = {
  id: string
  display_name: string | null
  email_address: string | null
  notes: string | null
}

type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  contact: { id: string; display_name: string | null; email_address: string | null } | null
}

type Results = { contacts: Contact[]; action_items: ActionItem[] }

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  useEffect(() => {
    if (!query) {
      setResults(null)
      setError(null)
      return
    }

    const timer = setTimeout(() => {
      const thisRequest = ++requestId.current
      apiFetch(`/api/search?q=${encodeURIComponent(query)}`).then(async (response) => {
        if (thisRequest !== requestId.current) return
        if (!response.ok) {
          setError('Something went wrong searching. Please try again.')
          return
        }
        setError(null)
        setResults(await response.json())
      })
    }, 300)

    return () => clearTimeout(timer)
  }, [query])

  return (
    <div className="p-6">
      <input
        type="text"
        placeholder="Search contacts and action items…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="rounded border border-gray-300 px-3 py-2"
      />

      {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}

      {results === null ? (
        <p className="mt-4">Type to search your contacts and action items.</p>
      ) : (
        <>
          <h2 className="mt-6 text-lg">Contacts</h2>
          {results.contacts.length === 0 ? (
            <p>No matching contacts.</p>
          ) : (
            <ul>
              {results.contacts.map((contact) => (
                <li key={contact.id}>
                  <a href={`/contacts/${contact.id}`}>
                    {contact.display_name ?? contact.email_address}
                  </a>
                  {contact.notes && ` — ${contact.notes}`}
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-6 text-lg">Action Items</h2>
          {results.action_items.length === 0 ? (
            <p>No matching action items.</p>
          ) : (
            <ul>
              {results.action_items.map((item) => (
                <li key={item.id}>
                  {item.text}
                  {item.contact && (
                    <>
                      {' — '}
                      <a href={`/contacts/${item.contact.id}`}>
                        {item.contact.display_name ?? item.contact.email_address}
                      </a>
                    </>
                  )}
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/search/page.test.tsx`
Expected: PASS (5/5)

- [ ] **Step 5: Add the nav link**

In `frontend/app/layout.tsx`, replace the `<nav>` block:

```tsx
        <nav className="flex gap-4 border-b border-gray-200 px-6 py-3">
          <a href="/dashboard">Dashboard</a>
          <a href="/contacts">Contacts</a>
          <a href="/planner">Planner</a>
          <a href="/search">Search</a>
        </nav>
```

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: all pass, no regressions (baseline: 28 passed across 9 files).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/search/page.tsx frontend/app/search/page.test.tsx frontend/app/layout.tsx
git commit -m "feat: add global search page and nav link"
```

---

## Final Verification

After all 3 tasks are complete:

- [ ] Run the full backend suite: `cd backend && .venv/Scripts/python.exe -m pytest -q` — expect all tests passing.
- [ ] Run the full frontend suite: `cd frontend && npx vitest run` — expect all tests passing.
- [ ] Manually start both dev servers and click through: search for a known contact's name, confirm it appears under Contacts and links to their profile; search for a term known to appear in an action item's text, confirm it appears under Action Items with its linked contact (if any) shown as a link; clear the search box and confirm the prompt returns.
