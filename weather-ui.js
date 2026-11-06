'use strict';

/*
 * Погода в календаре: значок и температура в месяце и неделе (ячейка подкрашена по температуре),
 * окно «🌦 Погода» (прогноз по дням, утро/день/вечер, погода к делам, точность прогноза) и карточка в «Списке».
 * Прогноз и его разбор — weather.js.
 *
 * Место и время вечернего предупреждения хранятся в настройках календаря, а после входа — ещё и в аккаунте
 * (user_prefs): их читает серверная функция remind, которая вечером предупреждает, если завтра погода заметно другая.
 */

/* global state, sync, notify, h, $, toast, closeNav, userTz, saveSettings, render, toKey, fromKey, addDays, today,
   collect, visibleEvents, isDailySpan, plansByDay, capitalize, relativeDay, formatDate, WD_SHORT, readJSON, loadNotifyState,
   weatherUrl, weatherAccuracyUrl, parseForecast, compactForecast, geoDistance, tempColor, dayIcon, wxLabel, fmtTemp, fmtRange,
   dayWeather, forecastAccuracy */

const WX_CACHE_KEY = 'everyday-calendar:weather';
const WX_ACC_KEY = 'everyday-calendar:weather-accuracy';
const WX_TTL = 60 * 60000;
const WX_DEFAULTS = { on: false, lat: null, lon: null, place: '', auto: true, eve: '21:00', month: true };

const wx = { fc: null, fcFor: null, loading: null, day: null, acc: undefined, found: null, missing: false, uploaded: 0, checked: 0 };

const wxSettings = () => ({ ...WX_DEFAULTS, ...(state.settings.weather || {}) });
const wxOn = () => { const s = wxSettings(); return s.on && s.lat != null; };
const round2 = (x) => Math.round(x * 100) / 100;
/** «−2°» без плюса — для тесных мест (месяц, неделя). */
const deg = (t) => `${Math.round(t) < 0 ? '−' : ''}${Math.abs(Math.round(t))}°`;

function wxStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* места нет или приватный режим — без кэша */ }
}

/* ---------- Настройки: в календаре и в аккаунте ---------- */

const wxServerReady = () => Boolean(sync.client && sync.user && notify.prefs && !notify.missing && !wx.missing);

