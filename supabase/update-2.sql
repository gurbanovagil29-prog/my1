-- Обновление 2: приглашения на события, Telegram-бот, утренняя сводка, срок действия ссылок.
-- Выполните ПОСЛЕ schema.sql, push.sql и friends.sql: Supabase → SQL Editor → New query → вставить → Run.
-- Скрипт можно запускать повторно.

/* ---------- Ссылки: срок действия, новая ссылка взамен старой, статистика открытий ---------- */

alter table public.shares add column if not exists expires_at timestamptz;
alter table public.shares add column if not exists open_count integer not null default 0;
alter table public.shares add column if not exists last_opened timestamptz;

-- Принять приглашение может только приглашённый; секретный адрес и счётчик меняют только функции ниже
create or replace function public.shares_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.viewer := null;
    new.accepted := false;
    new.open_count := 0;
    new.last_opened := null;
  else
    if coalesce(current_setting('app.accepting', true), '') <> 'on' then
      new.owner := old.owner;
      new.kind := old.kind;
      new.viewer := old.viewer;
      new.accepted := old.accepted;
      if new.email is distinct from old.email then
        new.viewer := null;
        new.accepted := false;
      end if;
    end if;
    if coalesce(current_setting('app.share_internal', true), '') <> 'on' then
      new.token := old.token;
      new.open_count := old.open_count;
      new.last_opened := old.last_opened;
    end if;
  end if;
  new.email := lower(trim(new.email));
  return new;
end;
$$;

-- Новая ссылка взамен старой: старая сразу перестаёт работать, настройки остаются
create or replace function public.reissue_link(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  perform set_config('app.share_internal', 'on', true);
  update public.shares sh
     set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), open_count = 0, last_opened = null
   where sh.id = p_id and sh.owner = auth.uid() and sh.kind = 'link'
  returning sh.token into t;
  if t is null then
    raise exception 'link not found';
  end if;
  return t;
end;
$$;

-- Календарь по ссылке: только пока ссылка не отозвана и не истекла. p_open — считать открытие
drop function if exists public.link_items(text);
create or replace function public.link_items(p_token text, p_open boolean default false)
returns table (kind text, id text, data jsonb)
language plpgsql security definer set search_path = public as $$
declare
  s public.shares;
begin
  select * into s from public.shares sh
   where sh.token = p_token and sh.kind = 'link' and (sh.expires_at is null or sh.expires_at > now());
  if not found then
    return;
  end if;
  if p_open then
    perform set_config('app.share_internal', 'on', true);
    update public.shares sh set open_count = sh.open_count + 1, last_opened = now() where sh.id = s.id;
  end if;
  return query
    select 'owner'::text, s.id::text, jsonb_build_object('name', s.owner_name)
    union all
    select p.kind, p.id, p.data from public.share_project(s.owner, s.settings) p;
end;
$$;

revoke all on function public.reissue_link(uuid) from public, anon;
revoke all on function public.link_items(text, boolean) from public;
grant execute on function public.reissue_link(uuid) to authenticated;
grant execute on function public.link_items(text, boolean) to anon, authenticated;

/* ---------- Приглашения на события ---------- */

-- Друзья — те, кто показывает календарь друг другу (хотя бы в одну сторону)
create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.shares sh
    where sh.kind = 'friend' and sh.accepted and ((sh.owner = a and sh.viewer = b) or (sh.owner = b and sh.viewer = a))
  );
$$;
revoke all on function public.are_friends(uuid, uuid) from public, anon;
grant execute on function public.are_friends(uuid, uuid) to authenticated;

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  invitee uuid not null references auth.users (id) on delete cascade,
  event_id text not null,
  owner_name text not null default '',
  invitee_name text not null default '',
  -- Снимок события: title, date, endDate, start, end, notes
  event jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'maybe', 'declined', 'cancelled')),
  -- О чём ещё не сообщили: new / changed / cancelled — приглашённому, answered — владельцу
  notify text check (notify in ('new', 'changed', 'cancelled', 'answered')),
  updated_at timestamptz not null default now(),
  unique (owner, event_id, invitee)
);

create index if not exists invites_invitee on public.invites (invitee);
create index if not exists invites_notify on public.invites (notify) where notify is not null;

