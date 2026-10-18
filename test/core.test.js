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
    title: 'Встреча с Аней', date: '2026-10-18', start: '15:00', end: '16:00', repeat: 'none', allDay: false, tag: null, priority: 0, matched: true, endDate: null, spanDays: 0,
    every: null, window: null, times: null, count: 0, inMinutes: 0, before: null, nag: false, remindWord: false, mention: null, range: false,
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

test('быстрое добавление: задачи со сроком и важностью', () => {
  const r = parse('сдать отчёт до пятницы 18:00 #работа !');
  assert.equal(r.title, 'Сдать отчёт');
  assert.equal(r.date, '2026-10-23');
  assert.equal(r.start, '18:00');
  assert.equal(r.priority, 1);
  assert.equal(parse('купить подарок до 25.10').date, '2026-10-25');
  assert.equal(parse('купить подарок до 25.10').title, 'Купить подарок');
  assert.equal(parse('позвонить маме до 18').start, '18:00');
  const cv = parse('отправить резюме до 25.10');
  assert.equal(cv.date, '2026-10-25');
  assert.equal(cv.start, null);
  assert.equal(parse('эссе до 20.11 до 23:59').start, '23:59');
  assert.equal(parse('встреча в 15.30').start, '15:30');
  assert.equal(parse('оплатить счёт важно').priority, 1);
  const slides = parse('к понедельнику подготовить слайды');
  assert.equal(slides.date, '2026-10-19');
  assert.equal(slides.title, 'Подготовить слайды');
  assert.equal(parse('просто дело').priority, 0);
});

test('срок задачи берётся из связанного события', () => {
  const ev = { id: 'e', date: '2026-10-20', start: '14:00', repeat: 'none' };
  assert.deepEqual(c.taskDeadline({ eventId: 'e', due: '2026-10-01' }, ev), { date: '2026-10-20', time: '14:00' });
  const weekly = { ...ev, repeat: 'weekly' };
  assert.deepEqual(c.taskDeadline({ eventId: 'e', eventKey: '2026-10-27' }, weekly), { date: '2026-10-27', time: '14:00' });
  // Событие удалено — остаётся сохранённый срок
  assert.deepEqual(c.taskDeadline({ eventId: 'e', due: '2026-10-01', time: '09:00' }, undefined), { date: '2026-10-01', time: '09:00' });
  assert.equal(c.taskDeadline({ due: null }, undefined), null);
});

test('нормализация задачи', () => {
  assert.equal(c.normalizeTask({ title: 'x' }), null);
  const t = c.normalizeTask({ id: 1, title: 'x', due: 'вчера', time: '10:00', done: 1, doneAt: 5, priority: 'yes' });
  assert.equal(t.due, null);
  assert.equal(t.time, null);
  assert.equal(t.done, true);
  assert.equal(t.doneAt, 5);
  assert.equal(t.priority, 1);
});

