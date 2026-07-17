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
