import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.core.config import settings
from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.repositories.profiles import ProfilesRepository
from app.services.graph_sync import sync_user

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("/run/me")
async def run_my_sync(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    await sync_user(pool, current_user.user_id)
    return {"status": "ok"}


@router.post("/run")
async def run_bulk_sync(x_sync_secret: str = Header(...)):
    if not hmac.compare_digest(x_sync_secret, settings.sync_secret):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid sync secret")

    pool = await get_pool()
    profiles = await ProfilesRepository(pool).list_connected()

    synced = 0
    failed = 0
    for profile in profiles:
        try:
            await sync_user(pool, profile["id"])
            synced += 1
        except Exception:
            failed += 1

    return {"synced": synced, "failed": failed}
