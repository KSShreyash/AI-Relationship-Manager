import re
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx

from app.repositories.calendar_events import CalendarEventsRepository
from app.repositories.emails import EmailsRepository
from app.repositories.sync_state import SyncStateRepository
from app.services import graph_client

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
