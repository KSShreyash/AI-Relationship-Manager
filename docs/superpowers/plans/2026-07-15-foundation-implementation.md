# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up authentication (Microsoft sign-in via Supabase Auth + backend-owned Graph token storage/refresh), the minimal data model behind it, and a real deployed skeleton (Next.js on Cloudflare Pages, FastAPI on Render, Supabase for Postgres+Auth) — proven end-to-end with one real Microsoft Graph API call.

**Architecture:** Frontend never talks to Supabase's data API directly — it only uses Supabase Auth for the "Sign in with Microsoft" flow and calls FastAPI for everything else. FastAPI owns the Postgres connection (service role) and independently stores/refreshes each user's Microsoft Graph delegated token so background sync (built in a later phase) can work without the user's browser open.

**Tech Stack:** FastAPI + asyncpg + PyJWT + msal + cryptography (backend, Python 3.12) · Next.js 15 (App Router) + TypeScript + Tailwind + @supabase/supabase-js/@supabase/ssr (frontend) · pytest/pytest-asyncio/respx + vitest/@testing-library/react (tests) · Supabase (Postgres+Auth), Render (backend host), Cloudflare Pages (frontend host).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-foundation-design.md` — every task below implements a piece of it.
- No `org_id`/tenancy scoping anywhere — this is a single-user-per-account tool, isolation is per `user_id` only.
- Azure AD app registration: multi-tenant ("Accounts in any organizational directory"), work/school accounts only.
- Frontend must never call Supabase's Postgres/data API directly — only Supabase Auth (for session) and FastAPI (for everything else).
- All Microsoft Graph tokens are Fernet-encrypted at rest; the Fernet key lives only in backend env vars, never in the DB or frontend.
- RLS enabled on every `public` table, even though the primary access path is FastAPI's service-role connection (defense-in-depth per the Supabase security checklist).
- No custom domain yet — frontend calls Render's default `*.onrender.com` URL directly (server-side only, never exposed to browser JS); Cloudflare reverse proxy is an explicit non-goal for this phase.
- Monorepo: `backend/` (FastAPI) and `frontend/` (Next.js) as siblings at the repo root, which is `C:\Drive D\Yolex Labs\AI Scheduler`.

## File Structure

```
AI Scheduler/                       (repo root, already git-initialized)
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI app, CORS, routers, /health
│   │   ├── core/{config,security,deps}.py
│   │   ├── db/session.py
│   │   ├── repositories/{profiles,graph_tokens}.py
│   │   ├── schemas/auth.py
│   │   ├── api/v1/{auth,me}.py
│   │   └── services/graph_client.py
│   ├── tests/{conftest,test_health,test_security,test_deps,test_repositories,test_auth_endpoint,test_graph_client,test_me_endpoint}.py
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── app/(auth)/login/page.tsx (+ page.test.tsx)
│   ├── app/(auth)/callback/page.tsx (+ page.test.tsx)
│   ├── app/dashboard/page.tsx (+ page.test.tsx)
│   ├── lib/supabase/client.ts (+ client.test.ts)
│   ├── lib/api.ts (+ api.test.ts)
│   ├── vitest.config.ts, vitest.setup.ts
│   └── .env.local.example
├── supabase/migrations/20260715000000_foundation_schema.sql
├── render.yaml
└── .gitignore
```

---

### Task 1: Provision the Supabase project and apply the Foundation schema

**Files:**
- Create: `supabase/migrations/20260715000000_foundation_schema.sql`

**Interfaces:**
- Produces: a live Supabase project with `public.profiles` and `public.ms_graph_tokens` tables (columns exactly as below), RLS enabled on both. Later tasks depend on: `profiles(id, email, display_name, avatar_url, timezone, graph_connection_status, created_at, updated_at)` and `ms_graph_tokens(user_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, scopes, created_at, updated_at)`.

- [ ] **Step 1: Load the Supabase MCP tool schemas needed for provisioning**

Call `ToolSearch` with query `"select:mcp__plugin_supabase_supabase__list_organizations,mcp__plugin_supabase_supabase__get_cost,mcp__plugin_supabase_supabase__confirm_cost,mcp__plugin_supabase_supabase__create_project,mcp__plugin_supabase_supabase__get_project,mcp__plugin_supabase_supabase__get_project_url,mcp__plugin_supabase_supabase__get_publishable_keys,mcp__plugin_supabase_supabase__apply_migration,mcp__plugin_supabase_supabase__get_advisors,mcp__plugin_supabase_supabase__list_tables"`.

- [ ] **Step 2: Identify the target organization**

Call `mcp__plugin_supabase_supabase__list_organizations`. There should be exactly one organization on this account — use its `id`.

- [ ] **Step 3: Get and confirm the cost estimate**

Call `mcp__plugin_supabase_supabase__get_cost` for a new project in that organization, then `mcp__plugin_supabase_supabase__confirm_cost` with the returned details. This is required by the MCP server before any resource-creating call, even for free-tier projects.

- [ ] **Step 4: Create the project**

Call `mcp__plugin_supabase_supabase__create_project` with `name: "ai-relationship-manager"`, the organization id from Step 2, `region: "ap-south-1"` (consistent with the account's existing projects), and the cost confirmation id from Step 3.

- [ ] **Step 5: Wait for the project to become active**

Poll `mcp__plugin_supabase_supabase__get_project` (or `list_projects`) every ~15 seconds until `status` is `ACTIVE_HEALTHY`. This typically takes 1-2 minutes.

- [ ] **Step 6: Write the migration file**

```sql
-- supabase/migrations/20260715000000_foundation_schema.sql

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  timezone text,
  graph_connection_status text not null default 'disconnected'
    check (graph_connection_status in ('connected', 'needs_reauth', 'disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ( (select auth.uid()) = id );

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ( (select auth.uid()) = id )
  with check ( (select auth.uid()) = id );

create table public.ms_graph_tokens (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text not null,
  access_token_expires_at timestamptz not null,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ms_graph_tokens enable row level security;
-- Intentionally no policies: only the service_role connection (bypasses RLS) may touch this table.
```

- [ ] **Step 7: Apply the migration to the new project**

Call `mcp__plugin_supabase_supabase__apply_migration` with `name: "foundation_schema"` and the exact SQL content from Step 6, targeting the project created in Step 4.

- [ ] **Step 8: Run advisors and confirm no issues**

Call `mcp__plugin_supabase_supabase__get_advisors` (type `security`) for the project. Confirm no findings about `profiles` or `ms_graph_tokens` (RLS-enabled-with-no-policy on `ms_graph_tokens` is intentional — if the advisor flags it, confirm the flag text matches "RLS enabled, no policies" and not something else; if something else, fix before continuing).

- [ ] **Step 9: Verify the tables exist**

Call `mcp__plugin_supabase_supabase__list_tables` and confirm both `profiles` and `ms_graph_tokens` are present with the columns from Step 6.

- [ ] **Step 10: Record connection details for later tasks**

Call `mcp__plugin_supabase_supabase__get_project_url` and `mcp__plugin_supabase_supabase__get_publishable_keys` — save the project URL and publishable (anon) key; these are needed in Task 2 and Task 10.

The MCP server does not expose the `service_role` key, the JWT secret, or the Postgres connection string/password (they're too sensitive to hand to a tool). Open the Supabase Dashboard for this project → **Project Settings → API** to copy the `service_role` key and JWT secret, and **Project Settings → Database** to copy the connection string (reset the DB password there if it wasn't shown at creation time — Supabase only displays it once). Keep these values at hand for Task 2.

- [ ] **Step 11: Commit the migration file**

```bash
git add supabase/migrations/20260715000000_foundation_schema.sql
git commit -m "feat: add Foundation schema (profiles, ms_graph_tokens)"
```

---

### Task 2: Scaffold the FastAPI backend with config and a health check

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/.env.example`
- Create: `backend/.env` (gitignored — real values from Task 1)
- Create: `backend/app/__init__.py`
- Create: `backend/app/core/__init__.py`
- Create: `backend/app/core/config.py`
- Create: `backend/app/main.py`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/test_health.py`
- Create: `backend/pyproject.toml` (pytest-asyncio config)
- Create: `.gitignore` (repo root)

**Interfaces:**
- Produces: `app.core.config.settings` (a `Settings` instance with fields `database_url`, `supabase_url`, `supabase_jwt_secret`, `supabase_service_role_key`, `fernet_key`, `ms_client_id`, `ms_client_secret`, `ms_authority`, `cors_allow_origins`), and `app.main.app` (the FastAPI instance).

- [ ] **Step 1: Create the root .gitignore**

```
# backend/.gitignore
backend/.env
backend/__pycache__/
backend/.pytest_cache/
backend/.venv/
backend/*.egg-info/

# frontend/.gitignore
frontend/node_modules/
frontend/.next/
frontend/.env.local
frontend/dist/

.DS_Store
```

- [ ] **Step 2: Write requirements.txt**

```
fastapi>=0.115
uvicorn[standard]>=0.32
pydantic-settings>=2.6
asyncpg>=0.30
PyJWT>=2.9
cryptography>=43
msal>=1.31
httpx>=0.27
pytest>=8.3
pytest-asyncio>=0.24
respx>=0.21
```

- [ ] **Step 3: Install dependencies**

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

- [ ] **Step 4: Generate a Fernet key**

```bash
.venv/Scripts/python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Save the output — it goes in `backend/.env` as `FERNET_KEY` in the next step.

- [ ] **Step 5: Write backend/.env.example (committed, no real secrets)**

```
DATABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_JWT_SECRET=
SUPABASE_SERVICE_ROLE_KEY=
FERNET_KEY=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_AUTHORITY=https://login.microsoftonline.com/organizations
CORS_ALLOW_ORIGINS=http://localhost:3000
```

- [ ] **Step 6: Write backend/.env (gitignored, real values)**

Copy `.env.example` to `.env` and fill in: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` from Task 1 Step 10; `FERNET_KEY` from Step 4 above. Leave `MS_CLIENT_ID`/`MS_CLIENT_SECRET` blank for now (filled in Task 9) — `pydantic-settings` will error on missing required fields, so also add temporary placeholder values `MS_CLIENT_ID=placeholder` and `MS_CLIENT_SECRET=placeholder` to unblock this task; Task 9 overwrites them with real values.

- [ ] **Step 7: Write app/core/config.py**

```python
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
```

- [ ] **Step 8: Write the failing test for /health**

```python
# backend/tests/test_health.py
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_health_returns_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 9: Write pyproject.toml for pytest-asyncio**

```toml
# backend/pyproject.toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
```

- [ ] **Step 10: Run the test to verify it fails**

```bash
cd backend
.venv/Scripts/pytest tests/test_health.py -v
```
Expected: FAIL (`ModuleNotFoundError: No module named 'app.main'`)

- [ ] **Step 11: Write app/main.py**

```python
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="AI Relationship Manager API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 12: Run the test to verify it passes**

```bash
.venv/Scripts/pytest tests/test_health.py -v
```
Expected: PASS

- [ ] **Step 13: Commit**

```bash
cd ..
git add .gitignore backend/requirements.txt backend/.env.example backend/pyproject.toml backend/app backend/tests
git commit -m "feat: scaffold FastAPI backend with config and health check"
```

---

### Task 3: Postgres connection pool and repositories (profiles, ms_graph_tokens)

**Files:**
- Create: `backend/app/db/__init__.py`
- Create: `backend/app/db/session.py`
- Create: `backend/app/repositories/__init__.py`
- Create: `backend/app/repositories/profiles.py`
- Create: `backend/app/repositories/graph_tokens.py`
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_repositories.py`

**Interfaces:**
- Consumes: `app.core.config.settings.database_url`, `settings.supabase_url`, `settings.supabase_service_role_key`.
- Produces: `get_pool() -> asyncpg.Pool`, `close_pool() -> None`; `ProfilesRepository(pool).upsert(user_id, email, display_name=None)`, `.get(user_id) -> asyncpg.Record | None`, `.set_graph_connection_status(user_id, status)`; `GraphTokensRepository(pool).upsert(user_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, scopes)`, `.get(user_id) -> asyncpg.Record | None`. These are used by Tasks 6 and 8.

- [ ] **Step 1: Write app/db/session.py**

```python
import asyncpg

from app.core.config import settings

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
```

- [ ] **Step 2: Write app/repositories/profiles.py**

```python
import uuid

import asyncpg


class ProfilesRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        email: str,
        display_name: str | None = None,
    ) -> None:
        await self._pool.execute(
            """
            insert into public.profiles (id, email, display_name, updated_at)
            values ($1, $2, $3, now())
            on conflict (id) do update
            set email = excluded.email,
                display_name = coalesce(excluded.display_name, public.profiles.display_name),
                updated_at = now()
            """,
            user_id,
            email,
            display_name,
        )

    async def get(self, user_id: uuid.UUID) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            "select * from public.profiles where id = $1",
            user_id,
        )

    async def set_graph_connection_status(self, user_id: uuid.UUID, status: str) -> None:
        await self._pool.execute(
            """
            update public.profiles
            set graph_connection_status = $2, updated_at = now()
            where id = $1
            """,
            user_id,
            status,
        )
```

- [ ] **Step 3: Write app/repositories/graph_tokens.py**

```python
import uuid
from datetime import datetime

import asyncpg


class GraphTokensRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert(
        self,
        user_id: uuid.UUID,
        encrypted_access_token: str,
        encrypted_refresh_token: str,
        access_token_expires_at: datetime,
        scopes: list[str],
    ) -> None:
        await self._pool.execute(
            """
            insert into public.ms_graph_tokens
                (user_id, encrypted_access_token, encrypted_refresh_token,
                 access_token_expires_at, scopes, updated_at)
            values ($1, $2, $3, $4, $5, now())
            on conflict (user_id) do update
            set encrypted_access_token = excluded.encrypted_access_token,
                encrypted_refresh_token = excluded.encrypted_refresh_token,
                access_token_expires_at = excluded.access_token_expires_at,
                scopes = excluded.scopes,
                updated_at = now()
            """,
            user_id,
            encrypted_access_token,
            encrypted_refresh_token,
            access_token_expires_at,
            scopes,
        )

    async def get(self, user_id: uuid.UUID) -> asyncpg.Record | None:
        return await self._pool.fetchrow(
            "select * from public.ms_graph_tokens where user_id = $1",
            user_id,
        )
```

- [ ] **Step 4: Write conftest.py with a disposable-auth-user fixture**

`profiles.id` has a foreign key to `auth.users(id)`, so integration tests need a real auth user. This fixture creates one via Supabase's Admin API and deletes it afterward.

```python
# backend/tests/conftest.py
import uuid

import httpx
import pytest_asyncio

from app.core.config import settings
from app.db.session import close_pool, get_pool


@pytest_asyncio.fixture
async def pool():
    p = await get_pool()
    yield p
    await close_pool()


@pytest_asyncio.fixture
async def test_auth_user():
    async with httpx.AsyncClient(
        base_url=settings.supabase_url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
        },
    ) as client:
        email = f"test-{uuid.uuid4()}@example.com"
        response = await client.post(
            "/auth/v1/admin/users",
            json={"email": email, "email_confirm": True},
        )
        response.raise_for_status()
        user_id = response.json()["id"]

        yield uuid.UUID(user_id), email

        await client.delete(f"/auth/v1/admin/users/{user_id}")
```

- [ ] **Step 5: Write the failing repository tests**

```python
# backend/tests/test_repositories.py
import pytest

from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository


@pytest.mark.asyncio
async def test_profiles_upsert_and_get(pool, test_auth_user):
    user_id, email = test_auth_user
    repo = ProfilesRepository(pool)

    await repo.upsert(user_id, email, display_name="Test User")
    row = await repo.get(user_id)

    assert row["email"] == email
    assert row["display_name"] == "Test User"
    assert row["graph_connection_status"] == "disconnected"


@pytest.mark.asyncio
async def test_profiles_set_graph_connection_status(pool, test_auth_user):
    user_id, email = test_auth_user
    repo = ProfilesRepository(pool)
    await repo.upsert(user_id, email)

    await repo.set_graph_connection_status(user_id, "connected")
    row = await repo.get(user_id)

    assert row["graph_connection_status"] == "connected"


@pytest.mark.asyncio
async def test_graph_tokens_upsert_and_get(pool, test_auth_user):
    from datetime import datetime, timedelta, timezone

    user_id, email = test_auth_user
    profiles_repo = ProfilesRepository(pool)
    tokens_repo = GraphTokensRepository(pool)
    await profiles_repo.upsert(user_id, email)

    expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
    await tokens_repo.upsert(
        user_id=user_id,
        encrypted_access_token="enc-access",
        encrypted_refresh_token="enc-refresh",
        access_token_expires_at=expires_at,
        scopes=["Mail.Read"],
    )
    row = await tokens_repo.get(user_id)

    assert row["encrypted_access_token"] == "enc-access"
    assert row["scopes"] == ["Mail.Read"]
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
cd backend
.venv/Scripts/pytest tests/test_repositories.py -v
```
Expected: FAIL (`ModuleNotFoundError` before Steps 1-3 are saved, or connection error if `.env` values are wrong — fix `.env` if so)

- [ ] **Step 7: Run tests to verify they pass**

```bash
.venv/Scripts/pytest tests/test_repositories.py -v
```
Expected: PASS (3 passed)

- [ ] **Step 8: Commit**

```bash
cd ..
git add backend/app/db backend/app/repositories backend/tests/conftest.py backend/tests/test_repositories.py
git commit -m "feat: add Postgres pool and profiles/ms_graph_tokens repositories"
```

---

### Task 4: Fernet token encryption helper

**Files:**
- Create: `backend/app/core/security.py`
- Create: `backend/tests/test_security.py`

**Interfaces:**
- Consumes: `settings.fernet_key`.
- Produces: `encrypt_token(plaintext: str) -> str`, `decrypt_token(ciphertext: str) -> str`. Used by Tasks 6 and 8.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_security.py
from app.core.security import decrypt_token, encrypt_token


def test_encrypt_decrypt_round_trip():
    plaintext = "super-secret-graph-token"

    ciphertext = encrypt_token(plaintext)

    assert ciphertext != plaintext
    assert decrypt_token(ciphertext) == plaintext
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend
.venv/Scripts/pytest tests/test_security.py -v
```
Expected: FAIL (`ModuleNotFoundError: No module named 'app.core.security'`)

- [ ] **Step 3: Write app/core/security.py**

```python
from cryptography.fernet import Fernet

from app.core.config import settings

_fernet = Fernet(settings.fernet_key.encode())


def encrypt_token(plaintext: str) -> str:
    return _fernet.encrypt(plaintext.encode()).decode()


def decrypt_token(ciphertext: str) -> str:
    return _fernet.decrypt(ciphertext.encode()).decode()
```

- [ ] **Step 4: Run test to verify it passes**

```bash
.venv/Scripts/pytest tests/test_security.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ..
git add backend/app/core/security.py backend/tests/test_security.py
git commit -m "feat: add Fernet token encryption helper"
```

---

### Task 5: Supabase JWT verification dependency

**Files:**
- Create: `backend/app/core/deps.py`
- Create: `backend/tests/test_deps.py`

**Interfaces:**
- Consumes: `settings.supabase_jwt_secret`.
- Produces: `CurrentUser(user_id: uuid.UUID, email: str)`, `get_current_user(credentials) -> CurrentUser` (a FastAPI dependency). Used by Tasks 6 and 8.

- [ ] **Step 1: Check current Supabase JWT verification guidance**

Fetch `https://supabase.com/docs/guides/auth/jwt.md` (per the Supabase skill's principle: verify against current docs before implementing, since Supabase has been rolling out asymmetric JWT signing keys alongside the legacy shared secret). Confirm this project's dashboard (**Project Settings → API**) still shows a "JWT Secret" (HS256, shared-secret model) rather than only asymmetric "signing keys". If it only shows signing keys, use the JWKS-based alternative in Step 4's comment instead of the primary implementation.

- [ ] **Step 2: Write the failing tests**

```python
# backend/tests/test_deps.py
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
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd backend
.venv/Scripts/pytest tests/test_deps.py -v
```
Expected: FAIL (`ModuleNotFoundError: No module named 'app.core.deps'`)

- [ ] **Step 4: Write app/core/deps.py**

```python
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
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from exc

    return CurrentUser(user_id=uuid.UUID(payload["sub"]), email=payload.get("email", ""))

# If Step 1 found this project uses asymmetric signing keys instead of a shared
# JWT secret, replace the jwt.decode call above with JWKS-based verification:
#
#   _jwks_client = jwt.PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")
#   signing_key = _jwks_client.get_signing_key_from_jwt(token)
#   payload = jwt.decode(token, signing_key.key, algorithms=["ES256"], audience="authenticated")
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
.venv/Scripts/pytest tests/test_deps.py -v
```
Expected: PASS (3 passed)

- [ ] **Step 6: Commit**

```bash
cd ..
git add backend/app/core/deps.py backend/tests/test_deps.py
git commit -m "feat: add Supabase JWT verification dependency"
```

---

### Task 6: POST /api/auth/graph-tokens endpoint

**Files:**
- Create: `backend/app/schemas/__init__.py`
- Create: `backend/app/schemas/auth.py`
- Create: `backend/app/api/__init__.py`
- Create: `backend/app/api/v1/__init__.py`
- Create: `backend/app/api/v1/auth.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_auth_endpoint.py`

**Interfaces:**
- Consumes: `CurrentUser`/`get_current_user` (Task 5), `encrypt_token` (Task 4), `ProfilesRepository`/`GraphTokensRepository` (Task 3).
- Produces: `POST /api/auth/graph-tokens` (204 on success). Consumed by the frontend callback page in Task 12.

- [ ] **Step 1: Write app/schemas/auth.py**

```python
from pydantic import BaseModel


class GraphTokensIn(BaseModel):
    provider_token: str
    provider_refresh_token: str
    expires_in: int
    scopes: list[str] = []
```

- [ ] **Step 2: Write the failing test**

```python
# backend/tests/test_auth_endpoint.py
import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.main import app
from app.repositories.graph_tokens import GraphTokensRepository


@pytest.mark.asyncio
async def test_store_graph_tokens_persists_encrypted(pool, test_auth_user):
    user_id, email = test_auth_user
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/auth/graph-tokens",
            json={
                "provider_token": "access-123",
                "provider_refresh_token": "refresh-456",
                "expires_in": 3600,
                "scopes": ["Mail.Read"],
            },
        )

    assert response.status_code == 204

    tokens_repo = GraphTokensRepository(pool)
    row = await tokens_repo.get(user_id)
    assert row is not None
    assert row["encrypted_access_token"] != "access-123"

    app.dependency_overrides.clear()
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend
.venv/Scripts/pytest tests/test_auth_endpoint.py -v
```
Expected: FAIL (`ModuleNotFoundError: No module named 'app.api.v1.auth'`)

- [ ] **Step 4: Write app/api/v1/auth.py**

```python
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
```

- [ ] **Step 5: Wire the router into main.py**

```python
# backend/app/main.py — add these two lines
from app.api.v1 import auth  # add near the top, after the settings import

app.include_router(auth.router)  # add after the CORSMiddleware block
```

- [ ] **Step 6: Run test to verify it passes**

```bash
.venv/Scripts/pytest tests/test_auth_endpoint.py -v
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd ..
git add backend/app/schemas backend/app/api backend/app/main.py backend/tests/test_auth_endpoint.py
git commit -m "feat: add POST /api/auth/graph-tokens endpoint"
```

---

### Task 7: Microsoft Graph client service (token refresh + /me call)

**Files:**
- Create: `backend/app/services/__init__.py`
- Create: `backend/app/services/graph_client.py`
- Create: `backend/tests/test_graph_client.py`

**Interfaces:**
- Consumes: `settings.ms_client_id`, `settings.ms_client_secret`, `settings.ms_authority`.
- Produces: `refresh_access_token(refresh_token: str, scopes: list[str]) -> dict` (keys: `access_token`, `refresh_token`, `expires_at`), `GraphRefreshError`, `async get_me(access_token: str) -> dict`. Used by Task 8.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_graph_client.py
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
import respx
from httpx import Response

from app.services.graph_client import GraphRefreshError, get_me, refresh_access_token


@patch("app.services.graph_client.msal.ConfidentialClientApplication")
def test_refresh_access_token_success(mock_app_cls):
    mock_app = MagicMock()
    mock_app.acquire_token_by_refresh_token.return_value = {
        "access_token": "new-access",
        "refresh_token": "new-refresh",
        "expires_in": 3600,
    }
    mock_app_cls.return_value = mock_app

    result = refresh_access_token("old-refresh", scopes=["Mail.Read"])

    assert result["access_token"] == "new-access"
    assert result["refresh_token"] == "new-refresh"
    assert result["expires_at"] > datetime.now(timezone.utc)


@patch("app.services.graph_client.msal.ConfidentialClientApplication")
def test_refresh_access_token_failure_raises(mock_app_cls):
    mock_app = MagicMock()
    mock_app.acquire_token_by_refresh_token.return_value = {
        "error": "invalid_grant",
        "error_description": "refresh token expired",
    }
    mock_app_cls.return_value = mock_app

    with pytest.raises(GraphRefreshError):
        refresh_access_token("old-refresh", scopes=["Mail.Read"])


@pytest.mark.asyncio
@respx.mock
async def test_get_me_returns_json():
    respx.get("https://graph.microsoft.com/v1.0/me").mock(
        return_value=Response(200, json={"mail": "user@example.com"})
    )

    result = await get_me("access-token")

    assert result["mail"] == "user@example.com"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
.venv/Scripts/pytest tests/test_graph_client.py -v
```
Expected: FAIL (`ModuleNotFoundError: No module named 'app.services.graph_client'`)

- [ ] **Step 3: Write app/services/graph_client.py**

```python
from datetime import datetime, timedelta, timezone

import httpx
import msal

from app.core.config import settings

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


class GraphRefreshError(Exception):
    pass


def _confidential_client() -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        client_id=settings.ms_client_id,
        client_credential=settings.ms_client_secret,
        authority=settings.ms_authority,
    )


def refresh_access_token(refresh_token: str, scopes: list[str]) -> dict:
    app = _confidential_client()
    result = app.acquire_token_by_refresh_token(refresh_token, scopes=scopes)
    if "access_token" not in result:
        raise GraphRefreshError(result.get("error_description", "refresh failed"))
    return {
        "access_token": result["access_token"],
        "refresh_token": result.get("refresh_token", refresh_token),
        "expires_at": datetime.now(timezone.utc) + timedelta(seconds=result["expires_in"]),
    }


async def get_me(access_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{GRAPH_BASE_URL}/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    response.raise_for_status()
    return response.json()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
.venv/Scripts/pytest tests/test_graph_client.py -v
```
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
cd ..
git add backend/app/services backend/tests/test_graph_client.py
git commit -m "feat: add Microsoft Graph client (token refresh + /me)"
```

---

### Task 8: GET /api/me/graph-status endpoint

**Files:**
- Create: `backend/app/api/v1/me.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_me_endpoint.py`

**Interfaces:**
- Consumes: everything from Tasks 3-7.
- Produces: `GET /api/me/graph-status` → `200 {"connected": true, "graph_me": {...}}` on success, `404` if no token stored, `409` if refresh fails (`needs_reauth`). Consumed by the frontend dashboard page in Task 13.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_me_endpoint.py
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.deps import CurrentUser, get_current_user
from app.core.security import encrypt_token
from app.main import app
from app.repositories.graph_tokens import GraphTokensRepository
from app.repositories.profiles import ProfilesRepository


@pytest.mark.asyncio
async def test_graph_status_returns_me_when_token_valid(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("valid-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        scopes=["Mail.Read"],
    )
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    with patch("app.api.v1.me.get_me", new=AsyncMock(return_value={"mail": email})):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/me/graph-status")

    assert response.status_code == 200
    assert response.json() == {"connected": True, "graph_me": {"mail": email}}
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_graph_status_refreshes_expired_token(pool, test_auth_user):
    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("expired-access"),
        encrypted_refresh_token=encrypt_token("valid-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        scopes=["Mail.Read"],
    )
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    refreshed = {
        "access_token": "new-access",
        "refresh_token": "new-refresh",
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    with patch("app.api.v1.me.refresh_access_token", return_value=refreshed), \
         patch("app.api.v1.me.get_me", new=AsyncMock(return_value={"mail": email})):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/me/graph-status")

    assert response.status_code == 200
    row = await GraphTokensRepository(pool).get(user_id)
    from app.core.security import decrypt_token
    assert decrypt_token(row["encrypted_access_token"]) == "new-access"
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_graph_status_sets_needs_reauth_on_refresh_failure(pool, test_auth_user):
    from app.services.graph_client import GraphRefreshError

    user_id, email = test_auth_user
    await ProfilesRepository(pool).upsert(user_id, email)
    await GraphTokensRepository(pool).upsert(
        user_id=user_id,
        encrypted_access_token=encrypt_token("expired-access"),
        encrypted_refresh_token=encrypt_token("dead-refresh"),
        access_token_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        scopes=["Mail.Read"],
    )
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id=user_id, email=email)

    with patch("app.api.v1.me.refresh_access_token", side_effect=GraphRefreshError("expired")):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/me/graph-status")

    assert response.status_code == 409
    profile = await ProfilesRepository(pool).get(user_id)
    assert profile["graph_connection_status"] == "needs_reauth"
    app.dependency_overrides.clear()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
.venv/Scripts/pytest tests/test_me_endpoint.py -v
```
Expected: FAIL (`ModuleNotFoundError: No module named 'app.api.v1.me'`)

- [ ] **Step 3: Write app/api/v1/me.py**

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

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
            refreshed = refresh_access_token(refresh_token, scopes=token_row["scopes"])
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
    return {"connected": True, "graph_me": graph_me}
```

- [ ] **Step 4: Wire the router into main.py**

```python
# backend/app/main.py
from app.api.v1 import auth, me  # replace the auth-only import from Task 6

app.include_router(auth.router)
app.include_router(me.router)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
.venv/Scripts/pytest tests/test_me_endpoint.py -v
```
Expected: PASS (3 passed)

- [ ] **Step 6: Run the full backend suite**

```bash
.venv/Scripts/pytest -v
```
Expected: all tests pass (Tasks 2-8 combined)

- [ ] **Step 7: Commit**

```bash
cd ..
git add backend/app/api/v1/me.py backend/app/main.py backend/tests/test_me_endpoint.py
git commit -m "feat: add GET /api/me/graph-status endpoint"
```

---

### Task 9: Configure Microsoft OAuth end-to-end (Azure AD app + Supabase Auth provider)

**Files:**
- Modify: `backend/.env` (real `MS_CLIENT_ID`/`MS_CLIENT_SECRET`, gitignored)

**Interfaces:**
- Produces: a working `https://PROJECT_REF.supabase.co/auth/v1/authorize?provider=azure` redirect to a real Microsoft consent screen. Required before Task 14's local end-to-end test.

- [ ] **Step 1: Get Supabase's OAuth callback URL**

It's `https://PROJECT_REF.supabase.co/auth/v1/callback`, using the project ref from Task 1.

- [ ] **Step 2: Register the Azure AD application**

In the [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations → New registration:
- Name: `AI Relationship Manager`
- Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**
- Redirect URI: type **Web**, value = the callback URL from Step 1

- [ ] **Step 3: Add delegated API permissions**

App registration → API permissions → Add a permission → Microsoft Graph → Delegated permissions. Add: `openid`, `email`, `profile`, `offline_access`, `User.Read`, `Mail.Read`, `Chat.Read`, `Calendars.ReadWrite`, `OnlineMeetings.ReadWrite`.

- [ ] **Step 4: Create a client secret**

App registration → Certificates & secrets → New client secret. Copy the secret value immediately (shown once).

- [ ] **Step 5: Record the Application (client) ID**

App registration → Overview → copy "Application (client) ID".

- [ ] **Step 6: Configure the Azure provider in Supabase**

Supabase Dashboard → this project → Authentication → Sign In / Providers → Azure. Enable it, paste the Application (client) ID (Step 5) and client secret (Step 4). Azure Tenant URL field: leave as `common`/default for multi-tenant, or explicitly set to `https://login.microsoftonline.com/organizations` if the field is present and accepts it — check the current field label against [Supabase's Azure provider docs](https://supabase.com/docs/guides/auth/social-login/auth-azure.md), since exact field names change between Supabase releases.

- [ ] **Step 7: Update backend/.env with the real Azure credentials**

Replace the `placeholder` values from Task 2 Step 6:
```
MS_CLIENT_ID=<Application (client) ID from Step 5>
MS_CLIENT_SECRET=<client secret value from Step 4>
```

- [ ] **Step 8: Verify the redirect works**

Open `https://PROJECT_REF.supabase.co/auth/v1/authorize?provider=azure` in a browser. Expected: redirected to a real Microsoft login page (not a Supabase or Azure error page). Do not complete sign-in yet — there's no frontend to receive the callback until Task 12.

No commit for this task (no tracked files change — `.env` is gitignored).

---

### Task 10: Scaffold the Next.js frontend, Supabase client, and API wrapper

**Files:**
- Create: `frontend/` (via `create-next-app`)
- Create: `frontend/.env.local.example`
- Create: `frontend/.env.local` (gitignored)
- Create: `frontend/vitest.config.ts`
- Create: `frontend/vitest.setup.ts`
- Create: `frontend/lib/supabase/client.ts`
- Create: `frontend/lib/supabase/client.test.ts`
- Create: `frontend/lib/api.ts`
- Create: `frontend/lib/api.test.ts`

**Interfaces:**
- Produces: `createClient()` (browser Supabase client), `apiFetch(path, init?) -> Promise<Response>` (attaches the Supabase JWT as a Bearer token). Used by Tasks 11-13.

- [ ] **Step 1: Scaffold the Next.js app**

```bash
npx create-next-app@latest frontend --typescript --tailwind --app --no-src-dir --import-alias "@/*" --eslint --use-npm --yes
```

- [ ] **Step 2: Install additional dependencies**

```bash
cd frontend
npm install @supabase/supabase-js @supabase/ssr
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 3: Write .env.local.example (committed) and .env.local (gitignored)**

```
# frontend/.env.local.example
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

Copy to `.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from Task 1 Step 10 (the publishable/anon key).

- [ ] **Step 4: Add a test script and Vitest config**

```json
// frontend/package.json — add to "scripts"
"test": "vitest run"
```

```typescript
// frontend/vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
})
```

```typescript
// frontend/vitest.setup.ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 5: Write the failing test for the Supabase client**

```typescript
// frontend/lib/supabase/client.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: vi.fn(() => ({ mocked: true })),
}))

import { createBrowserClient } from '@supabase/ssr'
import { createClient } from './client'

describe('createClient', () => {
  it('calls createBrowserClient with the configured URL and anon key', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'

    createClient()

    expect(createBrowserClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key-123'
    )
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npm test
```
Expected: FAIL (`Cannot find module './client'`)

- [ ] **Step 7: Write lib/supabase/client.ts**

```typescript
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

- [ ] **Step 8: Run test to verify it passes**

```bash
npm test
```
Expected: PASS

- [ ] **Step 9: Write the failing test for the API wrapper**

```typescript
// frontend/lib/api.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()

vi.mock('./supabase/client', () => ({
  createClient: () => ({ auth: { getSession: getSessionMock } }),
}))

import { apiFetch } from './api'

describe('apiFetch', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com'
    getSessionMock.mockReset()
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('attaches the Supabase access token as a Bearer header', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } })

    await apiFetch('/api/me/graph-status')

    const call = (global.fetch as any).mock.calls[0]
    expect(call[0]).toBe('https://api.example.com/api/me/graph-status')
    const headers: Headers = call[1].headers
    expect(headers.get('Authorization')).toBe('Bearer jwt-123')
  })

  it('omits the Authorization header when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })

    await apiFetch('/api/me/graph-status')

    const call = (global.fetch as any).mock.calls[0]
    const headers: Headers = call[1].headers
    expect(headers.get('Authorization')).toBeNull()
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

```bash
npm test
```
Expected: FAIL (`Cannot find module './api'`)

- [ ] **Step 11: Write lib/api.ts**

```typescript
import { createClient } from './supabase/client'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL!

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token

  const headers = new Headers(init.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return fetch(`${API_BASE_URL}${path}`, { ...init, headers })
}
```

- [ ] **Step 12: Run test to verify it passes**

```bash
npm test
```
Expected: PASS (all tests)

- [ ] **Step 13: Commit**

```bash
cd ..
git add frontend
git commit -m "feat: scaffold Next.js frontend with Supabase client and API wrapper"
```

---

### Task 11: Login page

**Files:**
- Create: `frontend/app/(auth)/login/page.tsx`
- Create: `frontend/app/(auth)/login/page.test.tsx`

**Interfaces:**
- Consumes: `createClient` (Task 10).
- Produces: the `/login` route with a "Sign in with Microsoft" button.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/app/(auth)/login/page.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signInWithOAuthMock = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: signInWithOAuthMock } }),
}))

import LoginPage from './page'

describe('LoginPage', () => {
  beforeEach(() => {
    signInWithOAuthMock.mockReset()
  })

  it('starts the Microsoft OAuth flow with the required Graph scopes on click', () => {
    render(<LoginPage />)

    fireEvent.click(screen.getByRole('button', { name: /sign in with microsoft/i }))

    expect(signInWithOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'azure',
        options: expect.objectContaining({
          scopes: expect.stringContaining('Mail.Read'),
          redirectTo: expect.stringContaining('/callback'),
        }),
      })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend
npm test
```
Expected: FAIL (`Cannot find module './page'`)

- [ ] **Step 3: Write app/(auth)/login/page.tsx**

```tsx
'use client'

import { createClient } from '@/lib/supabase/client'

const GRAPH_SCOPES =
  'openid email profile offline_access User.Read Mail.Read Chat.Read Calendars.ReadWrite OnlineMeetings.ReadWrite'

export default function LoginPage() {
  async function handleSignIn() {
    const supabase = createClient()
    await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        scopes: GRAPH_SCOPES,
        redirectTo: `${window.location.origin}/callback`,
      },
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <button
        onClick={handleSignIn}
        className="rounded bg-blue-600 px-6 py-3 text-white"
      >
        Sign in with Microsoft
      </button>
    </main>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ..
git add "frontend/app/(auth)/login"
git commit -m "feat: add login page with Microsoft sign-in"
```

---

### Task 12: Auth callback page

**Files:**
- Create: `frontend/app/(auth)/callback/page.tsx`
- Create: `frontend/app/(auth)/callback/page.test.tsx`

**Interfaces:**
- Consumes: `createClient` (Task 10), `POST /api/auth/graph-tokens` (Task 6).
- Produces: the `/callback` route that captures Graph tokens and redirects to `/dashboard`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/app/(auth)/callback/page.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const pushMock = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: getSessionMock } }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import CallbackPage from './page'

describe('CallbackPage', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    pushMock.mockReset()
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com'
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  })

  it('forwards Graph tokens to the backend and redirects to the dashboard', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'supabase-jwt',
          provider_token: 'graph-access',
          provider_refresh_token: 'graph-refresh',
        },
      },
      error: null,
    })

    render(<CallbackPage />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'))
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/auth/graph-tokens',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('shows an error message when Microsoft does not return Graph tokens', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'supabase-jwt' } },
      error: null,
    })

    render(<CallbackPage />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend
npm test
```
Expected: FAIL (`Cannot find module './page'`)

- [ ] **Step 3: Write app/(auth)/callback/page.tsx**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createClient } from '@/lib/supabase/client'

export default function CallbackPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function completeSignIn() {
      const supabase = createClient()
      const { data, error: sessionError } = await supabase.auth.getSession()

      if (sessionError || !data.session) {
        setError('Sign-in failed. Please try again.')
        return
      }

      const session = data.session as typeof data.session & {
        provider_token?: string
        provider_refresh_token?: string
      }

      if (!session.provider_token || !session.provider_refresh_token) {
        setError('Microsoft did not return Graph tokens. Please try again.')
        return
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_BASE_URL}/api/auth/graph-tokens`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            provider_token: session.provider_token,
            provider_refresh_token: session.provider_refresh_token,
            expires_in: 3600,
            scopes: [],
          }),
        }
      )

      if (!response.ok) {
        setError('Could not save your Microsoft connection. Please try again.')
        return
      }

      router.push('/dashboard')
    }

    completeSignIn()
  }, [router])

  if (error) {
    return <p role="alert">{error}</p>
  }

  return <p>Finishing sign-in…</p>
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd ..
git add "frontend/app/(auth)/callback"
git commit -m "feat: add auth callback page that captures Graph tokens"
```

---

### Task 13: Dashboard placeholder page

**Files:**
- Create: `frontend/app/dashboard/page.tsx`
- Create: `frontend/app/dashboard/page.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (Task 10), `GET /api/me/graph-status` (Task 8).
- Produces: the `/dashboard` route — proves the whole auth chain works end-to-end.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/app/dashboard/page.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import DashboardPage from './page'

describe('DashboardPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('shows the connected email on success', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ graph_me: { mail: 'user@example.com' } }), { status: 200 })
    )

    render(<DashboardPage />)

    await waitFor(() =>
      expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument()
    )
  })

  it('shows a reconnect prompt on 409 needs_reauth', async () => {
    apiFetchMock.mockResolvedValue(new Response(null, { status: 409 }))

    render(<DashboardPage />)

    await waitFor(() =>
      expect(screen.getByText(/reconnect your microsoft account/i)).toBeInTheDocument()
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend
npm test
```
Expected: FAIL (`Cannot find module './page'`)

- [ ] **Step 3: Write app/dashboard/page.tsx**

```tsx
'use client'

import { useEffect, useState } from 'react'

import { apiFetch } from '@/lib/api'

type GraphStatus =
  | { state: 'loading' }
  | { state: 'connected'; email: string }
  | { state: 'needs_reauth' }
  | { state: 'error' }

export default function DashboardPage() {
  const [status, setStatus] = useState<GraphStatus>({ state: 'loading' })

  useEffect(() => {
    async function loadStatus() {
      const response = await apiFetch('/api/me/graph-status')

      if (response.status === 409) {
        setStatus({ state: 'needs_reauth' })
        return
      }
      if (!response.ok) {
        setStatus({ state: 'error' })
        return
      }

      const body = await response.json()
      setStatus({
        state: 'connected',
        email: body.graph_me?.mail ?? body.graph_me?.userPrincipalName,
      })
    }

    loadStatus()
  }, [])

  if (status.state === 'loading') return <p>Loading…</p>

  if (status.state === 'needs_reauth') {
    return (
      <p>
        Your Microsoft connection expired.{' '}
        <a href="/login">Reconnect your Microsoft account</a>.
      </p>
    )
  }

  if (status.state === 'error') {
    return <p role="alert">Something went wrong loading your account.</p>
  }

  return <p>Connected as {status.email}</p>
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
cd ..
git add frontend/app/dashboard
git commit -m "feat: add dashboard placeholder showing Graph connection status"
```

---

### Task 14: Local end-to-end verification

**Files:** none (manual verification only)

**Interfaces:** exercises the full chain built in Tasks 1-13.

- [ ] **Step 1: Start the backend**

```bash
cd backend
.venv/Scripts/uvicorn app.main:app --reload --port 8000
```

- [ ] **Step 2: Start the frontend** (new terminal)

```bash
cd frontend
npm run dev
```

- [ ] **Step 3: Sign in with a real Microsoft work/school account**

Visit `http://localhost:3000/login`, click "Sign in with Microsoft", complete the Microsoft login and consent screen.

- [ ] **Step 4: Verify the dashboard**

Expected: redirected to `http://localhost:3000/dashboard`, showing `Connected as <your-email>`. If it shows the reconnect banner or an error, check the backend terminal logs — likely causes: Azure app permissions not admin-consented (Task 9 Step 3), or a scope typo between `frontend/app/(auth)/login/page.tsx` and the Azure app registration.

- [ ] **Step 5: Verify Graph token storage directly**

Call `mcp__plugin_supabase_supabase__execute_sql` with `select user_id, access_token_expires_at, scopes from public.ms_graph_tokens;` against the Task 1 project. Expected: one row for the signed-in user, with a plausible future `access_token_expires_at`.

No commit for this task (verification only).

---

### Task 15: Push the repository to GitHub

**Files:** none (git/GitHub operations only)

**Interfaces:** produces a GitHub remote required by Task 16 and Task 17 (Render/Cloudflare Pages both deploy from a connected repo).

- [ ] **Step 1: Check GitHub CLI auth**

```bash
gh auth status
```
If not authenticated, stop and ask the user to run `gh auth login` themselves — this needs interactive browser auth that cannot be done non-interactively.

- [ ] **Step 2: Create the GitHub repository and push**

```bash
gh repo create ai-relationship-manager --private --source=. --remote=origin
git push -u origin main
```

- [ ] **Step 3: Verify**

```bash
gh repo view --web
```
Expected: opens the new repo in a browser, showing all commits from Tasks 1-13.

---

### Task 16: Deploy the backend to Render

**Files:**
- Create: `render.yaml` (repo root)

**Interfaces:** produces a live `https://ai-relationship-manager-api.onrender.com` (or similar) serving the FastAPI app from Task 8.

- [ ] **Step 1: Write render.yaml**

```yaml
services:
  - type: web
    name: ai-relationship-manager-api
    runtime: python
    rootDir: backend
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    envVars:
      - key: DATABASE_URL
        sync: false
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_JWT_SECRET
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: FERNET_KEY
        sync: false
      - key: MS_CLIENT_ID
        sync: false
      - key: MS_CLIENT_SECRET
        sync: false
      - key: MS_AUTHORITY
        value: https://login.microsoftonline.com/organizations
      - key: CORS_ALLOW_ORIGINS
        value: http://localhost:3000
```

- [ ] **Step 2: Commit render.yaml**

```bash
git add render.yaml
git commit -m "chore: add Render Blueprint for backend deployment"
git push
```

- [ ] **Step 3: Create the Render service**

In the [Render Dashboard](https://dashboard.render.com): New → Blueprint → connect the `ai-relationship-manager` GitHub repo → Render detects `render.yaml`. For each `sync: false` env var, paste the real value from `backend/.env` (Tasks 2, 9). Deploy.

- [ ] **Step 4: Verify the deployed health check**

```bash
curl https://ai-relationship-manager-api.onrender.com/health
```
Expected: `{"status":"ok"}`. Record the Render URL — needed in Task 17 and Task 18.

---

### Task 17: Deploy the frontend to Cloudflare Pages

**Files:**
- Modify: `frontend/package.json` (add build dependency)

**Interfaces:** produces a live `https://ai-relationship-manager.pages.dev` (or similar) serving the Next.js app from Tasks 10-13.

- [ ] **Step 1: Install the Cloudflare Next.js adapter**

```bash
cd frontend
npm install -D @cloudflare/next-on-pages
```

Cloudflare's recommended Next.js build tooling changes over time — before this step, check [Cloudflare's current Next.js framework guide](https://developers.cloudflare.com/pages/framework-guides/nextjs/) to confirm `@cloudflare/next-on-pages` is still the current recommended adapter and the build command below is still accurate; adjust if it has changed.

- [ ] **Step 2: Commit**

```bash
cd ..
git add frontend/package.json frontend/package-lock.json
git commit -m "chore: add Cloudflare Pages Next.js build adapter"
git push
```

- [ ] **Step 3: Create the Cloudflare Pages project**

In the [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → connect the `ai-relationship-manager` GitHub repo. Settings:
- Root directory: `frontend`
- Build command: `npx @cloudflare/next-on-pages@1`
- Build output directory: `.vercel/output/static`
- Environment variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from Task 1), `NEXT_PUBLIC_API_BASE_URL` = the Render URL from Task 16.

Deploy.

- [ ] **Step 4: Verify the deployed login page loads**

Visit the resulting `*.pages.dev` URL + `/login`. Expected: the "Sign in with Microsoft" button renders.

---

### Task 18: Update production CORS and verify the full deployed flow

**Files:** none (config update + manual verification)

**Interfaces:** closes the loop — first real Microsoft sign-in against the fully deployed system.

- [ ] **Step 1: Update the backend's CORS origin**

In the Render Dashboard, update the `CORS_ALLOW_ORIGINS` env var on the service from Task 16 to the real `*.pages.dev` URL from Task 17. Save — Render redeploys automatically.

- [ ] **Step 2: Update Supabase's redirect URL allow-list**

Supabase Dashboard → Authentication → URL Configuration → add the `*.pages.dev` `/callback` URL to the redirect URL allow-list (Supabase rejects OAuth redirects to unlisted URLs).

- [ ] **Step 3: Sign in against the deployed app**

Visit `https://YOUR-PROJECT.pages.dev/login`, sign in with a real Microsoft work/school account.

- [ ] **Step 4: Verify**

Expected: redirected to `/dashboard` showing `Connected as <your-email>`, served entirely from Cloudflare Pages + Render + Supabase — no local servers running. This is the acceptance criterion for the entire Foundation sub-project.

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 16-18), data model (Task 1), auth flow steps 1-13 (Tasks 6, 9, 11-13), folder structure (all tasks), deployment (Tasks 1, 9, 16-17), error handling — OAuth denial/malformed tokens (Task 12), refresh failure → needs_reauth (Task 8), fail-fast config (Task 2's required Settings fields raise at import time), 401 on bad JWT (Task 5), testing strategy (every task has a test step; Task 14/18 cover the manual acceptance checks) — all covered.
- **Placeholder scan:** no TBD/TODO; the two "check current docs before implementing" steps (Task 5 Step 1, Task 17 Step 1) each still ship a concrete default implementation, not a stand-in.
- **Type consistency:** `CurrentUser(user_id, email)` (Task 5) matches usage in Tasks 6 and 8. `ProfilesRepository`/`GraphTokensRepository` method signatures (Task 3) match all call sites in Tasks 6 and 8. `apiFetch(path, init?)` (Task 10) matches its only call site (Task 13).
