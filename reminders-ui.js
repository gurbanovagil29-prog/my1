'use strict';

/*
 * Напоминания в приложении: пересчёт расписания при сохранении, плашка «Сделал / Отложить»,
 * подписка на push-уведомления и тихие часы. Само расписание считает alarms.js.
 *
 * Два режима:
 * — с сервером (вошли в аккаунт и функция «remind» в Supabase отвечает): напоминания рассылает сервер,
 *   даже когда календарь закрыт; приложение только показывает плашку;
 * — без сервера: календарь сам проверяет расписание раз в 30 секунд, пока он открыт.
 */

/* global state, h, $, readJSON, writeJSON, toast, closeNav, sync, saveEvents, saveTasks, saveSettings, findEvent, findTask,
   colorOf, toggleTask, refreshAlarm, dueAlarms, alarmText, zonedMs, localParts, normalizeReminder, iso, DEFAULT_QUIET,
   describeReminder, nextAlarm, STORE_KEY, TASKS_KEY, renderFooter, dayLabel, $$ */

const ALARM_ACK_KEY = 'everyday-calendar:alarm-ack';
const REMIND_OPTIONS = [[0, 'В начале'], [5, '5 мин'], [10, '10 мин'], [15, '15 мин'], [30, '30 мин'], [60, '1 час'], [120, '2 часа'], [1440, 'За день']];

const push = { server: null, subscribed: false };
const shownAlarms = []; // { kind, id, at }

const userTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const quietHours = () => (Array.isArray(state.settings.quiet) ? state.settings.quiet : DEFAULT_QUIET);
const functionUrl = () => {
  const c = window.SYNC_CONFIG || {};
  return c.supabaseUrl && c.supabaseKey ? `${c.supabaseUrl}/functions/v1/remind` : null;
};
/** Напоминания рассылает сервер: вошли в аккаунт и функция отвечает. */
const serverMode = () => Boolean(sync.user && push.server);

/* ---------- Расписание ---------- */

/** Пересчитывает alarmAt у изменённых объектов; вызывается перед каждой записью событий и задач. */
function refreshAlarms(kind, list) {
  const now = Date.now();
  const tz = userTz();
  let changed = false;
  for (const item of list) changed = refreshAlarm(kind, item, now, tz) || changed;
  return changed;
}

/** Проверка расписания на устройстве — только когда нет сервера. */
function runLocalAlarms() {
  if (serverMode()) return;
  const now = Date.now();
  const tz = userTz();
  const list = [
    ...state.events.map((item) => ({ kind: 'event', item })),
    ...state.tasks.map((item) => ({ kind: 'task', item })),
  ];
  const due = dueAlarms(list, now, () => tz);
  if (!due.length) return;
  for (const d of due) {
    d.item.alarmAt = d.next;
    if (!d.fire) continue;
    d.item.alarmLast = iso(now);
    showAlarm(d.kind, d.item.id, d.at);
    const text = alarmText(d.kind, d.item, d.at, now, tz);
    systemNotification(text, { kind: d.kind, id: d.item.id, local: true });
  }
  writeJSON(STORE_KEY, state.events);
  writeJSON(TASKS_KEY, state.tasks);
}

async function systemNotification({ title, body }, data) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const actions = data.kind === 'task' ? [{ action: 'done', title: '✓ Сделал' }, { action: 'snooze15', title: 'Через 15 мин' }] : [{ action: 'snooze15', title: 'Через 15 мин' }];
    if (reg) await reg.showNotification(title, { body, icon: 'icon.svg', tag: `${data.kind}:${data.id}`, renotify: true, data, actions });
    else new Notification(title, { body, icon: 'icon.svg' });
  } catch {
    // Плашка в приложении уже показана
  }
}

/* ---------- Плашка «Сделал / Отложить» ---------- */

const findItem = (kind, id) => (kind === 'task' ? findTask(id) : findEvent(id));
const ackKey = (kind, id) => `${kind}:${id}`;

function acknowledge(kind, id) {
  const ack = readJSON(ALARM_ACK_KEY, {}) || {};
  const item = findItem(kind, id);
  ack[ackKey(kind, id)] = item?.alarmLast || iso(Date.now());
  // Старые отметки не копим
  for (const [k, v] of Object.entries(ack)) if (Date.now() - Date.parse(v) > 3 * 86400000) delete ack[k];
  writeJSON(ALARM_ACK_KEY, ack);
  const i = shownAlarms.findIndex((a) => a.kind === kind && a.id === id);
  if (i >= 0) shownAlarms.splice(i, 1);
  renderAlarmBar();
}

