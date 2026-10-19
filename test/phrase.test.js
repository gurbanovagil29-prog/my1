'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(globalThis, require('../core.js'), require('../alarms.js'));
const { phraseToItem, describePhraseItem } = require('../phrase.js');
const { digestMessage, dayAgenda } = require('../digest.js');
const { normalizeEvent, normalizeTask } = require('../core.js');
const { zonedMs } = require('../alarms.js');

const TZ = 'Europe/Moscow';
const NOW = zonedMs('2026-10-19', '12:00', TZ); // понедельник
const cals = [{ id: 'personal', name: 'Личное' }, { id: 'work', name: 'Работа' }, { id: 'study', name: 'Учёба' }];
let n = 0;
const opts = (extra = {}) => ({ now: NOW, tz: TZ, calendars: cals, newId: () => `id${++n}`, ...extra });

test('фраза → событие: дата, время, категория, напоминание, закрепление «!»', () => {
  const r = phraseToItem('завтра в 15 встреча с Аней #работа', opts());
  assert.equal(r.kind, 'event');
  assert.deepEqual([r.item.title, r.item.date, r.item.start, r.item.end, r.item.cal, r.item.reminds, r.item.pin],
    ['Встреча с Аней', '2026-10-20', '15:00', '16:00', 'work', [10], false]);
  const pin = phraseToItem('24 октября в 10 защита проекта !', opts());
  assert.equal(pin.item.pin, true);
  assert.equal(pin.item.cal, 'personal');
  assert.equal(describePhraseItem(r, NOW, TZ), 'Встреча с Аней · завтра, 15:00–16:00 · Работа');
  const span = phraseToItem('с пятницы до воскресенья дача', opts());
  assert.deepEqual([span.item.date, span.item.endDate, span.item.start], ['2026-10-23', '2026-10-25', null]);
});

test('фраза → задача: напоминания, «@событие» и блок «Когда делаю»', () => {
  const nag = phraseToItem('позвонить маме, напоминай каждый час', opts());
  assert.equal(nag.kind, 'task');
  assert.equal(nag.item.reminder.every, 60);
  const events = [normalizeEvent({ id: 'def', title: 'Защита проекта', date: '2026-10-24', start: '10:00', end: '11:00', cal: 'study', repeat: 'none' })];
  const t = phraseToItem('сделать проект в четверг с 19 до 23 @защита', opts({ events }));
  assert.equal(t.kind, 'task');
  assert.deepEqual(t.item.plan, { date: '2026-10-22', start: '19:00', end: '23:00' });
  assert.deepEqual([t.item.eventId, t.item.due, t.item.time, t.item.cal], ['def', '2026-10-24', '10:00', 'study']);
  assert.equal(t.linkTitle, 'Защита проекта');
  assert.match(phraseToItem('подготовить слайды @экзамен', opts({ events })).error, /экзамен/);
  const due = phraseToItem('задача: сдать отчёт в пятницу в 18', opts());
  assert.deepEqual([due.kind, due.item.due, due.item.time], ['task', '2026-10-23', '18:00']);
});

test('утренняя сводка: события, задачи, просроченное; пустой день', () => {
  const events = [
    normalizeEvent({ id: 'a', title: 'Созвон', date: '2026-10-19', start: '10:00', end: '11:00', repeat: 'none' }),
    normalizeEvent({ id: 'b', title: 'Спортзал', date: '2026-10-05', start: '19:00', end: '20:00', repeat: 'weekly' }),
    normalizeEvent({ id: 'c', title: 'ДР Вари', date: '2026-10-18', endDate: '2026-10-20', repeat: 'none' }),
  ];
  const tasks = [
    normalizeTask({ id: 't1', title: 'Отчёт', due: '2026-10-19', time: '18:00' }),
    normalizeTask({ id: 't2', title: 'Слайды', plan: { date: '2026-10-19', start: '08:30', end: '09:30' } }),
    normalizeTask({ id: 't3', title: 'Оплатить', due: '2026-10-17' }),
    normalizeTask({ id: 't4', title: 'Готово', due: '2026-10-19', done: true }),
  ];
  const m = digestMessage({ events, tasks, key: '2026-10-19' });
  assert.equal(m.title, '☀️ Сегодня 3 события и 2 задачи');
  assert.equal(m.body, 'Первое — 08:30 Слайды · Просрочено: 1');
  assert.deepEqual(m.lines, ['☑ 08:30–09:30 Слайды', '10:00–11:00 Созвон', '☑ 18:00 Отчёт (срок)', '19:00–20:00 Спортзал', 'весь день: ДР Вари', '⚠️ просрочено: Оплатить']);
  const free = digestMessage({ events: [], tasks: [], key: '2026-10-19' });
  assert.equal(free.title, '☀️ Сегодня свободный день 🎉');
  assert.equal(dayAgenda({ events, tasks, key: '2026-10-21' }).items.length, 0);
});
