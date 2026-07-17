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


@pytest.mark.asyncio
async def test_patch_action_item_404_for_item_owned_by_another_user(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=other_user_id, contact_id=None, text="Other user's item", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    item_row = await pool.fetchrow(
        "select id from public.action_items where user_id = $1", other_user_id
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.patch(
                f"/api/action-items/{item_row['id']}", json={"status": "done"}
            )

        assert response.status_code == 404
        assert await action_items.count_open(other_user_id) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_action_items_only_returns_callers_own_items(pool, test_auth_user, test_auth_user_2):
    user_id, email = test_auth_user
    other_user_id, other_email = test_auth_user_2
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).upsert(other_user_id, other_email)
    action_items = ActionItemsRepository(pool)
    await action_items.insert(
        user_id=user_id, contact_id=None, text="Mine own item", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    await action_items.insert(
        user_id=other_user_id, contact_id=None, text="Other user's item", direction="mine",
        due_date=None, source_type="email", source_id=uuid.uuid4(),
    )
    _override_auth(user_id, email)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/action-items")

        assert response.status_code == 200
        texts = {row["text"] for row in response.json()}
        assert texts == {"Mine own item"}
    finally:
        app.dependency_overrides.clear()
