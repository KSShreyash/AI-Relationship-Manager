import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import httpx
import pytest

from app.repositories.calendar_events import CalendarEventsRepository
from app.repositories.chat_messages import ChatMessagesRepository
from app.repositories.emails import EmailsRepository
from app.repositories.profiles import ProfilesRepository
from app.repositories.sync_state import SyncStateRepository
from app.services.graph_sync import _parse_graph_datetime, sync_calendar, sync_chat, sync_mail


def test_parse_graph_datetime_handles_z_suffix():
    assert _parse_graph_datetime("2026-07-01T12:00:00Z") == datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_graph_datetime_handles_naive_utc_no_z():
    assert _parse_graph_datetime("2026-07-01T12:00:00.0000000") == datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_graph_datetime_truncates_seven_digit_fraction():
    result = _parse_graph_datetime("2026-07-01T12:00:00.1234567Z")
    assert result.microsecond == 123456


def test_parse_graph_datetime_handles_none():
    assert _parse_graph_datetime(None) is None


@pytest.mark.asyncio
async def test_sync_mail_upserts_and_stores_delta_link(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    page = {
        "items": [
            {
                "id": "msg-1",
                "subject": "Hello",
                "sender": {"emailAddress": {"address": "a@example.com", "name": "A"}},
                "toRecipients": [{"emailAddress": {"address": "b@example.com", "name": "B"}}],
                "receivedDateTime": "2026-07-01T12:00:00Z",
                "body": {"content": "Hi there"},
            }
        ],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/delta?$deltatoken=abc",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page):
        await sync_mail(pool, user_id, "access-token")

    assert await EmailsRepository(pool).count(user_id) == 1
    state = await SyncStateRepository(pool).get(user_id, "mail")
    assert state["delta_link"] == "https://graph.microsoft.com/v1.0/delta?$deltatoken=abc"
    assert state["status"] == "ok"


@pytest.mark.asyncio
async def test_sync_mail_resumes_from_stored_delta_link(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await SyncStateRepository(pool).upsert(user_id, "mail", "https://graph.microsoft.com/v1.0/delta?$deltatoken=prev", "ok")

    page = {"items": [], "next_link": None, "delta_link": "https://graph.microsoft.com/v1.0/delta?$deltatoken=next"}
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page) as mock_fetch:
        await sync_mail(pool, user_id, "access-token")

    mock_fetch.assert_called_once_with("access-token", "https://graph.microsoft.com/v1.0/delta?$deltatoken=prev")


@pytest.mark.asyncio
async def test_sync_mail_handles_removed_items(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await EmailsRepository(pool).upsert(
        user_id=user_id,
        graph_message_id="msg-to-remove",
        subject="Old",
        from_address="a@example.com",
        from_name="A",
        to_recipients=[],
        received_at=None,
        body_text=None,
    )

    page = {
        "items": [{"id": "msg-to-remove", "@removed": {"reason": "deleted"}}],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/delta?$deltatoken=abc",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page):
        await sync_mail(pool, user_id, "access-token")

    assert await EmailsRepository(pool).count(user_id) == 0


@pytest.mark.asyncio
async def test_sync_mail_sets_not_available_on_403(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    request = httpx.Request("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta")
    error = httpx.HTTPStatusError("forbidden", request=request, response=httpx.Response(403, request=request))

    with patch("app.services.graph_sync.graph_client.fetch_delta_page", side_effect=error):
        await sync_mail(pool, user_id, "access-token")

    state = await SyncStateRepository(pool).get(user_id, "mail")
    assert state["status"] == "not_available"


@pytest.mark.asyncio
async def test_sync_mail_skips_when_already_not_available(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await SyncStateRepository(pool).upsert(user_id, "mail", None, "not_available")

    with patch("app.services.graph_sync.graph_client.fetch_delta_page") as mock_fetch:
        await sync_mail(pool, user_id, "access-token")

    mock_fetch.assert_not_called()


@pytest.mark.asyncio
async def test_sync_calendar_upserts_with_online_meeting_info(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    page = {
        "items": [
            {
                "id": "evt-1",
                "subject": "Standup",
                "organizer": {"emailAddress": {"address": "a@example.com"}},
                "attendees": [{"emailAddress": {"address": "b@example.com", "name": "B"}}],
                "start": {"dateTime": "2026-07-01T09:00:00.0000000", "timeZone": "UTC"},
                "end": {"dateTime": "2026-07-01T09:30:00.0000000", "timeZone": "UTC"},
                "isOnlineMeeting": True,
                "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/meetup-join/xyz"},
                "body": {"content": "Daily sync"},
            }
        ],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=abc",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page):
        await sync_calendar(pool, user_id, "access-token")

    assert await CalendarEventsRepository(pool).count(user_id) == 1
    state = await SyncStateRepository(pool).get(user_id, "calendar")
    assert state["status"] == "ok"


@pytest.mark.asyncio
async def test_sync_calendar_first_sync_uses_backfill_and_lookahead_window(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    page = {"items": [], "next_link": None, "delta_link": "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=abc"}

    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page), \
         patch("app.services.graph_sync.graph_client.calendar_delta_url") as mock_url:
        mock_url.return_value = "https://graph.microsoft.com/v1.0/me/calendarView/delta?start=x&end=y"
        await sync_calendar(pool, user_id, "access-token")

    assert mock_url.call_count == 1
    start_arg, end_arg = mock_url.call_args[0]
    assert (end_arg - start_arg).days > 100  # spans BACKFILL_DAYS behind + CALENDAR_LOOKAHEAD_DAYS ahead


@pytest.mark.asyncio
async def test_sync_calendar_sets_not_available_on_403(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    request = httpx.Request("GET", "https://graph.microsoft.com/v1.0/me/calendarView/delta")
    error = httpx.HTTPStatusError("forbidden", request=request, response=httpx.Response(403, request=request))

    with patch("app.services.graph_sync.graph_client.fetch_delta_page", side_effect=error):
        await sync_calendar(pool, user_id, "access-token")

    state = await SyncStateRepository(pool).get(user_id, "calendar")
    assert state["status"] == "not_available"


@pytest.mark.asyncio
async def test_sync_calendar_resumes_from_stored_delta_link(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await SyncStateRepository(pool).upsert(
        user_id, "calendar", "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=prev", "ok"
    )

    page = {
        "items": [],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=next",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page) as mock_fetch:
        await sync_calendar(pool, user_id, "access-token")

    mock_fetch.assert_called_once_with(
        "access-token", "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=prev"
    )


@pytest.mark.asyncio
async def test_sync_calendar_handles_removed_items(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await CalendarEventsRepository(pool).upsert(
        user_id=user_id,
        graph_event_id="evt-to-remove",
        subject="Old",
        organizer=None,
        attendees=[],
        start_time=None,
        end_time=None,
        is_online_meeting=False,
        online_meeting_join_url=None,
        body_text=None,
    )

    page = {
        "items": [{"id": "evt-to-remove", "@removed": {"reason": "deleted"}}],
        "next_link": None,
        "delta_link": "https://graph.microsoft.com/v1.0/calendarView/delta?$deltatoken=abc",
    }
    with patch("app.services.graph_sync.graph_client.fetch_delta_page", return_value=page):
        await sync_calendar(pool, user_id, "access-token")

    assert await CalendarEventsRepository(pool).count(user_id) == 0


@pytest.mark.asyncio
async def test_sync_calendar_skips_when_already_not_available(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await SyncStateRepository(pool).upsert(user_id, "calendar", None, "not_available")

    with patch("app.services.graph_sync.graph_client.fetch_delta_page") as mock_fetch:
        await sync_calendar(pool, user_id, "access-token")

    mock_fetch.assert_not_called()


@pytest.mark.asyncio
async def test_sync_chat_upserts_messages_across_chats(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    chats = [{"id": "chat-1"}, {"id": "chat-2"}]
    page = {
        "items": [
            {
                "id": "chat-msg-1",
                "from": {"user": {"displayName": "Alice"}},
                "body": {"content": "Hey"},
                "createdDateTime": "2026-07-01T12:00:00Z",
            }
        ],
        "next_link": None,
    }
    with patch("app.services.graph_sync.graph_client.list_chats", return_value=chats), \
         patch("app.services.graph_sync.graph_client.fetch_chat_messages_page", return_value=page):
        await sync_chat(pool, user_id, "access-token")

    assert await ChatMessagesRepository(pool).count(user_id) == 2  # one message per chat
    state = await SyncStateRepository(pool).get(user_id, "chat")
    assert state["status"] == "ok"
    assert state["delta_link"] is None


@pytest.mark.asyncio
async def test_sync_chat_sets_not_available_when_list_chats_forbidden(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    request = httpx.Request("GET", "https://graph.microsoft.com/v1.0/me/chats")
    error = httpx.HTTPStatusError("forbidden", request=request, response=httpx.Response(403, request=request))

    with patch("app.services.graph_sync.graph_client.list_chats", side_effect=error), \
         patch("app.services.graph_sync.graph_client.fetch_chat_messages_page") as mock_messages:
        await sync_chat(pool, user_id, "access-token")

    mock_messages.assert_not_called()
    state = await SyncStateRepository(pool).get(user_id, "chat")
    assert state["status"] == "not_available"


@pytest.mark.asyncio
async def test_sync_chat_skips_when_already_not_available(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await SyncStateRepository(pool).upsert(user_id, "chat", None, "not_available")

    with patch("app.services.graph_sync.graph_client.list_chats") as mock_list:
        await sync_chat(pool, user_id, "access-token")

    mock_list.assert_not_called()
