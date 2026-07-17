import uuid

import httpx
import pytest_asyncio

from app.core.config import settings
from app.db.session import close_pool, get_pool


@pytest_asyncio.fixture
async def pool():
    p = await get_pool()
    yield p
    await close_pool()


@pytest_asyncio.fixture
async def test_auth_user():
    async with httpx.AsyncClient(
        base_url=settings.supabase_url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
        },
    ) as client:
        email = f"test-{uuid.uuid4()}@example.com"
        response = await client.post(
            "/auth/v1/admin/users",
            json={"email": email, "email_confirm": True},
        )
        response.raise_for_status()
        user_id = response.json()["id"]

        yield uuid.UUID(user_id), email

        await client.delete(f"/auth/v1/admin/users/{user_id}")


@pytest_asyncio.fixture
async def test_auth_user_2():
    async with httpx.AsyncClient(
        base_url=settings.supabase_url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
        },
    ) as client:
        email = f"test-{uuid.uuid4()}@example.com"
        response = await client.post(
            "/auth/v1/admin/users",
            json={"email": email, "email_confirm": True},
        )
        response.raise_for_status()
        user_id = response.json()["id"]

        yield uuid.UUID(user_id), email

        await client.delete(f"/auth/v1/admin/users/{user_id}")
