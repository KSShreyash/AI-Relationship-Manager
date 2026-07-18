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
