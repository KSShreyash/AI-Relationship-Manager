from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

_ACTIVITY_LIMIT = 20


def _merge_activity(contact_rows, action_item_rows, limit: int) -> list[dict]:
    events = []
    for row in contact_rows:
        events.append({
            "type": "contact_updated",
            "id": row["id"],
            "timestamp": row["updated_at"],
            "display_name": row["display_name"],
            "email_address": row["email_address"],
        })
    for row in action_item_rows:
        events.append({
            "type": "action_item_created",
            "id": row["id"],
            "timestamp": row["created_at"],
            "text": row["text"],
            "direction": row["direction"],
        })
    events.sort(key=lambda e: e["timestamp"], reverse=True)
    return events[:limit]


@router.get("")
async def get_dashboard(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    contacts_repo = ContactsRepository(pool)
    action_items_repo = ActionItemsRepository(pool)

    contact_count = await contacts_repo.count(current_user.user_id)
    open_action_item_count = await action_items_repo.count_open(current_user.user_id)
    recent_contacts = await contacts_repo.list_recent(current_user.user_id, _ACTIVITY_LIMIT)
    recent_action_items = await action_items_repo.list_recent(current_user.user_id, _ACTIVITY_LIMIT)

    return {
        "contact_count": contact_count,
        "open_action_item_count": open_action_item_count,
        "activity": _merge_activity(recent_contacts, recent_action_items, _ACTIVITY_LIMIT),
    }
