-- Lamp database setup. Paste into Supabase: SQL Editor -> New query -> Run.
-- Safe to run more than once.

create table if not exists public.docs (
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),   -- when the change was made on the device
  synced_at  timestamptz not null default now(),   -- when the server received it (used to catch up other devices)
  primary key (user_id, col, id)
);

create index if not exists docs_user_synced on public.docs (user_id, synced_at);

-- Stamp every write with the server's clock.
create or replace function public.docs_touch() returns trigger
language plpgsql as $$
begin
  new.synced_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
for each row execute function public.docs_touch();

-- Only you can see or change your rows.
alter table public.docs enable row level security;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Live updates between your devices.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