test('быстрое добавление: события на несколько дней', () => {
  const range = (text, base = BASE) => {
    const r = c.parseQuick(text, base);
    return [r.title, r.date && c.toKey(r.date), r.endDate && c.toKey(r.endDate), r.start];
  };
  assert.deepEqual(range('с пятницы до воскресенья дача'), ['Дача', '2026-10-23', '2026-10-25', null]);
  assert.deepEqual(range('с пт по вс дача'), ['Дача', '2026-10-23', '2026-10-25', null]);
  assert.deepEqual(range('со среды по пятницу командировка'), ['Командировка', '2026-10-21', '2026-10-23', null]);
  assert.deepEqual(range('с 20 по 25 октября отпуск'), ['Отпуск', '2026-10-20', '2026-10-25', null]);
  assert.deepEqual(range('с 28 октября по 3 ноября поездка'), ['Поездка', '2026-10-28', '2026-11-03', null]);
  assert.deepEqual(range('с 28 декабря по 3 января каникулы'), ['Каникулы', '2026-12-28', '2027-01-03', null]);
  assert.deepEqual(range('с 20.10 по 25.10 сессия'), ['Сессия', '2026-10-20', '2026-10-25', null]);
  // «с 10 до 15 октября» — это даты, а не время 10:00–15:00
  assert.deepEqual(range('с 20 до 22 октября выставка'), ['Выставка', '2026-10-20', '2026-10-22', null]);
  assert.equal(range('с 10 до 12 встреча')[3], '10:00');

  const wed = new Date(2026, 9, 21); // среда
  assert.deepEqual(range('на выходных шашлыки', wed), ['Шашлыки', '2026-10-24', '2026-10-25', null]);
  assert.deepEqual(range('на следующих выходных поход', wed), ['Поход', '2026-10-31', '2026-11-01', null]);
  assert.deepEqual(range('всю неделю отпуск', wed), ['Отпуск', '2026-10-21', '2026-10-25', null]);
  assert.deepEqual(range('всю следующую неделю отпуск', wed), ['Отпуск', '2026-10-26', '2026-11-01', null]);
  // Повторы не путаются с концом периода
  assert.equal(c.parseQuick('по пятницам спортзал', wed).repeat, 'weekly');

  const conf = c.parseQuick('конференция на 3 дня с 5 ноября', BASE);
  assert.equal(conf.title, 'Конференция');
  assert.equal(conf.spanDays, 3);
  assert.equal(c.toKey(c.parseQuick('отчёт до конца недели', wed).endDate), '2026-10-25');
  assert.equal(c.toKey(c.parseQuick('курсовая до конца месяца', wed).endDate), '2026-10-31');
});

test('многодневные события в календаре', () => {
  const trip = { id: 'v', title: 'Дача', date: '2026-10-23', endDate: '2026-10-25', repeat: 'none' };
  const map = c.collect([trip], new Date(2026, 9, 24), new Date(2026, 9, 26));
  assert.deepEqual(map.get('2026-10-24').map((o) => [o.key, o.index, o.len]), [['2026-10-23', 1, 3]]);
  assert.deepEqual(map.get('2026-10-25').map((o) => o.index), [2]);
  assert.equal(map.get('2026-10-26').length, 0);
  assert.equal(c.spanDays(trip), 3);

  // Каждые выходные: пятница–воскресенье повторяется еженедельно
  const weekly = { ...trip, repeat: 'weekly', exdates: ['2026-10-30'] };
  const m2 = c.collect([weekly], new Date(2026, 9, 26), new Date(2026, 10, 8));
  const days = [...m2].filter(([, l]) => l.length).map(([k]) => k);
  assert.deepEqual(days, ['2026-11-06', '2026-11-07', '2026-11-08']);

  // .ics: конец «на весь день» — следующий день, и обратно
  const ev = c.normalizeEvent(trip);
  assert.match(c.toICS([ev]), /DTEND;VALUE=DATE:20261026/);
  const [back] = c.fromICS(c.toICS([ev]), () => 'x');
  assert.equal(back.endDate, '2026-10-25');
  assert.equal(c.normalizeEvent({ ...trip, endDate: '2026-10-01' }).endDate, null);
});

test('быстрое добавление: задача к событию через @ и «когда делаю»', () => {
  const r = parse('сделать проект в четверг с 19 до 23 @защита');
  assert.equal(r.title, 'Сделать проект');
  assert.equal(r.mention, 'защита');
  assert.equal(r.date, '2026-10-22');
  assert.deepEqual([r.start, r.end, r.range], ['19:00', '23:00', true]);
  assert.equal(parse('слайды завтра в 18 @теория_финансов').mention, 'теория_финансов');
  assert.equal(parse('слайды завтра в 18').range, false);
  assert.equal(parse('подарок #личное @др_мамы').tag, 'личное');
  assert.deepEqual(c.normalizePlan({ date: '2026-10-22', start: '19:00', end: '23:00' }), { date: '2026-10-22', start: '19:00', end: '23:00' });
  assert.deepEqual(c.normalizePlan({ date: '2026-10-22', start: '19:00', end: '18:00' }), { date: '2026-10-22', start: '19:00', end: null });
  assert.equal(c.normalizePlan({ date: 'потом' }), null);
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
