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
