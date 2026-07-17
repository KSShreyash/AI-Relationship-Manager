import uuid
from datetime import date

import asyncpg


class ActionItemsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def insert(
        self,
        user_id: uuid.UUID,
        contact_id: uuid.UUID | None,
        text: str,
        direction: str,
        due_date: date | None,
        source_type: str,
        source_id: uuid.UUID,
        conn: asyncpg.Connection | None = None,
    ) -> None:
        executor = conn or self._pool
        await executor.execute(
            """
            insert into public.action_items
                (user_id, contact_id, text, direction, status, due_date, source_type, source_id)
            values ($1, $2, $3, $4, 'open', $5, $6, $7)
            """,
            user_id,
            contact_id,
            text,
            direction,
            due_date,
            source_type,
            source_id,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.action_items where user_id = $1",
            user_id,
        )
