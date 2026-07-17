import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.action_items import ActionItemsRepository
from app.repositories.contacts import ContactsRepository

router = APIRouter(prefix="/api/contacts", tags=["contacts"])


def _contact_summary(row) -> dict:
    return {
        "id": row["id"],
        "email_address": row["email_address"],
        "display_name": row["display_name"],
        "open_action_item_count": row["open_action_item_count"],
        "updated_at": row["updated_at"],
    }


def _contact_detail(row) -> dict:
    return {
        "id": row["id"],
        "email_address": row["email_address"],
        "display_name": row["display_name"],
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _action_item(row) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "direction": row["direction"],
        "status": row["status"],
        "due_date": row["due_date"],
        "source_type": row["source_type"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("")
async def list_contacts(
    q: str | None = None, current_user: CurrentUser = Depends(get_current_user)
):
    pool = await get_pool()
    rows = await ContactsRepository(pool).list_for_user(current_user.user_id, search=q)
    return [_contact_summary(row) for row in rows]


@router.get("/{contact_id}")
async def get_contact(
    contact_id: uuid.UUID, current_user: CurrentUser = Depends(get_current_user)
):
    pool = await get_pool()
    row = await ContactsRepository(pool).get(current_user.user_id, contact_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    return _contact_detail(row)


@router.get("/{contact_id}/action-items")
async def list_contact_action_items(
    contact_id: uuid.UUID, current_user: CurrentUser = Depends(get_current_user)
):
    pool = await get_pool()
    contact_row = await ContactsRepository(pool).get(current_user.user_id, contact_id)
    if contact_row is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    rows = await ActionItemsRepository(pool).list_for_contact(current_user.user_id, contact_id)
    return [_action_item(row) for row in rows]
