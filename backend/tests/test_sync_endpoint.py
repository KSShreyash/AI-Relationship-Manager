from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app


@pytest.mark.asyncio
async def test_run_me_calls_sync_user_for_current_user(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    with patch("app.api.v1.sync.sync_user", new=AsyncMock()) as mock_sync_user:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/sync/run/me")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    mock_sync_user.assert_called_once()
    called_user_id = mock_sync_user.call_args[0][1]
    assert called_user_id == user_id

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_run_me_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/sync/run/me")

    assert response.status_code in (401, 403)
