'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// alarms.js, как в браузере, пользуется функциями core.js как глобальными
Object.assign(globalThis, require('../core.js'));
const a = require('../alarms.js');
const { normalizeEvent, normalizeTask, parseQuick } = require('../core.js');

const TZ = 'Europe/Moscow'; // UTC+3, без перевода часов
const at = (key, hm, tz = TZ) => a.zonedMs(key, hm, tz);
const show = (ms, tz = TZ) => (ms == null ? null : `${a.localParts(ms, tz).key} ${a.localParts(ms, tz).hm}`);

test('часовые пояса: время на часах и обратно', () => {
  assert.equal(new Date(at('2026-10-18', '09:00')).toISOString(), '2026-10-18T06:00:00.000Z');
  assert.equal(show(Date.parse('2026-10-18T21:30:00Z')), '2026-10-19 00:30');
  // Лондон: 25 октября 2026 переходит с BST (UTC+1) на GMT
  assert.equal(new Date(at('2026-10-24', '09:00', 'Europe/London')).toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(new Date(at('2026-10-26', '09:00', 'Europe/London')).toISOString(), '2026-10-26T09:00:00.000Z');
});

test('событие: напоминания за час и за 10 минут, повтор и весь день', () => {
  const ev = normalizeEvent({ id: 'e', title: 'Встреча', date: '2026-10-19', start: '15:00', reminds: [60, 10] });
  const now = at('2026-10-19', '12:00');
  assert.equal(show(a.nextAlarm('event', ev, now, TZ)), '2026-10-19 14:00');
  assert.equal(show(a.nextAlarm('event', ev, at('2026-10-19', '14:00'), TZ)), '2026-10-19 14:50');
  assert.equal(a.nextAlarm('event', ev, at('2026-10-19', '14:50'), TZ), null);

  const weekly = normalizeEvent({ id: 'w', title: 'Спортзал', date: '2026-10-23', start: '19:00', repeat: 'weekly', reminds: [30], exdates: ['2026-10-30'] });
  assert.equal(show(a.nextAlarm('event', weekly, at('2026-10-23', '19:00'), TZ)), '2026-11-06 18:30');

  const allDay = normalizeEvent({ id: 'd', title: 'ДР мамы', date: '2026-10-25', reminds: [0, 1440] });
  assert.equal(show(a.nextAlarm('event', allDay, at('2026-10-20', '10:00'), TZ)), '2026-10-24 09:00');

  const snoozed = { ...ev, snooze: new Date(at('2026-10-19', '12:30')).toISOString() };
  assert.equal(show(a.nextAlarm('event', snoozed, now, TZ)), '2026-10-19 12:30');
});

test('задача без правила: за час до срока, выполненная — молчит', () => {
  const t = normalizeTask({ id: 't', title: 'Отчёт', due: '2026-10-23', time: '18:00' });
  assert.equal(show(a.nextAlarm('task', t, at('2026-10-20', '10:00'), TZ)), '2026-10-23 17:00');
  assert.equal(a.nextAlarm('task', { ...t, done: true }, at('2026-10-20', '10:00'), TZ), null);
  assert.equal(a.nextAlarm('task', normalizeTask({ id: 'x', title: 'Без времени', due: '2026-10-23' }), 0, TZ), null);
});

test('«каждый час»: тихие часы 23:30–07:00 пропускаются', () => {
  const now = at('2026-10-18', '21:10');
  const t = normalizeTask({ id: 't', title: 'Позвонить', reminder: { every: 60, from: new Date(now).toISOString(), tz: TZ } });
  const seq = [];
  let cur = now;
  for (let i = 0; i < 4; i++) {
    cur = a.nextAlarm('task', t, cur, TZ);
    seq.push(show(cur));
  }
  assert.deepEqual(seq, ['2026-10-18 22:10', '2026-10-18 23:10', '2026-10-19 07:00', '2026-10-19 07:10']);
});

test('повтор только в рабочие часы и до срока, после срока — раз в час', () => {
  const now = at('2026-10-22', '17:20');
  const t = normalizeTask({
    id: 't', title: 'Сдать отчёт', due: '2026-10-23', time: '18:00',
    reminder: { every: 120, from: new Date(now).toISOString(), window: ['10:00', '19:00'], until: new Date(at('2026-10-23', '18:00')).toISOString(), keepAfter: true, tz: TZ },
  });
  const seq = [];
  let cur = now;
  for (let i = 0; i < 6; i++) {
    cur = a.nextAlarm('task', t, cur, TZ);
    seq.push(show(cur));
  }
  // 19:20 уже вне окна 10:00–19:00 — переносится на утро; последнее — ровно в момент срока
  assert.deepEqual(seq, ['2026-10-23 10:00', '2026-10-23 11:20', '2026-10-23 13:20', '2026-10-23 15:20', '2026-10-23 17:20', '2026-10-23 18:00']);
  // В момент срока — напоминание, после — не чаще раза в час
  const atDeadline = a.nextAlarm('task', t, at('2026-10-23', '17:30'), TZ);
  assert.equal(show(atDeadline), '2026-10-23 18:00');
  // После срока шаг 2 часа сохраняется: 20:00 вне окна — значит, утром
  assert.equal(show(a.nextAlarm('task', t, atDeadline, TZ)), '2026-10-24 10:00');
  // При «каждые 15 минут» после срока — не чаще раза в час
  const often = normalizeTask({ ...t, reminder: { ...t.reminder, every: 15, window: null } });
  assert.equal(show(a.nextAlarm('task', often, atDeadline, TZ)), '2026-10-23 19:00');
  // Без keepAfter после срока тишина
  const strict = normalizeTask({ ...t, reminder: { ...t.reminder, keepAfter: false } });
  assert.equal(a.nextAlarm('task', strict, atDeadline, TZ), null);
});

test('конкретные моменты и «отложить»', () => {
  const now = at('2026-10-18', '13:00');
  const t = normalizeTask({
    id: 't', title: 'Таблетки',
    reminder: { at: ['09:00', '14:00', '21:00'].map((hm) => new Date(at('2026-10-18', hm)).toISOString()), tz: TZ },
  });
  assert.equal(show(a.nextAlarm('task', t, now, TZ)), '2026-10-18 14:00');
  assert.equal(show(a.nextAlarm('task', t, at('2026-10-18', '14:00'), TZ)), '2026-10-18 21:00');
  assert.equal(a.nextAlarm('task', t, at('2026-10-18', '21:00'), TZ), null);
  const snoozed = normalizeTask({ ...t, reminder: { ...t.reminder, snooze: new Date(at('2026-10-18', '14:15')).toISOString() } });
  assert.equal(show(a.nextAlarm('task', snoozed, at('2026-10-18', '14:00'), TZ)), '2026-10-18 14:15');
  assert.equal(show(a.nextAlarm('task', snoozed, at('2026-10-18', '14:15'), TZ)), '2026-10-18 21:00');
});

test('alarmAt пересчитывается только при изменении правила', () => {
  const t = normalizeTask({ id: 't', title: 'Отчёт', due: '2026-10-23', time: '18:00' });
  assert.equal(a.refreshAlarm('task', t, at('2026-10-20', '10:00'), TZ), true);
  assert.equal(show(Date.parse(t.alarmAt)), '2026-10-23 17:00');
  // Сервер отправил и сдвинул alarmAt — без изменений правила устройство его не трогает
  t.alarmAt = null;
  assert.equal(a.refreshAlarm('task', t, at('2026-10-20', '10:00'), TZ), false);
  t.time = '20:00';
  assert.equal(a.refreshAlarm('task', t, at('2026-10-20', '10:00'), TZ), true);
  assert.equal(show(Date.parse(t.alarmAt)), '2026-10-23 19:00');
});

test('dueAlarms: опоздавшие больше чем на 15 минут не показываются', () => {
  const t = normalizeTask({ id: 't', title: 'Отчёт', due: '2026-10-23', time: '18:00' });
  t.alarmAt = new Date(at('2026-10-23', '17:00')).toISOString();
  const [fresh] = a.dueAlarms([{ kind: 'task', item: t }], at('2026-10-23', '17:05'), () => TZ);
  assert.equal(fresh.fire, true);
  assert.equal(fresh.next, null);
  const [late] = a.dueAlarms([{ kind: 'task', item: t }], at('2026-10-23', '17:40'), () => TZ);
  assert.equal(late.fire, false);
  assert.equal(a.dueAlarms([{ kind: 'task', item: t }], at('2026-10-23', '16:00'), () => TZ).length, 0);
});

test('правило из быстрой строки', () => {
  const now = at('2026-10-18', '13:00');
  const rule = (text, due = {}) => a.reminderFromParse(parseQuick(text, new Date(2026, 9, 18)), { now, tz: TZ, ...due });

  const hourly = rule('позвонить маме сегодня, напоминай каждый час', { dueKey: '2026-10-18' });
  assert.equal(hourly.every, 60);
  assert.equal(hourly.keepAfter, true);
  assert.deepEqual(hourly.quiet, ['23:30', '07:00']);

  const pills = rule('выпить таблетки в 9, 14 и 21');
  assert.deepEqual(pills.at.map((s) => show(Date.parse(s))), ['2026-10-18 09:00', '2026-10-18 14:00', '2026-10-18 21:00']);

  const three = rule('оплатить интернет завтра, напомни 3 раза', { dueKey: '2026-10-19' });
  assert.deepEqual(three.at.map((s) => show(Date.parse(s))), ['2026-10-19 10:00', '2026-10-19 15:00', '2026-10-19 20:00']);

  const oven = rule('проверить духовку через 30 минут');
  assert.deepEqual(oven.at.map((s) => show(Date.parse(s))), ['2026-10-18 13:30']);

  const call = rule('напомни позвонить маме в 18', { dueKey: '2026-10-18', dueTime: '18:00' });
  assert.deepEqual(call.at.map((s) => show(Date.parse(s))), ['2026-10-18 18:00']);

  assert.equal(rule('полить цветы пока не сделаю').every, 60);
  assert.equal(rule('просто задача'), null);
});

test('тексты уведомлений', () => {
  const now = at('2026-10-19', '14:50');
  const ev = normalizeEvent({ id: 'e', title: 'Встреча с Аней', date: '2026-10-19', start: '15:00', reminds: [10] });
  assert.deepEqual(a.alarmText('event', ev, now, now, TZ), { title: 'Встреча с Аней', body: 'Через 10 мин · Сегодня в 15:00' });
  const t = normalizeTask({ id: 't', title: 'Отчёт', due: '2026-10-19', time: '12:00' });
  assert.equal(a.alarmText('task', t, now, now, TZ).body, 'Срок прошёл: сегодня, 12:00');
  assert.equal(a.alarmText('task', t, now, now, TZ).title, '☑ Отчёт');
});

test('«когда делаю»: напоминание в начале блока и за час до срока', () => {
  const task = normalizeTask({
    id: 't', title: 'Сделать проект', due: '2026-10-24', time: '10:00', eventId: 'defense', eventKey: null,
    plan: { date: '2026-10-22', start: '19:00', end: '23:00' },
  });
  const first = a.nextAlarm('task', task, at('2026-10-20', '12:00'), TZ);
  assert.equal(show(first), '2026-10-22 19:00');
  assert.deepEqual(a.alarmText('task', task, first, first, TZ), { title: '☑ Сделать проект', body: 'Пора начинать · до 23:00 · срок: сб, 24 окт, 10:00' });
  assert.equal(show(a.nextAlarm('task', task, first, TZ)), '2026-10-24 09:00');
  assert.equal(a.nextAlarm('task', { ...task, done: true }, first, TZ), null);
  // Задача события без своего блока молчит — напоминает само событие
  assert.equal(a.nextAlarm('task', { ...task, plan: null }, first, TZ), null);
  // Блок изменили — расписание пересчитывается
  const sig = a.alarmSig('task', task);
  assert.notEqual(a.alarmSig('task', { ...task, plan: { ...task.plan, start: '20:00' } }), sig);
});
