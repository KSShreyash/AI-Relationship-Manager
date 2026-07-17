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
