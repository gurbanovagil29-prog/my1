'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(globalThis, require('../core.js'), require('../alarms.js'), require('../webpush.js'));
const { createReminderServer } = require('../reminder-server.js');
const { normalizeTask, normalizeEvent } = require('../core.js');
const { zonedMs, refreshAlarm } = require('../alarms.js');

const TZ = 'Europe/Moscow';
const at = (key, hm) => zonedMs(key, hm, TZ);

function fakeDb() {
  const items = new Map();
  const subs = [];
  let keys = null;
  const k = (u, kind, id) => `${u}:${kind}:${id}`;
  return {
    items,
    subs,
    put(user, kind, data) { items.set(k(user, kind, data.id), { user_id: user, kind, id: data.id, data: structuredClone(data) }); },
    get(user, kind, id) { return items.get(k(user, kind, id)).data; },
    async getKeys() { return keys; },
    async insertKeys(row) { keys ||= row; },
    async dueItems(nowIso) { return [...items.values()].filter((r) => r.data.alarmAt && r.data.alarmAt <= nowIso).map((r) => structuredClone(r)); },
    async subscriptions(users) { return subs.filter((s) => users.includes(s.user_id)); },
    async claim(row, old, data) {
      const cur = items.get(k(row.user_id, row.kind, row.id));
      if (cur.data.alarmAt !== old) return false;
      cur.data = structuredClone(data);
      return true;
    },
    async deleteSubscription(endpoint) { subs.splice(subs.findIndex((s) => s.endpoint === endpoint), 1); },
    async getItem(user, kind, id) { return structuredClone(items.get(k(user, kind, id)) || null); },
    async updateItem(user, kind, id, data) { items.get(k(user, kind, id)).data = structuredClone(data); },
    async userFromToken(token) { return token === 'good-token' ? 'u1' : null; },
  };
}

function setup(nowMs) {
  const db = fakeDb();
  const sent = [];
  let clock = nowMs;
  const server = createReminderServer({
    db,
    now: () => clock,
    actionUrl: 'https://x.supabase.co/functions/v1/remind',
    subject: 'mailto:me@example.com',
    push: async (s, payload) => {
      sent.push({ endpoint: s.endpoint, ...JSON.parse(payload) });
      return { ok: s.endpoint !== 'gone', status: s.endpoint === 'gone' ? 410 : 201 };
    },
  });
  return { db, sent, server, setNow: (t) => { clock = t; } };
}

test('отправляет наступившее напоминание на все устройства и сдвигает alarmAt', async () => {
  const { db, sent, server, setNow } = setup(at('2026-10-18', '12:00'));
  const task = normalizeTask({ id: 't1', title: 'Позвонить маме', due: '2026-10-18', reminder: { every: 60, from: new Date(at('2026-10-18', '12:00')).toISOString(), tz: TZ } });
  refreshAlarm('task', task, at('2026-10-18', '12:00'), TZ);
  db.put('u1', 'task', task);
  db.subs.push({ endpoint: 'phone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ }, { endpoint: 'gone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ });

  setNow(at('2026-10-18', '12:30'));
  assert.deepEqual(await server.runDue(), { due: 0, sent: 0 });

  setNow(at('2026-10-18', '13:00'));
  const r = await server.runDue();
  assert.equal(r.sent, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].title, '☑ Позвонить маме');
  assert.equal(sent[0].kind, 'task');
  assert.ok(sent[0].token);
  assert.equal(db.get('u1', 'task', 't1').alarmAt, new Date(at('2026-10-18', '14:00')).toISOString());
  // Недействующая подписка удалена
  assert.deepEqual(db.subs.map((s) => s.endpoint), ['phone']);
  // Повторный запуск в ту же минуту ничего не шлёт
  await server.runDue();
  assert.equal(sent.length, 2);
});

