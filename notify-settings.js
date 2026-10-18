'use strict';

/*
 * Окно «Сводка и Telegram»: утренняя сводка (время или выкл), подключение Telegram-бота
 * и куда присылать напоминания — push, Telegram или оба. Настройки хранятся в Supabase
 * (user_prefs, telegram_links): их читает серверная функция remind.
 */

/* global sync, h, $, toast, closeNav, userTz, renderFooter */

const notify = { prefs: null, link: null, bot: undefined, missing: false, poll: null, connectUrl: null };

const remindUrl = () => {
  const c = window.SYNC_CONFIG || {};
  return c.supabaseUrl ? `${c.supabaseUrl}/functions/v1/remind` : null;
};

async function loadNotifyState() {
  if (!sync.client || !sync.user) return;
  const [prefs, link] = await Promise.all([
    sync.client.from('user_prefs').select('*').eq('user_id', sync.user.id),
    sync.client.from('telegram_links').select('*').eq('user_id', sync.user.id),
  ]);
  notify.missing = Boolean(prefs.error || link.error);
  notify.prefs = prefs.data?.[0] || null;
  notify.link = link.data?.[0] || null;
}

/** После входа: запомнить часовой пояс (для сводки в 8:00 по вашим часам). Сводка включена по умолчанию. */
async function onPrefsUser() {
  if (!sync.user) {
    notify.prefs = null;
    notify.link = null;
    return renderFooter();
  }
  await loadNotifyState();
  if (notify.missing) return renderFooter();
  if (!notify.prefs || notify.prefs.tz !== userTz()) {
    const { data } = await sync.client.from('user_prefs').upsert({ user_id: sync.user.id, tz: userTz() }, { onConflict: 'user_id' }).select();
    notify.prefs = data?.[0] || notify.prefs;
  }
  renderFooter();
}

function notifySettingsLabel() {
  if (!sync.user || !notify.prefs) return '☀️ Сводка и Telegram';
  const digest = notify.prefs.digest_time ? `сводка в ${notify.prefs.digest_time}` : 'сводка выкл';
  return `☀️ ${digest} · ${notify.link ? 'Telegram ✓' : 'Telegram'}`;
}

async function botName() {
  if (notify.bot !== undefined) return notify.bot;
  try {
    const res = await fetch(`${remindUrl()}?telegram`, { cache: 'no-store' });
    notify.bot = res.ok ? (await res.json()).bot || null : null;
  } catch {
    notify.bot = null;
  }
  return notify.bot;
}

async function openNotifySettings() {
  closeNav();
  if (!sync.client) return toast('Нужна синхронизация с Supabase');
  if (!sync.user) return toast('Сначала войдите в аккаунт (☁): сводку и Telegram присылает сервер', { duration: 7000 });
  $('#notifyBody').replaceChildren(h('div', { class: 'side-empty' }, 'Загружаю…'));
  $('#notifyDialog').showModal();
  await loadNotifyState();
  renderNotifySettings();
}

