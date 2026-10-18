'use strict';

/*
 * Окна «Статистика времени» и «Свободное окно» (открываются из панели слева),
 * плюс поиск окна из быстрой строки: «найди 2 часа на этой неделе».
 */

/* global state, $, h, toKey, fromKey, addDays, addMonths, startOfWeek, today, sameDay, wdIndex, fromMin,
   WD_SHORT, MONTHS, MONTHS_GEN, calOf, timeStats, findFreeSlots, parseSlotQuery, quietHours, saveSettings,
   formatDate, shortDate, relativeDay, capitalize, openEditor, openTaskEditor, closeNav, toast, findLayer, layerByName */

/* ---------- Статистика ---------- */

const stats = { period: 'week', anchor: null };

/** «3 ч 20 мин», «45 мин», «0». */
function fmtDuration(min) {
  if (!min) return '0';
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return [hh ? `${hh} ч` : '', mm ? `${mm} мин` : ''].filter(Boolean).join(' ');
}

function statsRange(anchor, period, shift = 0) {
  if (period === 'week') {
    const from = addDays(startOfWeek(anchor), shift * 7);
    return [from, addDays(from, 6)];
  }
  const first = addMonths(new Date(anchor.getFullYear(), anchor.getMonth(), 1), shift);
  return [first, new Date(first.getFullYear(), first.getMonth() + 1, 0)];
}

function statsLabel(from, to, period) {
  if (period === 'month') return `${capitalize(MONTHS[from.getMonth()])} ${from.getFullYear()}`;
  if (sameDay(from, startOfWeek(today()))) return 'Эта неделя';
  if (from.getMonth() === to.getMonth()) return `${from.getDate()}–${to.getDate()} ${MONTHS_GEN[to.getMonth()]}`;
  return `${from.getDate()} ${MONTHS_GEN[from.getMonth()].slice(0, 3)} – ${to.getDate()} ${MONTHS_GEN[to.getMonth()].slice(0, 3)}`;
}

function openStats() {
  closeNav();
  stats.anchor = today();
  renderStats();
  $('#statsDialog').showModal();
}