-- Владелец меняет событие и может отменить приглашение; ответить может только приглашённый (answer_invite —
-- она работает от имени владельца базы, и эта проверка её пропускает)
create or replace function public.invites_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new; -- сервер (функция remind) знает, что делает
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.notify := 'new';
    return new;
  end if;
  new.owner := old.owner;
  new.invitee := old.invitee;
  new.event_id := old.event_id;
  -- Дальше — изменение от владельца
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    new.notify := 'cancelled';
  elsif new.status = 'pending' and old.status = 'cancelled' then
    new.notify := 'new'; -- пригласили снова
  else
    new.status := old.status;
    new.notify := old.notify;
    if old.status <> 'cancelled' and old.status <> 'declined'
       and (new.event ->> 'date', new.event ->> 'endDate', new.event ->> 'start', new.event ->> 'end', new.event ->> 'title')
           is distinct from (old.event ->> 'date', old.event ->> 'endDate', old.event ->> 'start', old.event ->> 'end', old.event ->> 'title') then
      new.notify := coalesce(nullif(old.notify, 'answered'), 'changed');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invites_guard on public.invites;
create trigger invites_guard before insert or update on public.invites
  for each row execute function public.invites_guard();

alter table public.invites enable row level security;

drop policy if exists "owner manages invites" on public.invites;
create policy "owner manages invites" on public.invites
  for all to authenticated
  using ((select auth.uid()) = owner)
  with check ((select auth.uid()) = owner and public.are_friends(owner, invitee));

drop policy if exists "invitee sees invites" on public.invites;
create policy "invitee sees invites" on public.invites
  for select to authenticated
  using ((select auth.uid()) = invitee);

create or replace function public.answer_invite(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('accepted', 'maybe', 'declined') then
    raise exception 'bad status';
  end if;
  update public.invites iv set status = p_status, notify = 'answered', updated_at = now()
   where iv.id = p_id and iv.invitee = auth.uid() and iv.status <> 'cancelled';
  if not found then
    raise exception 'invite not found';
  end if;
end;
$$;
revoke all on function public.answer_invite(uuid, text) from public, anon;
grant execute on function public.answer_invite(uuid, text) to authenticated;

/* ---------- Telegram ---------- */

create table if not exists public.telegram_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  chat_id bigint not null unique,
  username text,
  -- Куда присылать напоминания: both — push и Telegram, telegram — только Telegram, push — только push
  mode text not null default 'both' check (mode in ('both', 'telegram', 'push')),
  linked_at timestamptz not null default now()
);

alter table public.telegram_links enable row level security;

drop policy if exists "own telegram" on public.telegram_links;
create policy "own telegram" on public.telegram_links
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Сам пользователь меняет только mode: привязывает чат бот, по одноразовому коду
revoke insert, update on public.telegram_links from anon, authenticated;
grant update (mode) on public.telegram_links to authenticated;

create table if not exists public.telegram_codes (
  code text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  tz text not null default 'UTC',
  expires_at timestamptz not null
);

alter table public.telegram_codes enable row level security; -- правил нет: читает только функция remind

-- Одноразовый код для ссылки t.me/<бот>?start=<код>, действует 10 минут
create or replace function public.telegram_code(p_tz text) returns text
language plpgsql security definer set search_path = public as $$
declare
  c text := replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from public.telegram_codes tc where tc.user_id = auth.uid() or tc.expires_at < now();
  insert into public.telegram_codes (code, user_id, tz, expires_at) values (c, auth.uid(), coalesce(p_tz, 'UTC'), now() + interval '10 minutes');
  return c;
end;
$$;
revoke all on function public.telegram_code(text) from public, anon;
grant execute on function public.telegram_code(text) to authenticated;

/* ---------- Утренняя сводка ---------- */

create table if not exists public.user_prefs (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  digest_time text default '08:00' check (digest_time is null or digest_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  tz text not null default 'UTC',
  digest_sent date,
  updated_at timestamptz not null default now()
);

alter table public.user_prefs enable row level security;

drop policy if exists "own prefs" on public.user_prefs;
create policy "own prefs" on public.user_prefs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
