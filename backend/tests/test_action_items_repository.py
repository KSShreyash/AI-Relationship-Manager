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