function renderStats() {
  const { period, anchor } = stats;
  const [from, to] = statsRange(anchor, period);
  const [pFrom, pTo] = statsRange(anchor, period, -1);
  const catOf = (x) => calOf(x).id;
  const cur = timeStats({ events: state.events, tasks: state.tasks, from, to, catOf });
  const prev = timeStats({ events: state.events, tasks: state.tasks, from: pFrom, to: pTo, catOf });
  const cals = state.calendars;
  const prevName = period === 'week' ? 'прошлой неделей' : 'прошлым месяцем';
  const prevTitle = period === 'week' ? 'Прошлая неделя' : 'Прошлый месяц';

  for (const b of $('#statsPeriod').children) b.classList.toggle('is-active', b.dataset.period === period);
  $('#statsLabel').textContent = statsLabel(from, to, period);

  const share = (m) => (cur.total ? Math.round((m / cur.total) * 100) : 0);
  const delta = (id) => {
    const d = (cur.byCat[id] || 0) - (prev.byCat[id] || 0);
    if (!d) return null;
    return h('span', { class: `stats-delta ${d > 0 ? 'is-up' : 'is-down'}`, title: `По сравнению с ${prevName}` },
      `${d > 0 ? '+' : '−'}${fmtDuration(Math.abs(d))} ${d > 0 ? '↑' : '↓'}`);
  };
  const top = cals.filter((c) => cur.byCat[c.id]).sort((a, b) => cur.byCat[b.id] - cur.byCat[a.id])[0];

  // Столбики по дням: высота — от самого загруженного дня
  const maxDay = Math.max(60, ...cur.days.map((d) => Object.values(d.byCat).reduce((a, b) => a + b, 0)));
  const isWeek = period === 'week';
  const bars = h('div', { class: `stats-days${isWeek ? '' : ' is-month'}` }, cur.days.map(({ key, byCat }) => {
    const d = fromKey(key);
    const total = Object.values(byCat).reduce((a, b) => a + b, 0);
    const label = isWeek ? WD_SHORT[wdIndex(d)] : (d.getDate() === 1 || wdIndex(d) === 0 ? d.getDate() : '');
    return h('div', {
      class: `stats-day${sameDay(d, today()) ? ' is-today' : ''}`,
      title: `${capitalize(formatDate(d))}: ${fmtDuration(total)}`,
    },
    h('div', { class: 'stats-col' }, cals.filter((c) => byCat[c.id]).map((c) => h('div', {
      class: 'stats-seg',
      style: { height: `${(byCat[c.id] / maxDay) * 100}%`, '--c': c.color },
    }))),
    h('span', { class: 'stats-day-label' }, label));
  }));

  $('#statsBody').replaceChildren(...[
    h('div', { class: 'stats-total' },
      h('strong', {}, cur.total ? fmtDuration(cur.total) : 'Пока пусто'),
      h('span', { class: 'muted' }, prev.total ? `${prevTitle}: ${fmtDuration(prev.total)}` : '')),
    cur.total ? h('div', { class: 'stats-stack', role: 'img', 'aria-label': 'Доли категорий' },
      cals.filter((c) => cur.byCat[c.id]).map((c) => h('div', {
        style: { width: `${(cur.byCat[c.id] / cur.total) * 100}%`, '--c': c.color },
        title: `${c.name}: ${share(cur.byCat[c.id])}%`,
      }))) : null,
    h('div', { class: 'stats-rows' }, cals.map((c) => h('div', { class: `stats-row${cur.byCat[c.id] ? '' : ' is-zero'}`, style: { '--c': c.color } },
      h('span', { class: 'stats-dot' }),
      h('span', { class: 'stats-name' }, c.name),
      h('span', { class: 'stats-hours' }, fmtDuration(cur.byCat[c.id] || 0)),
      h('span', { class: 'stats-share' }, cur.byCat[c.id] ? `${share(cur.byCat[c.id])}%` : ''),
      delta(c.id) || h('span', { class: 'stats-delta' })))),
    top && cur.total ? h('p', { class: 'stats-note' }, `Больше всего времени — «${top.name}»: ${share(cur.byCat[top.id])}%.`) : null,
    bars,
  ].filter(Boolean));
}

function initStats() {
  $('#btnStats').addEventListener('click', openStats);
  $('#statsPeriod').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    stats.period = b.dataset.period;
    renderStats();
  });
  const shift = (dir) => {
    stats.anchor = stats.period === 'week' ? addDays(stats.anchor, 7 * dir) : addMonths(stats.anchor, dir);
    renderStats();
  };
  $('#statsPrev').addEventListener('click', () => shift(-1));
  $('#statsNext').addEventListener('click', () => shift(1));
}

/* ---------- Свободное окно ---------- */

const DURATIONS = [30, 45, 60, 90, 120, 180, 240];
const PERIODS = {
  today: 'Сегодня',
  tomorrow: 'Завтра',
  week: 'Эта неделя',
  next7: 'Ближайшие 7 дней',
  nextWeek: 'Следующая неделя',
  next14: 'Ближайшие 14 дней',
};
const DAY_PARTS_UI = { any: ['Любое', null], morning: ['Утро', [360, 720]], day: ['День', [720, 1080]], evening: ['Вечер', [1080, 1440]] };

const slotSleep = () => (Array.isArray(state.settings.sleep) ? state.settings.sleep : quietHours());
const slotBuffer = () => (Number.isFinite(state.settings.slotBuffer) ? state.settings.slotBuffer : 15);

/** Текущий запрос: { duration, from, to, window, custom } — custom — подпись периода из фразы. */
let slotQuery = null;

function periodRange(id) {
  const t = today();
  switch (id) {
    case 'today': return [t, t];
    case 'tomorrow': return [addDays(t, 1), addDays(t, 1)];
    case 'week': return [t, addDays(startOfWeek(t), 6)];
    case 'nextWeek': return [addDays(startOfWeek(t), 7), addDays(startOfWeek(t), 13)];
    case 'next14': return [t, addDays(t, 13)];
    default: return [t, addDays(t, 6)];
  }
}