async function saveWx(patch, { server = true } = {}) {
  state.settings.weather = { ...wxSettings(), ...patch };
  saveSettings();
  if (!server || !wxServerReady()) return;
  const s = wxSettings();
  const { data, error } = await sync.client.from('user_prefs').upsert({
    user_id: sync.user.id, tz: userTz(),
    wx_lat: s.on ? s.lat : null, wx_lon: s.on ? s.lon : null, wx_place: s.place || null,
    wx_eve: s.eve || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' }).select();
  if (error) {
    // Колонок погоды ещё нет (не выполнен update-3.sql) — работаем без вечернего предупреждения
    if (/wx_|column/i.test(error.message)) wx.missing = true;
    else toast(`Погода: не получилось сохранить в аккаунт — ${error.message}`);
    return;
  }
  notify.prefs = data?.[0] || notify.prefs;
}

/** Настройки из аккаунта (после входа и при открытии окна): место и время с другого устройства. */
function onWeatherPrefs(p) {
  if (!p) return;
  if (!('wx_lat' in p)) { wx.missing = true; return; }
  wx.missing = false;
  const s = wxSettings();
  if (p.wx_lat != null) {
    const moved = s.lat == null || geoDistance({ lat: p.wx_lat, lon: p.wx_lon }, s) > 1;
    state.settings.weather = {
      ...s, on: true, lat: p.wx_lat, lon: p.wx_lon, place: p.wx_place || s.place, eve: p.wx_eve ?? null,
    };
    saveSettings();
    if (moved) { wx.fc = null; refreshForecast(true); }
    render();
  } else if (s.on && s.lat != null) {
    saveWx({}); // погоду включили до входа — переносим в аккаунт
  }
}

/* ---------- Прогноз ---------- */

function loadWxCache() {
  const c = readJSON(WX_CACHE_KEY, null);
  const s = wxSettings();
  if (c?.fc && s.lat != null && geoDistance(c, s) < 3) {
    wx.fc = c.fc;
    wx.fcFor = { lat: c.lat, lon: c.lon };
  }
}

async function refreshForecast(force = false) {
  const s = wxSettings();
  if (!wxOn()) return;
  const same = wx.fcFor && geoDistance(wx.fcFor, s) < 3;
  if (!force && wx.fc && same && Date.now() - wx.fc.at < WX_TTL) return;
  if (wx.loading) return wx.loading;
  wx.loading = (async () => {
    try {
      const res = await fetch(weatherUrl(s.lat, s.lon, userTz()));
      if (!res.ok) throw new Error(String(res.status));
      wx.fc = parseForecast(await res.json());
      wx.fcFor = { lat: s.lat, lon: s.lon };
      wxStore(WX_CACHE_KEY, { lat: s.lat, lon: s.lon, fc: wx.fc });
      uploadWxCache();
      render();
      if ($('#weatherDialog').open) renderWeather();
    } catch {
      // Нет сети или сервис занят — остаётся последний сохранённый прогноз
    } finally {
      wx.loading = null;
    }
  })();
  return wx.loading;
}

/** Копия прогноза на 3 дня — в аккаунт, на случай если сервер вечером не достучится до сервиса погоды. */
async function uploadWxCache() {
  if (!wxServerReady() || !wx.fc || Date.now() - wx.uploaded < 3 * 3600000) return;
  wx.uploaded = Date.now();
  await sync.client.from('user_prefs').update({ wx_cache: compactForecast(wx.fc, toKey(today()), 3) }).eq('user_id', sync.user.id);
}

/* ---------- Место ---------- */

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geolocation')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: round2(p.coords.latitude), lon: round2(p.coords.longitude) }),
      reject,
      { timeout: 15000, maximumAge: 10 * 60000 },
    );
  });
}

/** Название места по координатам — чтобы было видно, для какого места прогноз. */
async function placeName(lat, lon) {
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ru`);
    const j = await res.json();
    return j.city || j.locality || j.principalSubdivision || '';
  } catch {
    return '';
  }
}

async function useGeolocation() {
  try {
    const p = await locate();
    const place = await placeName(p.lat, p.lon);
    await saveWx({ on: true, ...p, place, auto: true });
    wx.fc = null;
    renderWeather();
    await refreshForecast(true);
    toast(`🌦 Погода${place ? ` для: ${place}` : ' включена'}`);
  } catch (err) {
    toast(err?.code === 1
      ? 'Доступ к геолокации запрещён — разрешите его в настройках браузера или найдите город'
      : 'Не получилось определить место — найдите город поиском', { duration: 7000 });
  }
}

async function searchCity(name) {
  wx.found = 'loading';
  renderWeather();
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=ru&format=json`);
    wx.found = (await res.json()).results || [];
  } catch {
    wx.found = [];
  }
  renderWeather();
}

async function pickCity(c) {
  wx.found = null;
  await saveWx({ on: true, lat: round2(c.latitude), lon: round2(c.longitude), place: c.name, auto: false });
  wx.fc = null;
  renderWeather();
  await refreshForecast(true);
}

/** При открытии: если геолокация уже разрешена и вы уехали больше чем на 20 км — прогноз для нового места. */
async function recheckLocation() {
  const s = wxSettings();
  if (!wxOn() || !s.auto || !navigator.permissions || Date.now() - wx.checked < 3 * 3600000) return;
  wx.checked = Date.now();
  try {
    if ((await navigator.permissions.query({ name: 'geolocation' })).state !== 'granted') return;
  } catch {
    return;
  }
  const p = await locate().catch(() => null);
  if (!p || geoDistance(p, s) < 20) return;
  const place = await placeName(p.lat, p.lon);
  await saveWx({ ...p, place });
  await refreshForecast(true);
  toast(`🌦 Погода теперь для: ${place || 'нового места'}`);
}