test('событие: напоминание за 10 минут с понятным текстом', async () => {
  const { db, sent, server, setNow } = setup(at('2026-10-19', '10:00'));
  const ev = normalizeEvent({ id: 'e1', title: 'Встреча с Аней', date: '2026-10-19', start: '15:00', reminds: [10] });
  refreshAlarm('event', ev, at('2026-10-19', '10:00'), TZ);
  db.put('u1', 'event', ev);
  db.subs.push({ endpoint: 'phone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ });
  setNow(at('2026-10-19', '14:50'));
  await server.runDue();
  assert.equal(sent[0].body, 'Через 10 мин · Сегодня в 15:00');
  assert.equal(db.get('u1', 'event', 'e1').alarmAt, null);
});

test('сильно опоздавшее напоминание не отправляется, но расписание идёт дальше', async () => {
  const { db, sent, server, setNow } = setup(at('2026-10-18', '12:00'));
  const task = normalizeTask({ id: 't1', title: 'Задача', reminder: { every: 60, from: new Date(at('2026-10-18', '12:00')).toISOString(), tz: TZ } });
  refreshAlarm('task', task, at('2026-10-18', '12:00'), TZ);
  db.put('u1', 'task', task);
  db.subs.push({ endpoint: 'phone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ });
  setNow(at('2026-10-18', '13:40'));
  await server.runDue();
  assert.equal(sent.length, 0);
  assert.equal(db.get('u1', 'task', 't1').alarmAt, new Date(at('2026-10-18', '14:00')).toISOString());
});

test('кнопки «Сделал» и «Отложить» работают только с верной подписью', async () => {
  const { db, server } = setup(at('2026-10-18', '13:00'));
  const task = normalizeTask({ id: 't1', title: 'Задача', reminder: { every: 60, from: new Date(at('2026-10-18', '12:00')).toISOString(), tz: TZ } });
  db.put('u1', 'task', task);
  db.subs.push({ endpoint: 'phone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ });
  const token = await server.sign('u1', 'task', 't1');

  assert.equal((await server.action({ action: 'done', user: 'u1', type: 'task', id: 't1', token: 'forged' })).status, 403);
  assert.equal((await server.action({ action: 'done', user: 'u2', type: 'task', id: 't1', token })).status, 403);

  assert.equal((await server.action({ action: 'snooze', minutes: 15, user: 'u1', type: 'task', id: 't1', token })).status, 200);
  assert.equal(db.get('u1', 'task', 't1').alarmAt, new Date(at('2026-10-18', '13:15')).toISOString());

  assert.equal((await server.action({ action: 'done', user: 'u1', type: 'task', id: 't1', token })).status, 200);
  assert.equal(db.get('u1', 'task', 't1').done, true);
  assert.equal(db.get('u1', 'task', 't1').alarmAt, null);
});

test('ключи VAPID создаются один раз', async () => {
  const { server } = setup(Date.now());
  const k1 = await server.publicKey();
  const k2 = await server.publicKey();
  assert.equal(k1, k2);
  assert.match(k1, /^[A-Za-z0-9_-]{87}$/);
});

test('«Проверить push»: только для вошедшего, отчёт по каждому устройству', async () => {
  const { db, sent, server } = setup(at('2026-10-19', '12:00'));
  db.subs.push({ endpoint: 'phone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ }, { endpoint: 'gone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ },
    { endpoint: 'other', user_id: 'u2', p256dh: 'x', auth: 'y', tz: TZ });
  assert.equal((await server.testPush('bad')).status, 401);
  assert.equal((await server.testPush('')).status, 401);
  const r = await server.testPush('good-token');
  assert.equal(r.status, 200);
  assert.equal(r.body.devices, 2);
  assert.equal(r.body.sent, 1);
  assert.deepEqual(r.body.results.map((x) => [x.endpoint, x.status]), [['phone', 201], ['gone', 410]]);
  assert.deepEqual(sent.map((x) => [x.endpoint, x.title]), [['phone', '🔔 Проверка'], ['gone', '🔔 Проверка']]);
  // Устаревшая подписка удалена, чужие не тронуты
  assert.deepEqual(db.subs.map((x) => x.endpoint), ['phone', 'other']);
});

/* ---------- Telegram, приглашения, утренняя сводка ---------- */

Object.assign(globalThis, require('../digest.js'), require('../phrase.js'));

function setupFull(nowMs) {
  const base = setup(nowMs);
  const { db } = base;
  const tg = [];
  db.links = [];
  db.prefs = [];
  db.invites = [];
  db.codes = [{ code: 'abc', user_id: 'u1', tz: TZ }];
  Object.assign(db, {
    async telegramLinks(ids) { return db.links.filter((l) => ids.includes(l.user_id)); },
    async telegramLinkByChat(chat) { return db.links.find((l) => l.chat_id === chat) || null; },
    async linkTelegram(user_id, chat_id, username) { db.links = db.links.filter((l) => l.chat_id !== chat_id && l.user_id !== user_id); db.links.push({ user_id, chat_id, username, mode: 'both' }); },
    async takeTelegramCode(code) { const i = db.codes.findIndex((c) => c.code === code); return i < 0 ? null : db.codes.splice(i, 1)[0]; },
    async prefsOf(ids) { return db.prefs.filter((p) => ids.includes(p.user_id)); },
    async savePrefsTz(user_id, tz) { const p = db.prefs.find((x) => x.user_id === user_id); if (p) p.tz = tz; else db.prefs.push({ user_id, tz, digest_time: '08:00', digest_sent: null }); },
    async digestPrefs() { return db.prefs.filter((p) => p.digest_time); },
    async claimDigest(user, key) { const p = db.prefs.find((x) => x.user_id === user); if (p.digest_sent && p.digest_sent >= key) return false; p.digest_sent = key; return true; },
    async inviteNotices() { return db.invites.filter((i) => i.notify).map((i) => ({ ...i })); },
    async clearInviteNotice(id, notify) { const i = db.invites.find((x) => x.id === id && x.notify === notify); if (!i) return false; i.notify = null; return true; },
    async answerInvite(id, user, status) { const i = db.invites.find((x) => x.id === id && x.invitee === user && x.status !== 'cancelled'); if (!i) return false; Object.assign(i, { status, notify: 'answered' }); return true; },
    async userItems(user) { return [...db.items.values()].filter((r) => r.user_id === user && !r.deleted); },
    async insertItem(user, kind, id, data) { db.put(user, kind, data); },
    async deleteItem(user, kind, id) { db.items.get(`${user}:${kind}:${id}`).deleted = true; },
  });
  const telegram = { async call(method, params) { tg.push({ method, ...params }); return method === 'getMe' ? { username: 'my_cal_bot' } : true; } };
  const server = createReminderServer({ db, push: base.server && (async () => ({ ok: true, status: 201 })), now: () => base.clock(), actionUrl: 'https://x/remind', subject: 'mailto:a@b.c', telegram });
  return { ...base, server, tg };
}

test('Telegram: привязка по коду, фраза → событие, отмена, /today', async () => {
  let clock = at('2026-10-19', '12:00');
  const env = setupFull(clock);
  env.clock = () => clock;
  const { db, tg } = env;
  const server = createReminderServer({ db, push: async () => ({ ok: true, status: 201 }), now: () => clock, actionUrl: 'x', subject: 's', telegram: { async call(m, p) { tg.push({ method: m, ...p }); return m === 'getMe' ? { username: 'b' } : true; } } });
  db.put('u1', 'calendar', { id: 'work', name: 'Работа' });
  const msg = (text) => server.telegramUpdate({ message: { chat: { id: 77 }, from: { username: 'agil' }, text } });
  await msg('завтра в 15 встреча');
  assert.match(tg.at(-1).text, /Чтобы подключить/);
  await msg('/start abc');
  assert.deepEqual(db.links, [{ user_id: 'u1', chat_id: 77, username: 'agil', mode: 'both' }]);
  assert.equal(db.prefs[0].tz, TZ);
  await msg('/start abc');
  assert.match(tg.at(-1).text, /Код устарел/);
  await msg('завтра в 15 встреча с Аней #работа');
  const reply = tg.at(-1);
  assert.equal(reply.text, '✓ Добавлено: Встреча с Аней · завтра, 15:00–16:00 · Работа');
  const ev = [...db.items.values()].find((r) => r.kind === 'event');
  assert.equal(ev.data.cal, 'work');
  assert.ok(ev.data.alarmAt, 'напоминание за 10 минут посчитано');
  const undo = reply.reply_markup.inline_keyboard[0][0].callback_data;
  await server.telegramUpdate({ callback_query: { id: 'q1', data: undo, message: { chat: { id: 77 }, message_id: 5, text: reply.text } } });
  assert.equal(ev.deleted, true);
  assert.equal(tg.find((x) => x.method === 'answerCallbackQuery').text, 'Отменено, удалил');
  await msg('позвонить маме, напоминай каждый час');
  await msg('/today');
  assert.match(tg.at(-1).text, /<b>Сегодня<\/b>\n☑ Позвонить маме|<b>Сегодня<\/b>\nСвободно/);
  // Чужой чат не может нажимать кнопки
  const task = [...db.items.values()].find((r) => r.kind === 'task');
  await server.telegramUpdate({ callback_query: { id: 'q2', data: `d:${task.id}`, message: { chat: { id: 99 }, message_id: 6, text: '' } } });
  assert.equal(task.data.done, false);
  await server.telegramUpdate({ callback_query: { id: 'q3', data: `d:${task.id}`, message: { chat: { id: 77 }, message_id: 6, text: '' } } });
  assert.equal(db.get('u1', 'task', task.id).done, true);
});

test('напоминание: push и Telegram — по выбору пользователя', async () => {
  const clock = at('2026-10-19', '12:00');
  const db = setup(clock).db;
  Object.assign(db, setupFull(clock).db, { items: db.items });
  const pushes = [];
  const tg = [];
  const server = createReminderServer({ db, push: async (s) => { pushes.push(s.endpoint); return { ok: true, status: 201 }; }, now: () => clock, actionUrl: 'x', subject: 's', telegram: { async call(m, p) { tg.push({ method: m, ...p }); return true; } } });
  db.subs.push({ endpoint: 'phone', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ });
  const task = normalizeTask({ id: 't', title: 'Отчёт', due: '2026-10-19', time: '13:00' });
  refreshAlarm('task', task, at('2026-10-19', '11:00'), TZ);
  db.put('u1', 'task', task);
  db.links.push({ user_id: 'u1', chat_id: 5, mode: 'both' });
  let r = await server.tick();
  assert.equal(r.sent, 2);
  assert.deepEqual(pushes, ['phone']);
  assert.equal(tg[0].chat_id, 5);
  assert.match(tg[0].text, /Отчёт/);
  assert.deepEqual(tg[0].reply_markup.inline_keyboard[0].map((b) => b.text), ['✓ Сделал', 'Через 15 мин', 'Через час']);
  // Только Telegram
  db.links[0].mode = 'telegram';
  const t2 = normalizeTask({ id: 't2', title: 'Ещё', reminder: { at: [new Date(clock - 60000).toISOString()] } });
  refreshAlarm('task', t2, clock - 120000, TZ);
  db.put('u1', 'task', t2);
  r = await server.tick();
  assert.equal(pushes.length, 1);
  assert.equal(tg.length, 2);
});

test('приглашения: сообщение приглашённому и владельцу, ответ кнопкой', async () => {
  const clock = at('2026-10-19', '12:00');
  const env = setupFull(clock);
  const { db } = env;
  const tg = [];
  const pushes = [];
  const server = createReminderServer({ db, push: async (s, p) => { pushes.push({ to: s.user_id, ...JSON.parse(p) }); return { ok: true, status: 201 }; }, now: () => clock, actionUrl: 'x', subject: 's', telegram: { async call(m, p) { tg.push({ method: m, ...p }); return true; } } });
  db.subs.push({ endpoint: 'a', user_id: 'owner', p256dh: 'x', auth: 'y', tz: TZ }, { endpoint: 'b', user_id: 'friend', p256dh: 'x', auth: 'y', tz: TZ });
  db.links.push({ user_id: 'friend', chat_id: 9, mode: 'both' });
  db.invites.push({ id: 'i1', owner: 'owner', invitee: 'friend', owner_name: 'Агиль', invitee_name: 'Аня', event: { title: 'Кофе', date: '2026-10-20', start: '15:00', end: '16:00' }, status: 'pending', notify: 'new' });
  await server.tick();
  assert.deepEqual(pushes.map((p) => [p.to, p.title, p.body, p.kind]), [['friend', '📨 Агиль приглашает: Кофе', 'Завтра, 15:00–16:00', 'invite']]);
  assert.ok(pushes[0].token);
  assert.deepEqual(tg[0].reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['i:i1:a', 'i:i1:m', 'i:i1:d']);
  await server.tick();
  assert.equal(pushes.length, 1, 'второй раз не шлём');
  // Ответ кнопкой в Telegram → сообщение владельцу
  await server.telegramUpdate({ callback_query: { id: 'q', data: 'i:i1:a', message: { chat: { id: 9 }, message_id: 1, text: 'x' } } });
  assert.equal(db.invites[0].status, 'accepted');
  await server.tick();
  assert.deepEqual(pushes.at(-1).to, 'owner');
  assert.equal(pushes.at(-1).title, 'Аня придёт ✓');
  // Ответ кнопкой в push — только с верной подписью
  db.invites[0].status = 'pending';
  assert.equal((await server.action({ action: 'decline', user: 'friend', type: 'invite', id: 'i1', token: 'bad' })).status, 403);
  const ok = await server.action({ action: 'decline', user: 'friend', type: 'invite', id: 'i1', token: await server.sign('friend', 'invite', 'i1') });
  assert.equal(ok.status, 200);
  assert.equal(db.invites[0].status, 'declined');
});

test('утренняя сводка: в своё время, один раз в день', async () => {
  let clock = at('2026-10-19', '07:59');
  const env = setupFull(clock);
  const { db } = env;
  const pushes = [];
  const server = createReminderServer({ db, push: async (s, p) => { pushes.push(JSON.parse(p)); return { ok: true, status: 201 }; }, now: () => clock, actionUrl: 'x', subject: 's', telegram: null });
  db.subs.push({ endpoint: 'a', user_id: 'u1', p256dh: 'x', auth: 'y', tz: TZ });
  db.prefs.push({ user_id: 'u1', tz: TZ, digest_time: '08:00', digest_sent: null });
  db.put('u1', 'event', normalizeEvent({ id: 'e', title: 'Созвон', date: '2026-10-19', start: '10:00', end: '11:00' }));
  await server.tick();
  assert.equal(pushes.length, 0);
  clock = at('2026-10-19', '08:00');
  await server.tick();
  await server.tick();
  assert.deepEqual(pushes.map((p) => [p.title, p.body]), [['☀️ Сегодня 1 событие', 'Первое — 10:00 Созвон']]);
  clock = at('2026-10-20', '08:01');
  await server.tick();
  assert.deepEqual(pushes.at(-1).title, '☀️ Сегодня свободный день 🎉');
  // Если функция не работала больше трёх часов — старую сводку не шлём
  clock = at('2026-10-21', '12:30');
  await server.tick();
  assert.equal(pushes.length, 2);
});

test('«⏰ Другое время»: бот спрашивает и понимает ответ словами', async () => {
  const { snoozeFromText } = require('../phrase.js');
  const now = at('2026-10-19', '12:42');
  const hm = (ms) => require('../alarms.js').localParts(ms, TZ);
  assert.equal(hm(snoozeFromText('через 40 минут', now, TZ)).hm, '13:22');
  assert.equal(hm(snoozeFromText('в 17:30', now, TZ)).hm, '17:30');
  assert.equal(hm(snoozeFromText('17:30', now, TZ)).hm, '17:30');
  assert.deepEqual([hm(snoozeFromText('завтра в 9', now, TZ)).key, hm(snoozeFromText('завтра в 9', now, TZ)).hm], ['2026-10-20', '09:00']);
  assert.equal(hm(snoozeFromText('в 9', now, TZ)).key, '2026-10-20', '9 утра уже прошло — завтра');
  assert.equal(hm(snoozeFromText('40', now, TZ)).hm, '13:22');
  assert.equal(hm(snoozeFromText('2 часа', now, TZ)).hm, '14:42');
  assert.equal(snoozeFromText('когда-нибудь', now, TZ), null);

  const env = setupFull(now);
  const { db } = env;
  const tg = [];
  const server = createReminderServer({ db, push: async () => ({ ok: true, status: 201 }), now: () => now, actionUrl: 'x', subject: 's', telegram: { async call(m, p) { tg.push({ method: m, ...p }); return true; } } });
  db.links.push({ user_id: 'u1', chat_id: 7, mode: 'both' });
  db.prefs.push({ user_id: 'u1', tz: TZ, digest_time: null });
  db.put('u1', 'task', normalizeTask({ id: 'call', title: 'Созвон', due: '2026-10-19', time: '13:30' }));
  await server.telegramUpdate({ callback_query: { id: 'q', data: 'o:t:call', message: { chat: { id: 7 }, message_id: 1, text: 'x' } } });
  const ask = tg.find((x) => x.method === 'sendMessage');
  assert.match(ask.text, /Когда напомнить «Созвон»/);
  assert.equal(ask.reply_markup.force_reply, true);
  const url = ask.text.match(/href="([^"]+)"/)[1];
  await server.telegramUpdate({ message: { chat: { id: 7 }, text: 'в 17:30', reply_to_message: { text: 'x', entities: [{ type: 'text_link', url }] } } });
  assert.equal(tg.at(-1).text, '⏰ Напомню сегодня в 17:30');
  assert.equal(hm(Date.parse(db.get('u1', 'task', 'call').reminder.snooze)).hm, '17:30');
});
