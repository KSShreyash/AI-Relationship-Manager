import uuid

import asyncpg


class ContactsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def get_by_email(
        self, user_id: uuid.UUID, email_address: str, conn: asyncpg.Connection | None = None
    ) -> asyncpg.Record | None:
        executor = conn or self._pool
        return await executor.fetchrow(
            "select * from public.contacts where user_id = $1 and email_address = $2",
            user_id,
            email_address,
        )

    async def get_by_display_name(
        self, user_id: uuid.UUID, display_name: str, conn: asyncpg.Connection | None = None
    ) -> asyncpg.Record | None:
        executor = conn or self._pool
        return await executor.fetchrow(
            "select * from public.contacts where user_id = $1 and display_name = $2 and email_address is null",
            user_id,
            display_name,
        )

    async def upsert_by_email(
        self,
        user_id: uuid.UUID,
        email_address: str,
        display_name: str | None,
        notes: str | None,
        conn: asyncpg.Connection | None = None,
    ) -> uuid.UUID:
        executor = conn or self._pool
        row = await executor.fetchrow(
            """
            insert into public.contacts (user_id, email_address, display_name, notes, updated_at)
            values ($1, $2, $3, $4, now())
            on conflict (user_id, email_address) where email_address is not null do update
            set display_name = coalesce(excluded.display_name, public.contacts.display_name),
                notes = excluded.notes,
                updated_at = now()
            returning id
            """,
            user_id,
            email_address,
            display_name,
            notes,
        )
        return row["id"]

    async def upsert_by_display_name(
        self,
        user_id: uuid.UUID,
        display_name: str,
        notes: str | None,
        conn: asyncpg.Connection | None = None,
    ) -> uuid.UUID:
        executor = conn or self._pool
        row = await executor.fetchrow(
            """
            insert into public.contacts (user_id, email_address, display_name, notes, updated_at)
            values ($1, null, $2, $3, now())
            on conflict (user_id, display_name) where email_address is null do update
            set notes = excluded.notes,
                updated_at = now()
            returning id
            """,
            user_id,
            display_name,
            notes,
        )
        return row["id"]

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.contacts where user_id = $1",
            user_id,
        )
