import uuid

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings

_bearer_scheme = HTTPBearer(auto_error=True)


class CurrentUser:
    def __init__(self, user_id: uuid.UUID, email: str):
        self.user_id = user_id
        self.email = email


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> CurrentUser:
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
        return CurrentUser(user_id=uuid.UUID(payload["sub"]), email=payload.get("email", ""))
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from exc

# This project's Supabase dashboard (Project Settings -> API) presents its secret
# under "Legacy JWT secret", confirming the HS256 shared-secret model above is the
# correct verification path for this project (see docs: supabase.com/docs/guides/auth/signing-keys).
#
# If a future project migrates to the newer asymmetric Signing keys system, replace
# the jwt.decode call above with JWKS-based verification instead:
#
#   _jwks_client = jwt.PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")
#   signing_key = _jwks_client.get_signing_key_from_jwt(token)
#   payload = jwt.decode(token, signing_key.key, algorithms=["ES256"], audience="authenticated")
