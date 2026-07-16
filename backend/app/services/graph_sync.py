import re
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx
from starlette.concurrency import run_in_threadpool

from app.core.security import decrypt_token, encrypt_token
from app.repositories.calendar_events import CalendarEventsRepository
from app.repositories.chat_messages import ChatMessagesRepository
from app.repositories.emails import EmailsRepository
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.repositories.sync_state import SyncStateRepository
from app.services import graph_client
from app.services.graph_client import GraphRefreshError, refresh_access_token

BACKFILL_DAYS = 30
CALENDAR_LOOKAHEAD_DAYS = 90

_FRACTION_RE = re.compile(r"(\.\d{7,})")


def _parse_graph_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.replace("Z", "+00:00")
    match = _FRACTION_RE.search(value)
    if match:
        value = value.replace(match.group(1), match.group(1)[:7])
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


async def sync_mail(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None:
    sync_state = SyncStateRepository(pool)
    emails = EmailsRepository(pool)

    state = await sync_state.get(user_id, "mail")
    if state is not None and state["status"] == "not_available":
        return

    url = (
        state["delta_link"]
        if state and state["delta_link"]
        else graph_client.mail_delta_url(datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS))
    )

    try:
        delta_link = None
        while True:
            page = await graph_client.fetch_delta_page(access_token, url)
            for item in page["items"]:
                if "@removed" in item:
                    await emails.delete(user_id, item["id"])
                    continue
                sender = (item.get("sender") or {}).get("emailAddress") or {}
                await emails.upsert(
                    user_id=user_id,
                    graph_message_id=item["id"],
                    subject=item.get("subject"),
                    from_address=sender.get("address"),
                    from_name=sender.get("name"),
                    to_recipients=[
                        (r.get("emailAddress") or {}) for r in item.get("toRecipients", [])
                    ],
                    received_at=_parse_graph_datetime(item.get("receivedDateTime")),
                    body_text=(item.get("body") or {}).get("content"),
                )
            if page["delta_link"]:
                delta_link = page["delta_link"]
                break
            url = page["next_link"]
        await sync_state.upsert(user_id, "mail", delta_link, "ok")
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (400, 403):
            await sync_state.upsert(user_id, "mail", None, "not_available")
        else:
            raise


async def sync_calendar(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None:
    sync_state = SyncStateRepository(pool)
    events = CalendarEventsRepository(pool)

    state = await sync_state.get(user_id, "calendar")
    if state is not None and state["status"] == "not_available":
        return

    if state and state["delta_link"]:
        url = state["delta_link"]
    else:
        now = datetime.now(timezone.utc)
        url = graph_client.calendar_delta_url(
            now - timedelta(days=BACKFILL_DAYS),
            now + timedelta(days=CALENDAR_LOOKAHEAD_DAYS),
        )

    try:
        delta_link = None
        while True:
            page = await graph_client.fetch_delta_page(access_token, url)
            for item in page["items"]:
                if "@removed" in item:
                    await events.delete(user_id, item["id"])
                    continue
                online_meeting = item.get("onlineMeeting") or {}
                await events.upsert(
                    user_id=user_id,
                    graph_event_id=item["id"],
                    subject=item.get("subject"),
                    organizer=((item.get("organizer") or {}).get("emailAddress") or {}).get("address"),
                    attendees=[
                        (a.get("emailAddress") or {}) for a in item.get("attendees", [])
                    ],
                    start_time=_parse_graph_datetime((item.get("start") or {}).get("dateTime")),
                    end_time=_parse_graph_datetime((item.get("end") or {}).get("dateTime")),
                    is_online_meeting=item.get("isOnlineMeeting", False),
                    online_meeting_join_url=online_meeting.get("joinUrl"),
                    body_text=(item.get("body") or {}).get("content"),
                )
            if page["delta_link"]:
                delta_link = page["delta_link"]
                break
            url = page["next_link"]
        await sync_state.upsert(user_id, "calendar", delta_link, "ok")
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (400, 403):
            await sync_state.upsert(user_id, "calendar", None, "not_available")
        else:
            raise


async def sync_chat(pool: asyncpg.Pool, user_id: uuid.UUID, access_token: str) -> None:
    sync_state = SyncStateRepository(pool)
    messages = ChatMessagesRepository(pool)

    state = await sync_state.get(user_id, "chat")
    if state is not None and state["status"] == "not_available":
        return

    since = (
        state["last_synced_at"]
        if state and state["last_synced_at"]
        else datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS)
    )

    try:
        chats = await graph_client.list_chats(access_token)

        for chat in chats:
            chat_id = chat["id"]
            url = graph_client.chat_messages_url(chat_id, since)
            while url:
                page = await graph_client.fetch_chat_messages_page(access_token, url)
                for item in page["items"]:
                    from_user = (item.get("from") or {}).get("user") or {}
                    await messages.upsert(
                        user_id=user_id,
                        graph_chat_id=chat_id,
                        graph_message_id=item["id"],
                        from_user=from_user.get("displayName"),
                        content=(item.get("body") or {}).get("content"),
                        sent_at=_parse_graph_datetime(item.get("createdDateTime")),
                    )
                url = page["next_link"]
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (400, 403):
            await sync_state.upsert(user_id, "chat", None, "not_available")
            return
        raise

    await sync_state.upsert(user_id, "chat", None, "ok")


async def sync_user(pool: asyncpg.Pool, user_id: uuid.UUID) -> None:
    tokens_repo = GraphTokensRepository(pool)
    profiles_repo = ProfilesRepository(pool)

    token_row = await tokens_repo.get(user_id)
    if token_row is None:
        return

    access_token = decrypt_token(token_row["encrypted_access_token"])

    if token_row["access_token_expires_at"] <= datetime.now(timezone.utc):
        refresh_token = decrypt_token(token_row["encrypted_refresh_token"])
        try:
            refreshed = await run_in_threadpool(
                refresh_access_token, refresh_token, scopes=token_row["scopes"]
            )
        except GraphRefreshError:
            await profiles_repo.set_graph_connection_status(user_id, "needs_reauth")
            return

        await tokens_repo.upsert(
            user_id=user_id,
            encrypted_access_token=encrypt_token(refreshed["access_token"]),
            encrypted_refresh_token=encrypt_token(refreshed["refresh_token"]),
            access_token_expires_at=refreshed["expires_at"],
            scopes=token_row["scopes"],
        )
        access_token = refreshed["access_token"]

    await sync_mail(pool, user_id, access_token)
    await sync_calendar(pool, user_id, access_token)
    await sync_chat(pool, user_id, access_token)
