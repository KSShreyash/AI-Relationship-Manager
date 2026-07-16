import json
import uuid
from datetime import datetime

import asyncpg


class EmailsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        graph_message_id: str,
        subject: str | None,
        from_address: str | None,
        from_name: str | None,
        to_recipients: list[dict],
        received_at: datetime | None,
        body_text: str | None,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.emails
                (user_id, graph_message_id, subject, from_address, from_name,
                 to_recipients, received_at, body_text, synced_at)
            values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
            on conflict (user_id, graph_message_id) do update
            set subject = excluded.subject,
                from_address = excluded.from_address,
                from_name = excluded.from_name,
                to_recipients = excluded.to_recipients,
                received_at = excluded.received_at,
                body_text = excluded.body_text,
                synced_at = now()
            """,
            user_id,
            graph_message_id,
            subject,
            from_address,
            from_name,
            json.dumps(to_recipients),
            received_at,
            body_text,
        )

    async def delete(self, user_id: uuid.UUID, graph_message_id: str) -> None:
        await self._pool.execute(
            "delete from public.emails where user_id = $1 and graph_message_id = $2",
            user_id,
            graph_message_id,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.emails where user_id = $1",
            user_id,
        )
