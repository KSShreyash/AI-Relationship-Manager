import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.core.config import settings
from app.core.deps import get_current_user


def _make_token(sub: str, exp_delta_seconds: int = 3600) -> str:
    payload = {
        "sub": sub,
        "email": "user@example.com",
        "aud": "authenticated",
        "exp": datetime.now(timezone.utc) + timedelta(seconds=exp_delta_seconds),
    }
    return jwt.encode(payload, settings.supabase_jwt_secret, algorithm="HS256")


def test_valid_token_returns_current_user():
    user_id = str(uuid.uuid4())
    token = _make_token(user_id)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    current_user = get_current_user(creds)

    assert str(current_user.user_id) == user_id
    assert current_user.email == "user@example.com"


def test_expired_token_raises_401():
    token = _make_token(str(uuid.uuid4()), exp_delta_seconds=-10)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    with pytest.raises(HTTPException) as exc_info:
        get_current_user(creds)

    assert exc_info.value.status_code == 401


def test_malformed_token_raises_401():
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="not-a-jwt")

    with pytest.raises(HTTPException) as exc_info:
        get_current_user(creds)

    assert exc_info.value.status_code == 401


def test_token_with_invalid_uuid_sub_raises_401():
    # Create a validly-signed, non-expired token with a malformed sub claim
    payload = {
        "sub": "not-a-uuid",
        "email": "user@example.com",
        "aud": "authenticated",
        "exp": datetime.now(timezone.utc) + timedelta(seconds=3600),
    }
    token = jwt.encode(payload, settings.supabase_jwt_secret, algorithm="HS256")
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    with pytest.raises(HTTPException) as exc_info:
        get_current_user(creds)

    assert exc_info.value.status_code == 401