function showAlarm(kind, id, at = Date.now()) {
  if (!findItem(kind, id)) return;
  const i = shownAlarms.findIndex((a) => a.kind === kind && a.id === id);
  if (i >= 0) shownAlarms.splice(i, 1);
  shownAlarms.unshift({ kind, id, at });
  shownAlarms.splice(3);
  renderAlarmBar();
}

/** Напоминания, которые сработали, пока календарь был закрыт (сервер отметил alarmLast). */
function showMissedAlarms() {
  const ack = readJSON(ALARM_ACK_KEY, {}) || {};
  const now = Date.now();
  const recent = [
    ...state.events.map((item) => ['event', item]),
    ...state.tasks.filter((t) => !t.done).map((item) => ['task', item]),
  ].filter(([kind, item]) => item.alarmLast && now - Date.parse(item.alarmLast) < 60 * 60000 && ack[ackKey(kind, item.id)] !== item.alarmLast);
  for (const [kind, item] of recent) showAlarm(kind, item.id, Date.parse(item.alarmLast));
}

function snoozeAlarm(kind, id, minutes) {
  const tz = userTz();
  const now = Date.now();
  const until = minutes === 'morning'
    ? zonedMs(localParts(now + 86400000, tz).key, '09:00', tz)
    : now + minutes * 60000;
  snoozeUntil(kind, id, until);
}

/** Отложить напоминание до момента until (мс). */
function snoozeUntil(kind, id, until) {
  const item = findItem(kind, id);
  if (!item) return;
  const tz = userTz();
  const now = Date.now();
  if (kind === 'task') {
    item.reminder = normalizeReminder({ ...(item.reminder || { at: [] }), snooze: iso(until), quiet: quietHours(), tz });
    saveTasks();
  } else {
    item.snooze = iso(until);
    saveEvents();
  }
  acknowledge(kind, id);
  toast(`Напомню ${whenLabel(until, now, tz)}`);
}

/** «в 17:30», «завтра в 09:00», «пт, 23 окт в 10:00». */
function whenLabel(ms, now, tz) {
  const p = localParts(ms, tz);
  const day = p.key === localParts(now, tz).key ? '' : `${dayLabel(p.key, now, tz)} `;
  return `${day}в ${p.hm}`;
}

/* ---------- «⏰ Другое…»: напомнить через сколько угодно или в точное время ---------- */

let snoozeTarget = null;
let snoozeMode = 'in';

/** Варианты-кнопки: последний свой выбор, 5/10/30 мин, 2/3 часа, вечером в 19:00. */
function snoozeQuickOptions(now, tz) {
  const opts = [];
  const last = state.settings.lastSnooze;
  const nextAt = (hm) => {
    const key = localParts(now, tz).key;
    const t = zonedMs(key, hm, tz);
    return t > now + 60000 ? t : zonedMs(localParts(now + 86400000, tz).key, hm, tz);
  };
  if (last?.in) opts.push({ label: `⭐ Через ${minutesLabel(last.in)}`, until: now + last.in * 60000 });
  if (last?.at) opts.push({ label: `⭐ ${capitalizeFirst(whenLabel(nextAt(last.at), now, tz))}`, until: nextAt(last.at) });
  for (const m of [5, 10, 30, 120, 180]) if (m !== last?.in) opts.push({ label: `Через ${minutesLabel(m)}`, until: now + m * 60000 });
  if (localParts(now, tz).hm < '18:30' && last?.at !== '19:00') opts.push({ label: 'Вечером в 19:00', until: nextAt('19:00') });
  return opts;
}

const capitalizeFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
function minutesLabel(m) {
  if (m % 1440 === 0) return m === 1440 ? 'день' : `${m / 1440} дн.`;
  if (m % 60 === 0) return m === 60 ? 'час' : `${m / 60} ч`;
  return `${m} мин`;
}

