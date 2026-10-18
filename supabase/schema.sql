-- Схема синхронизации календаря. Выполните один раз: Supabase → SQL Editor → New query → Run.
-- Каждое событие, задача и календарь — отдельная строка; удалённые помечаются deleted = true,
-- чтобы удаление дошло до других устройств.

create table if not exists public.items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('event', 'task', 'calendar')),
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

create index if not exists items_user_updated on public.items (user_id, updated_at);

-- Время изменения ставит сервер, чтобы не зависеть от часов на устройствах
create or replace function public.items_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
  for each row execute function public.items_touch();

-- Каждый видит и меняет только свои данные
alter table public.items enable row level security;

drop policy if exists "own items" on public.items;
create policy "own items" on public.items
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Мгновенные обновления на других устройствах
do $$
begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null;
end;
$$;