/* ---------- Погода на день ---------- */

/** Дела дня со временем — к каждому показываем погоду в это время. */
function wxDayItems(key) {
  const d = fromKey(key);
  const events = (collect(visibleEvents(false), d, d).get(key) || [])
    .filter((o) => o.ev.start && (o.len === 1 || isDailySpan(o.ev)))
    .map((o) => ({ title: o.ev.title, start: o.ev.start, end: o.ev.end }));
  const plans = (plansByDay(d, d).get(key) || []).filter((t) => t.plan.start).map((t) => ({ title: t.title, start: t.plan.start, end: t.plan.end }));
  return [...events, ...plans];
}

function wxDay(key) {
  if (!wxOn() || !wx.fc) return null;
  const isToday = key === toKey(today());
  return dayWeather(wx.fc, key, { events: wxDayItems(key), nowHour: isToday ? new Date().getHours() : null });
}

/** Погода дня для месяца и недели: { icon, tmax, tmin, color, text } или null. */
function wxForDay(key, { month = false } = {}) {
  if (!wxOn() || (month && !wxSettings().month)) return null;
  const d = wx.fc?.days?.[key];
  if (!d || key < toKey(today())) return null;
  return { icon: dayIcon(d), tmax: d.tmax, tmin: d.tmin, color: tempColor(d.tmax), text: wxLabel(d.code) };
}

/** Значок и температура у числа в месяце. */
function monthWxBadge(key) {
  const w = wxForDay(key, { month: true });
  return w ? h('span', { class: 'cell-wx', title: `${w.text}, ${fmtRange(w.tmin, w.tmax)}` }, w.icon, h('b', {}, deg(w.tmax))) : null;
}

/** Под числом в шапке недели: «☀️ 12°/4°». */
function weekWxBadge(key) {
  const w = wxForDay(key);
  return w ? h('span', { class: 'tg-wx', title: w.text }, `${w.icon} ${deg(w.tmax)}/${deg(w.tmin)}`) : null;
}

/** Карточка вверху «Списка»: погода на сегодня (вечером — на завтра), а без погоды — предложение включить. */
function agendaWeatherCard() {
  const s = wxSettings();
  if (!wxOn()) {
    if (state.settings.wxPromoHidden) return null;
    return h('div', { class: 'wx-card is-promo' },
      h('span', {}, '🌦 Погода прямо в календаре — в месяце, неделе и к каждому делу'),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => openWeather() }, 'Включить'),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Скрыть', onclick: () => { state.settings.wxPromoHidden = true; saveSettings(); render(); } }, '✕'));
  }
  const evening = new Date().getHours() >= 20;
  const key = toKey(evening ? addDays(today(), 1) : today());
  const a = wxDay(key);
  if (!a) return wx.loading ? h('div', { class: 'wx-card muted' }, '🌦 Загружаю прогноз…') : null;
  return h('div', { class: 'wx-card' },
    h('button', { class: 'wx-card-main', type: 'button', onclick: () => openWeather(key) },
      h('span', { class: 'wx-card-icon' }, a.icon),
      h('span', { class: 'wx-card-text' },
        h('strong', {}, `${evening ? 'Завтра' : 'Сегодня'}${s.place ? ` · ${s.place}` : ''}: ${a.summary}`),
        a.notes.length ? h('small', {}, a.notes.join(' · ')) : null),
      h('span', { class: 'wx-card-more' }, 'Подробнее ›')),
    a.alerts.length ? h('div', { class: 'wx-alert' }, a.alerts[0]) : null);
}

/* ---------- Окно «🌦 Погода» ---------- */

function openWeather(key = null) {
  closeNav();
  wx.day = key || toKey(today());
  renderWeather();
  $('#weatherDialog').showModal();
  refreshForecast();
  if (sync.user && typeof loadNotifyState === 'function') {
    loadNotifyState().then(() => { onWeatherPrefs(notify.prefs); if ($('#weatherDialog').open) renderWeather(); });
  }
}

