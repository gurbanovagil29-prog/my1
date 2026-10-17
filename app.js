'use strict';

/* global MONTHS, MONTHS_GEN, WD_SHORT, WD_FULL, REPEAT_LABELS, pad, toKey, fromKey, today, addDays, addMonths,
   wdIndex, startOfWeek, sameDay, dayDiff, toMin, fromMin, snap, occursOn, endMinutes, collect, nextOccurrence,
   parseQuick, toICS, fromICS, normalizeEvent */

const STORE_KEY = 'everyday-calendar:events';
const SETTINGS_KEY = 'everyday-calendar:settings';
const FIRED_KEY = 'everyday-calendar:fired';
const HOUR_H = 48;
const COLORS = ['#4f6bed', '#e5484d', '#f76b15', '#f5a524', '#30a46c', '#12a594', '#8e4ec6', '#e93d82', '#6b7280'];
const VIEWS = ['month', 'week', 'day', 'agenda'];

/* ---------- Хранилище ---------- */

function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const loadEvents = () => (readJSON(STORE_KEY, []) || []).map(normalizeEvent).filter(Boolean);

const state = {
  events: loadEvents(),
  settings: { theme: 'auto', view: 'month', defaultRemind: 10, ...readJSON(SETTINGS_KEY, {}) },
  cursor: today(),
  mini: today(),
  search: '',
  autoScroll: true,
};
state.view = VIEWS.includes(state.settings.view) ? state.settings.view : 'month';

function saveEvents() {
  if (!writeJSON(STORE_KEY, state.events)) toast('Не удалось сохранить: хранилище браузера недоступно');
  render();
}

function saveSettings() {
  writeJSON(SETTINGS_KEY, state.settings);
}

const findEvent = (id) => state.events.find((e) => e.id === id);

/** Снимок для «Отменить». */
function withUndo(message, change) {
  const snapshot = JSON.stringify(state.events);
  change();
  saveEvents();
  toast(message, {
    action: 'Отменить',
    onAction: () => {
      state.events = JSON.parse(snapshot);
      saveEvents();
    },
  });
}

/* ---------- DOM-помощники ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

/* ---------- Форматирование ---------- */

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function relativeDay(d) {
  const diff = dayDiff(today(), d);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  return null;
}

