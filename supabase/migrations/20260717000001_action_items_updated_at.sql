alter table public.action_items
  add column updated_at timestamptz not null default now();
