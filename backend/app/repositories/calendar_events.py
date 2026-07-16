import json
import uuid
from datetime import datetime

import asyncpg


class CalendarEventsRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        graph_event_id: str,
        subject: str | None,
        organizer: str | None,
        attendees: list[dict],
        start_time: datetime | None,
        end_time: datetime | None,
        is_online_meeting: bool,
        online_meeting_join_url: str | None,
        body_text: str | None,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.calendar_events
                (user_id, graph_event_id, subject, organizer, attendees,
                 start_time, end_time, is_online_meeting, online_meeting_join_url,
                 body_text, synced_at)
            values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, now())
            on conflict (user_id, graph_event_id) do update
            set subject = excluded.subject,
                organizer = excluded.organizer,
                attendees = excluded.attendees,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                is_online_meeting = excluded.is_online_meeting,
                online_meeting_join_url = excluded.online_meeting_join_url,
                body_text = excluded.body_text,
                synced_at = now()
            """,
            user_id,
            graph_event_id,
            subject,
            organizer,
            json.dumps(attendees),
            start_time,
            end_time,
            is_online_meeting,
            online_meeting_join_url,
            body_text,
        )

    async def delete(self, user_id: uuid.UUID, graph_event_id: str) -> None:
        await self._pool.execute(
            "delete from public.calendar_events where user_id = $1 and graph_event_id = $2",
            user_id,
            graph_event_id,
        )

    async def count(self, user_id: uuid.UUID) -> int:
        return await self._pool.fetchval(
            "select count(*) from public.calendar_events where user_id = $1",
            user_id,
        )
