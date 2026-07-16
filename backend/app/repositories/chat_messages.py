import uuid
from datetime import datetime

import asyncpg


class ChatMessagesRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        graph_chat_id: str,
        graph_message_id: str,
        from_user: str | None,
        content: str | None,
        sent_at: datetime | None,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.chat_messages
                (user_id, graph_chat_id, graph_message_id, from_user, content, sent_at, synced_at)
            values ($1, $2, $3, $4, $5, $6, now())
            on conflict (user_id, graph_message_id) do update
            set from_user = excluded.from_user,
                content = excluded.content,
                sent_at = excluded.sent_at,
                synced_at = now()
            """,
            user_id,
            graph_chat_id,
            graph_message_id,
            from_user,
            content,
            sent_at,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.chat_messages where user_id = $1",
            user_id,
        )
