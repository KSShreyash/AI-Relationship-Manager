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
