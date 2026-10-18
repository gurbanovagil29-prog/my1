'use strict';

/*
 * Календари друзей и ссылки: настройки доступа и превращение того, что отдал сервер, в события для показа.
 * Без DOM — проверяется тестами в Node.
 *
 * Чужой календарь показывается слоем поверх своего: его события и задачи становятся событиями «только для
 * просмотра» с полем friend (ключ слоя) и cal = ключ слоя, поэтому цвет и переключатель у слоя свои.
 * Задача друга — блоком «Когда делаю» (☑, занимает время) и отметкой срока ⚑ на весь день (время не занимает).
 */

/* global normalizeEvent, normalizeTask, taskDeadline, toMin, fromMin */

const SHARE_LEVELS = { hidden: 'Скрыто', busy: 'Только занято', details: 'С названиями' };
const BUSY_TITLE = 'Занят';

/** Настройки доступа в ожидаемой форме: { default, cals: { id: уровень }, tasks, notes }. */
function normalizeShareSettings(s) {
  const level = (v, fallback) => (SHARE_LEVELS[v] ? v : fallback);
  const src = s && typeof s === 'object' ? s : {};
  const cals = {};
  for (const [id, v] of Object.entries(src.cals && typeof src.cals === 'object' ? src.cals : {})) if (SHARE_LEVELS[v]) cals[id] = v;
  return { default: level(src.default, 'busy'), cals, tasks: level(src.tasks, 'busy'), notes: src.notes === true };
}

/** Уровень доступа категории. */
const shareLevelOf = (settings, calId) => settings.cals[calId] || settings.default;

/**
 * Строки от сервера ({ kind, id, data }) → { ownerName, cals: Map id → { name, color }, events }.
 * key — ключ слоя: им помечаются события, чтобы они не путались со своими.
 */
function buildLayer(rows, key) {
  let ownerName = null;
  const cals = new Map();
  const events = [];
  const tasks = [];
  for (const r of rows || []) {
    const d = r.data || {};
    if (r.kind === 'owner') ownerName = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : null;
    else if (r.kind === 'calendar') cals.set(r.id, { name: String(d.name || ''), color: d.color || null });
    else if (r.kind === 'event') {
      const ev = d.date ? normalizeEvent({ ...d, id: r.id, title: d.title || BUSY_TITLE }) : null;
      if (ev) events.push({ ev, busy: !d.title });
    } else if (r.kind === 'task') {
      const t = normalizeTask({ ...d, id: r.id, title: d.title || 'Задача' });
      if (t) tasks.push({ t, busy: !d.title });
    }
  }
  const base = (id, extra) => ({
    id: `${key}/${id}`, friend: key, cal: key, repeat: 'none', until: null, exdates: [], endDate: null,
    reminds: [], snooze: null, alarmAt: null, alarmSig: null, alarmLast: null, notes: '', ...extra,
  });
  const out = events.map(({ ev, busy }) => ({
    ...ev, id: `${key}/${ev.id}`, friend: key, cal: key, friendCal: ev.cal, busy,
    reminds: [], snooze: null, alarmAt: null, alarmSig: null, alarmLast: null,
  }));
  const byId = new Map(events.map(({ ev }) => [ev.id, ev]));
  for (const { t, busy } of tasks) {
    const title = busy ? 'Задача' : t.title;
    if (t.plan?.start) {
      const end = t.plan.end || fromMin(Math.min(toMin(t.plan.start) + 60, 1439));
      out.push(base(`plan/${t.id}`, {
        title: `☑ ${title}`, date: t.plan.date, start: t.plan.start, end, friendCal: t.cal, busy, task: true, done: t.done, notes: t.notes,
      }));
    }
    const dl = t.done ? null : taskDeadline(t, t.eventId ? byId.get(t.eventId) : null);
    if (dl) {
      out.push(base(`due/${t.id}`, {
        title: `⚑ ${dl.time ? `${dl.time} ` : ''}${title}`, date: dl.date, start: null, end: null, friendCal: t.cal, busy, task: true, notes: t.notes,
      }));
    }
  }
  return { ownerName, cals, events: out };
}

/** «Аней», «с Машей» → подходит ли к имени «Аня», «Маша»: сравниваем по основе слова. */
function nameMatches(word, name) {
  const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
  const w = norm(word);
  const n = norm(name);
  if (w.length < 2 || !n) return false;
  const stem = w.slice(0, Math.max(2, w.length - 2));
  return n.startsWith(stem) || n.split(/\s+/).some((part) => part.startsWith(stem));
}

if (typeof module !== 'undefined') {
  module.exports = { SHARE_LEVELS, BUSY_TITLE, normalizeShareSettings, shareLevelOf, buildLayer, nameMatches };
}