function rangeLabel(from, to) {
  if (sameDay(from, to)) return relativeDay(from) || capitalize(formatDate(from));
  return `${shortDate(from)} – ${shortDate(to)}`;
}

function openSlots(query = null) {
  closeNav();
  if (query) {
    const named = { 'эта неделя': 'week', 'следующая неделя': 'nextWeek', 'ближайшие 7 дней': 'next7' }[query.period];
    const known = named || Object.keys(PERIODS).find((id) => {
      const [a, b] = periodRange(id);
      return sameDay(a, query.from) && sameDay(b, query.to);
    });
    slotQuery = { ...query, periodId: known || 'custom', custom: known ? null : rangeLabel(query.from, query.to) };
  } else if (!slotQuery) {
    slotQuery = { duration: 60, periodId: 'next7', window: null, with: null };
  }
  if (slotQuery.with && !findLayer(slotQuery.with)) slotQuery.with = null;
  renderSlotControls();
  renderSlots();
  $('#slotsDialog').showModal();
}

function renderSlotControls() {
  const q = slotQuery;
  const durations = DURATIONS.includes(q.duration) ? DURATIONS : [...DURATIONS, q.duration].sort((a, b) => a - b);
  $('#sDuration').replaceChildren(...durations.map((m) => h('option', { value: m, selected: m === q.duration }, fmtDuration(m))));
  $('#sPeriod').replaceChildren(
    ...(q.periodId === 'custom' ? [h('option', { value: 'custom', selected: true }, q.custom)] : []),
    ...Object.entries(PERIODS).map(([id, label]) => h('option', { value: id, selected: id === q.periodId }, label)));
  const partId = Object.keys(DAY_PARTS_UI).find((id) => JSON.stringify(DAY_PARTS_UI[id][1]) === JSON.stringify(q.window));
  $('#sPart').replaceChildren(
    ...(partId ? [] : [h('option', { value: 'custom', selected: true }, `${fromMin(q.window[0])}–${fromMin(q.window[1])}`)]),
    ...Object.entries(DAY_PARTS_UI).map(([id, [label]]) => h('option', { value: id, selected: id === partId }, label)));
  // Совместный поиск: календари друзей, которые вам видны
  const layers = (state.layers || []).filter((l) => !l.error);
  $('#sWithWrap').hidden = !layers.length;
  $('#sWith').replaceChildren(h('option', { value: '' }, 'Только я'),
    ...layers.map((l) => h('option', { value: l.key, selected: l.key === q.with }, `Я и ${l.name}`)));
}

function renderSlots() {
  const q = slotQuery;
  const [from, to] = q.periodId === 'custom' ? [q.from, q.to] : periodRange(q.periodId);
  const keys = [];
  for (let d = from; d <= to; d = addDays(d, 1)) keys.push(toKey(d));
  const n = new Date();
  // С другом — его занятое время тоже занято (его события и блоки «Когда делаю»)
  const friend = q.with ? findLayer(q.with) : null;
  const slots = findFreeSlots({
    events: friend ? [...state.events, ...friend.events] : state.events,
    tasks: state.tasks,
    keys,
    duration: q.duration,
    sleep: slotSleep(),
    buffer: slotBuffer(),
    window: q.window,
    now: { key: toKey(n), min: n.getHours() * 60 + n.getMinutes() },
  });
  const plan = (s) => ({ date: s.key, start: fromMin(s.start), end: fromMin(s.end) });
  $('#slotList').replaceChildren(...(slots.length ? slots.map((s) => {
    const d = fromKey(s.key);
    return h('div', { class: 'slot' },
      h('div', { class: 'slot-when' },
        h('strong', {}, capitalize(relativeDay(d) || formatDate(d))),
        h('span', {}, `${fromMin(s.start)}–${fromMin(s.end)}`),
        s.freeUntil > s.end ? h('small', {}, `свободно до ${fromMin(s.freeUntil)}`) : null),
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => { $('#slotsDialog').close(); openEditor({ preset: { date: s.key, start: fromMin(s.start), end: fromMin(s.end) } }); },
      }, '📅 Событие'),
      h('button', {
        class: 'btn',
        type: 'button',
        title: 'Новая задача с этим временем в «Когда делаю»',
        onclick: () => { $('#slotsDialog').close(); openTaskEditor(null, { plan: plan(s) }); },
      }, '☑ Задача'));
  }) : [h('div', { class: 'side-empty' }, `Нет свободных ${fmtDuration(q.duration)} подряд в этот период. Попробуйте другой период или меньше времени.`)]));
  const sleep = slotSleep();
  $('#slotHint').textContent = `${friend ? `Время, когда свободны вы и ${friend.name}. ` : ''}Не предлагаю время сна (${sleep[0]}–${sleep[1]}) и оставляю ${slotBuffer()} мин до и после других дел.`;
}

