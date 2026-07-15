import uuid
from datetime import datetime

import asyncpg


class GraphTokensRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        encrypted_access_token: str,
        encrypted_refresh_token: str,
        access_token_expires_at: datetime,
        scopes: list[str],
    ) -> None:
        await self._pool.execute(
            """
            insert into public.ms_graph_tokens
                (user_id, encrypted_access_token, encrypted_refresh_token,
                 access_token_expires_at, scopes, updated_at)
            values ($1, $2, $3, $4, $5, now())
            on conflict (user_id) do update
            set encrypted_access_token = excluded.encrypted_access_token,
                encrypted_refresh_token = excluded.encrypted_refresh_token,
                access_token_expires_at = excluded.access_token_expires_at,
                scopes = excluded.scopes,
                updated_at = now()
            """,
            user_id,
            encrypted_access_token,
            encrypted_refresh_token,
            access_token_expires_at,
            scopes,
        )

    async def get(self, user_id: uuid.UUID) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            "select * from public.ms_graph_tokens where user_id = $1",
            user_id,
        )
