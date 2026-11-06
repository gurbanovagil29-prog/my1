'use strict';

/*
 * Погода. Без DOM: тот же код работает в календаре, в серверной функции remind
 * (вечернее предупреждение «завтра похолодает», строка в утренней сводке, /weather у бота) и в тестах.
 *
 * Прогноз — Open-Meteo (бесплатно, без ключа): по часам на 16 дней. Внутри календаря он хранится так:
 * { tz, at, days: { 'YYYY-MM-DD': день }, hours: { 'YYYY-MM-DD': [час × 24] } }
 *   день: { code, tmax, tmin, fmax, fmin, pr, pop, snow, gust, uv }
 *   час:  { h, t, f, pop, pr, snow, code, wind, gust, uv, day }
 * t — температура, f — ощущается как, pop — вероятность осадков (%), pr — осадки (мм), snow — снег (см),
 * wind/gust — ветер и порывы (м/с), uv — УФ-индекс, day — светло ли.
 */

const WX_API = 'https://api.open-meteo.com/v1/forecast';
const WX_PREV_API = 'https://previous-runs-api.open-meteo.com/v1/forecast';
const WX_HOURLY = ['temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'snowfall', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'uv_index', 'is_day'];
const WX_DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min', 'precipitation_sum', 'precipitation_probability_max', 'snowfall_sum', 'wind_gusts_10m_max', 'uv_index_max'];

// Коды погоды WMO: [вид, описание, значок днём, значок ночью]
const WX_CODES = {
  0: ['clear', 'Ясно', '☀️', '🌙'], 1: ['clear', 'Почти ясно', '🌤', '🌙'], 2: ['partly', 'Переменная облачность', '⛅', '☁️'], 3: ['cloudy', 'Пасмурно', '☁️', '☁️'],
  45: ['fog', 'Туман', '🌫', '🌫'], 48: ['fog', 'Туман с изморозью', '🌫', '🌫'],
  51: ['drizzle', 'Морось', '🌦', '🌧'], 53: ['drizzle', 'Морось', '🌦', '🌧'], 55: ['drizzle', 'Сильная морось', '🌧', '🌧'],
  56: ['ice', 'Ледяная морось', '🌧', '🌧'], 57: ['ice', 'Ледяная морось', '🌧', '🌧'],
  61: ['rain', 'Небольшой дождь', '🌦', '🌧'], 63: ['rain', 'Дождь', '🌧', '🌧'], 65: ['rain', 'Сильный дождь', '🌧', '🌧'],
  66: ['ice', 'Ледяной дождь', '🌧', '🌧'], 67: ['ice', 'Сильный ледяной дождь', '🌧', '🌧'],
  71: ['snow', 'Небольшой снег', '🌨', '🌨'], 73: ['snow', 'Снег', '🌨', '🌨'], 75: ['snow', 'Сильный снег', '❄️', '❄️'], 77: ['snow', 'Снежная крупа', '🌨', '🌨'],
  80: ['rain', 'Ливень', '🌦', '🌧'], 81: ['rain', 'Ливень', '🌧', '🌧'], 82: ['rain', 'Сильный ливень', '⛈', '⛈'],
  85: ['snow', 'Снегопад', '🌨', '🌨'], 86: ['snow', 'Сильный снегопад', '❄️', '❄️'],
  95: ['storm', 'Гроза', '⛈', '⛈'], 96: ['storm', 'Гроза с градом', '⛈', '⛈'], 99: ['storm', 'Гроза с сильным градом', '⛈', '⛈'],
};
const wxInfo = (code) => WX_CODES[code] || WX_CODES[Math.floor(code / 10) * 10] || ['cloudy', 'Облачно', '☁️', '☁️'];
const wxKind = (code) => wxInfo(code)[0];
const wxIcon = (code, day = true) => wxInfo(code)[day ? 2 : 3];
const wxLabel = (code) => wxInfo(code)[1];

/** «+5°», «−3°», «0°». */
function fmtTemp(t) {
  const n = Math.round(t);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}°`;
}
/** «+4…+11°», а если почти не меняется — «+4°». */
function fmtRange(a, b) {
  const lo = Math.round(Math.min(a, b));
  const hi = Math.round(Math.max(a, b));
  return lo === hi ? fmtTemp(lo) : `${fmtTemp(lo).slice(0, -1)}…${fmtTemp(hi)}`;
}

const wxRound = (x, d = 1) => (x == null || Number.isNaN(+x) ? null : Math.round(+x * 10 ** d) / 10 ** d);

/** Адрес прогноза: по часам на 16 дней, время — по часам пользователя (как события в календаре). */
function weatherUrl(lat, lon, tz, days = 16) {
  const p = new URLSearchParams({
    latitude: String(wxRound(lat, 2)), longitude: String(wxRound(lon, 2)),
    hourly: WX_HOURLY.join(','), daily: WX_DAILY.join(','),
    timezone: tz || 'auto', forecast_days: String(days), wind_speed_unit: 'ms',
  });
  return `${WX_API}?${p}`;
}

/** Прошлый месяц: что обещали за день до и как было на самом деле — для «точности прогноза». */
function weatherAccuracyUrl(lat, lon, tz, days = 30) {
  const p = new URLSearchParams({
    latitude: String(wxRound(lat, 2)), longitude: String(wxRound(lon, 2)),
    hourly: 'temperature_2m,temperature_2m_previous_day1,precipitation,precipitation_previous_day1',
    timezone: tz || 'auto', past_days: String(days), forecast_days: '1',
  });
  return `${WX_PREV_API}?${p}`;
}

/** Ответ Open-Meteo → прогноз календаря (см. описание вверху). */
function parseForecast(json, at = Date.now()) {
  const fc = { tz: json.timezone || null, at, days: {}, hours: {} };
  const d = json.daily || {};
  (d.time || []).forEach((key, i) => {
    fc.days[key] = {
      code: d.weather_code?.[i] ?? 3,
      tmax: wxRound(d.temperature_2m_max?.[i]), tmin: wxRound(d.temperature_2m_min?.[i]),
      fmax: wxRound(d.apparent_temperature_max?.[i]), fmin: wxRound(d.apparent_temperature_min?.[i]),
      pr: wxRound(d.precipitation_sum?.[i]) || 0, pop: d.precipitation_probability_max?.[i] ?? 0,
      snow: wxRound(d.snowfall_sum?.[i]) || 0, gust: wxRound(d.wind_gusts_10m_max?.[i]) || 0, uv: wxRound(d.uv_index_max?.[i]) || 0,
    };
  });
  const hr = json.hourly || {};
  (hr.time || []).forEach((time, i) => {
    const t = hr.temperature_2m?.[i];
    if (t == null) return; // на краю прогноза часы бывают пустыми
    const key = time.slice(0, 10);
    (fc.hours[key] ||= []).push({
      h: +time.slice(11, 13), t: wxRound(t), f: wxRound(hr.apparent_temperature?.[i] ?? t),
      pop: hr.precipitation_probability?.[i] ?? 0, pr: wxRound(hr.precipitation?.[i]) || 0, snow: wxRound(hr.snowfall?.[i]) || 0,
      code: hr.weather_code?.[i] ?? 3, wind: wxRound(hr.wind_speed_10m?.[i]) || 0, gust: wxRound(hr.wind_gusts_10m?.[i]) || 0,
      uv: wxRound(hr.uv_index?.[i]) || 0, day: hr.is_day ? Boolean(hr.is_day[i]) : true,
    });
  });
  return fc;
}

/** Часть прогноза на несколько дней с fromKey — в настройки аккаунта, на случай если сервер не достучится до Open-Meteo. */
function compactForecast(fc, fromKey, n = 3) {
  const keys = Object.keys(fc.days).filter((k) => k >= fromKey).sort().slice(0, n);
  return { tz: fc.tz, at: fc.at, days: Object.fromEntries(keys.map((k) => [k, fc.days[k]])), hours: Object.fromEntries(keys.filter((k) => fc.hours[k]).map((k) => [k, fc.hours[k]])) };
}

/** Расстояние между точками, км. */
function geoDistance(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ---------- Цвет и значок дня (месяц, неделя) ---------- */

/** Цвет дня по температуре: синий в мороз → серый → жёлтый → оранжевый в жару. */
function tempColor(t) {
  if (t <= -10) return '#3f6fd8';
  if (t <= -3) return '#5b8def';
  if (t <= 2) return '#7fb3ff';
  if (t <= 8) return '#9aa7b8';
  if (t <= 15) return '#d9b44a';
  if (t <= 23) return '#f0a03c';
  return '#e8603c';
}

/** Значок дня: осадки важнее облаков — если днём ждут дождь, показываем дождь. */
function dayIcon(day) {
  if (!day) return '';
  const kind = wxKind(day.code);
  if (kind === 'storm') return '⛈';
  if (day.snow >= 0.5 || kind === 'snow') return day.snow >= 5 ? '❄️' : '🌨';
  if (kind === 'ice') return '🌧';
  if (day.pr >= 1 && day.pop >= 40) return day.pr >= 5 ? '🌧' : '🌦';
  return wxIcon(day.code);
}

/* ---------- Погода на день ---------- */

const WX_PHASES = [['Утро', 6, 11], ['День', 12, 16], ['Вечер', 17, 22]];

/** Как ощущается: слово для температуры. */
function feelWord(e) {
  if (e >= 28) return 'жарко';
  if (e >= 21) return 'тепло';
  if (e >= 15) return 'комфортно';
  if (e >= 7) return 'прохладно';
  if (e >= 0) return 'холодно';
  if (e >= -10) return 'мороз';
  return 'сильный мороз';
}

/** Часы подряд, когда выполняется условие: «14–17», «в 9». */
function hourRanges(hours, test) {
  const out = [];
  for (const x of hours) {
    const last = out[out.length - 1];
    if (!test(x)) continue;
    if (last && last[1] === x.h) last[1] = x.h + 1;
    else out.push([x.h, x.h + 1]);
  }
  return out;
}
const rangesText = (rs) => rs.map(([a, b]) => (b - a <= 1 ? `в ${a}` : `${a}–${b}`)).join(', ');

const isRainHour = (x) => wxKind(x.code) !== 'snow' && x.snow < 0.1 && (x.pr >= 0.3 || x.pop >= 50 || (['rain', 'drizzle', 'ice', 'storm'].includes(wxKind(x.code)) && x.pop >= 30));
const isSnowHour = (x) => x.snow >= 0.1 || (wxKind(x.code) === 'snow' && x.pop >= 30);

/**
 * Погода на день key: температура, осадки по часам, утро/день/вечер, предупреждения и погода к делам дня.
 * opts: { events — дела дня [{ title, start }], nowHour — для сегодняшнего дня берём только оставшиеся часы }.
 * Возвращает null, если прогноза на этот день нет.
 */
function dayWeather(fc, key, { events = [], nowHour = null } = {}) {
  const day = fc?.days?.[key];
  if (!day) return null;
  const all = fc.hours?.[key] || [];
  const from = nowHour == null ? 6 : Math.min(nowHour, 23);
  const hs = all.filter((x) => x.h >= from);
  const gust = hs.length ? Math.max(...hs.map((x) => x.gust)) : day.gust;
  const wind = hs.length ? Math.max(...hs.map((x) => x.wind)) : day.gust * 0.6;
  const uv = hs.length ? Math.max(...hs.map((x) => x.uv)) : day.uv;
  const rain = hs.length ? hourRanges(hs, isRainHour) : (day.pr >= 1 && day.pop >= 50 ? [[from, 24]] : []);
  const snow = hs.length ? hourRanges(hs, isSnowHour) : (day.snow >= 0.5 ? [[from, 24]] : []);
  const storm = hourRanges(hs, (x) => wxKind(x.code) === 'storm');
  const maybeRain = !rain.length && (hs.length ? hs.some((x) => x.pop >= 30 && x.snow < 0.1) : day.pop >= 40);
  const rainPop = Math.max(0, ...hs.filter(isRainHour).map((x) => x.pop));
  // Гололёд: около нуля после осадков или ледяной дождь
  const ice = hs.some((x) => wxKind(x.code) === 'ice') || (day.tmin <= 0.5 && day.tmax >= -3 && (day.pr >= 0.5 || rain.length > 0 || snow.length > 0));
  const windy = gust >= 12 || wind >= 8;

  const phases = WX_PHASES.map(([label, a, b]) => {
    const xs = all.filter((x) => x.h >= a && x.h <= b && x.h >= from - 1);
    if (!xs.length) return null;
    const f = xs.reduce((sum, x) => sum + x.f, 0) / xs.length;
    const r = xs.some(isRainHour) ? '🌧' : xs.some(isSnowHour) ? '🌨' : '';
    return { label, temp: f, word: feelWord(f), icon: r };
  }).filter(Boolean);

  const notes = [];
  if (rain.length) notes.push(`🌧 дождь ${rangesText(rain)}${rainPop ? ` (${rainPop}%)` : ''}`);
  else if (maybeRain) notes.push('🌦 возможен дождь');
  if (snow.length) notes.push(`🌨 снег ${rangesText(snow)}`);
  if (windy) notes.push(`💨 ветер до ${Math.round(Math.max(wind, gust * 0.7))} м/с`);
  if (uv >= 6) notes.push(`☀️ УФ ${Math.round(uv)}`);

  const alerts = [];
  if (storm.length) alerts.push(`⛈ Гроза ${rangesText(storm)}`);
  if (ice) alerts.push('🧊 Возможен гололёд');
  if (gust >= 15) alerts.push(`💨 Сильный ветер, порывы до ${Math.round(gust)} м/с`);
  if (day.tmax >= 30) alerts.push(`🔥 Жара до ${fmtTemp(day.tmax)}`);
  if (day.tmin <= -20) alerts.push(`🥶 Сильный мороз до ${fmtTemp(day.tmin)}`);

  // Погода к делам дня: дождь в это время, гроза, заметно холоднее или теплее, чем днём
  const mid = (day.fmin + day.fmax) / 2;
  const evNotes = events.filter((e) => e.start).map((e) => {
    const hh = +e.start.slice(0, 2);
    if (nowHour != null && hh < nowHour) return null;
    const x = all.find((y) => y.h === hh);
    if (!x) return null;
    const n = [];
    if (isRainHour(x)) n.push(`дождь (${x.pop}%)`);
    else if (isSnowHour(x)) n.push('снег');
    if (wxKind(x.code) === 'storm') n.push('гроза');
    if (x.f <= mid - 4) n.push('холоднее, чем днём');
    else if (x.f >= mid + 4) n.push('теплее, чем днём');
    if (x.gust >= 12) n.push('сильный ветер');
    return { time: e.start, title: e.title, temp: x.t, icon: isRainHour(x) ? '🌧' : wxIcon(x.code, x.day), note: n.join(', ') };
  }).filter(Boolean).sort((p, q) => p.time.localeCompare(q.time));

  return {
    key,
    icon: dayIcon(day), text: wxLabel(day.code),
    temp: [day.tmin, day.tmax], feels: [day.fmin, day.fmax],
    summary: `${fmtRange(day.tmin, day.tmax)}, ощущается ${fmtRange(day.fmin, day.fmax)}`,
    notes, phases, alerts, events: evNotes,
    rain: rain.length > 0, snow: snow.length > 0,
  };
}

/* ---------- Завтра заметно отличается? ---------- */

/**
 * Чем завтра заметно отличается от сегодня: разница от 5°, начинаются дождь, снег или гроза, сильный ветер, гололёд.
 * Возвращает список причин (пустой — «как сегодня», не беспокоим).
 */
function weatherChange(today, tomorrow) {
  if (!today || !tomorrow) return [];
  const out = [];
  const dMax = Math.round(tomorrow.fmax - today.fmax);
  const dMin = Math.round(tomorrow.fmin - today.fmin);
  const d = Math.abs(dMax) >= Math.abs(dMin) ? dMax : dMin;
  if (Math.abs(d) >= 5) out.push(d < 0 ? `похолодает на ${-d}°` : `потеплеет на ${d}°`);
  const kindT = wxKind(tomorrow.code);
  const rainy = (x) => (x.pr >= 1.5 && x.pop >= 50) || (['rain', 'drizzle', 'ice'].includes(wxKind(x.code)) && x.pop >= 60);
  if (kindT === 'storm' && wxKind(today.code) !== 'storm') out.push('гроза');
  else if (tomorrow.snow >= 0.5 && today.snow < 0.5) out.push('снег');
  else if (rainy(tomorrow) && !rainy(today)) out.push('дождь');
  if (tomorrow.gust >= 15 && today.gust < 12) out.push('сильный ветер');
  if (tomorrow.tmin <= 0 && today.tmin > 0) out.push('заморозки');
  return out;
}

/**
 * Точность прогноза за прошлые дни (ответ Previous Runs API): насколько ошибался прогноз «на завтра»
 * по дневному максимуму и угадал ли он, будет ли дождь (от 1 мм за день). todayKey — сегодняшний день не считаем.
 */
function forecastAccuracy(json, todayKey) {
  const hr = json?.hourly || {};
  const byDay = new Map();
  (hr.time || []).forEach((time, i) => {
    const key = time.slice(0, 10);
    if (key >= todayKey) return;
    const d = byDay.get(key) || { t: [], tp: [], pr: 0, prp: 0, n: 0 };
    const t = hr.temperature_2m?.[i];
    const tp = hr.temperature_2m_previous_day1?.[i];
    if (t != null && tp != null) { d.t.push(t); d.tp.push(tp); }
    d.pr += hr.precipitation?.[i] || 0;
    d.prp += hr.precipitation_previous_day1?.[i] || 0;
    byDay.set(key, d);
  });
  const days = [...byDay.values()].filter((d) => d.t.length >= 20);
  if (!days.length) return null;
  const err = days.reduce((s, d) => s + Math.abs(Math.max(...d.t) - Math.max(...d.tp)), 0) / days.length;
  const hits = days.filter((d) => (d.pr >= 1) === (d.prp >= 1)).length;
  return { days: days.length, tempErr: Math.round(err * 10) / 10, rainHit: Math.round((hits / days.length) * 100), rainDays: days.filter((d) => d.pr >= 1).length };
}

/* ---------- Тексты для push, Telegram и сводки ---------- */

/** Строка для утренней сводки: «🌦 +4…+11°, дождь 14–17». */
function weatherLine(w) {
  if (!w) return '';
  const extra = w.notes.filter((n) => /дождь|снег/.test(n)).map((n) => n.replace(/^\S+ /, ''));
  return `${w.icon} ${fmtRange(w.temp[0], w.temp[1])}${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

/** Погода на день строками (Telegram). */
function weatherLines(w) {
  if (!w) return [];
  return [
    `${w.icon} ${w.summary}${w.notes.length ? ` · ${w.notes.join(' · ')}` : ''}`,
    w.phases.length > 1 ? w.phases.map((p) => `${p.label}: ${fmtTemp(p.temp)}${p.icon ? ` ${p.icon}` : ''}`).join(' → ') : '',
    ...w.alerts,
    ...w.events.filter((e) => e.note).map((e) => `📅 ${e.time} ${e.title} — ${fmtTemp(e.temp)}, ${e.note}`),
  ].filter(Boolean);
}

if (typeof module !== 'undefined') {
  module.exports = {
    wxKind, wxIcon, wxLabel, fmtTemp, fmtRange, weatherUrl, weatherAccuracyUrl, parseForecast, compactForecast,
    geoDistance, tempColor, dayIcon, feelWord, dayWeather, weatherChange, forecastAccuracy, weatherLine, weatherLines,
  };
}
