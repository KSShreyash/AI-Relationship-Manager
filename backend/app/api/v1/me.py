from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from app.core.deps import CurrentUser, get_current_user
from app.core.security import decrypt_token, encrypt_token
from app.db.session import get_pool
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.graph_client import GraphRefreshError, get_me, refresh_access_token

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("/graph-status")
async def graph_status(current_user: CurrentUser = Depends(get_current_user)):
    pool = await get_pool()
    tokens_repo = GraphTokensRepository(pool)
    profiles_repo = ProfilesRepository(pool)

    token_row = await tokens_repo.get(current_user.user_id)
    if token_row is None:
        raise HTTPException(status_code=404, detail="Microsoft account not connected")

    access_token = decrypt_token(token_row["encrypted_access_token"])

    if token_row["access_token_expires_at"] <= datetime.now(timezone.utc):
        refresh_token = decrypt_token(token_row["encrypted_refresh_token"])
        try:
            refreshed = await run_in_threadpool(
                refresh_access_token, refresh_token, scopes=token_row["scopes"]
            )
        except GraphRefreshError:
            await profiles_repo.set_graph_connection_status(current_user.user_id, "needs_reauth")
            raise HTTPException(status_code=409, detail="needs_reauth")

        await tokens_repo.upsert(
            user_id=current_user.user_id,
            encrypted_access_token=encrypt_token(refreshed["access_token"]),
            encrypted_refresh_token=encrypt_token(refreshed["refresh_token"]),
            access_token_expires_at=refreshed["expires_at"],
            scopes=token_row["scopes"],
        )
        access_token = refreshed["access_token"]

    graph_me = await get_me(access_token)
    await profiles_repo.set_graph_connection_status(current_user.user_id, "connected")
    return {"connected": True, "graph_me": graph_me}