function formatDate(d, { weekday = true, year = 'auto' } = {}) {
  const showYear = year === true || (year === 'auto' && d.getFullYear() !== today().getFullYear());
  const parts = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${showYear ? ` ${d.getFullYear()}` : ''}`;
  return weekday ? `${WD_SHORT[wdIndex(d)]}, ${parts}` : parts;
}

function formatTime(ev) {
  if (!ev.start) return 'Весь день';
  return `${ev.start}–${fromMin(endMinutes(ev)).replace('23:59', '24:00')}`;
}

function isPast(ev, key) {
  const now = new Date();
  const d = fromKey(key);
  const endMin = ev.start ? endMinutes(ev) : 1440;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, endMin) < now;
}

function viewTitle() {
  const c = state.cursor;
  switch (state.view) {
    case 'month': return `${MONTHS[c.getMonth()]} ${c.getFullYear()}`;
    case 'week': {
      const s = startOfWeek(c);
      const e = addDays(s, 6);
      if (s.getMonth() === e.getMonth()) return `${s.getDate()}–${e.getDate()} ${MONTHS_GEN[e.getMonth()]} ${e.getFullYear()}`;
      return `${s.getDate()} ${MONTHS_GEN[s.getMonth()]} – ${e.getDate()} ${MONTHS_GEN[e.getMonth()]} ${e.getFullYear()}`;
    }
    case 'day': {
      const rel = relativeDay(c);
      return `${rel ? `${rel}, ` : `${WD_FULL[wdIndex(c)]}, `}${formatDate(c, { weekday: false, year: true })}`;
    }
    default: return `События с ${formatDate(c, { weekday: false })}`;
  }
}

/* ---------- Рендер ---------- */

function render() {
  applyTheme();
  $('#title').textContent = viewTitle();
  document.title = `${capitalize(viewTitle())} — Календарь`;
  for (const b of $$('#viewSwitch button')) b.classList.toggle('is-active', b.dataset.view === state.view);

  const view = $('#view');
  const prevScroll = $('.tg-scroll', view)?.scrollTop;
  view.replaceChildren();
  if (state.view === 'month') view.append(...renderMonth());
  else if (state.view === 'week') view.append(renderTimeGrid(Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(state.cursor), i))));
  else if (state.view === 'day') view.append(renderTimeGrid([state.cursor]));
  else view.append(renderAgenda());

  const scroller = $('.tg-scroll', view);
  if (scroller) {
    if (state.autoScroll || prevScroll == null) {
      const now = new Date();
      const hasToday = $('.tg-col.is-today', view);
      scroller.scrollTop = (hasToday ? Math.max(0, now.getHours() - 2) : 7) * HOUR_H;
    } else {
      scroller.scrollTop = prevScroll;
    }
  }
  state.autoScroll = false;

  renderMini();
  renderSideList();
  renderFooter();
}

function setView(v) {
  if (!VIEWS.includes(v)) return;
  state.view = v;
  state.settings.view = v;
  state.autoScroll = true;
  saveSettings();
  render();
}

function go(dir) {
  const c = state.cursor;
  if (state.view === 'month') state.cursor = addMonths(c, dir);
  else if (state.view === 'week') state.cursor = addDays(c, 7 * dir);
  else if (state.view === 'day') state.cursor = addDays(c, dir);
  else state.cursor = addDays(c, 14 * dir);
  state.mini = state.cursor;
  render();
}

function visibleRange() {
  const c = state.cursor;
  if (state.view === 'month') {
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    return [first, new Date(c.getFullYear(), c.getMonth() + 1, 0)];
  }
  if (state.view === 'week') return [startOfWeek(c), addDays(startOfWeek(c), 6)];
  if (state.view === 'day') return [c, c];
  return [c, addDays(c, 59)];
}

function goToday() {
  state.cursor = today();
  state.mini = today();
  state.autoScroll = true;
  render();
}

function selectDay(d, view) {
  state.cursor = d;
  state.mini = d;
  if (view) setView(view);
  else render();
}

/* ---------- Месяц ---------- */

function renderMonth() {
  const c = state.cursor;
  const first = new Date(c.getFullYear(), c.getMonth(), 1);
  const start = startOfWeek(first);
  const weeks = Math.ceil((wdIndex(first) + new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate()) / 7);
  const end = addDays(start, weeks * 7 - 1);
  const map = collect(state.events, start, end);
  const t = today();

  const grid = h('div', { class: 'month', style: { gridTemplateRows: `auto repeat(${weeks}, minmax(0, 1fr))` } },
    WD_SHORT.map((w) => h('div', { class: 'month-wd' }, w)));

  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = d;
    const key = toKey(day);
    const list = map.get(key);
    const cls = ['cell'];
    if (day.getMonth() !== c.getMonth()) cls.push('is-other');
    if (sameDay(day, t)) cls.push('is-today');
    if (sameDay(day, state.cursor)) cls.push('is-selected');
    if (wdIndex(day) >= 5) cls.push('is-weekend');

    const cell = h('div', {
      class: cls.join(' '),
      dataset: { date: key },
      onclick: () => (sameDay(day, state.cursor) ? selectDay(day, 'day') : selectDay(day)),
    },
    h('div', { class: 'cell-head' },
      h('span', { class: 'cell-num' }, day.getDate() === 1 ? `${day.getDate()} ${MONTHS_GEN[day.getMonth()].slice(0, 3)}` : day.getDate()),
      h('button', {
        class: 'cell-add',
        type: 'button',
        title: 'Добавить событие',
        'aria-label': `Добавить событие ${formatDate(day)}`,
        onclick: (e) => { e.stopPropagation(); openEditor({ preset: { date: key } }); },
      }, '+')));

    const limit = 3;
    const shown = list.length > limit + 1 ? list.slice(0, limit) : list;
    for (const o of shown) cell.append(chip(o));
    if (shown.length < list.length) {
      cell.append(h('button', {
        class: 'more',
        type: 'button',
        onclick: (e) => { e.stopPropagation(); selectDay(day, 'day'); },
      }, `ещё ${list.length - shown.length}`));
    }
    dropTarget(cell, key, 'date');
    grid.append(cell);
  }
  return [grid, renderDayPanel(state.cursor)];
}

/** Список событий выбранного дня под месяцем — виден на телефоне. */
function renderDayPanel(d) {
  const key = toKey(d);
  const list = collect(state.events, d, d).get(key);
  return h('div', { class: 'day-panel' },
    h('div', { class: 'day-panel-head' },
      h('strong', {}, capitalize(relativeDay(d) || WD_FULL[wdIndex(d)]), `, ${formatDate(d, { weekday: false })}`),
      h('button', { class: 'cell-add', type: 'button', 'aria-label': 'Добавить событие', onclick: () => openEditor({ preset: { date: key } }) }, '+')),
    list.length
      ? list.map(({ ev }) => h('button', {
        class: `side-item${isPast(ev, key) ? ' is-past' : ''}`,
        type: 'button',
        style: { '--c': ev.color },
        onclick: () => openEditor({ ev, key }),
      }, h('span', {}, ev.title, h('small', {}, formatTime(ev)))))
      : h('div', { class: 'side-empty' }, 'Свободный день'));
}

function chip({ ev, key }) {
  const el = h('div', {
    class: `chip${ev.start ? '' : ' is-allday'}${isPast(ev, key) ? ' is-past' : ''}`,
    role: 'button',
    tabindex: '0',
    style: { '--c': ev.color },
    title: `${ev.title}\n${formatTime(ev)}${ev.repeat !== 'none' ? ` · ${REPEAT_LABELS[ev.repeat]}` : ''}`,
    onclick: (e) => { e.stopPropagation(); openEditor({ ev, key }); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); openEditor({ ev, key }); } },
  },
  ev.start ? h('span', { class: 'chip-time' }, ev.start) : null,
  h('span', { class: 'chip-title' }, ev.repeat !== 'none' ? '↻ ' : '', ev.title));
  makeDraggable(el, ev);
  return el;
}

/* ---------- Неделя / день ---------- */

function renderTimeGrid(days) {
  const map = collect(state.events, days[0], days[days.length - 1]);
  const t = today();

  const head = h('div', { class: 'tg-row tg-head' }, h('div'),
    days.map((d) => h('button', {
      class: `tg-day${sameDay(d, t) ? ' is-today' : ''}`,
      type: 'button',
      onclick: () => selectDay(d, 'day'),
    }, h('span', { class: 'tg-wd' }, WD_SHORT[wdIndex(d)]), h('span', { class: 'tg-num' }, d.getDate()))));

  const allDay = h('div', { class: 'tg-row tg-allday' }, h('div', { class: 'tg-allday-label' }, 'весь день'),
    days.map((d) => {
      const key = toKey(d);
      const cell = h('div', { class: 'tg-allday-cell' });
      cell.addEventListener('click', (e) => {
        if (e.target === cell) openEditor({ preset: { date: key, allDay: true } });
      });
      for (const o of map.get(key)) if (!o.ev.start) cell.append(chip(o));
      dropTarget(cell, key, 'allday');
      return cell;
    }));

  const hours = h('div', { class: 'tg-hours' });
  for (let i = 1; i < 24; i++) hours.append(h('span', { style: { top: `${i * HOUR_H}px` } }, `${pad(i)}:00`));
  const body = h('div', { class: 'tg-body', style: { height: `${24 * HOUR_H}px` } }, hours,
    days.map((d) => dayColumn(d, map.get(toKey(d)).filter((o) => o.ev.start), sameDay(d, t))));

  return h('div', { class: 'tg', style: { '--cols': days.length, '--hour': `${HOUR_H}px` } },
    head, allDay, h('div', { class: 'tg-scroll' }, body));
}

function dayColumn(d, items, isToday) {
  const key = toKey(d);
  const col = h('div', { class: `tg-col${isToday ? ' is-today' : ''}${wdIndex(d) >= 5 ? ' is-weekend' : ''}`, dataset: { date: key } });
  col.addEventListener('click', (e) => {
    if (e.target !== col) return;
    const m = Math.min(snap((e.offsetY / HOUR_H) * 60 - 15, 30), 1410);
    openEditor({ preset: { date: key, start: fromMin(m), end: fromMin(m + 60) } });
  });
  dropTarget(col, key, col);

  const laid = layoutDay(items.map((o) => ({ ...o, s: toMin(o.ev.start), e: endMinutes(o.ev) })));
  for (const it of laid) col.append(eventBlock(it));
  if (isToday) col.append(h('div', { class: 'now-line', style: { top: `${nowTop()}px` } }));
  return col;
}

const nowTop = () => {
  const n = new Date();
  return ((n.getHours() * 60 + n.getMinutes()) / 60) * HOUR_H;
};

/** Раскладывает пересекающиеся события по колонкам. */
function layoutDay(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const colEnds = [];
    for (const it of cluster) {
      let c = colEnds.findIndex((end) => end <= it.s);
      if (c < 0) { c = colEnds.length; colEnds.push(0); }
      colEnds[c] = it.e;
      it.col = c;
    }
    for (const it of cluster) it.cols = colEnds.length;
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return items;
}

let suppressClickUntil = 0;
let resizing = false;

function eventBlock(it) {
  const { ev, key, s, e, col, cols } = it;
  const time = h('div', { class: 'tg-ev-time' }, formatTime(ev));
  const el = h('div', {
    class: `tg-ev${e - s < 45 ? ' is-short' : ''}${isPast(ev, key) ? ' is-past' : ''}`,
    role: 'button',
    tabindex: '0',
    style: {
      '--c': ev.color,
      top: `${(s / 60) * HOUR_H}px`,
      height: `${Math.max(((e - s) / 60) * HOUR_H - 2, 18)}px`,
      left: `calc(${(col / cols) * 100}% + 2px)`,
      width: `calc(${100 / cols}% - 4px)`,
    },
    title: `${ev.title}\n${formatTime(ev)}`,
    onclick: () => { if (Date.now() > suppressClickUntil) openEditor({ ev, key }); },
    onkeydown: (k) => { if (k.key === 'Enter') openEditor({ ev, key }); },
  }, h('div', { class: 'tg-ev-title' }, ev.repeat !== 'none' ? '↻ ' : '', ev.title), time);
  makeDraggable(el, ev);

  // Потянуть за нижний край — изменить длительность (для повторов меняется вся серия)
  const handle = h('div', { class: 'tg-resize', title: 'Потяните, чтобы изменить длительность' });
  handle.addEventListener('pointerdown', (pd) => {
    pd.preventDefault();
    pd.stopPropagation();
    resizing = true;
    handle.setPointerCapture(pd.pointerId);
    const y0 = pd.clientY;
    let newEnd = e;
    const move = (pm) => {
      newEnd = Math.min(1440, Math.max(s + 15, snap(e + ((pm.clientY - y0) / HOUR_H) * 60, 15)));
      el.style.height = `${((newEnd - s) / 60) * HOUR_H - 2}px`;
      time.textContent = `${ev.start}–${fromMin(newEnd).replace('23:59', '24:00')}`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      resizing = false;
      suppressClickUntil = Date.now() + 300;
      if (newEnd !== e) {
        const target = findEvent(ev.id);
        if (target) {
          target.end = fromMin(newEnd);
          saveEvents();
        }
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('click', (c) => c.stopPropagation());
  el.append(handle);
  return el;
}

/* ---------- Перетаскивание ---------- */

let drag = null;

function makeDraggable(el, ev) {
  if (ev.repeat !== 'none') return; // повторяющиеся меняются через форму
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (resizing) { e.preventDefault(); return; }
    const r = el.getBoundingClientRect();
    drag = { id: ev.id, grabMin: ev.start ? ((e.clientY - r.top) / HOUR_H) * 60 : 0 };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ev.title);
    requestAnimationFrame(() => el.classList.add('is-dragging'));
  });
  el.addEventListener('dragend', () => {
    drag = null;
    el.classList.remove('is-dragging');
    for (const x of $$('.drop-over')) x.classList.remove('drop-over');
  });
}

/** mode: 'date' — меняется только дата; 'allday' — событие на весь день; элемент колонки — время по месту броска. */
function dropTarget(el, key, mode) {
  el.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const ev = findEvent(drag.id);
    if (!ev) return;
    const { grabMin } = drag;
    withUndo('Событие перенесено', () => {
      ev.date = key;
      if (mode === 'allday') {
        ev.start = null;
        ev.end = null;
      } else if (mode instanceof Element) {
        const dur = ev.start ? endMinutes(ev) - toMin(ev.start) : 60;
        const r = mode.getBoundingClientRect();
        const s = Math.max(0, Math.min(1440 - 15, snap(((e.clientY - r.top) / HOUR_H) * 60 - grabMin, 15)));
        ev.start = fromMin(s);
        ev.end = fromMin(Math.min(s + dur, 1440));
      }
    });
  });
}

/* ---------- Список ---------- */

function renderAgenda() {
  const from = state.cursor;
  const to = addDays(from, 59);
  const map = collect(state.events, from, to);
  const t = today();
  const wrap = h('div', { class: 'agenda' });

  for (const [key, list] of map) {
    if (!list.length) continue;
    const d = fromKey(key);
    const rel = relativeDay(d);
    wrap.append(h('div', { class: `agenda-day${sameDay(d, t) ? ' is-today' : ''}` },
      h('div', { class: 'agenda-date' },
        h('b', {}, d.getDate()),
        h('span', {}, `${WD_SHORT[wdIndex(d)]}, ${MONTHS_GEN[d.getMonth()]}`, rel ? h('br') : null, rel)),
      h('div', { class: 'agenda-items' }, list.map(({ ev }) => h('button', {
        class: `agenda-item${isPast(ev, key) ? ' is-past' : ''}`,
        type: 'button',
        style: { '--c': ev.color },
        onclick: () => openEditor({ ev, key }),
      },
      h('span', { class: 'agenda-time' }, formatTime(ev)),
      h('span', { class: 'agenda-title' }, ev.title,
        ev.repeat !== 'none' || ev.notes
          ? h('small', {}, [ev.repeat !== 'none' ? `↻ ${REPEAT_LABELS[ev.repeat]}` : '', ev.notes].filter(Boolean).join(' · '))
          : null))))));
  }

  if (!wrap.childElementCount) {
    wrap.append(h('div', { class: 'empty' },
      h('strong', {}, 'Ближайшие 60 дней свободны'),
      'Добавьте событие кнопкой «Создать» или строкой быстрого добавления сверху.'));
  }
  return wrap;
}

/* ---------- Сайдбар ---------- */

function renderMini() {
  const m = state.mini;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = startOfWeek(first);
  const end = addDays(start, 41);
  const map = collect(state.events, start, end);
  const t = today();

  const grid = h('div', { class: 'mini-grid' }, WD_SHORT.map((w) => h('div', { class: 'mini-wd' }, w)));
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = d;
    const cls = ['mini-day'];
    if (day.getMonth() !== m.getMonth()) cls.push('is-other');
    if (sameDay(day, t)) cls.push('is-today');
    if (sameDay(day, state.cursor)) cls.push('is-selected');
    if (map.get(toKey(day)).length) cls.push('has-events');
    grid.append(h('button', {
      class: cls.join(' '),
      type: 'button',
      'aria-label': formatDate(day, { year: true }),
      onclick: () => { selectDay(day); closeNav(); },
    }, day.getDate()));
  }

  $('#mini').replaceChildren(
    h('div', { class: 'mini-head' },
      h('strong', {}, `${capitalize(MONTHS[m.getMonth()])} ${m.getFullYear()}`),
      h('div', {},
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Предыдущий месяц', onclick: () => { state.mini = addMonths(m, -1); renderMini(); } }, '‹'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Следующий месяц', onclick: () => { state.mini = addMonths(m, 1); renderMini(); } }, '›'))),
    grid);
}

function renderSideList() {
  const t = today();
  const map = collect(state.events, t, addDays(t, 1));
  const section = (label, key) => {
    const list = map.get(key);
    return [
      h('h3', {}, label),
      list.length
        ? list.map(({ ev }) => h('button', {
          class: `side-item${isPast(ev, key) ? ' is-past' : ''}`,
          type: 'button',
          style: { '--c': ev.color },
          onclick: () => { openEditor({ ev, key }); closeNav(); },
        }, h('span', {}, ev.title, h('small', {}, formatTime(ev)))))
        : h('div', { class: 'side-empty' }, 'Ничего не запланировано'),
    ];
  };
  $('#sideList').replaceChildren(...section('Сегодня', toKey(t)).flat(), ...section('Завтра', toKey(addDays(t, 1))).flat());
}

function renderFooter() {
  const theme = state.settings.theme;
  $('#btnTheme').textContent = `Тема: ${{ auto: 'как в системе', light: 'светлая', dark: 'тёмная' }[theme]}`;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#btnNotify').textContent = {
    granted: '🔔 Напоминания включены',
    denied: '🔕 Уведомления запрещены в браузере',
    default: '🔔 Включить напоминания',
    unsupported: '🔕 Уведомления не поддерживаются',
  }[perm];
}

function applyTheme() {
  const theme = state.settings.theme;
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

function openNav() { $('#app').classList.add('nav-open'); }
function closeNav() { $('#app').classList.remove('nav-open'); }

/* ---------- Редактор ---------- */

const editor = $('#editor');
const f = {
  title: $('#fTitle'),
  date: $('#fDate'),
  dateLabel: $('#fDateLabel'),
  allDay: $('#fAllDay'),
  start: $('#fStart'),
  end: $('#fEnd'),
  repeat: $('#fRepeat'),
  until: $('#fUntil'),
  remind: $('#fRemind'),
  notes: $('#fNotes'),
  colors: $('#fColors'),
};
let editing = null;
let pickedColor = COLORS[0];

for (const [value, label] of Object.entries(REPEAT_LABELS)) f.repeat.append(h('option', { value }, label));

function renderColors() {
  f.colors.replaceChildren(...COLORS.map((c) => h('button', {
    class: 'color-swatch',
    type: 'button',
    role: 'radio',
    'aria-checked': String(c === pickedColor),
    'aria-label': `Цвет ${c}`,
    style: { '--c': c },
    onclick: () => { pickedColor = c; renderColors(); },
  })));
}

function syncEditorFields() {
  $('#timeRow').hidden = f.allDay.checked;
  $('#untilWrap').hidden = f.repeat.value === 'none';
  f.dateLabel.textContent = f.repeat.value === 'none' ? 'Дата' : 'Первый день';
}

function defaultStart(dateKey) {
  if (dateKey !== toKey(today())) return 9 * 60;
  const n = new Date();
  return Math.min((n.getHours() + 1) * 60, 23 * 60);
}

function openEditor({ ev = null, key = null, preset = {} } = {}) {
  editing = { id: ev ? ev.id : null, key };
  let v;
  if (ev) {
    v = ev;
  } else {
    const date = preset.date || toKey(state.cursor);
    const s = preset.allDay ? null : (preset.start || fromMin(defaultStart(date)));
    v = {
      title: preset.title || '',
      date,
      start: s,
      end: s ? (preset.end || fromMin(toMin(s) + 60)) : null,
      repeat: preset.repeat || 'none',
      until: null,
      color: preset.color || COLORS[0],
      remind: state.settings.defaultRemind,
      notes: '',
    };
  }

  f.title.value = v.title;
  f.date.value = v.date;
  f.allDay.checked = !v.start;
  f.start.value = v.start || '09:00';
  f.end.value = v.start ? fromMin(endMinutes(v)) : '10:00';
  f.repeat.value = v.repeat;
  f.until.value = v.until || '';
  f.remind.value = v.remind == null ? '' : String(v.remind);
  f.notes.value = v.notes || '';
  pickedColor = v.color;
  renderColors();
  $('#btnDelete').hidden = !ev;
  $('#btnDuplicate').hidden = !ev;
  $('#deleteChoice').hidden = true;
  syncEditorFields();

  editor.showModal();
  f.title.focus();
  if (ev) f.title.select();
}

function readEditor() {
  const allDay = f.allDay.checked;
  const start = allDay ? null : (f.start.value || '09:00');
  let end = allDay ? null : (f.end.value || null);
  if (start && end && toMin(end) <= toMin(start)) end = fromMin(toMin(start) + 60);
  const repeat = f.repeat.value;
  return {
    title: f.title.value.trim() || 'Без названия',
    date: f.date.value || toKey(today()),
    start,
    end,
    repeat,
    until: repeat !== 'none' && f.until.value ? f.until.value : null,
    color: pickedColor,
    remind: f.remind.value === '' ? null : Number(f.remind.value),
    notes: f.notes.value.trim(),
  };
}

let prevStart = null;
f.start.addEventListener('focus', () => { prevStart = f.start.value; });
f.start.addEventListener('change', () => {
  // Сдвигаем конец вместе с началом, сохраняя длительность
  if (!prevStart || !f.start.value || !f.end.value) return;
  const dur = toMin(f.end.value) - toMin(prevStart);
  if (dur > 0) f.end.value = fromMin(toMin(f.start.value) + dur);
  prevStart = f.start.value;
});
f.allDay.addEventListener('change', syncEditorFields);
f.repeat.addEventListener('change', syncEditorFields);

$('#editorForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = readEditor();
  const target = editing.id && findEvent(editing.id);
  if (target) {
    withUndo('Изменения сохранены', () => Object.assign(target, data));
  } else {
    state.events.push({ id: uid(), exdates: [], ...data });
    saveEvents();
    toast(`Добавлено: ${data.title}`);
  }
  editor.close();
});

$('#btnDuplicate').addEventListener('click', () => {
  state.events.push({ id: uid(), exdates: [], ...readEditor() });
  saveEvents();
  editor.close();
  toast('Создана копия');
});

$('#btnDelete').addEventListener('click', () => {
  const ev = findEvent(editing.id);
  if (!ev) return editor.close();
  if (ev.repeat !== 'none' && editing.key) {
    $('#deleteChoice').hidden = false;
    $('#deleteChoice button').focus();
    return;
  }
  withUndo('Событие удалено', () => { state.events = state.events.filter((x) => x.id !== ev.id); });
  editor.close();
});

$('#deleteChoice').addEventListener('click', (e) => {
  const mode = e.target.dataset.del;
  if (!mode) return;
  const ev = findEvent(editing.id);
  const { key } = editing;
  if (!ev) return editor.close();
  withUndo('Событие удалено', () => {
    if (mode === 'one') {
      ev.exdates = [...(ev.exdates || []), key];
    } else if (mode === 'future' && key > ev.date) {
      ev.until = toKey(addDays(fromKey(key), -1));
    } else {
      state.events = state.events.filter((x) => x.id !== ev.id);
    }
  });
  editor.close();
});

for (const btn of $$('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());
for (const dlg of $$('dialog')) {
  // Клик по затемнению закрывает диалог
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

/* ---------- Быстрое добавление ---------- */

const quickInput = $('#quickInput');

function quickParse() {
  const r = parseQuick(quickInput.value, today());
  if (!r.date) r.date = r.repeat === 'none' || state.cursor >= today() ? state.cursor : today();
  return r;
}

function updateQuickPreview() {
  const preview = $('#quickPreview');
  if (!quickInput.value.trim()) { preview.textContent = ''; return; }
  const r = quickParse();
  const parts = [relativeDay(r.date) || formatDate(r.date), r.start ? `${r.start}–${r.end}` : 'весь день'];
  if (r.repeat !== 'none') parts.push(REPEAT_LABELS[r.repeat].toLowerCase());
  preview.textContent = `${r.title || 'Без названия'} · ${parts.join(', ')}`;
}

quickInput.addEventListener('input', updateQuickPreview);
quickInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { quickInput.value = ''; updateQuickPreview(); quickInput.blur(); }
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    const r = quickParse();
    openEditor({ preset: { title: r.title, date: toKey(r.date), start: r.start, end: r.end, repeat: r.repeat, allDay: !r.start } });
    quickInput.value = '';
    updateQuickPreview();
  }
});

$('#quickForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!quickInput.value.trim()) return;
  const r = quickParse();
  const ev = {
    id: uid(),
    title: r.title || 'Без названия',
    date: toKey(r.date),
    start: r.start,
    end: r.end,
    repeat: r.repeat,
    until: null,
    exdates: [],
    color: COLORS[0],
    remind: r.start ? state.settings.defaultRemind : null,
    notes: '',
  };
  withUndo(`Добавлено: ${ev.title} · ${relativeDay(r.date) || formatDate(r.date)}${r.start ? `, ${r.start}` : ''}`, () => {
    state.events.push(ev);
    // Переходим к дате события, только если её сейчас не видно
    const [from, to] = visibleRange();
    if (r.date < from || r.date > to) {
      state.cursor = r.date;
      state.mini = r.date;
    }
  });
  quickInput.value = '';
  updateQuickPreview();
});

/* ---------- Поиск ---------- */

const searchInput = $('#search');
const searchResults = $('#searchResults');

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return [text.slice(0, i), h('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

function renderSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchResults.hidden = true; return; }
  const t = today();
  const found = state.events
    .filter((ev) => ev.title.toLowerCase().includes(q) || (ev.notes || '').toLowerCase().includes(q))
    .map((ev) => {
      const next = ev.repeat === 'none' ? ev.date : (nextOccurrence(ev, t) || ev.date);
      return { ev, key: next, upcoming: next >= toKey(t) };
    })
    .sort((a, b) => (b.upcoming - a.upcoming) || (a.upcoming ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)))
    .slice(0, 30);

  searchResults.replaceChildren(...(found.length
    ? found.map(({ ev, key }) => h('button', {
      class: `side-item${isPast(ev, key) ? ' is-past' : ''}`,
      type: 'button',
      style: { '--c': ev.color },
      onclick: () => {
        searchResults.hidden = true;
        searchInput.value = '';
        selectDay(fromKey(key), state.view === 'month' ? 'month' : 'day');
        openEditor({ ev, key });
      },
    }, h('span', {}, highlight(ev.title, q),
      h('small', {}, `${capitalize(formatDate(fromKey(key)))} · ${formatTime(ev)}${ev.repeat !== 'none' ? ` · ↻ ${REPEAT_LABELS[ev.repeat].toLowerCase()}` : ''}`))))
    : [h('div', { class: 'side-empty' }, 'Ничего не найдено')]));
  searchResults.hidden = false;
}

searchInput.addEventListener('input', renderSearch);
searchInput.addEventListener('focus', renderSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; renderSearch(); searchInput.blur(); }
  if (e.key === 'Enter') $('button', searchResults)?.click();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) searchResults.hidden = true;
});

/* ---------- Напоминания ---------- */

async function showNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icon.svg', tag: title + body });
    else new Notification(title, { body, icon: 'icon.svg' });
  } catch {
    // Уведомление на экране уже показано
  }
}

function checkReminders() {
  const now = Date.now();
  const fired = readJSON(FIRED_KEY, {}) || {};
  const t = today();
  for (const [key, list] of collect(state.events, t, addDays(t, 1))) {
    for (const { ev } of list) {
      if (ev.remind == null) continue;
      const d = fromKey(key);
      const startMin = ev.start ? toMin(ev.start) : 9 * 60;
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin - ev.remind).getTime();
      const id = `${ev.id}@${key}@${ev.start}@${ev.remind}`;
      // Окно 15 минут: не засыпаем старыми напоминаниями, если вкладку открыли позже
      if (fired[id] || now < at || now - at > 15 * 60 * 1000) continue;
      fired[id] = now;
      const when = ev.start
        ? (ev.remind === 0 ? `Сейчас, ${ev.start}` : `${relativeDay(d) || formatDate(d)} в ${ev.start}`)
        : `${relativeDay(d) || formatDate(d)}, весь день`;
      toast(`🔔 ${ev.title} — ${when}`, { reminder: true, duration: 15000 });
      showNotification(ev.title, when);
    }
  }
  for (const [k, ts] of Object.entries(fired)) if (now - ts > 3 * 86400000) delete fired[k];
  writeJSON(FIRED_KEY, fired);
}

$('#btnNotify').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Этот браузер не поддерживает уведомления');
  if (Notification.permission === 'granted') return toast('Напоминания придут, пока календарь открыт в браузере или установлен как приложение');
  if (Notification.permission === 'denied') return toast('Разрешите уведомления для сайта в настройках браузера');
  const p = await Notification.requestPermission();
  renderFooter();
  if (p === 'granted') toast('Готово! Напоминания включены');
});

/* ---------- Экран уведомлений ---------- */

function toast(message, { action, onAction, reminder = false, duration = 5000 } = {}) {
  const el = h('div', { class: `toast${reminder ? ' is-reminder' : ''}`, role: 'status' }, h('span', {}, message));
  const close = () => el.remove();
  if (action) el.append(h('button', { type: 'button', onclick: () => { close(); onAction(); } }, action));
  else el.append(h('button', { type: 'button', 'aria-label': 'Закрыть', onclick: close }, '✕'));
  const box = $('#toasts');
  box.append(el);
  while (box.childElementCount > 3) box.firstElementChild.remove();
  setTimeout(close, duration);
}

/* ---------- Импорт / экспорт ---------- */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btnExportJson').addEventListener('click', () => {
  download(`calendar-${toKey(today())}.json`, JSON.stringify({ version: 1, events: state.events }, null, 2), 'application/json');
});

$('#btnExportIcs').addEventListener('click', () => {
  download(`calendar-${toKey(today())}.ics`, toICS(state.events), 'text/calendar');
});

$('#btnImport').addEventListener('click', () => $('#importFile').click());

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    let incoming;
    if (/^\s*BEGIN:VCALENDAR/.test(text)) {
      incoming = fromICS(text, uid);
    } else {
      const data = JSON.parse(text);
      incoming = (Array.isArray(data) ? data : data.events || []).map(normalizeEvent);
    }
    incoming = incoming.filter(Boolean);
    if (!incoming.length) return toast('В файле не найдено событий');
    withUndo(`Импортировано событий: ${incoming.length}`, () => {
      const byId = new Map(state.events.map((x) => [x.id, x]));
      for (const ev of incoming) byId.set(ev.id, ev);
      state.events = [...byId.values()];
    });
  } catch {
    toast('Не удалось прочитать файл');
  }
});

/* ---------- Управление ---------- */

$('#btnCreate').addEventListener('click', () => { closeNav(); openEditor(); });
$('#btnToday').addEventListener('click', goToday);
$('#btnPrev').addEventListener('click', () => go(-1));
$('#btnNext').addEventListener('click', () => go(1));
$('#btnMenu').addEventListener('click', openNav);
$('#backdrop').addEventListener('click', closeNav);
$('#btnHelp').addEventListener('click', () => { closeNav(); $('#help').showModal(); });
$('#btnTheme').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  saveSettings();
  applyTheme();
  renderFooter();
});
$('#viewSwitch').addEventListener('click', (e) => {
  if (e.target.dataset.view) setView(e.target.dataset.view);
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if ($('dialog[open]')) return;
  const actions = {
    KeyT: goToday,
    KeyM: () => setView('month'),
    KeyW: () => setView('week'),
    KeyD: () => setView('day'),
    KeyA: () => setView('agenda'),
    KeyN: () => openEditor(),
    KeyQ: () => quickInput.focus(),
    ArrowLeft: () => go(-1),
    ArrowRight: () => go(1),
    Slash: () => (e.shiftKey ? $('#help').showModal() : searchInput.focus()),
    Escape: closeNav,
  };
  const fn = actions[e.code];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

// Свайпы влево/вправо на телефоне листают период
let touchStart = null;
$('#view').addEventListener('touchstart', (e) => {
  touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
$('#view').addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
});

// Изменения из другой вкладки
window.addEventListener('storage', (e) => {
  if (e.key === STORE_KEY) {
    state.events = loadEvents();
    render();
  }
});

// Раз в минуту: линия «сейчас», прошедшие события, смена дня, напоминания
let lastDay = toKey(today());
setInterval(() => {
  const nowKey = toKey(today());
  if (nowKey !== lastDay) {
    lastDay = nowKey;
    render();
  } else {
    for (const line of $$('.now-line')) line.style.top = `${nowTop()}px`;
    renderSideList();
  }
  checkReminders();
}, 30000);

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
checkReminders();
