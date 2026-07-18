alter table public.action_items
  drop constraint action_items_scheduled_calendar_event_id_fkey;

alter table public.action_items
  add constraint action_items_scheduled_calendar_event_id_fkey
  foreign key (scheduled_calendar_event_id) references public.calendar_events(id) on delete set null;
