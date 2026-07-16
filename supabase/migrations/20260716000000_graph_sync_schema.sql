create table public.emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  graph_message_id text not null,
  subject text,
  from_address text,
  from_name text,
  to_recipients jsonb not null default '[]',
  received_at timestamptz,
  body_text text,
  synced_at timestamptz not null default now(),
  unique (user_id, graph_message_id)
);

alter table public.emails enable row level security;
-- Intentionally no policies: only the service_role connection (bypasses RLS) may touch this table.

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  graph_event_id text not null,
  subject text,
  organizer text,
  attendees jsonb not null default '[]',
  start_time timestamptz,
  end_time timestamptz,
  is_online_meeting boolean not null default false,
  online_meeting_join_url text,
  body_text text,
  synced_at timestamptz not null default now(),
  unique (user_id, graph_event_id)
);

alter table public.calendar_events enable row level security;

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  graph_chat_id text not null,
  graph_message_id text not null,
  from_user text,
  content text,
  sent_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (user_id, graph_message_id)
);

alter table public.chat_messages enable row level security;

create table public.sync_state (
  user_id uuid not null references public.profiles(id) on delete cascade,
  resource_type text not null check (resource_type in ('mail', 'calendar', 'chat')),
  delta_link text,
  last_synced_at timestamptz,
  status text not null default 'ok' check (status in ('ok', 'not_available', 'error')),
  primary key (user_id, resource_type)
);

alter table public.sync_state enable row level security;
