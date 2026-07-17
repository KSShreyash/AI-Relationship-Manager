import uuid
from datetime import datetime, timezone

import asyncpg
from starlette.concurrency import run_in_threadpool

from app.core.security import decrypt_token, encrypt_token
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.graph_client import GraphRefreshError, refresh_access_token


async def refresh_and_persist(pool: asyncpg.Pool, user_id: uuid.UUID) -> str | None:
    tokens_repo = GraphTokensRepository(pool)
    profiles_repo = ProfilesRepository(pool)

    token_row = await tokens_repo.get(user_id)
    if token_row is None:
        return None

    refresh_token = decrypt_token(token_row["encrypted_refresh_token"])
    try:
        refreshed = await run_in_threadpool(
            refresh_access_token, refresh_token, scopes=token_row["scopes"]
        )
    except GraphRefreshError:
        await profiles_repo.set_graph_connection_status(user_id, "needs_reauth")
        return None

    await tokens_repo.upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token(refreshed["access_token"]),
        encrypted_refresh_token=encrypt_token(refreshed["refresh_token"]),
        access_token_expires_at=refreshed["expires_at"],
        scopes=token_row["scopes"],
    )
    return refreshed["access_token"]


async def get_valid_access_token(pool: asyncpg.Pool, user_id: uuid.UUID) -> str | None:
    tokens_repo = GraphTokensRepository(pool)
    token_row = await tokens_repo.get(user_id)
    if token_row is None:
        return None

    if token_row["access_token_expires_at"] <= datetime.now(timezone.utc):
        return await refresh_and_persist(pool, user_id)

    return decrypt_token(token_row["encrypted_access_token"])
