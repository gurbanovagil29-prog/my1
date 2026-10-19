-- Друзья и ссылки на календарь. Выполните один раз ПОСЛЕ schema.sql:
-- Supabase → SQL Editor → New query → вставить → Run.
--
-- Кто кому что показывает хранится в таблице shares. Сами события и задачи друг никогда не читает
-- из таблицы items напрямую: их отдают функции friend_items и link_items, и только в том виде,
-- который разрешил владелец («только занято» — без названий и заметок).

create table if not exists public.shares (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('friend', 'link')),
  -- Друг: email, на который отправлено приглашение, и его аккаунт после принятия
  email text,
  viewer uuid references auth.users (id) on delete cascade,
  accepted boolean not null default false,
  -- Ссылка: секретный адрес; кто его знает, тот видит календарь (без входа в аккаунт)
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  label text not null default '',      -- подпись для владельца: «Аня», «Ссылка для группы»
  owner_name text not null default '', -- как владелец подписан у друга
  -- { "default": "busy", "cals": { "<id категории>": "hidden" | "busy" | "details" }, "tasks": "busy", "notes": false }
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (kind = 'link' or email is not null)
);

create index if not exists shares_owner on public.shares (owner);
create index if not exists shares_viewer on public.shares (viewer);
create index if not exists shares_email on public.shares (lower(email));

alter table public.shares enable row level security;

drop policy if exists "owner manages shares" on public.shares;
create policy "owner manages shares" on public.shares
  for all to authenticated
  using ((select auth.uid()) = owner)
  with check ((select auth.uid()) = owner);

-- Приглашённый видит приглашение (по своему email или после принятия) и может его удалить — «отписаться»
drop policy if exists "invitee sees invite" on public.shares;
create policy "invitee sees invite" on public.shares
  for select to authenticated
  using (kind = 'friend' and (viewer = (select auth.uid()) or email = lower((select auth.jwt() ->> 'email'))));

drop policy if exists "invitee removes invite" on public.shares;
create policy "invitee removes invite" on public.shares
  for delete to authenticated
  using (kind = 'friend' and (viewer = (select auth.uid()) or email = lower((select auth.jwt() ->> 'email'))));

create or replace function public.accept_share(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.accepting', 'on', true);
  update public.shares set viewer = auth.uid(), accepted = true
   where id = p_id and kind = 'friend' and email = lower(auth.jwt() ->> 'email') and owner <> auth.uid();
  if not found then
    raise exception 'invite not found';
  end if;
end;
$$;

-- Что видно другу: категории «hidden» не отдаются совсем, «busy» — без названий и заметок, «details» — с названиями.
-- Задача видна не подробнее, чем её категория и общая настройка задач.
create or replace function public.share_project(p_owner uuid, p_settings jsonb)
returns table (kind text, id text, data jsonb)
language sql stable security definer set search_path = public as $$
  with src as (
    select i.kind, i.id, i.data,
      case coalesce(p_settings -> 'cals' ->> (case when i.kind = 'calendar' then i.id else i.data ->> 'cal' end),
                    p_settings ->> 'default', 'busy')
        when 'hidden' then 0 when 'details' then 2 else 1 end as cal_rank,
      case coalesce(p_settings ->> 'tasks', 'busy') when 'hidden' then 0 when 'details' then 2 else 1 end as task_rank
    from public.items i
    where i.user_id = p_owner and not i.deleted and i.data is not null
  ), lvl as (
    select s.kind, s.id, s.data, case when s.kind = 'task' then least(s.cal_rank, s.task_rank) else s.cal_rank end as r
    from src s
  )
  select l.kind, l.id,
    case l.kind
      when 'calendar' then jsonb_build_object('id', l.id, 'name', l.data -> 'name', 'color', l.data -> 'color')
      when 'event' then jsonb_strip_nulls(jsonb_build_object(
        'id', l.id, 'date', l.data -> 'date', 'endDate', l.data -> 'endDate', 'start', l.data -> 'start', 'end', l.data -> 'end',
        'repeat', l.data -> 'repeat', 'until', l.data -> 'until', 'exdates', l.data -> 'exdates', 'cal', l.data -> 'cal',
        'title', case when l.r = 2 then l.data -> 'title' end,
        'notes', case when l.r = 2 and coalesce((p_settings ->> 'notes')::boolean, false) then l.data -> 'notes' end))
      else jsonb_strip_nulls(jsonb_build_object(
        'id', l.id, 'due', l.data -> 'due', 'time', l.data -> 'time', 'plan', l.data -> 'plan', 'done', l.data -> 'done',
        'cal', l.data -> 'cal', 'eventId', l.data -> 'eventId', 'eventKey', l.data -> 'eventKey',
        'title', case when l.r = 2 then l.data -> 'title' end,
        'notes', case when l.r = 2 and coalesce((p_settings ->> 'notes')::boolean, false) then l.data -> 'notes' end))
    end
  from lvl l
  where l.r > 0;
$$;

-- Календарь друга — только тому, кто принял его приглашение
create or replace function public.friend_items(p_share uuid)
returns table (kind text, id text, data jsonb)
language sql stable security definer set search_path = public as $$
  select p.kind, p.id, p.data
  from public.shares s
  cross join lateral public.share_project(s.owner, s.settings) p
  where s.id = p_share and s.kind = 'friend' and s.accepted and s.viewer = auth.uid();
$$;

-- Ссылки: срок действия, новая ссылка взамен старой, статистика открытий
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

drop trigger if exists shares_guard on public.shares;
create trigger shares_guard before insert or update on public.shares
  for each row execute function public.shares_guard();

-- share_project отдаёт данные любого пользователя — вызывать её снаружи нельзя, только из функций выше
revoke all on function public.share_project(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.accept_share(uuid) from public, anon;
revoke all on function public.friend_items(uuid) from public, anon;
grant execute on function public.accept_share(uuid) to authenticated;
grant execute on function public.friend_items(uuid) to authenticated;
