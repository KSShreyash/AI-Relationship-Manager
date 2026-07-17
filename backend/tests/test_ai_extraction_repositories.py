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