function renderNotifySettings() {
  if (notify.missing) {
    $('#notifyBody').replaceChildren(h('p', { class: 'sync-error' },
      'В Supabase ещё нет таблиц для сводки и Telegram: выполните supabase/update-2.sql в SQL Editor (см. docs/SYNC_SETUP.md).'));
    return;
  }
  const p = notify.prefs || { digest_time: '08:00' };
  const link = notify.link;
  const time = h('input', { type: 'time', value: p.digest_time || '08:00', disabled: !p.digest_time, onchange: (e) => savePrefs({ digest_time: e.target.value || '08:00' }) });
  const mode = (value, label) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: 'tgMode', value, checked: (link?.mode || 'both') === value, disabled: !link, onchange: () => saveMode(value) }), label);
  $('#notifyBody').replaceChildren(
    h('section', { class: 'notify-sec' },
      h('h3', {}, '☀️ Утренняя сводка'),
      h('p', { class: 'muted small' }, 'Каждое утро: «Сегодня 3 события и 2 задачи, первое — в 10:00». В пустой день — «Свободный день».'),
      h('div', { class: 'notify-row' },
        h('label', { class: 'check' }, h('input', {
          type: 'checkbox', checked: Boolean(p.digest_time),
          onchange: (e) => savePrefs({ digest_time: e.target.checked ? time.value || '08:00' : null }),
        }), 'Присылать в'),
        time)),
    h('section', { class: 'notify-sec' },
      h('h3', {}, '🤖 Telegram'),
      link
        ? h('div', { class: 'notify-row' }, h('span', {}, `Подключён${link.username ? `: @${link.username}` : ''}. Пишите боту фразы — они станут событиями.`),
          h('button', { class: 'btn small', type: 'button', onclick: disconnectTelegram }, 'Отключить'))
        : h('div', { class: 'notify-row' }, h('span', { class: 'muted' }, 'Пишете боту «завтра в 15 встреча» — и событие в календаре. Напоминания — тоже в Telegram.'),
          notify.connectUrl
            ? h('a', { class: 'btn primary small', href: notify.connectUrl, target: '_blank', rel: 'noopener' }, 'Открыть Telegram')
            : h('button', { class: 'btn primary small', type: 'button', onclick: connectTelegram }, 'Подключить'))),
    h('section', { class: 'notify-sec' },
      h('h3', {}, '🔔 Куда присылать напоминания'),
      link ? null : h('p', { class: 'muted small' }, 'Выбор появится после подключения Telegram — пока только push.'),
      mode('both', 'И push, и Telegram'),
      mode('telegram', 'Только Telegram'),
      mode('push', 'Только push')));
}

async function savePrefs(patch) {
  const { data, error } = await sync.client.from('user_prefs')
    .upsert({ user_id: sync.user.id, tz: userTz(), ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).select();
  if (error) return toast(`Не получилось сохранить: ${error.message}`);
  notify.prefs = data?.[0] || notify.prefs;
  renderNotifySettings();
  renderFooter();
  toast(notify.prefs?.digest_time ? `Сводка будет приходить в ${notify.prefs.digest_time}` : 'Утренняя сводка выключена');
}

async function saveMode(mode) {
  const { error } = await sync.client.from('telegram_links').update({ mode }).eq('user_id', sync.user.id);
  if (error) return toast(`Не получилось: ${error.message}`);
  notify.link = { ...notify.link, mode };
  toast({ both: 'Напоминания: push и Telegram', telegram: 'Напоминания: только Telegram', push: 'Напоминания: только push' }[mode]);
}

async function connectTelegram() {
  const bot = await botName();
  if (!bot) {
    return toast('Бот ещё не настроен: нужен токен от @BotFather в секретах функции remind (см. docs/SYNC_SETUP.md)', { duration: 9000 });
  }
  const { data: code, error } = await sync.client.rpc('telegram_code', { p_tz: userTz() });
  if (error) return toast(`Не получилось: ${error.message}`);
  notify.connectUrl = `https://t.me/${bot}?start=${code}`;
  renderNotifySettings(); // кнопка «Открыть Telegram» — на случай, если браузер не даст открыть окно сам
  window.open(notify.connectUrl, '_blank');
  toast('В Telegram нажмите «Start» — бот подключится сам', { duration: 8000 });
  // Ждём, пока бот привяжет чат (до 2 минут)
  clearInterval(notify.poll);
  const until = Date.now() + 120000;
  notify.poll = setInterval(async () => {
    await loadNotifyState();
    if (notify.link || Date.now() > until) {
      clearInterval(notify.poll);
      notify.connectUrl = null;
      if (notify.link) toast('🤖 Telegram подключён');
      if ($('#notifyDialog').open) renderNotifySettings();
      renderFooter();
    }
  }, 3000);
}

async function disconnectTelegram() {
  if (!confirm('Отключить Telegram? Бот перестанет присылать напоминания и принимать фразы.')) return;
  const { error } = await sync.client.from('telegram_links').delete().eq('user_id', sync.user.id);
  if (error) return toast(`Не получилось: ${error.message}`);
  notify.link = null;
  renderNotifySettings();
  renderFooter();
}

function initNotifySettings() {
  $('#btnNotifySettings').addEventListener('click', openNotifySettings);
}
