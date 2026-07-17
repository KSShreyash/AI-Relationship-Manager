from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.core.security import decrypt_token, encrypt_token
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository
from app.services.graph_tokens_service import get_valid_access_token


@pytest.mark.asyncio
async def test_get_valid_access_token_returns_none_when_no_connection(pool, test_auth_user):
    user_id, _ = test_auth_user

    result = await get_valid_access_token(pool, user_id)

    assert result is None


@pytest.mark.asyncio
async def test_get_valid_access_token_returns_decrypted_token_when_not_expired(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("still-valid"),
        encrypted_refresh_token=encrypt_token("refresh-token"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Mail.Read"],
    )

    result = await get_valid_access_token(pool, user_id)

    assert result == "still-valid"


@pytest.mark.asyncio
async def test_get_valid_access_token_refreshes_when_expired(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("expired"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        scopes=["Mail.Read"],
    )
    refreshed = {
        "access_token": "brand-new",
        "refresh_token": "brand-new-refresh",
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
    }

    with patch("app.services.graph_tokens_service.refresh_access_token", return_value=refreshed):
        result = await get_valid_access_token(pool, user_id)

    assert result == "brand-new"
    row = await GraphTokensRepository(pool).get(user_id)
    assert decrypt_token(row["encrypted_access_token"]) == "brand-new"
