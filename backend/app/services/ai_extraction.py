import re
import uuid
from datetime import date
from html import unescape

import asyncpg

from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository
from app.repositories.profiles import ProfilesRepository
from app.services import openai_client

EXTRACTION_BATCH_LIMIT = 50
_UNBOUNDED = 1_000_000

_TABLES = {
    "email": "emails",
    "calendar_event": "calendar_events",
    "chat_message": "chat_messages",
}


def _strip_html(value: str | None) -> str | None:
    if not value:
        return value
    text = re.sub(r"<[^>]+>", " ", value)
    text = unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _parse_due_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


async def _process_item(
    pool: asyncpg.Pool,
    user_id: uuid.UUID,
    source_type: str,
    source_id: uuid.UUID,
    content: str,
    participants: list[tuple[str | None, str | None]],
    own_email: str | None,
) -> None:
    contacts = ContactsRepository(pool)
    action_items = ActionItemsRepository(pool)

    resolved: list[dict] = []
    for i, (email_address, display_name) in enumerate(participants):
        if email_address and own_email and email_address.lower() == own_email.lower():
            continue
        if not email_address and not display_name:
            continue
        ref = f"p{i}"
        if email_address:
            existing = await contacts.get_by_email(user_id, email_address)
        else:
            existing = await contacts.get_by_display_name(user_id, display_name)
        resolved.append(
            {
                "ref": ref,
                "email": email_address,
                "name": display_name or (existing["display_name"] if existing else None),
                "notes": existing["notes"] if existing else None,
            }
        )

    if resolved:
        result = await openai_client.extract(content, resolved)
    else:
        result = {"people": [], "action_items": []}

    table = _TABLES[source_type]
    async with pool.acquire() as conn:
        async with conn.transaction():
            ref_to_contact_id: dict[str, uuid.UUID] = {}
            for person in result.get("people", []):
                match = next((p for p in resolved if p["ref"] == person["ref"]), None)
                if match is None:
                    continue
                if match["email"]:
                    contact_id = await contacts.upsert_by_email(
                        user_id, match["email"], match["name"], person["notes"], conn=conn
                    )
                else:
                    contact_id = await contacts.upsert_by_display_name(
                        user_id, match["name"], person["notes"], conn=conn
                    )
                ref_to_contact_id[match["ref"]] = contact_id

            for item in result.get("action_items", []):
                contact_id = ref_to_contact_id.get(item.get("participant_ref"))
                await action_items.insert(
                    user_id=user_id,
                    contact_id=contact_id,
                    text=item["text"],
                    direction=item["direction"],
                    due_date=_parse_due_date(item.get("due_date")),
                    source_type=source_type,
                    source_id=source_id,
                    conn=conn,
                )

            await conn.execute(
                f"update public.{table} set extracted_at = now() where id = $1",
                source_id,
            )
