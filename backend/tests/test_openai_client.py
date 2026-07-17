import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from openai import RateLimitError

from app.services.openai_client import extract


def _mock_response(payload: dict) -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=json.dumps(payload)))]
    return response


def _rate_limit_error() -> RateLimitError:
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    response = httpx.Response(429, request=request, json={"error": {"message": "rate limited"}})
    return RateLimitError("rate limited", response=response, body=None)


@pytest.mark.asyncio
async def test_extract_returns_parsed_json():
    payload = {"people": [{"ref": "p0", "notes": "Works at Acme"}], "action_items": []}
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=_mock_response(payload))

    with patch("app.services.openai_client._client", return_value=mock_client):
        result = await extract(
            "Hi, I work at Acme.",
            [{"ref": "p0", "email": "a@example.com", "name": None, "notes": None}],
        )

    assert result == payload
    mock_client.chat.completions.create.assert_called_once()
    _, kwargs = mock_client.chat.completions.create.call_args
    assert kwargs["model"] == "gpt-4o-mini"
    assert "response_format" in kwargs


@pytest.mark.asyncio
async def test_extract_retries_once_on_rate_limit():
    payload = {"people": [], "action_items": []}
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(
        side_effect=[_rate_limit_error(), _mock_response(payload)]
    )

    with patch("app.services.openai_client._client", return_value=mock_client), \
         patch("app.services.openai_client.asyncio.sleep", new=AsyncMock()):
        result = await extract("content", [])

    assert result == payload
    assert mock_client.chat.completions.create.call_count == 2
