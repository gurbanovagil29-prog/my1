-- Обновление 3: погода и «что надеть» — место, «мёрзну / как все / жарко», ответы «Как было по одежде?»,
-- вечерний вопрос и совет на завтра. Выполните ПОСЛЕ update-2.sql: Supabase → SQL Editor → New query → вставить → Run.
-- Скрипт можно запускать повторно.

alter table public.user_prefs add column if not exists wx_lat double precision check (wx_lat is null or wx_lat between -90 and 90);
alter table public.user_prefs add column if not exists wx_lon double precision check (wx_lon is null or wx_lon between -180 and 180);
alter table public.user_prefs add column if not exists wx_place text check (wx_place is null or length(wx_place) <= 120);
alter table public.user_prefs add column if not exists wx_feel text not null default 'normal' check (wx_feel in ('cold', 'normal', 'hot'));
alter table public.user_prefs add column if not exists wx_adjust smallint not null default 0 check (wx_adjust between -6 and 6);
-- Во сколько вечером спрашивать «Как было по одежде?» (и предупреждать, если завтра погода заметно другая); null — не спрашивать
alter table public.user_prefs add column if not exists wx_eve text default '21:00' check (wx_eve is null or wx_eve ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.user_prefs add column if not exists wx_sent date;
-- Ответы: [{ "d": "2026-10-25", "a": "ok" | "cold" | "hot" | "in" }], последние 120 дней
alter table public.user_prefs add column if not exists wx_log jsonb not null default '[]'::jsonb check (jsonb_typeof(wx_log) = 'array');
-- Прогноз на 3 дня, который прислал календарь, — если сервер не достучится до сервиса погоды
alter table public.user_prefs add column if not exists wx_cache jsonb;
