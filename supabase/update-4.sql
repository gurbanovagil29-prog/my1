-- Обновление 4: заметки (строка «Версия …» внизу меню) — синхронизация между устройствами.
-- Выполните в Supabase → SQL Editor → New query → вставить → Run. Скрипт можно запускать повторно.
-- Таблица видна только владельцу: друзьям, ссылкам и серверу напоминаний она не отдаётся.

create table if not exists public.memos (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  text text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.memos enable row level security;

drop policy if exists "own memo" on public.memos;
create policy "own memo" on public.memos
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.memos from anon;
