'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../weather.js');

const { openMeteo } = require('./wx-fixture.js');

const fc = W.parseForecast(openMeteo([
  { key: '2026-10-26', t: [2, 11], rain: [14, 17] },
  { key: '2026-10-27', t: [-4, 2], wind: 9, gust: 16 },
  { key: '2026-10-28', t: [18, 29], code: 0, uv: 8 },
  { key: '2026-10-29', t: [-3, 1], rain: [8, 12], snow: true },
]), 1000);

test('прогноз: дни и часы, значки и цвет дня', () => {
  assert.deepEqual(Object.keys(fc.days), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']);
  assert.equal(fc.hours['2026-10-26'].length, 24);
  assert.equal(fc.days['2026-10-26'].tmax, 11);
  assert.equal(W.dayIcon(fc.days['2026-10-26']), '🌦');
  assert.equal(W.dayIcon(fc.days['2026-10-29']), '❄️');
  assert.equal(W.dayIcon(fc.days['2026-10-28']), '☀️');
  assert.equal(W.tempColor(-12), '#3f6fd8');
  assert.equal(W.tempColor(30), '#e8603c');
  assert.equal(W.fmtRange(2.2, 10.7), '+2…+11°');
  assert.equal(W.fmtRange(-4, -4.3), '−4°');
  assert.equal(W.fmtTemp(0.2), '0°');
  const url = W.weatherUrl(40.4093, 49.8671, 'Asia/Baku');
  assert.match(url, /latitude=40\.41&longitude=49\.87/);
  assert.match(url, /timezone=Asia%2FBaku/);
  assert.match(url, /forecast_days=16/);
});

test('совет: прохладный день с дождём — куртка, худи, зонт, обувь для луж, погода к делам', () => {
  const a = W.clothingAdvice(fc, '2026-10-26', { events: [{ title: 'Работа', start: '09:00', end: '18:00' }, { title: 'Спортзал', start: '15:00', end: '16:00' }] });
  assert.deepEqual([a.from, a.to], [8, 19]);
  assert.equal(a.summary, '+5…+11°, ощущается +3…+9°');
  assert.ok(a.notes.includes('🌧 дождь 14–17'));
  const layer = (label) => a.layers.find((l) => l.label === label)?.text;
  assert.equal(layer('Верхняя'), 'непромокаемая демисезонная куртка');
  assert.match(layer('Утеплитель'), /тёплый свитер|худи/);
  assert.match(layer('Обувь'), /непромокаемая/);
  assert.ok(a.carry.some((c) => /зонт — дождь 14–17 \(80%\)/.test(c)));
  const gym = a.events.find((e) => e.title === 'Спортзал');
  assert.match(gym.note, /попадает на дождь/);
  assert.match(a.short, /куртка/);
  assert.match(a.short, /зонт/);
  assert.match(W.weatherLine(a), /^🌦 \+5…\+11°, дождь 14–17 · /);
  assert.ok(W.adviceLines(a).some((l) => /^🧥 Верхняя: /.test(l)));
});

test('совет: мороз с ветром, жара с солнцем, снег — и сдвиг «я мёрзну»', () => {
  const cold = W.clothingAdvice(fc, '2026-10-27');
  const layer = (a, label) => a.layers.find((l) => l.label === label)?.text;
  assert.match(layer(cold, 'Верхняя'), /зимняя куртка или пуховик/);
  assert.match(layer(cold, 'Аксессуары'), /шапка, шарф и перчатки/);
  assert.ok(cold.alerts.some((x) => /Сильный ветер/.test(x)));
  const hot = W.clothingAdvice(fc, '2026-10-28');
  assert.equal(layer(hot, 'Верхняя'), 'не нужна');
  assert.match(layer(hot, 'Низ'), /шорты/);
  assert.ok(hot.carry.some((c) => /крем/.test(c)));
  assert.ok(hot.carry.some((c) => /вода/.test(c)));
  const snow = W.clothingAdvice(fc, '2026-10-29');
  assert.ok(snow.snow);
  assert.match(layer(snow, 'Обувь'), /зимняя/);
  // «Мёрзну» — тот же день советует теплее
  const mild = W.clothingAdvice(fc, '2026-10-26');
  const chilly = W.clothingAdvice(fc, '2026-10-26', { offset: -6 });
  assert.notEqual(layer(mild, 'Верхняя'), layer(chilly, 'Верхняя'));
  assert.match(layer(chilly, 'Верхняя'), /тёплая/);
  // Сегодня после обеда — только оставшиеся часы
  const evening = W.clothingAdvice(fc, '2026-10-26', { nowHour: 18 });
  assert.equal(evening.from, 18);
  assert.equal(W.clothingAdvice(fc, '2026-11-30'), null);
});

test('окно «на улице»: по делам дня, без дел — с 8 до 21', () => {
  assert.deepEqual(W.outdoorWindow([]), [8, 21]);
  assert.deepEqual(W.outdoorWindow([{ start: '19:00', end: '20:00' }]), [18, 21]);
  assert.deepEqual(W.outdoorWindow([{ start: '10:30', end: '11:00' }, { start: '13:00', end: '17:30' }]), [9, 19]);
  assert.deepEqual(W.outdoorWindow([{ start: '05:00', end: '23:30' }]), [6, 24]);
});

test('завтра заметно отличается: похолодание, снег, ветер; похожий день — молчим', () => {
  const d = fc.days;
  assert.deepEqual(W.weatherChange(d['2026-10-26'], d['2026-10-27']), ['похолодает на 12°', 'сильный ветер', 'заморозки']);
  assert.deepEqual(W.weatherChange(d['2026-10-27'], d['2026-10-28']), ['потеплеет на 30°']);
  assert.ok(W.weatherChange(d['2026-10-26'], d['2026-10-29']).includes('снег'));
  const same = { ...d['2026-10-26'], fmax: d['2026-10-26'].fmax + 2 };
  assert.deepEqual(W.weatherChange(d['2026-10-26'], same), []);
  const dry = { ...d['2026-10-26'], pr: 0, pop: 5, code: 1 };
  assert.deepEqual(W.weatherChange(dry, d['2026-10-26']), ['дождь']);
});

test('ответы «Как было по одежде?»: поправка, повторный ответ за день, «не был на улице», статистика', () => {
  let p = { wx_feel: 'cold', wx_adjust: 0, wx_log: [] };
  assert.equal(W.wxOffset(p), -3);
  p = { ...p, ...W.applyWeatherFeedback(p, '2026-10-20', 'cold') };
  assert.equal(p.wx_adjust, -1);
  p = { ...p, ...W.applyWeatherFeedback(p, '2026-10-20', 'ok') }; // передумал — поправка отменяется
  assert.equal(p.wx_adjust, 0);
  p = { ...p, ...W.applyWeatherFeedback(p, '2026-10-21', 'hot') };
  p = { ...p, ...W.applyWeatherFeedback(p, '2026-10-22', 'in') };
  assert.equal(p.wx_adjust, 1);
  assert.equal(W.wxOffset(p), -2);
  assert.deepEqual(p.wx_log.map((x) => x.a), ['ok', 'hot', 'in']);
  for (let i = 0; i < 10; i++) p = { ...p, ...W.applyWeatherFeedback(p, `2026-09-${10 + i}`, 'hot') };
  assert.equal(p.wx_adjust, 6);
  assert.equal(W.applyWeatherFeedback(p, '2026-10-23', 'nope'), null);
  const s = W.feedbackStats(p.wx_log, '2026-10-22', 30);
  assert.deepEqual([s.ok, s.hot, s.in, s.total], [1, 1, 1, 2]);
});

test('точность прогноза: ошибка по максимуму и угаданные дни с дождём', () => {
  const hourly = { time: [], temperature_2m: [], temperature_2m_previous_day1: [], precipitation: [], precipitation_previous_day1: [] };
  const push = (key, max, maxPrev, pr, prPrev) => {
    for (let h = 0; h < 24; h++) {
      hourly.time.push(`${key}T${String(h).padStart(2, '0')}:00`);
      hourly.temperature_2m.push(h === 14 ? max : max - 5);
      hourly.temperature_2m_previous_day1.push(h === 14 ? maxPrev : maxPrev - 5);
      hourly.precipitation.push(h === 10 ? pr : 0);
      hourly.precipitation_previous_day1.push(h === 10 ? prPrev : 0);
    }
  };
  push('2026-10-22', 10, 12, 3, 2); // ошибся на 2°, дождь угадал
  push('2026-10-23', 8, 8, 0, 4); // температура точно, обещал дождь — не было
  push('2026-10-24', 6, 5, 0, 0); // ошибся на 1°, сухо — угадал
  push('2026-10-25', 30, 0, 0, 0); // сегодня — не считается
  const a = W.forecastAccuracy({ hourly }, '2026-10-25');
  assert.deepEqual(a, { days: 3, tempErr: 1, rainHit: 67, rainDays: 1 });
  assert.equal(W.forecastAccuracy({}, '2026-10-25'), null);
});

test('сжатый прогноз для сервера и расстояние между точками', () => {
  const c = W.compactForecast(fc, '2026-10-27', 2);
  assert.deepEqual(Object.keys(c.days), ['2026-10-27', '2026-10-28']);
  assert.equal(c.hours['2026-10-28'].length, 24);
  const km = W.geoDistance({ lat: 55.75, lon: 37.62 }, { lat: 59.94, lon: 30.31 });
  assert.ok(km > 620 && km < 640);
});
