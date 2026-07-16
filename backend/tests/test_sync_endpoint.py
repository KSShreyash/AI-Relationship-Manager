from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app


@pytest.mark.asyncio
async def test_run_me_calls_sync_user_for_current_user(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    try:
        with patch("app.api.v1.sync.sync_user", new=AsyncMock()) as mock_sync_user:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post("/api/sync/run/me")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        mock_sync_user.assert_called_once()
        called_user_id = mock_sync_user.call_args[0][1]
        assert called_user_id == user_id
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_run_me_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/sync/run/me")

    assert response.status_code in (401, 403)


from app.core.config import settings
from app.repositories.profiles import ProfilesRepository


@pytest.mark.asyncio
async def test_run_bulk_requires_correct_secret(pool):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/sync/run", headers={"X-Sync-Secret": "wrong"})

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_run_bulk_syncs_all_connected_users_with_isolation(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).set_graph_connection_status(user_id, "connected")

    async def fake_sync_user(pool_arg, uid):
        if uid == user_id:
            raise RuntimeError("boom")

    with patch("app.api.v1.sync.sync_user", side_effect=fake_sync_user):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/sync/run", headers={"X-Sync-Secret": settings.sync_secret}
            )

    assert response.status_code == 200
    body = response.json()
    assert body["failed"] >= 1