function openSnoozePicker(kind, id) {
  const item = findItem(kind, id);
  if (!item) return;
  snoozeTarget = { kind, id };
  const tz = userTz();
  const now = Date.now();
  $('#snTitle').textContent = item.title;
  $('#snQuick').replaceChildren(...snoozeQuickOptions(now, tz).map((o) => h('button', {
    class: 'remind-chip', type: 'button',
    onclick: () => { $('#snoozeDialog').close(); snoozeUntil(kind, id, o.until); },
  }, o.label)));
  const inHour = localParts(now + 60 * 60000, tz);
  $('#snDate').value = inHour.key;
  $('#snDate').min = localParts(now, tz).key;
  $('#snTime').value = `${inHour.hm.slice(0, 3)}${inHour.hm.slice(3) < '30' ? '00' : '30'}`;
  snoozeMode = 'in';
  updateSnoozePreview();
  $('#snoozeDialog').showModal();
}

/** Когда напомним по введённому: «через N» или «точно в». */
function snoozePickerUntil() {
  const now = Date.now();
  if (snoozeMode === 'at') {
    if (!$('#snDate').value || !$('#snTime').value) return null;
    const tz = userTz();
    const t = zonedMs($('#snDate').value, $('#snTime').value, tz);
    // Сегодня это время уже прошло — значит, завтра
    if (t <= now && $('#snDate').value === localParts(now, tz).key) return zonedMs(localParts(now + 86400000, tz).key, $('#snTime').value, tz);
    return t;
  }
  const n = +$('#snNum').value;
  return n > 0 ? now + Math.round(n * +$('#snUnit').value) * 60000 : null;
}

function updateSnoozePreview() {
  for (const el of $$('#snoozeForm .sn-mode')) el.classList.toggle('is-active', el.dataset.mode === snoozeMode);
  const until = snoozePickerUntil();
  const now = Date.now();
  const ok = until && until > now + 30000 && until - now <= 30 * 86400000;
  $('#snPreview').textContent = ok ? `Напомню ${whenLabel(until, now, userTz())}` : 'Выберите время в будущем (не дальше 30 дней)';
  $('#snSubmit').disabled = !ok;
}

function initSnoozePicker() {
  for (const el of [$('#snNum'), $('#snUnit')]) el.addEventListener('input', () => { snoozeMode = 'in'; updateSnoozePreview(); });
  for (const el of [$('#snDate'), $('#snTime')]) el.addEventListener('input', () => { snoozeMode = 'at'; updateSnoozePreview(); });
  for (const el of $$('#snoozeForm .sn-mode')) el.addEventListener('click', () => { snoozeMode = el.dataset.mode; updateSnoozePreview(); });
  $('#snoozeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const until = snoozePickerUntil();
    if (!until || !snoozeTarget) return;
    // Запоминаем свой вариант — в следующий раз он будет первым
    state.settings.lastSnooze = snoozeMode === 'at'
      ? { at: $('#snTime').value }
      : { in: Math.round(+$('#snNum').value * +$('#snUnit').value) };
    saveSettings();
    $('#snoozeDialog').close();
    snoozeUntil(snoozeTarget.kind, snoozeTarget.id, until);
  });
}

function renderAlarmBar() {
  const bar = $('#alarmBar');
  if (!bar) return;
  const tz = userTz();
  const now = Date.now();
  const cards = [];
  for (const a of [...shownAlarms]) {
    const item = findItem(a.kind, a.id);
    if (!item || (a.kind === 'task' && item.done)) {
      shownAlarms.splice(shownAlarms.indexOf(a), 1);
      continue;
    }
    const text = alarmText(a.kind, item, a.at, now, tz);
    const later = (label, m) => h('button', { class: 'btn small', type: 'button', onclick: () => snoozeAlarm(a.kind, a.id, m) }, label);
    cards.push(h('div', { class: 'alarm-card', role: 'alert', style: { '--c': colorOf(item) } },
      h('div', { class: 'alarm-text' }, h('strong', {}, text.title), h('small', {}, text.body)),
      h('button', { class: 'icon-btn alarm-close', type: 'button', 'aria-label': 'Закрыть', onclick: () => acknowledge(a.kind, a.id) }, '✕'),
      h('div', { class: 'alarm-actions' },
        a.kind === 'task'
          ? h('button', { class: 'btn primary small', type: 'button', onclick: () => { acknowledge(a.kind, a.id); toggleTask(a.id); } }, '✓ Сделал')
          : null,
        later('Через 15 мин', 15), later('Через час', 60), later('Завтра утром', 'morning'),
        h('button', { class: 'btn small', type: 'button', onclick: () => openSnoozePicker(a.kind, a.id) }, '⏰ Другое…'))));
  }
  bar.replaceChildren(...cards);
  bar.hidden = !cards.length;
}

