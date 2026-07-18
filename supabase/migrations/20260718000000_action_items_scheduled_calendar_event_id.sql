alter table public.action_items
  add column scheduled_calendar_event_id uuid null references public.calendar_events(id);
