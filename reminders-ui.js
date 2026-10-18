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
   describeReminder, nextAlarm, STORE_KEY, TASKS_KEY, renderFooter */

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
  const item = findItem(kind, id);
  if (!item) return;
  const tz = userTz();
  const now = Date.now();
  const until = minutes === 'morning'
    ? zonedMs(localParts(now + 86400000, tz).key, '09:00', tz)
    : now + minutes * 60000;
  if (kind === 'task') {
    item.reminder = normalizeReminder({ ...(item.reminder || { at: [] }), snooze: iso(until), quiet: quietHours(), tz });
    saveTasks();
  } else {
    item.snooze = iso(until);
    saveEvents();
  }
  acknowledge(kind, id);
  toast(`Напомню ${minutes === 'morning' ? 'завтра в 9:00' : `в ${localParts(until, tz).hm}`}`);
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
        later('Через 15 мин', 15), later('Через час', 60), later('Завтра утром', 'morning'))));
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
  else if (taskLike.time && taskLike.due) hint.push('Своих напоминаний нет — напомню за час до срока');
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
  for (const id of ['#tEvery', '#tWinFrom', '#tWinTo', '#tDue', '#tTime']) $(id).addEventListener('change', update);
}