function placeSection() {
  const input = h('input', { type: 'search', placeholder: 'Город', 'aria-label': 'Город', enterkeyhint: 'search' });
  const form = h('form', { class: 'wx-search', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) searchCity(input.value.trim()); } },
    input, h('button', { class: 'btn small', type: 'submit' }, 'Найти'));
  return h('div', { class: 'wx-place' },
    h('button', { class: 'btn primary', type: 'button', onclick: useGeolocation }, '📍 Определить по геолокации'),
    form,
    wx.found === 'loading' ? h('p', { class: 'muted small' }, 'Ищу…') : null,
    Array.isArray(wx.found) ? (wx.found.length
      ? h('div', { class: 'wx-found' }, wx.found.map((c) => h('button', { class: 'side-item', type: 'button', onclick: () => pickCity(c) },
        h('span', {}, c.name, h('small', {}, [c.admin1, c.country].filter(Boolean).join(', '))))))
      : h('p', { class: 'muted small' }, 'Ничего не нашёл — попробуйте иначе')) : null);
}

function daySection(a) {
  return h('section', { class: 'wx-advice' },
    h('div', { class: 'wx-summary' },
      h('span', { class: 'wx-big' }, a.icon),
      h('div', {}, h('strong', {}, a.summary), h('small', { class: 'muted' }, [a.text, ...a.notes].join(' · ')))),
    a.phases.length > 1 ? h('div', { class: 'wx-phases' }, a.phases.map((p) => h('div', { class: 'wx-phase', style: { '--wx': tempColor(p.temp) } },
      h('small', {}, p.label), h('b', {}, `${fmtTemp(p.temp)}${p.icon ? ` ${p.icon}` : ''}`), h('span', {}, p.word)))) : null,
    a.alerts.length ? h('div', { class: 'wx-alerts' }, a.alerts.map((x) => h('div', { class: 'wx-alert' }, x))) : null,
    a.events.length ? h('div', { class: 'wx-events' }, h('small', { class: 'muted' }, 'К делам дня'),
      a.events.map((e) => h('div', { class: e.note ? 'is-note' : '' }, `${e.time} ${e.title} — ${e.icon} ${fmtTemp(e.temp)}${e.note ? `, ${e.note}` : ''}`))) : null);
}

function accuracySection() {
  if (wx.acc === undefined) loadAccuracy();
  const acc = wx.acc;
  return h('section', { class: 'notify-sec' },
    h('h3', {}, '🎯 Насколько точен прогноз'),
    h('p', { class: 'muted small' }, acc
      ? `Прогноз «на завтра» за ${acc.days} дн.: ошибался в среднем на ${String(acc.tempErr).replace('.', ',')}°, дождь угадал в ${acc.rainHit}% дней.`
      : acc === null ? 'Точность прогноза пока не посчитать — нет данных или сети.' : 'Считаю точность прогноза…'));
}

async function loadAccuracy() {
  const s = wxSettings();
  const cached = readJSON(WX_ACC_KEY, null);
  if (cached && Date.now() - cached.at < 12 * 3600000 && geoDistance(cached, s) < 3) { wx.acc = cached.acc; return; }
  wx.acc = false; // считаем
  try {
    const res = await fetch(weatherAccuracyUrl(s.lat, s.lon, userTz(), 30));
    if (!res.ok) throw new Error(String(res.status));
    wx.acc = forecastAccuracy(await res.json(), toKey(today()));
    wxStore(WX_ACC_KEY, { at: Date.now(), lat: s.lat, lon: s.lon, acc: wx.acc });
  } catch {
    wx.acc = null;
  }
  if ($('#weatherDialog').open) renderWeather();
}

