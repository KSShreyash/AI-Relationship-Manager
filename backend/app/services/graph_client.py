from datetime import datetime, timedelta, timezone
import asyncio

import httpx
import msal

from app.core.config import settings

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


class GraphRefreshError(Exception):
    pass


def _confidential_client() -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        client_id=settings.ms_client_id,
        client_credential=settings.ms_client_secret,
        authority=settings.ms_authority,
    )


def refresh_access_token(refresh_token: str, scopes: list[str]) -> dict:
    app = _confidential_client()
    result = app.acquire_token_by_refresh_token(refresh_token, scopes=scopes)
    if "access_token" not in result:
        raise GraphRefreshError(result.get("error_description", "refresh failed"))
    return {
        "access_token": result["access_token"],
        "refresh_token": result.get("refresh_token", refresh_token),
        "expires_at": datetime.now(timezone.utc) + timedelta(seconds=result["expires_in"]),
    }


async def get_me(access_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{GRAPH_BASE_URL}/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    response.raise_for_status()
    return response.json()


async def _get_json(client: httpx.AsyncClient, url: str, headers: dict) -> dict:
    response = await client.get(url, headers=headers)
    if response.status_code == 429:
        retry_after = float(response.headers.get("Retry-After", "1"))
        await asyncio.sleep(retry_after)
        response = await client.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


def mail_delta_url(since: datetime) -> str:
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{GRAPH_BASE_URL}/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime ge {since_str}"


def calendar_delta_url(start: datetime, end: datetime) -> str:
    start_str = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    end_str = end.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{GRAPH_BASE_URL}/me/calendarView/delta?startDateTime={start_str}&endDateTime={end_str}"


async def fetch_delta_page(access_token: str, url: str) -> dict:
    async with httpx.AsyncClient() as client:
        body = await _get_json(client, url, {"Authorization": f"Bearer {access_token}"})
    return {
        "items": body.get("value", []),
        "next_link": body.get("@odata.nextLink"),
        "delta_link": body.get("@odata.deltaLink"),
    }
