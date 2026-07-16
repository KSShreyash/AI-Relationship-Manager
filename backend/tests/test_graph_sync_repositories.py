import uuid
from datetime import datetime, timezone

import pytest

from app.repositories.emails import EmailsRepository
from app.repositories.profiles import ProfilesRepository
from app.repositories.sync_state import SyncStateRepository


@pytest.mark.asyncio
async def test_sync_state_upsert_and_get(pool, test_auth_user):
    user_id, email = test_auth_user
    profiles_repo = ProfilesRepository(pool)
    await profiles_repo.upsert(user_id, email)
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
    user_id, email = test_auth_user
    profiles_repo = ProfilesRepository(pool)
    await profiles_repo.upsert(user_id, email)
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
    user_id, email = test_auth_user
    profiles_repo = ProfilesRepository(pool)
    await profiles_repo.upsert(user_id, email)
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
