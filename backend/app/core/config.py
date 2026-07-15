from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    supabase_url: str
    supabase_jwt_secret: str
    supabase_service_role_key: str
    fernet_key: str
    ms_client_id: str
    ms_client_secret: str
    ms_authority: str = "https://login.microsoftonline.com/organizations"
    cors_allow_origins: str = "http://localhost:3000"


settings = Settings()
