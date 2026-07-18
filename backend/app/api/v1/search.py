from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository

router = APIRouter(prefix="/api/search", tags=["search"])

RESULT_LIMIT = 20


def _serialize_contact(row) -> dict:
    return {
        "id": row["id"],
        "display_name": row["display_name"],
        "email_address": row["email_address"],
        "notes": row["notes"],
    }


def _serialize_action_item(row) -> dict:
    contact = None
    if row["contact_id"] is not None:
        contact = {
            "id": row["contact_id"],
            "display_name": row["contact_display_name"],
            "email_address": row["contact_email_address"],
        }
    return {
        "id": row["id"],
        "text": row["text"],
        "direction": row["direction"],
        "status": row["status"],
        "due_date": row["due_date"],
        "contact": contact,
    }


@router.get("")
async def search(q: str | None = None, current_user: CurrentUser = Depends(get_current_user)):
    if not q:
        return {"contacts": [], "action_items": []}

    pool = await get_pool()
    contact_rows = await ContactsRepository(pool).search(current_user.user_id, q, RESULT_LIMIT)
    action_item_rows = await ActionItemsRepository(pool).search(current_user.user_id, q, RESULT_LIMIT)

    return {
        "contacts": [_serialize_contact(row) for row in contact_rows],
        "action_items": [_serialize_action_item(row) for row in action_item_rows],
    }
