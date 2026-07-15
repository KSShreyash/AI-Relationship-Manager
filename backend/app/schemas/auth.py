from pydantic import BaseModel


class GraphTokensIn(BaseModel):
    provider_token: str
    provider_refresh_token: str
    expires_in: int
    scopes: list[str] = []
