-- Обновление 5: свои имена для друзей (✎ в разделе «Друзья») — одинаковые на всех устройствах.
-- Выполните в Supabase → SQL Editor → New query → вставить → Run. Скрипт можно запускать повторно.
-- Имена видите только вы: это ваши настройки, другу они не показываются.

alter table public.user_prefs add column if not exists friend_names jsonb not null default '{}'::jsonb
  check (jsonb_typeof(friend_names) = 'object');
