from datetime import datetime, timezone

import pytest
import respx
from httpx import Response

from app.services.graph_client import calendar_delta_url, fetch_delta_page, mail_delta_url


def test_mail_delta_url_scopes_to_inbox_and_since():
    since = datetime(2026, 6, 16, tzinfo=timezone.utc)
    url = mail_delta_url(since)
    assert url == (
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"
        "?$filter=receivedDateTime ge 2026-06-16T00:00:00Z"
    )


def test_calendar_delta_url_includes_date_range():
    start = datetime(2026, 6, 16, tzinfo=timezone.utc)
    end = datetime(2026, 10, 14, tzinfo=timezone.utc)
    url = calendar_delta_url(start, end)
    assert url == (
        "https://graph.microsoft.com/v1.0/me/calendarView/delta"
        "?startDateTime=2026-06-16T00:00:00Z&endDateTime=2026-10-14T00:00:00Z"
    )


@pytest.mark.asyncio
@respx.mock
async def test_fetch_delta_page_returns_items_and_links():
    respx.get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta").mock(
        return_value=Response(
            200,
            json={
                "value": [{"id": "msg-1", "subject": "Hi"}],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc",
            },
        )
    )

    result = await fetch_delta_page(
        "access-token", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"
    )

    assert result["items"] == [{"id": "msg-1", "subject": "Hi"}]
    assert result["next_link"] == "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc"
    assert result["delta_link"] is None


@pytest.mark.asyncio
@respx.mock
async def test_fetch_delta_page_retries_once_on_429():
    route = respx.get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta").mock(
        side_effect=[
            Response(429, headers={"Retry-After": "0"}),
            Response(200, json={"value": [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?$deltatoken=done"}),
        ]
    )

    result = await fetch_delta_page(
        "access-token", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"
    )

    assert route.call_count == 2
    assert result["delta_link"] == "https://graph.microsoft.com/v1.0/delta?$deltatoken=done"
