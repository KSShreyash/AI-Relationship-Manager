import uuid

import asyncpg


class SyncStateRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def get(self, user_id: uuid.UUID, resource_type: str) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            "select * from public.sync_state where user_id = $1 and resource_type = $2",
            user_id,
            resource_type,
        )

    async def upsert(
        self,
        user_id: uuid.UUID,
        resource_type: str,
        delta_link: str | None,
        status: str,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.sync_state (user_id, resource_type, delta_link, last_synced_at, status)
            values ($1, $2, $3, now(), $4)
            on conflict (user_id, resource_type) do update
            set delta_link = excluded.delta_link,
                last_synced_at = now(),
                status = excluded.status
            """,
            user_id,
            resource_type,
            delta_link,
            status,
        )
