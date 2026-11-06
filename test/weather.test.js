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

test('погода на день: дождь по часам, утро/день/вечер, погода к делам; сегодня — только оставшиеся часы', () => {
  const w = W.dayWeather(fc, '2026-10-26', { events: [{ title: 'Работа', start: '09:00' }, { title: 'Спортзал', start: '15:00' }] });
  assert.equal(w.summary, '+2…+11°, ощущается 0…+9°');
  assert.ok(w.notes.includes('🌧 дождь 14–17 (80%)'));
  assert.deepEqual(w.phases.map((p) => p.label), ['Утро', 'День', 'Вечер']);
  assert.equal(w.phases[1].icon, '🌧');
  const gym = w.events.find((e) => e.title === 'Спортзал');
  assert.match(gym.note, /дождь \(80%\)/);
  assert.deepEqual(w.events.map((e) => e.time), ['09:00', '15:00']);
  assert.equal(W.weatherLine(w), '🌦 +2…+11°, дождь 14–17 (80%)');
  assert.ok(W.weatherLines(w).some((l) => /^📅 15:00 Спортзал/.test(l)));
  // Ни слова об одежде
  assert.equal(JSON.stringify(w).match(/куртк|свитер|зонт|обувь|надеть/), null);
  const evening = W.dayWeather(fc, '2026-10-26', { nowHour: 18 });
  assert.equal(evening.rain, false);
  assert.deepEqual(evening.phases.map((p) => p.label), ['Вечер']);
  assert.equal(W.dayWeather(fc, '2026-11-30'), null);
});

test('погода на день: предупреждения — ветер, жара с солнцем, снег и гололёд', () => {
  const cold = W.dayWeather(fc, '2026-10-27');
  assert.ok(cold.alerts.some((x) => /Сильный ветер, порывы до 16/.test(x)));
  assert.ok(cold.notes.some((x) => /ветер/.test(x)));
  const hot = W.dayWeather(fc, '2026-10-28');
  assert.ok(hot.notes.includes('☀️ УФ 8'));
  const snow = W.dayWeather(fc, '2026-10-29');
  assert.ok(snow.snow);
  assert.ok(snow.alerts.includes('🧊 Возможен гололёд'));
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
