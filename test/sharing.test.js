'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(globalThis, require('../core.js'));
const sh = require('../sharing.js');

test('настройки доступа: по умолчанию «только занято», мусор отбрасывается', () => {
  assert.deepEqual(sh.normalizeShareSettings(null), { default: 'busy', cals: {}, tasks: 'busy', notes: false });
  const s = sh.normalizeShareSettings({ default: 'details', cals: { work: 'hidden', x: 'all' }, tasks: 'nope', notes: true });
  assert.deepEqual(s, { default: 'details', cals: { work: 'hidden' }, tasks: 'busy', notes: true });
  assert.equal(sh.shareLevelOf(s, 'work'), 'hidden');
  assert.equal(sh.shareLevelOf(s, 'study'), 'details');
});

test('слой друга: события «только для просмотра», задачи — блоком и отметкой срока', () => {
  const rows = [
    { kind: 'owner', id: 's', data: { name: 'Аня' } },
    { kind: 'calendar', id: 'work', data: { name: 'Работа', color: '#4f6bed' } },
    { kind: 'event', id: 'e1', data: { date: '2026-10-20', start: '10:00', end: '11:00', cal: 'work', repeat: 'weekly' } },
    { kind: 'event', id: 'e2', data: { date: '2026-10-21', title: 'Кино', cal: 'work', repeat: 'none' } },
    { kind: 'task', id: 't1', data: { title: 'Отчёт', due: '2026-10-22', time: '18:00', plan: { date: '2026-10-21', start: '19:00' }, cal: 'work', done: false } },
    { kind: 'task', id: 't2', data: { eventId: 'e2', cal: 'work', done: false } },
    { kind: 'task', id: 't3', data: { title: 'Сделано', due: '2026-10-22', cal: 'work', done: true } },
  ];
  const layer = sh.buildLayer(rows, 's:1');
  assert.equal(layer.ownerName, 'Аня');
  assert.equal(layer.cals.get('work').name, 'Работа');
  const show = layer.events.map((e) => [e.id, e.title, e.date, e.start, e.end, e.repeat, e.cal, e.friendCal, e.busy]);
  assert.deepEqual(show, [
    ['s:1/e1', 'Занят', '2026-10-20', '10:00', '11:00', 'weekly', 's:1', 'work', true],
    ['s:1/e2', 'Кино', '2026-10-21', null, null, 'none', 's:1', 'work', false],
    ['s:1/plan/t1', '☑ Отчёт', '2026-10-21', '19:00', '20:00', 'none', 's:1', 'work', false],
    ['s:1/due/t1', '⚑ 18:00 Отчёт', '2026-10-22', null, null, 'none', 's:1', 'work', false],
    ['s:1/due/t2', '⚑ Задача', '2026-10-21', null, null, 'none', 's:1', 'work', true],
  ]);
  assert.ok(layer.events.every((e) => e.friend === 's:1' && !e.reminds.length));
});

test('имя в падеже: «с Аней» — Аня, «с Машей» — Маша', () => {
  assert.ok(sh.nameMatches('Аней', 'Аня'));
  assert.ok(sh.nameMatches('машей', 'Маша Петрова'));
  assert.ok(sh.nameMatches('Олегом', 'Олег'));
  assert.ok(!sh.nameMatches('Аней', 'Борис'));
  assert.ok(!sh.nameMatches('9', 'Аня'));
});
