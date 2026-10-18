'use strict';

/*
 * Статистика времени и поиск свободного окна. Без DOM, только функции core.js,
 * поэтому всё проверяется тестами в Node.
 *
 * Время считается «на часах» устройства: день — ключ 'YYYY-MM-DD', время — минуты от полуночи.
 * Занятость: события со временем (многодневное — от начала в первый день до конца в последний)
 * и блоки «Когда делаю» у задач (без конца — час). События на весь день время не занимают.
 */

/* global fromKey, addDays, toMin, endMinutes, collect, startOfWeek, parseQuick */

/**
 * Многодневное событие с началом и концом в пределах дня («всю неделю с 9 до 18 работа») —
 * это ежедневный блок с 9 до 18. Если конец раньше начала («с пятницы 19:00 до воскресенья 18:00») —
 * один сплошной отрезок, как поездка.
 */
const isDailySpan = (ev) => Boolean(ev.start && ev.end && ev.endDate && ev.endDate > ev.date && toMin(ev.end) > toMin(ev.start));

/** Отрезки [начало, конец] в минутах, которые вхождение занимает в своём дне. */
function occurrenceMinutes(o) {
  const { ev, index, len } = o;
  if (!ev.start) return null;
  if (len === 1 || isDailySpan(ev)) return [toMin(ev.start), endMinutes(ev)];
  const s = index === 0 ? toMin(ev.start) : 0;
  const e = index === len - 1 ? (ev.end ? toMin(ev.end) : 1440) : 1440;
  return e > s ? [s, e] : null;
}

/** Отрезок блока «Когда делаю» (без конца — час). */
function planMinutes(plan) {
  if (!plan || !plan.start) return null;
  const s = toMin(plan.start);
  const e = plan.end && toMin(plan.end) > s ? toMin(plan.end) : Math.min(s + 60, 1440);
  return [s, e];
}

/** Объединяет пересекающиеся отрезки. */
function mergeIntervals(list) {
  const sorted = list.filter(Boolean).map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it[0] <= last[1]) last[1] = Math.max(last[1], it[1]);
    else out.push(it);
  }
  return out;
}

const totalMinutes = (list) => list.reduce((sum, [s, e]) => sum + e - s, 0);

/* ---------- Статистика ---------- */

/**
 * Сколько минут ушло на каждую категорию с from по to (Date, включительно).
 * Учитываются события со временем (ежедневный блок многодневного — каждый день) и блоки «Когда делаю»;
 * события на весь день и сплошные многодневные (поездки, отпуск) не считаются. Пересечения внутри одной категории считаются один раз.
 * catOf(item) — категория события или задачи. Возвращает { days: [{ key, byCat }], byCat, total }.
 */
function timeStats({ events, tasks = [], from, to, catOf = (x) => x.cal }) {
  const map = collect(events, from, to);
  const days = [];
  const byCat = {};
  let total = 0;
  for (const [key, list] of map) {
    const raw = {};
    const add = (cat, iv) => { if (iv) (raw[cat] = raw[cat] || []).push(iv); };
    for (const o of list) if (o.len === 1 || isDailySpan(o.ev)) add(catOf(o.ev), occurrenceMinutes(o));
    for (const t of tasks) if (t.plan && t.plan.date === key) add(catOf(t), planMinutes(t.plan));
    const day = {};
    for (const [cat, ivs] of Object.entries(raw)) {
      const m = totalMinutes(mergeIntervals(ivs));
      if (!m) continue;
      day[cat] = m;
      byCat[cat] = (byCat[cat] || 0) + m;
      total += m;
    }
    days.push({ key, byCat: day });
  }
  return { days, byCat, total };
}

/* ---------- Свободные окна ---------- */

/** Когда человек не спит: сон ['23:30', '07:00'] → [[420, 1410]]. */
function awakeIntervals(sleep) {
  const s = toMin(sleep[0]);
  const e = toMin(sleep[1]);
  if (s === e) return [[0, 1440]];
  if (s > e) return [[e, s]];
  return [[0, s], [e, 1440]].filter(([a, b]) => b > a);
}

/** Вычитает из отрезков list занятые busy (оба списка — [начало, конец]). */
function subtractIntervals(list, busy) {
  let free = list.map(([s, e]) => [s, e]);
  for (const [bs, be] of mergeIntervals(busy)) {
    free = free.flatMap(([s, e]) => {
      if (be <= s || bs >= e) return [[s, e]];
      return [[s, bs], [be, e]].filter(([a, b]) => b > a);
    });
  }
  return free;
}

/**
 * Свободные окна длиной duration минут в днях keys (['YYYY-MM-DD', …]).
 * sleep — часы сна, buffer — запас до и после других дел, window — только в эти часы [мин, мин],
 * now — { key, min }: сегодняшнее прошедшее время не предлагается.
 * Сначала по одному окну в разные дни, потом остальные; результат по времени: [{ key, start, end, freeUntil }].
 */
