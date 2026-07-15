from datetime import datetime, timedelta, timezone

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