/* ---------- Настройки поиска окна ---------- */

const slotSettingsLabel = () => `😴 Сон: ${slotSleep()[0]}–${slotSleep()[1]}`;

function openSlotSettings() {
  closeNav();
  $('#sleepFrom').value = slotSleep()[0];
  $('#sleepTo').value = slotSleep()[1];
  $('#slotBuffer').value = String(slotBuffer());
  $('#slotSettings').showModal();
}

function initSlots() {
  $('#btnSlots').addEventListener('click', () => openSlots());
  $('#btnSleep').addEventListener('click', openSlotSettings);
  $('#slotSettingsLink').addEventListener('click', () => { $('#slotsDialog').close(); openSlotSettings(); });
  $('#sDuration').addEventListener('change', (e) => { slotQuery.duration = +e.target.value; renderSlots(); });
  $('#sPeriod').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    slotQuery.periodId = e.target.value;
    renderSlots();
  });
  $('#sWith').addEventListener('change', (e) => { slotQuery.with = e.target.value || null; renderSlots(); });
  $('#sPart').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    slotQuery.window = DAY_PARTS_UI[e.target.value][1];
    renderSlots();
  });
  $('#slotSettingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const sleep = [$('#sleepFrom').value || quietHours()[0], $('#sleepTo').value || quietHours()[1]];
    // Совпадает с тихими часами — не запоминаем: сон и дальше следует за ними
    state.settings.sleep = sleep[0] === quietHours()[0] && sleep[1] === quietHours()[1] ? null : sleep;
    state.settings.slotBuffer = +$('#slotBuffer').value;
    saveSettings();
    $('#slotSettings').close();
    $('#btnSleep').textContent = slotSettingsLabel();
    toast(`Сон: ${sleep[0]}–${sleep[1]}, запас ${slotBuffer()} мин`);
  });
}

/** Быстрая строка: «найди 2 часа на этой неделе» — запрос на поиск окна или null. */
function quickSlotQuery(text) {
  const q = parseSlotQuery(text, today());
  if (!q) return null;
  // «найди 2 часа с Аней» — общее окно с другом, чей календарь вам виден
  let friend = null;
  for (const m of String(text).matchAll(/(?:^|\s)со? ([А-Яа-яЁёA-Za-z-]{2,})/g)) friend ||= layerByName(m[1]);
  return { ...q, with: friend?.key || null, window: q.window && [Math.max(0, q.window[0]), Math.min(1440, q.window[1])] };
}

function quickSlotPreview(q) {
  const part = Object.values(DAY_PARTS_UI).find(([, w]) => JSON.stringify(w) === JSON.stringify(q.window));
  const when = q.period ? q.period : rangeLabel(q.from, q.to).toLowerCase();
  const time = q.window ? (part ? part[0].toLowerCase() : `${fromMin(q.window[0])}–${fromMin(q.window[1])}`) : '';
  const friend = q.with ? findLayer(q.with) : null;
  return `🔎 Найти свободные ${fmtDuration(q.duration)}${friend ? ` (вы и ${friend.name})` : ''} · ${[when, time].filter(Boolean).join(', ')} · Enter — показать`;
}

function initInsights() {
  initStats();
  initSlots();
  $('#btnSleep').textContent = slotSettingsLabel();
}