function findFreeSlots({ events, tasks = [], keys, duration, sleep, buffer = 15, window = null, now = null, max = 5, step = 15 }) {
  if (!keys.length || !(duration > 0)) return [];
  const map = collect(events, fromKey(keys[0]), fromKey(keys[keys.length - 1]));
  const perDay = [];
  for (const key of keys) {
    if (now && key < now.key) continue;
    let room = awakeIntervals(sleep);
    if (window) room = subtractIntervals(room, [[0, window[0]], [window[1], 1440]]);
    if (now && key === now.key) room = subtractIntervals(room, [[0, Math.ceil(now.min / step) * step]]);
    const busy = [
      ...(map.get(key) || []).map(occurrenceMinutes),
      ...tasks.filter((t) => t.plan && t.plan.date === key).map((t) => planMinutes(t.plan)),
    ].filter(Boolean).map(([s, e]) => [Math.max(0, s - buffer), Math.min(1440, e + buffer)]);
    const slots = [];
    for (const [s, e] of subtractIntervals(room, busy)) {
      const start = Math.ceil(s / step) * step;
      if (start + duration <= e) slots.push({ key, start, end: start + duration, freeUntil: e });
    }
    if (slots.length) perDay.push(slots);
  }
  const picked = perDay.map((slots) => slots[0]);
  const rest = perDay.flatMap((slots) => slots.slice(1));
  return [...picked, ...rest].slice(0, max)
    .sort((a, b) => a.key.localeCompare(b.key) || a.start - b.start);
}

/* ---------- Фраза «найди 2 часа на этой неделе» ---------- */

const SLOT_TRIGGER = /^\s*(?:найди|найти|найдите|поищи|ищи|подбери|свободн(?:о|ое|ые|ый)(?: (?:время|окно|окна))?|окно)(?=\s|$)/i;
const DURATION_WORDS = /\d+(?:[.,]\d+)?\s*(?:ч|час(?:а|ов)?)(?:\s*(?:и\s*)?\d+\s*мин\S*)?(?=\s)|полтора\s+час\S*|полчаса|\d+\s*мин\S*|(?<=\s)час(?=\s)/gi;
const DAY_PARTS = { утр: [360, 720], днём: [720, 1080], днем: [720, 1080], вечер: [1080, 1440] };

/** Длительность в минутах из «2 часа», «1.5 ч», «полтора часа», «полчаса», «час 30 минут», «45 минут». */
function slotDuration(s) {
  const text = s.toLowerCase();
  let m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:ч|час(?:а|ов)?)(?![а-яё])(?:\s*(?:и\s*)?(\d+)\s*мин)?/);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 60) + (m[2] ? +m[2] : 0);
  if (/полтора\s+час/.test(text)) return 90;
  if (/полчаса/.test(text)) return 30;
  m = text.match(/(\d+)\s*мин/);
  if (m) return +m[1];
  if (/(?:^|\s)час(?:\s|$)/.test(text)) return 60;
  return null;
}

/**
 * Разбирает запрос на поиск окна. Не запрос (нет «найди …» или длительности) — null.
 * Иначе { duration, from, to, window, period }: from/to — Date, period — подпись периода.
 */
function parseSlotQuery(input, base) {
  const text = ` ${String(input).replace(/\s+/g, ' ').trim()} `;
  if (!SLOT_TRIGGER.test(text)) return null;
  const duration = slotDuration(text);
  if (!duration || duration > 24 * 60) return null;
  const low = text.toLowerCase();
  let window = null;
  for (const [word, range] of Object.entries(DAY_PARTS)) if (low.includes(` ${word}`)) window = range;

  const sunday = addDays(startOfWeek(base), 6);
  let from = base;
  let to = addDays(base, 6);
  let period = 'ближайшие 7 дней';
  let m;
  if (/следующ\S* недел/.test(low)) {
    from = addDays(startOfWeek(base), 7);
    to = addDays(from, 6);
    period = 'следующая неделя';
  } else if (/(?:на|в) (?:эт\S* |текущ\S* )?недел[еи]|эт\S* недел/.test(low) && !/(?:всю|целую) /.test(low)) {
    to = sunday;
    period = 'эта неделя';
  } else if ((m = low.match(/ближайш\S* (\d+) (?:дн|день)/))) {
    to = addDays(base, Math.max(1, Math.min(+m[1], 60)) - 1);
    period = `ближайшие ${m[1]} дн.`;
  } else if (/(?:в )?эт\S* месяц/.test(low)) {
    to = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    period = 'этот месяц';
  } else {
    // Остальное понимает разбор быстрой строки: «завтра», «в пятницу», «на выходных», «с пн по ср»
    const rest = text.replace(SLOT_TRIGGER, ' ').replace(DURATION_WORDS, ' ');
    const r = parseQuick(rest, base);
    if (r.date || r.endDate) {
      from = r.date || base;
      to = r.endDate || (r.spanDays ? addDays(from, r.spanDays - 1) : from);
      period = null; // подпись составит приложение по датам
    }
    if (r.start && r.end && r.range) window = [toMin(r.start), toMin(r.end)];
  }
  if (from < base) from = base;
  if (to < from) to = from;
  return { duration, from, to, window, period };
}

if (typeof module !== 'undefined') {
  module.exports = {
    isDailySpan, occurrenceMinutes, planMinutes, mergeIntervals, timeStats, awakeIntervals, subtractIntervals,
    findFreeSlots, slotDuration, parseSlotQuery,
  };
}
