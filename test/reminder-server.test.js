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
