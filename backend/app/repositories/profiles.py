import uuid

import asyncpg


class ProfilesRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        email: str,
        display_name: str | None = None,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.profiles (id, email, display_name, updated_at)
            values ($1, $2, $3, now())
            on conflict (id) do update
            set email = excluded.email,
                display_name = coalesce(excluded.display_name, public.profiles.display_name),
                updated_at = now()
            """,
            user_id,
            email,
            display_name,
        )

    async def get(self, user_id: uuid.UUID) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            "select * from public.profiles where id = $1",
            user_id,
        )

    async def set_graph_connection_status(self, user_id: uuid.UUID, status: str) -> None:
        await self._pool.execute(
            """
            update public.profiles
            set graph_connection_status = $2, updated_at = now()
            where id = $1
            """,
            user_id,
            status,
        )

    async def list_connected(self) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            "select * from public.profiles where graph_connection_status = 'connected'"
        )
