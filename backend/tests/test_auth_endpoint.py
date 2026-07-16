import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from app.core.deps import CurrentUser, get_current_user
from app.main import app
from app.repositories.graph_tokens import GraphTokensRepository


@pytest.mark.asyncio
async def test_store_graph_tokens_persists_encrypted(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    try:
        with patch("app.api.v1.auth.sync_user", new=AsyncMock()):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/api/auth/graph-tokens",
                    json={
                        "provider_token": "access-123",
                        "provider_refresh_token": "refresh-456",
                        "expires_in": 3600,
                        "scopes": ["Mail.Read"],
                    },
                )

        assert response.status_code == 204

        tokens_repo = GraphTokensRepository(pool)
        row = await tokens_repo.get(user_id)
        assert row is not None
        assert row["encrypted_access_token"] != "access-123"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_store_graph_tokens_schedules_sync(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    try:
        with patch("app.api.v1.auth.sync_user", new=AsyncMock()) as mock_sync_user:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/api/auth/graph-tokens",
                    json={
                        "provider_token": "access-123",
                        "provider_refresh_token": "refresh-456",
                        "expires_in": 3600,
                        "scopes": ["Mail.Read"],
                    },
                )

        assert response.status_code == 204
        mock_sync_user.assert_called_once()
        called_user_id = mock_sync_user.call_args[0][1]
        assert called_user_id == user_id
    finally:
        app.dependency_overrides.clear()
