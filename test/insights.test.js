'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(globalThis, require('../core.js'));
const { normalizeEvent, fromKey, toKey } = require('../core.js');
const ins = require('../insights.js');

const ev = (o) => normalizeEvent({ id: o.title, repeat: 'none', ...o });
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const show = (slots) => slots.map((s) => `${s.key} ${hm(s.start)}-${hm(s.end)}`);

test('статистика: часы по категориям, пересечения внутри категории — один раз', () => {
  const events = [
    ev({ title: 'a', date: '2026-10-19', start: '09:00', end: '12:00', cal: 'work' }),
    ev({ title: 'b', date: '2026-10-19', start: '11:00', end: '13:00', cal: 'work' }),
    ev({ title: 'c', date: '2026-10-19', start: '11:00', end: '12:00', cal: 'study' }),
    ev({ title: 'весь день', date: '2026-10-20', cal: 'personal' }),
    ev({ title: 'поездка', date: '2026-10-20', endDate: '2026-10-22', start: '19:00', end: '18:00', cal: 'personal' }),
    ev({ title: 'спорт', date: '2026-10-19', start: '19:00', end: '20:30', repeat: 'daily', cal: 'personal' }),
  ];
  const tasks = [{ cal: 'study', plan: { date: '2026-10-21', start: '19:00', end: null } }];
  const st = ins.timeStats({ events, tasks, from: fromKey('2026-10-19'), to: fromKey('2026-10-21') });
  assert.deepEqual(st.byCat, { work: 240, study: 120, personal: 270 });
  assert.equal(st.total, 630);
  assert.deepEqual(st.days[0].byCat, { work: 240, study: 60, personal: 90 });
});

test('свободные окна: сон, запас, сегодняшнее прошедшее время', () => {
  const events = [
    ev({ title: 'пара', date: '2026-10-19', start: '09:00', end: '17:00' }),
    ev({ title: 'весь день', date: '2026-10-20' }),
    ev({ title: 'встреча', date: '2026-10-20', start: '10:00', end: '11:00' }),
  ];
  const slots = ins.findFreeSlots({
    events, keys: ['2026-10-19', '2026-10-20'], duration: 120, sleep: ['23:30', '07:00'], buffer: 15,
    now: { key: '2026-10-19', min: 7 * 60 + 5 },
  });
  // 19-го утро до пары короче двух часов с запасом, после пары — с 17:15; 20-го — с 7:00 и после встречи
  assert.deepEqual(show(slots), ['2026-10-19 17:15-19:15', '2026-10-20 07:00-09:00', '2026-10-20 11:15-13:15']);
  const evening = ins.findFreeSlots({ events, keys: ['2026-10-20'], duration: 60, sleep: ['23:30', '07:00'], window: [1080, 1440] });
  assert.deepEqual(show(evening), ['2026-10-20 18:00-19:00']);
  assert.deepEqual(ins.awakeIntervals(['01:00', '09:00']), [[0, 60], [540, 1440]]);
});

test('свободные окна: блоки «Когда делаю» и многодневные события заняты', () => {
  const events = [ev({ title: 'поездка', date: '2026-10-19', endDate: '2026-10-20', start: '18:00', end: '12:00' })];
  const tasks = [{ plan: { date: '2026-10-20', start: '13:00', end: '22:00' } }];
  const slots = ins.findFreeSlots({ events, tasks, keys: ['2026-10-19', '2026-10-20'], duration: 60, sleep: ['23:30', '07:00'], buffer: 0, max: 10 });
  assert.deepEqual(show(slots), ['2026-10-19 07:00-08:00', '2026-10-20 12:00-13:00', '2026-10-20 22:00-23:00']);
});

test('запрос «найди 2 часа …»', () => {
  const base = fromKey('2026-10-21'); // среда
  const q = (s) => {
    const r = ins.parseSlotQuery(s, base);
    return r && { duration: r.duration, from: toKey(r.from), to: toKey(r.to), window: r.window, period: r.period };
  };
  assert.deepEqual(q('найди 2 часа на этой неделе'), { duration: 120, from: '2026-10-21', to: '2026-10-25', window: null, period: 'эта неделя' });
  assert.deepEqual(q('найди 1.5 часа на следующей неделе вечером'), { duration: 90, from: '2026-10-26', to: '2026-11-01', window: [1080, 1440], period: 'следующая неделя' });
  assert.equal(q('найди полтора часа завтра').from, '2026-10-22');
  assert.equal(q('найди полтора часа завтра').to, '2026-10-22');
  assert.deepEqual([q('найди 3 часа на выходных').from, q('найди 3 часа на выходных').to], ['2026-10-24', '2026-10-25']);
  assert.equal(q('свободно 45 минут в пятницу').duration, 45);
  assert.equal(q('свободно 45 минут в пятницу').from, '2026-10-23');
  assert.equal(q('найди час').duration, 60);
  assert.equal(q('найди час').to, '2026-10-27');
  assert.deepEqual(q('найди 2 часа завтра с 9 до 18').window, [540, 1080]);
  assert.equal(q('найди 2 ч 30 мин').duration, 150);
  assert.equal(q('окно в ремонт'), null);
  assert.equal(q('завтра в 15 встреча'), null);
});

test('многодневное с началом и концом — ежедневный блок; с концом раньше начала — сплошной отрезок', () => {
  const work = ev({ title: 'работа', date: '2026-10-19', endDate: '2026-10-23', start: '09:00', end: '18:00', cal: 'work' });
  const trip = ev({ title: 'поездка', date: '2026-10-23', endDate: '2026-10-25', start: '19:00', end: '18:00', cal: 'personal' });
  assert.equal(ins.isDailySpan(work), true);
  assert.equal(ins.isDailySpan(trip), false);
  const st = ins.timeStats({ events: [work, trip], from: fromKey('2026-10-19'), to: fromKey('2026-10-25') });
  assert.deepEqual(st.byCat, { work: 5 * 540 });
  const slots = ins.findFreeSlots({ events: [work], keys: ['2026-10-20'], duration: 60, sleep: ['23:30', '07:00'], buffer: 0, max: 5 });
  assert.deepEqual(show(slots), ['2026-10-20 07:00-08:00', '2026-10-20 18:00-19:00']);
});

test('пересечения: с событиями, повторами и блоками «Когда делаю»', () => {
  const events = [
    ev({ title: 'Семинар', date: '2026-10-20', start: '14:00', end: '15:30' }),
    ev({ title: 'Спорт', date: '2026-10-06', start: '19:00', end: '20:00', repeat: 'weekly' }),
    ev({ title: 'Весь день', date: '2026-10-20' }),
  ];
  const tasks = [{ id: 't', title: 'Проект', done: false, plan: { date: '2026-10-20', start: '16:00', end: '18:00' } }];
  const c = (cand, extra) => ins.findConflicts(ev({ title: 'новое', ...cand }), { events, tasks, ...extra }).map((x) => `${x.title} ${x.start}–${x.end}`);
  assert.deepEqual(c({ date: '2026-10-20', start: '15:00', end: '16:30' }), ['Семинар 14:00–15:30', '☑ Проект 16:00–18:00', 'Спорт 19:00–20:00'].slice(0, 2));
  assert.deepEqual(c({ date: '2026-10-20', start: '19:30', end: '21:00' }), ['Спорт 19:00–20:00']);
  assert.deepEqual(c({ date: '2026-10-20', start: '15:30', end: '16:00' }), []);
  assert.deepEqual(c({ date: '2026-10-20' }), []);
  assert.deepEqual(ins.findConflicts(events[0], { events, tasks, excludeId: events[0].id }), []);
});
