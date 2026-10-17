'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../core.js');

// Суббота, 17 октября 2026
const BASE = new Date(2026, 9, 17);
const parse = (text) => {
  const r = c.parseQuick(text, BASE);
  return { ...r, date: r.date && c.toKey(r.date) };
};

test('быстрое добавление: дата, время и название', () => {
  assert.deepEqual(parse('завтра в 15 встреча с Аней'), {
    title: 'Встреча с Аней', date: '2026-10-18', start: '15:00', end: '16:00', repeat: 'none', allDay: false, tag: null, matched: true,
  });
  assert.equal(parse('через 3 дня в 7 вечера кино').start, '19:00');
  assert.equal(parse('через 3 дня в 7 вечера кино').date, '2026-10-20');
  assert.equal(parse('через неделю стоматолог').date, '2026-10-24');
  assert.equal(parse('позвонить в банк в 9:30').title, 'Позвонить в банк');
  assert.equal(parse('позвонить в банк в 9:30').start, '09:30');
});

test('быстрое добавление: интервалы', () => {
  const r = parse('в следующий вторник с 10 до 12:30 стоматолог');
  assert.equal(r.date, '2026-10-20');
  assert.equal(r.start, '10:00');
  assert.equal(r.end, '12:30');
  assert.equal(parse('обед 13:00-14:00').end, '14:00');
  const evening = parse('с 7 до 9 вечера ужин');
  assert.equal(evening.start, '19:00');
  assert.equal(evening.end, '21:00');
});

test('быстрое добавление: даты', () => {
  assert.equal(parse('25 декабря новый год у мамы').date, '2026-12-25');
  assert.equal(parse('15.11 отпуск').date, '2026-11-15');
  // Прошедшая дата без года уходит на следующий год
  assert.equal(parse('1 марта день рождения').date, '2027-03-01');
  // «в 15 октября» — это дата, а не время
  const r = parse('в 15 октября концерт');
  assert.equal(r.start, null);
  assert.equal(r.title, 'Концерт');
  assert.equal(parse('в пт бар').date, '2026-10-23');
  assert.equal(parse('сегодня весь день уборка').title, 'Уборка');
});

test('быстрое добавление: повторы', () => {
  const gym = parse('по пятницам в 19 спортзал');
  assert.equal(gym.repeat, 'weekly');
  assert.equal(gym.date, '2026-10-23');
  assert.equal(gym.title, 'Спортзал');
  assert.equal(parse('созвон по будням в 10').repeat, 'weekdays');
  assert.equal(parse('витамины каждый день в 9').repeat, 'daily');
  assert.equal(parse('оплатить интернет каждый месяц').repeat, 'monthly');
});

test('быстрое добавление: метка категории', () => {
  const r = parse('завтра в 10 созвон #работа');
  assert.equal(r.tag, 'работа');
  assert.equal(r.title, 'Созвон');
  assert.equal(r.start, '10:00');
  assert.equal(parse('#учёба экзамен 20.12').tag, 'учёба');
});

test('обычный текст остаётся названием', () => {
  const r = parse('купить 2 яблока');
  assert.equal(r.title, 'Купить 2 яблока');
  assert.equal(r.matched, false);
});

test('повторы и исключения', () => {
  const ev = { id: '1', title: 'x', date: '2026-10-17', repeat: 'weekdays', exdates: ['2026-10-20'], until: '2026-10-23' };
  const map = c.collect([ev], new Date(2026, 9, 17), new Date(2026, 9, 25));
  const days = [...map].filter(([, l]) => l.length).map(([k]) => k);
  assert.deepEqual(days, ['2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23']);

  const monthly = { id: '2', title: 'y', date: '2026-01-31', repeat: 'monthly' };
  assert.equal(c.occursOn(monthly, '2026-02-28'), false);
  assert.equal(c.occursOn(monthly, '2026-03-31'), true);
  assert.equal(c.nextOccurrence(monthly, new Date(2026, 9, 17)), '2026-10-31');
});

test('экспорт и импорт .ics сохраняют событие', () => {
  const ev = c.normalizeEvent({
    id: 'a', title: 'Йога, утро; дома', date: '2026-10-19', start: '08:00', end: '09:15',
    repeat: 'weekly', until: '2026-12-31', exdates: ['2026-10-26'], remind: 15, notes: 'Коврик\nвода', cal: 'personal',
  });
  const [back] = c.fromICS(c.toICS([ev], () => 'Личное, спорт'), () => 'b');
  assert.equal(back.category, 'Личное, спорт');
  const { category, ...rest } = back;
  assert.deepEqual({ ...rest, id: 'a', cal: ev.cal }, ev);
});

test('нормализация отбрасывает мусор', () => {
  assert.equal(c.normalizeEvent({ title: 'x' }), null);
  const e = c.normalizeEvent({ id: 1, date: '2026-10-17', start: '25:99', repeat: 'hourly' });
  assert.equal(e.start, null);
  assert.equal(e.repeat, 'none');
});
