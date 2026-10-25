'use strict';

/*
 * Погода и «что надеть». Без DOM: тот же код работает в календаре, в серверной функции remind
 * (вечерний совет «на завтра», строка в утренней сводке, ответы боту) и в тестах.
 *
 * Прогноз — Open-Meteo (бесплатно, без ключа): по часам на 16 дней. Внутри календаря он хранится так:
 * { tz, at, days: { 'YYYY-MM-DD': день }, hours: { 'YYYY-MM-DD': [час × 24] } }
 *   день: { code, tmax, tmin, fmax, fmin, pr, pop, snow, gust, uv }
 *   час:  { h, t, f, pop, pr, snow, code, wind, gust, uv, day }
 * t — температура, f — ощущается как, pop — вероятность осадков (%), pr — осадки (мм), snow — снег (см),
 * wind/gust — ветер и порывы (м/с), uv — УФ-индекс, day — светло ли.
 *
 * Совет по одежде строится по ощущаемой температуре со сдвигом «под себя»: offset = «я обычно мёрзну / как все / мне жарко»
 * (−3 / 0 / +3) плюс поправка по вечерним ответам «Как было по одежде?» (холодно −1, жарко +1, не больше ±6).
 */

const WX_API = 'https://api.open-meteo.com/v1/forecast';
const WX_PREV_API = 'https://previous-runs-api.open-meteo.com/v1/forecast';
const WX_HOURLY = ['temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'snowfall', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'uv_index', 'is_day'];
const WX_DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min', 'precipitation_sum', 'precipitation_probability_max', 'snowfall_sum', 'wind_gusts_10m_max', 'uv_index_max'];
const WX_ADJUST_MAX = 6;
const WX_FEEL = { cold: -3, normal: 0, hot: 3 };
const WX_ANSWERS = { cold: -1, ok: 0, hot: 1, in: 0 };
const WX_ANSWER_TEXT = { cold: '🥶 холодно', ok: '👌 в самый раз', hot: '🥵 жарко', in: '🏠 не был(а) на улице' };

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

/* ---------- Совет «что надеть» ---------- */

const WX_PHASES = [['Утро', 6, 11], ['День', 12, 16], ['Вечер', 17, 22]];

/** Как ощущается: слово для температуры (уже со сдвигом «под себя»). */
function feelWord(e) {
  if (e >= 28) return 'жарко';
  if (e >= 21) return 'тепло';
  if (e >= 15) return 'комфортно';
  if (e >= 7) return 'прохладно';
  if (e >= 0) return 'холодно';
  if (e >= -10) return 'мороз';
  return 'сильный мороз';
}

/**
 * Когда вы на улице: от часа до первого дела дня до часа после последнего (не меньше трёх часов),
 * без дел — с 8 до 21. events — [{ start: 'HH:MM', end: 'HH:MM' }].
 */
function outdoorWindow(events = []) {
  const toM = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const timed = events.filter((e) => e.start);
  if (!timed.length) return [8, 21];
  const first = Math.min(...timed.map((e) => toM(e.start)));
  const last = Math.max(...timed.map((e) => (e.end && toM(e.end) > toM(e.start) ? toM(e.end) : toM(e.start) + 60)));
  const from = Math.min(21, Math.max(6, Math.floor(first / 60) - 1));
  return [from, Math.min(24, Math.max(from + 3, Math.ceil(last / 60) + 1))];
}

/** Часы подряд, когда выполняется условие: «14–17», «весь день». */
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
 * Совет на день key. opts: { offset — сдвиг «под себя» (°), events — дела дня [{ title, start, end }],
 * now — для сегодняшнего дня берём только оставшиеся часы, nowHour — текущий час (по часам пользователя) }.
 * Возвращает null, если прогноза на этот день нет.
 */
function clothingAdvice(fc, key, { offset = 0, events = [], nowHour = null } = {}) {
  const day = fc?.days?.[key];
  if (!day) return null;
  const all = fc.hours?.[key] || [];
  let [from, to] = outdoorWindow(events);
  if (nowHour != null) {
    // Сегодня: утро уже прошло — советуем на оставшуюся часть дня
    if (nowHour >= to - 1) [from, to] = [nowHour, Math.min(24, nowHour + 3)];
    else from = Math.max(from, nowHour);
  }
  let hs = all.filter((x) => x.h >= from && x.h < to);
  if (!hs.length) hs = all;
  // Нет почасового прогноза (дальние дни) — считаем по дневным цифрам
  const fmin = hs.length ? Math.min(...hs.map((x) => x.f)) : day.fmin;
  const fmax = hs.length ? Math.max(...hs.map((x) => x.f)) : day.fmax;
  const tmin = hs.length ? Math.min(...hs.map((x) => x.t)) : day.tmin;
  const tmax = hs.length ? Math.max(...hs.map((x) => x.t)) : day.tmax;
  const emin = fmin + offset;
  const emax = fmax + offset;
  const gust = hs.length ? Math.max(...hs.map((x) => x.gust)) : day.gust;
  const wind = hs.length ? Math.max(...hs.map((x) => x.wind)) : day.gust * 0.6;
  const uv = hs.length ? Math.max(...hs.map((x) => x.uv)) : day.uv;
  const rain = hs.length ? hourRanges(hs, isRainHour) : (day.pr >= 1 && day.pop >= 50 ? [[from, to]] : []);
  const snow = hs.length ? hourRanges(hs, isSnowHour) : (day.snow >= 0.5 ? [[from, to]] : []);
  const storm = hourRanges(hs, (x) => wxKind(x.code) === 'storm');
  const maybeRain = !rain.length && (hs.length ? hs.some((x) => x.pop >= 30 && x.snow < 0.1) : day.pop >= 40);
  const wet = rain.length > 0 || snow.length > 0;
  const rainPop = Math.max(0, ...hs.filter(isRainHour).map((x) => x.pop));
  // Гололёд: около нуля после осадков или ледяной дождь
  const ice = hs.some((x) => wxKind(x.code) === 'ice') || (tmin <= 0.5 && tmax >= -3 && (day.pr >= 0.5 || wet) && day.tmin < 0.5);
  const windy = gust >= 12 || wind >= 8;

  const phases = WX_PHASES.map(([label, a, b]) => {
    const xs = all.filter((x) => x.h >= a && x.h <= b && x.h >= from - 1 && x.h <= to);
    if (!xs.length) return null;
    const f = xs.reduce((s, x) => s + x.f, 0) / xs.length;
    const r = xs.some(isRainHour) ? '🌧' : xs.some(isSnowHour) ? '🌨' : '';
    return { label, temp: f, word: feelWord(f + offset), icon: r };
  }).filter(Boolean);

  const layers = [];
  const add = (icon, label, text) => layers.push({ icon, label, text });
  // Верх — по самому тёплому времени, утеплитель и куртка — по самому холодному
  if (emax >= 24) add('👕', 'Верх', 'футболка или майка из лёгкой ткани');
  else if (emax >= 17) add('👕', 'Верх', 'футболка');
  else if (emax >= 8) add('👕', 'Верх', 'лонгслив или футболка');
  else if (emin >= -5) add('👕', 'Верх', 'лонгслив или водолазка');
  else add('👕', 'Верх', 'термобельё и водолазка');

  const swing = emax - emin >= 7;
  if (emin >= 18) { /* утеплитель не нужен */ } else if (emin >= 13) add('🧶', 'Утеплитель', swing ? 'лёгкая кофта или рубашка — на утро и вечер' : 'лёгкая кофта или рубашка');
  else if (emin >= 7) add('🧶', 'Утеплитель', `худи или лёгкий свитер${swing ? ' — днём можно снять' : ''}`);
  else if (emin >= -2) add('🧶', 'Утеплитель', 'тёплый свитер или флиска');
  else add('🧶', 'Утеплитель', 'тёплый свитер, лучше шерстяной');

  let outer = null;
  if (emin >= 19) outer = wet ? 'не нужна — хватит зонта' : 'не нужна';
  else if (emin >= 14) outer = wet ? 'лёгкая непромокаемая ветровка' : windy ? 'ветровка' : 'не нужна, разве что лёгкая ветровка на вечер';
  else if (emin >= 9) outer = wet ? 'непромокаемая куртка или плащ' : windy ? 'ветровка или лёгкая куртка' : 'лёгкая куртка';
  else if (emin >= 3) outer = wet ? 'непромокаемая демисезонная куртка' : 'демисезонная куртка';
  else if (emin >= -5) outer = wet && !snow.length ? 'тёплая непромокаемая куртка' : 'тёплая куртка';
  else if (emin >= -15) outer = 'зимняя куртка или пуховик';
  else outer = 'тёплый пуховик подлиннее';
  if (windy && emin < 14 && !/ветровк/.test(outer)) outer += ', непродуваемая';
  add('🧥', 'Верхняя', outer);

  if (emax >= 24) add('👖', 'Низ', 'шорты, юбка или лёгкие брюки');
  else if (emax >= 18) add('👖', 'Низ', 'лёгкие брюки или джинсы');
  else if (emin >= 0) add('👖', 'Низ', 'джинсы или брюки');
  else if (emin >= -10) add('👖', 'Низ', 'плотные джинсы или брюки, в мороз — с термобельём');
  else add('👖', 'Низ', 'утеплённые брюки или термобельё под джинсы');

  if (snow.length || emin < -3) add('🥾', 'Обувь', ice ? 'зимняя, с нескользящей подошвой' : 'зимняя, тёплая');
  else if (wet) add('🥾', 'Обувь', 'закрытая и непромокаемая — не замшевая, будут лужи');
  else if (ice) add('🥾', 'Обувь', 'с нескользящей подошвой');
  else if (emax >= 24) add('👡', 'Обувь', 'лёгкая или открытая — можно сандалии');
  else add('👟', 'Обувь', emin < 8 ? 'закрытая, потеплее' : 'кроссовки или закрытая обувь');

  const acc = [];
  if (emin < -10) acc.push('тёплая шапка, шарф, варежки — прикройте лицо');
  else if (emin < 0) acc.push('шапка, шарф и перчатки');
  else if (emin < 5) acc.push(windy ? 'шапка — ветер холодный' : 'шапка не помешает');
  if (uv >= 6) acc.push('солнцезащитные очки и кепка');
  else if (emax >= 25 && !wet) acc.push('кепка или панама');
  if (windy && wet && emin >= 0) acc.push('капюшон — зонт может вывернуть');
  if (acc.length) add('🧣', 'Аксессуары', acc.join('; '));

  const carry = [];
  if (rain.length) carry.push(`☂️ зонт — дождь ${rangesText(rain)}${rainPop ? ` (${rainPop}%)` : ''}`);
  else if (maybeRain) carry.push('☂️ складной зонт — возможен дождь');
  if (swing && emin < 18) carry.push(`🎒 слой, который легко снять: утром и вечером на ${Math.round(emax - emin)}° холоднее`);
  if (uv >= 6) carry.push(`🧴 солнцезащитный крем — УФ до ${Math.round(uv)}`);
  if (emax >= 27) carry.push('💧 вода');

  const alerts = [];
  if (storm.length) alerts.push(`⛈ Гроза ${rangesText(storm)} — лучше переждать в помещении`);
  if (ice) alerts.push('🧊 Возможен гололёд — осторожно на ступеньках и тротуарах');
  if (gust >= 15) alerts.push(`💨 Сильный ветер, порывы до ${Math.round(gust)} м/с`);
  if (emax >= 30) alerts.push('🔥 Жара — пейте воду, в 12–16 лучше в тени');
  if (emin <= -20) alerts.push('🥶 Сильный мороз — не задерживайтесь на улице надолго');

  const notes = [];
  if (rain.length) notes.push(`🌧 дождь ${rangesText(rain)}`);
  else if (maybeRain) notes.push('🌦 возможен дождь');
  if (snow.length) notes.push(`🌨 снег ${rangesText(snow)}`);
  if (windy) notes.push(`💨 ветер до ${Math.round(Math.max(wind, gust * 0.7))} м/с`);
  if (uv >= 6) notes.push(`☀️ УФ ${Math.round(uv)}`);

  // Погода к делам дня: дождь в это время или заметно холоднее/теплее, чем днём
  const mid = (emin + emax) / 2;
  const evNotes = events.filter((e) => e.start).map((e) => {
    const hh = +e.start.slice(0, 2);
    if (nowHour != null && hh < nowHour) return null;
    const x = all.find((y) => y.h === hh);
    if (!x) return null;
    const notesE = [];
    if (isRainHour(x)) notesE.push(`попадает на дождь (${x.pop}%)`);
    else if (isSnowHour(x)) notesE.push('попадает на снег');
    if (wxKind(x.code) === 'storm') notesE.push('гроза');
    if (x.f + offset <= mid - 4) notesE.push('будет холоднее, чем днём');
    else if (x.f + offset >= mid + 4) notesE.push('будет теплее');
    if (x.gust >= 12) notesE.push('сильный ветер');
    return { time: e.start, title: e.title, temp: x.t, icon: isRainHour(x) ? '🌧' : wxIcon(x.code, x.day), note: notesE.join(', ') };
  }).filter(Boolean).sort((a, b) => a.time.localeCompare(b.time));

  // Коротко — для push, сводки и Telegram: «демисезонная куртка, худи; зонт»
  const pick = (label) => layers.find((l) => l.label === label)?.text;
  const shortParts = [];
  const o = pick('Верхняя');
  if (o && !/^не нужна/.test(o)) shortParts.push(o.split(/[,—]/)[0].trim());
  const m = pick('Утеплитель');
  if (m) shortParts.push(m.split(/[,—]/)[0].trim());
  if (!shortParts.length) shortParts.push(pick('Верх'));
  if (rain.length || maybeRain) shortParts.push('зонт');
  if (snow.length || emin < 0) shortParts.push('шапка');
  if (uv >= 6) shortParts.push('крем от солнца');

  return {
    key, from, to, offset,
    icon: dayIcon(day), text: wxLabel(day.code),
    temp: [tmin, tmax], feels: [fmin, fmax],
    summary: `${fmtRange(tmin, tmax)}, ощущается ${fmtRange(fmin, fmax)}`,
    notes, phases, layers, carry, alerts, events: evNotes,
    short: shortParts.join(', '),
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

/* ---------- Ответы «Как было по одежде?» ---------- */

/** Сдвиг «под себя» из настроек аккаунта: { wx_feel: 'cold'|'normal'|'hot', wx_adjust }. */
function wxOffset(prefs) {
  return (WX_FEEL[prefs?.wx_feel] || 0) + (+prefs?.wx_adjust || 0);
}

/**
 * Ответ на «Как было по одежде?» за день key → новые wx_log и wx_adjust.
 * Повторный ответ за тот же день заменяет прежний (и отменяет его поправку). Журнал — последние 120 дней.
 */
function applyWeatherFeedback(prefs, key, answer) {
  if (!(answer in WX_ANSWERS)) return null;
  const log = Array.isArray(prefs?.wx_log) ? prefs.wx_log.filter((x) => x && x.d) : [];
  const prev = log.find((x) => x.d === key);
  const delta = WX_ANSWERS[answer] - (prev ? WX_ANSWERS[prev.a] || 0 : 0);
  const adjust = Math.max(-WX_ADJUST_MAX, Math.min(WX_ADJUST_MAX, (+prefs?.wx_adjust || 0) + delta));
  const next = [...log.filter((x) => x.d !== key), { d: key, a: answer }].sort((a, b) => a.d.localeCompare(b.d)).slice(-120);
  return { wx_log: next, wx_adjust: adjust };
}

/** За последние days дней до key: сколько раз «в самый раз», «холодно», «жарко», «не был на улице». */
function feedbackStats(log, key, days = 30) {
  const from = new Date(`${key}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days + 1);
  const fromKey = from.toISOString().slice(0, 10);
  const r = { ok: 0, cold: 0, hot: 0, in: 0, total: 0 };
  for (const x of log || []) {
    if (x.d < fromKey || x.d > key || !(x.a in r)) continue;
    r[x.a] += 1;
    if (x.a !== 'in') r.total += 1;
  }
  return r;
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

/** Строка для утренней сводки: «🌦 +4…+11°, дождь 14–17 · куртка, худи, зонт». */
function weatherLine(advice) {
  if (!advice) return '';
  const extra = advice.notes.filter((n) => /дождь|снег/.test(n)).map((n) => n.replace(/^\S+ /, ''));
  return `${advice.icon} ${fmtRange(advice.temp[0], advice.temp[1])}${extra.length ? `, ${extra.join(', ')}` : ''} · ${advice.short}`;
}

/** Совет полностью — строками (Telegram). */
function adviceLines(advice) {
  if (!advice) return [];
  return [
    `${advice.icon} ${advice.summary}${advice.notes.length ? ` · ${advice.notes.join(' · ')}` : ''}`,
    advice.phases.length > 1 ? advice.phases.map((p) => `${p.label}: ${p.word} (${fmtTemp(p.temp)})${p.icon ? ` ${p.icon}` : ''}`).join(' → ') : '',
    '',
    ...advice.layers.map((l) => `${l.icon} ${l.label}: ${l.text}`),
    ...(advice.carry.length ? ['', `С собой: ${advice.carry.map((c) => c.replace(/^\S+ /, '')).join('; ')}`] : []),
    ...(advice.alerts.length ? ['', ...advice.alerts] : []),
    ...(advice.events.filter((e) => e.note).length ? ['', ...advice.events.filter((e) => e.note).map((e) => `📅 ${e.time} ${e.title} — ${fmtTemp(e.temp)}, ${e.note}`)] : []),
  ].filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== ''));
}

if (typeof module !== 'undefined') {
  module.exports = {
    WX_FEEL, WX_ANSWERS, WX_ANSWER_TEXT, wxKind, wxIcon, wxLabel, fmtTemp, fmtRange, weatherUrl, weatherAccuracyUrl, parseForecast, compactForecast,
    geoDistance, tempColor, dayIcon, feelWord, outdoorWindow, clothingAdvice, weatherChange, wxOffset, applyWeatherFeedback, feedbackStats,
    forecastAccuracy, weatherLine, adviceLines,
  };
}