/* ---------- Push-уведомления ---------- */

const bytesFromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Проверяем, развёрнута ли функция «remind»: она отдаёт публичный ключ для подписки. */
async function detectPushServer() {
  const url = functionUrl();
  if (!url) return;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    push.server = data?.publicKey ? { url, publicKey: data.publicKey } : null;
  } catch {
    push.server = null;
  }
  renderFooter();
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function saveSubscription(sub) {
  const j = sub.toJSON();
  const { error } = await sync.client.from('push_subscriptions').upsert({
    endpoint: j.endpoint, user_id: sync.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth, tz: userTz(), updated_at: iso(Date.now()),
  }, { onConflict: 'endpoint' });
  if (error) throw error;
  push.subscribed = true;
}

/** Подписывает устройство (или обновляет подписку: часовой пояс, новый ключ сервера). */
async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = bytesFromB64url(push.server.publicKey);
  const current = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && current && current.join() !== key.join()) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(sub);
}

/** После входа в аккаунт: если уведомления уже разрешены — обновить подписку этого устройства. */
async function onSyncUser() {
  await detectPushServer();
  if (serverMode() && 'Notification' in window && Notification.permission === 'granted' && 'PushManager' in window) {
    try {
      await subscribePush();
    } catch (err) {
      console.warn('Push:', err);
    }
  }
  renderFooter();
}

async function enableReminders() {
  closeNav();
  if (!('Notification' in window)) {
    toast(/iPhone|iPad/.test(navigator.userAgent)
      ? 'На iPhone уведомления работают в календаре с экрана «Домой»: Safari → «Поделиться» → «На экран „Домой“»'
      : 'Этот браузер не поддерживает уведомления', { duration: 9000 });
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Уведомления запрещены. Разрешите их для этого сайта в настройках браузера или телефона', { duration: 9000 });
    return;
  }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') return renderFooter();
  if (!serverMode()) {
    renderFooter();
    toast(sync.user
      ? 'Напоминания включены, пока календарь открыт. Чтобы они приходили всегда, нужна функция «remind» в Supabase'
      : 'Напоминания включены, пока календарь открыт. Войдите в аккаунт (☁), чтобы они приходили и при закрытом календаре', { duration: 9000 });
    return;
  }
  if (!('PushManager' in window)) {
    toast('На iPhone push-уведомления работают в календаре с экрана «Домой». Откройте календарь оттуда и нажмите ещё раз', { duration: 9000 });
    return;
  }
  try {
    await subscribePush();
    toast('Готово! Напоминания будут приходить, даже когда календарь закрыт');
  } catch (err) {
    toast(`Не получилось включить push: ${err.message || err}`, { duration: 9000 });
  }
  renderFooter();
}

/* ---------- «Проверить push» ---------- */

