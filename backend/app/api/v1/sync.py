from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.services.graph_sync import sync_user

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("/run/me")
async def run_my_sync(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    await sync_user(pool, current_user.user_id)
    return {"status": "ok"}
