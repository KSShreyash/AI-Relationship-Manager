from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, get_current_user
from app.core.security import encrypt_token
from app.db.session import get_pool
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.schemas.auth import GraphTokensIn

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/graph-tokens", status_code=204)
async def store_graph_tokens(
    body: GraphTokensIn,
    current_user: CurrentUser = Depends(get_current_user),
):
    pool = await get_pool()
    profiles = ProfilesRepository(pool)
    tokens = GraphTokensRepository(pool)

    await profiles.upsert(current_user.user_id, current_user.email)
    await tokens.upsert(
        user_id=current_user.user_id,
        encrypted_access_token=encrypt_token(body.provider_token),
        encrypted_refresh_token=encrypt_token(body.provider_refresh_token),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(seconds=body.expires_in),
        scopes=body.scopes,
    )
    await profiles.set_graph_connection_status(current_user.user_id, "connected")
