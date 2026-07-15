import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app
from app.repositories.graph_tokens import GraphTokensRepository


@pytest.mark.asyncio
async def test_store_graph_tokens_persists_encrypted(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

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

    app.dependency_overrides.clear()
