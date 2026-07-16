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
async def test_run_bulk_requires_secret_header_present(pool):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/sync/run")

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_run_bulk_syncs_all_connected_users_with_isolation(pool, test_auth_user):
    import uuid as uuid_module

    import httpx

    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await ProfilesRepository(pool).set_graph_connection_status(user_id, "connected")

    second_email = f"test-{uuid_module.uuid4()}@example.com"
    async with httpx.AsyncClient(
        base_url=settings.supabase_url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
        },
    ) as admin_client:
        create_response = await admin_client.post(
            "/auth/v1/admin/users",
            json={"email": second_email, "email_confirm": True},
        )
        create_response.raise_for_status()
        second_user_id = uuid_module.UUID(create_response.json()["id"])

        try:
            await ProfilesRepository(pool).upsert(second_user_id, second_email)
            await ProfilesRepository(pool).set_graph_connection_status(second_user_id, "connected")

            # Clean up any stale connected profiles from previous test runs
            stale_profiles = await ProfilesRepository(pool).list_connected()
            for profile in stale_profiles:
                if profile["id"] not in (user_id, second_user_id):
                    await ProfilesRepository(pool).set_graph_connection_status(profile["id"], "disconnected")

            async def fake_sync_user(pool_arg, uid):
                if uid == user_id:
                    raise RuntimeError("boom")
                # second_user_id succeeds silently (no exception)

            with patch("app.api.v1.sync.sync_user", side_effect=fake_sync_user):
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    response = await client.post(
                        "/api/sync/run", headers={"X-Sync-Secret": settings.sync_secret}
                    )

            assert response.status_code == 200
            body = response.json()
            assert body["synced"] == 1
            assert body["failed"] == 1
        finally:
            await admin_client.delete(f"/auth/v1/admin/users/{second_user_id}")
            # Clean up the first user's connected profile
            await ProfilesRepository(pool).set_graph_connection_status(user_id, "disconnected")