function settingsSection() {
  const s = wxSettings();
  const eveTime = h('input', { type: 'time', value: s.eve || '21:00', disabled: !s.eve, onchange: (e) => saveWx({ eve: e.target.value || '21:00' }) });
  const serverNote = !sync.user ? 'Присылает сервер — работает после входа в аккаунт (☁).'
    : wx.missing ? 'В Supabase ещё нет колонок погоды: выполните supabase/update-3.sql (см. docs/SYNC_SETUP.md).' : 'Push и/или Telegram — как в «Сводка и Telegram».';
  return h('details', { class: 'wx-settings', open: Boolean(wx.found) },
    h('summary', {}, '⚙️ Настройки погоды'),
    h('section', { class: 'notify-sec' },
      h('h3', {}, `📍 ${s.place || 'Моё место'}`),
      placeSection()),
    h('section', { class: 'notify-sec' },
      h('h3', {}, '🌙 Вечером'),
      h('div', { class: 'notify-row' },
        h('label', { class: 'check' }, h('input', {
          type: 'checkbox', checked: Boolean(s.eve),
          onchange: async (e) => { await saveWx({ eve: e.target.checked ? eveTime.value || '21:00' : null }); renderWeather(); },
        }), 'Предупреждать в'),
        eveTime),
      h('p', { class: 'muted small' }, `Если завтра погода заметно другая — на 5° холоднее или теплее, дождь, снег, гроза, сильный ветер, — вечером придёт предупреждение. ${serverNote}`)),
    h('section', { class: 'notify-sec' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.month, onchange: (e) => { saveWx({ month: e.target.checked }, { server: false }); render(); } }), 'Погода в месяце: значок и цвет дня'),
      h('button', { class: 'btn small', type: 'button', onclick: async () => { await saveWx({ on: false }); wx.fc = null; renderWeather(); render(); } }, 'Выключить погоду')));
}

function renderWeather() {
  const body = $('#weatherBody');
  if (!body) return;
  const s = wxSettings();
  if (!wxOn()) {
    body.replaceChildren(
      h('p', {}, 'Покажу погоду прямо в календаре: значок и температуру в месяце и неделе, прогноз по часам и погоду к каждому вашему делу.'),
      h('p', { class: 'muted small' }, 'Прогноз — Open-Meteo, бесплатно и без регистрации. Место нужно, чтобы взять прогноз для него.'),
      placeSection());
    return;
  }
  const t = today();
  const days = Array.from({ length: 7 }, (_, i) => toKey(addDays(t, i)));
  if (!days.includes(wx.day) && !wx.fc?.days?.[wx.day]) wx.day = days[0];
  const tabs = h('div', { class: 'wx-tabs', role: 'tablist' }, days.map((key, i) => {
    const d = wx.fc?.days?.[key];
    const label = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${capitalize(WD_SHORT[(fromKey(key).getDay() + 6) % 7])} ${fromKey(key).getDate()}`;
    return h('button', {
      class: `wx-tab${wx.day === key ? ' is-active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(wx.day === key),
      style: d ? { '--wx': tempColor(d.tmax) } : null,
      onclick: () => { wx.day = key; renderWeather(); },
    }, h('small', {}, label), h('span', {}, d ? dayIcon(d) : '·'), h('b', {}, d ? deg(d.tmax) : ''));
  }));
  const a = wxDay(wx.day);
  body.replaceChildren(...[
    h('p', { class: 'wx-where muted small' }, `📍 ${s.place || 'Моё место'} · `, h('span', {}, wx.fc ? `обновлено в ${new Date(wx.fc.at).toTimeString().slice(0, 5)}` : 'загружаю…')),
    tabs,
    a ? daySection(a) : h('div', { class: 'side-empty' }, wx.loading || !wx.fc ? 'Загружаю прогноз…' : 'На этот день прогноза нет'),
    accuracySection(),
    settingsSection(),
  ].filter(Boolean));
}

function initWeather() {
  loadWxCache();
  $('#btnWeather').addEventListener('click', () => openWeather());
  refreshForecast();
  setTimeout(recheckLocation, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshForecast();
    recheckLocation();
  });
  setInterval(() => refreshForecast(), WX_TTL);
  // Нажали на вечернее предупреждение о погоде
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'weather-open') openWeather();
  });
  const params = new URLSearchParams(location.search);
  if (params.has('weather')) {
    params.delete('weather');
    history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
    setTimeout(() => openWeather(), 400);
  }
}
