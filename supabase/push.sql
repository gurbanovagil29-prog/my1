-- Push-напоминания. Выполните один раз ПОСЛЕ schema.sql и после создания функции «remind»:
-- Supabase → SQL Editor → New query → вставить → Run.

-- Подписки устройств на уведомления (каждое устройство — своя строка)
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  tz text not null default 'UTC',
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own subscriptions" on public.push_subscriptions;
create policy "own subscriptions" on public.push_subscriptions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Ключи для подписи уведомлений. Правил доступа нет — читать и менять может только сама функция
create table if not exists public.push_keys (
  id int primary key,
  public_key text not null,
  private_jwk jsonb not null,
  hmac_secret text not null
);

alter table public.push_keys enable row level security;

-- Быстрый поиск напоминаний, которым пора сработать
create index if not exists items_alarm_at on public.items ((data ->> 'alarmAt'))
  where not deleted and data ? 'alarmAt';

-- Раз в минуту вызываем функцию «remind»: она рассылает наступившие напоминания
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('calendar-reminders');
exception when others then null;
end;
$$;

select cron.schedule(
  'calendar-reminders',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://dtwdhhyqseokmaliwkje.supabase.co/functions/v1/remind',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
