from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.db.session import get_pool
from app.services.ai_extraction import extract_user

router = APIRouter(prefix="/api/extraction", tags=["extraction"])


@router.post("/run/me")
async def run_my_extraction(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    await extract_user(pool, current_user.user_id, None)
    return {"status": "ok"}