/** Проверяет всю цепочку по шагам и просит сервер прислать тестовое уведомление. Отвечает, где сбой. */
async function testPush() {
  closeNav();
  const say = (text, ok = false) => toast(`${ok ? '✅' : '⚠️'} ${text}`, { duration: ok ? 8000 : 12000 });
  if (!('Notification' in window) || !('PushManager' in window)) {
    return say(/iPhone|iPad/.test(navigator.userAgent)
      ? 'Push на iPhone работает только в календаре, открытом с экрана «Домой» (iOS 16.4+)'
      : 'Этот браузер не поддерживает push-уведомления');
  }
  if (Notification.permission !== 'granted') return say('Уведомления не разрешены. Нажмите «🔔 Включить push-напоминания» и разрешите их');
  if (!sync.user) return say('Войдите в аккаунт (☁): push приходят через сервер, ему нужно знать, чьи это напоминания');
  await detectPushServer();
  if (!push.server) return say('Функция «remind» в Supabase не отвечает. Проверьте, что она развёрнута под этим именем и у неё выключен Verify JWT');
  let endpoint;
  try {
    await subscribePush();
    endpoint = (await currentSubscription())?.endpoint;
  } catch (err) {
    return say(`Не удалось подписать это устройство: ${err.message || err}`);
  }
  toast('Отправляю тестовое уведомление…', { duration: 3000 });
  let data;
  try {
    const { data: { session } } = await sync.client.auth.getSession();
    const res = await fetch(push.server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}`, apikey: window.SYNC_CONFIG.supabaseKey },
      body: JSON.stringify({ action: 'test' }),
    });
    data = await res.json().catch(() => null);
    if (res.status === 401) return say('Сервер не узнал аккаунт. Выйдите и войдите снова (☁)');
    if (!res.ok) return say(`Функция «remind» ответила ошибкой ${res.status}: ${data?.error || 'нет подробностей'}. Загляните в Supabase → Edge Functions → remind → Logs`);
  } catch (err) {
    return say(`Нет связи с сервером: ${err.message || err}`);
  }
  if (!data || data.devices == null) return say('В Supabase старая версия функции «remind». Вставьте в неё новый код из supabase/functions/remind/index.ts и нажмите Deploy');
  const mine = (data.results || []).find((r) => r.endpoint === endpoint);
  if (mine && !mine.ok) {
    const why = mine.status === 403 || mine.status === 401 ? 'сервис уведомлений отклонил подпись сервера'
      : mine.status === 404 || mine.status === 410 ? 'подписка устройства устарела — нажмите «Проверить push» ещё раз'
        : `ошибка ${mine.status}${mine.error ? `: ${mine.error}` : ''}`;
    return say(`Сервер не смог отправить уведомление на это устройство: ${why}`);
  }
  say(`Сервер отправил уведомление (устройств в аккаунте: ${data.devices}, доставлено в сервис push: ${data.sent}). Если баннер не появился в течение минуты — проверьте, что уведомления для календаря разрешены в настройках телефона`, true);
}

function notifyStatusText() {
  if (!('Notification' in window)) return '🔕 Уведомления недоступны в этом браузере';
  if (Notification.permission === 'denied') return '🔕 Уведомления запрещены';
  if (Notification.permission !== 'granted') return '🔔 Включить напоминания';
  if (serverMode()) return push.subscribed ? '🔔 Push-напоминания включены' : '🔔 Включить push-напоминания';
  return '🔔 Напоминания, пока календарь открыт';
}

/* ---------- Сообщения от сервис-воркера ---------- */

function applyAlarmAction(action, kind, id) {
  if (action === 'done') {
    const t = findTask(id);
    if (t && !t.done) toggleTask(id);
    acknowledge(kind, id);
  } else if (action === 'snooze15') {
    snoozeAlarm(kind, id, 15);
  }
}

function initReminders() {
  initSnoozePicker();
  $('#btnPushTest').addEventListener('click', testPush);
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'alarm' && m.alarm) showAlarm(m.alarm.kind, m.alarm.id);
    if (m.type === 'alarm-action') applyAlarmAction(m.action, m.kind, m.id);
  });
  // Открыли календарь нажатием на уведомление: ?alarm=task:ID
  const param = new URLSearchParams(location.search).get('alarm');
  if (param) {
    const [kind, id] = param.split(':');
    history.replaceState(null, '', location.pathname);
    setTimeout(() => showAlarm(kind, id), 300);
  }
  // Посчитать расписание для данных, сохранённых до появления напоминаний
  if (refreshAlarms('event', state.events)) writeJSON(STORE_KEY, state.events);
  if (refreshAlarms('task', state.tasks)) writeJSON(TASKS_KEY, state.tasks);
  showMissedAlarms();
  detectPushServer();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      runLocalAlarms();
      showMissedAlarms();
    }
  });
  $('#btnQuiet').addEventListener('click', openQuietDialog);
  $('#quietForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = [$('#qFrom').value || DEFAULT_QUIET[0], $('#qTo').value || DEFAULT_QUIET[1]];
    state.settings.quiet = q;
    saveSettings();
    // Повторяющимся напоминаниям — новые тихие часы
    for (const t of state.tasks) if (t.reminder?.every) t.reminder = normalizeReminder({ ...t.reminder, quiet: q });
    saveTasks();
    $('#quietDialog').close();
    toast(`Тихие часы: ${q[0]}–${q[1]}`);
  });
}

/* ---------- Тихие часы ---------- */

const quietLabel = () => `🌙 Тихие часы: ${quietHours()[0]}–${quietHours()[1]}`;

function openQuietDialog() {
  closeNav();
  $('#qFrom').value = quietHours()[0];
  $('#qTo').value = quietHours()[1];
  $('#quietDialog').showModal();
}

/* ---------- Окно события: за сколько напомнить ---------- */

let pickedReminds = new Set();

function renderRemindChips() {
  $('#fReminds').replaceChildren(...REMIND_OPTIONS.map(([m, label]) => h('button', {
    class: 'remind-chip',
    type: 'button',
    'aria-pressed': String(pickedReminds.has(m)),
    onclick: () => {
      if (pickedReminds.has(m)) pickedReminds.delete(m);
      else pickedReminds.add(m);
      renderRemindChips();
    },
  }, label)));
}

function setEditorReminds(list) {
  pickedReminds = new Set(list);
  renderRemindChips();
}

const editorReminds = () => [...pickedReminds].sort((a, b) => b - a);

/* ---------- Окно задачи: напоминания ---------- */

const draft = { at: [], base: null };

function fmtMoment(ms) {
  const tz = userTz();
  const p = localParts(ms, tz);
  const today = localParts(Date.now(), tz).key;
  const tomorrow = localParts(Date.now() + 86400000, tz).key;
  const day = p.key === today ? 'сегодня' : p.key === tomorrow ? 'завтра' : new Date(ms).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${p.hm}`;
}

function renderTaskReminderDraft(taskLike) {
  const now = Date.now();
  $('#tAtList').replaceChildren(...draft.at.sort((a, b) => a - b).map((t) => h('span', { class: `remind-chip is-on${t < now ? ' is-past' : ''}` },
    fmtMoment(t),
    h('button', { type: 'button', 'aria-label': 'Убрать', onclick: () => { draft.at = draft.at.filter((x) => x !== t); renderTaskReminderDraft(currentTaskDraft()); } }, '✕'))));
  $('#tWindowWrap').hidden = !$('#tEvery').value;
  const rule = taskLike.reminder;
  const next = nextAlarm('task', { ...taskLike, done: false }, now, userTz());
  const hint = [];
  if (next) hint.push(`Следующее: ${fmtMoment(next)}`);
  if (rule) hint.push(describeReminder(rule, now, userTz()));
  else if (taskLike.plan?.start) hint.push(`напомню в ${taskLike.plan.start}${taskLike.time ? ' и за час до срока, если не сделано' : ''}`);
  else if (taskLike.time && taskLike.due && !taskLike.eventId) hint.push('Своих напоминаний нет — напомню за час до срока');
  $('#tRemindHint').textContent = hint.filter(Boolean).join(' · ');
}

/** Правило из полей окна задачи. deadline — срок задачи { date, time } или null. */
function buildTaskReminder(deadline) {
  const every = $('#tEvery').value ? +$('#tEvery').value : null;
  const from = $('#tWinFrom').value;
  const to = $('#tWinTo').value;
  const base = draft.base || {};
  const tz = userTz();
  const until = every && deadline ? iso(zonedMs(deadline.date, deadline.time || '23:59', tz)) : null;
  return normalizeReminder({
    at: draft.at.map(iso),
    every,
    // Тот же интервал — продолжаем прежний отсчёт, новый — с этой минуты
    from: every && base.every === every && base.from ? base.from : iso(Date.now()),
    window: every && from && to && from < to ? [from, to] : null,
    until,
    keepAfter: Boolean(until),
    snooze: base.snooze || null,
    quiet: quietHours(),
    tz,
  });
}

let currentTaskDraft = () => ({});

function fillTaskReminder(task, getDraft) {
  currentTaskDraft = getDraft;
  const r = task.reminder;
  draft.base = r;
  draft.at = (r?.at || []).map((s) => Date.parse(s));
  $('#tEvery').value = r?.every ? String(r.every) : '';
  $('#tWinFrom').value = r?.window?.[0] || '';
  $('#tWinTo').value = r?.window?.[1] || '';
  $('#tAtInput').value = '';
  renderTaskReminderDraft(getDraft());
}

function initTaskReminderFields() {
  const update = () => renderTaskReminderDraft(currentTaskDraft());
  $('#tAtAdd').addEventListener('click', () => {
    const v = $('#tAtInput').value;
    if (!v) return;
    const [day, hm] = v.split('T');
    const t = zonedMs(day, hm.slice(0, 5), userTz());
    if (!draft.at.includes(t)) draft.at.push(t);
    $('#tAtInput').value = '';
    update();
  });
  for (const id of ['#tEvery', '#tWinFrom', '#tWinTo', '#tDue', '#tTime', '#tPlanDate', '#tPlanStart', '#tPlanEnd', '#tEvent']) $(id).addEventListener('change', update);
}
