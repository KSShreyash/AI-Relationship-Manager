from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
import respx
from httpx import Response

from app.services.graph_client import GraphRefreshError, get_me, refresh_access_token


@patch("app.services.graph_client.msal.ConfidentialClientApplication")
def test_refresh_access_token_success(mock_app_cls):
    mock_app = MagicMock()
    mock_app.acquire_token_by_refresh_token.return_value = {
        "access_token": "new-access",
        "refresh_token": "new-refresh",
        "expires_in": 3600,
    }
    mock_app_cls.return_value = mock_app

    result = refresh_access_token("old-refresh", scopes=["Mail.Read"])

    assert result["access_token"] == "new-access"
    assert result["refresh_token"] == "new-refresh"
    assert result["expires_at"] > datetime.now(timezone.utc)


@patch("app.services.graph_client.msal.ConfidentialClientApplication")
def test_refresh_access_token_failure_raises(mock_app_cls):
    mock_app = MagicMock()
    mock_app.acquire_token_by_refresh_token.return_value = {
        "error": "invalid_grant",
        "error_description": "refresh token expired",
    }
    mock_app_cls.return_value = mock_app

    with pytest.raises(GraphRefreshError):
        refresh_access_token("old-refresh", scopes=["Mail.Read"])


@pytest.mark.asyncio
@respx.mock
async def test_get_me_returns_json():
    respx.get("https://graph.microsoft.com/v1.0/me").mock(
        return_value=Response(200, json={"mail": "user@example.com"})
    )

    result = await get_me("access-token")

    assert result["mail"] == "user@example.com"
