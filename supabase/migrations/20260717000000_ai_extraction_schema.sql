alter table public.emails add column extracted_at timestamptz;
alter table public.calendar_events add column extracted_at timestamptz;
alter table public.chat_messages add column extracted_at timestamptz;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  email_address text,
  display_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index contacts_user_email_key
  on public.contacts (user_id, email_address)
  where email_address is not null;

create unique index contacts_user_display_name_key
  on public.contacts (user_id, display_name)
  where email_address is null;

alter table public.contacts enable row level security;
-- Intentionally no policies: only the service_role connection (bypasses RLS) may touch this table.

create table public.action_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  text text not null,
  direction text not null check (direction in ('mine', 'theirs')),
  status text not null default 'open' check (status in ('open', 'done')),
  due_date date,
  source_type text not null check (source_type in ('email', 'calendar_event', 'chat_message')),
  source_id uuid not null,
  created_at timestamptz not null default now()
);

alter table public.action_items enable row level security;
