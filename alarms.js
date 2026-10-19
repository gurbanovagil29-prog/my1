'use strict';

/*
 * Напоминания: когда напомнить в следующий раз. Без DOM и без зависимостей, кроме core.js,
 * поэтому один и тот же код работает в браузере, в серверной функции Supabase и в тестах.
 *
 * Все моменты времени — миллисекунды UTC; «на часах» (тихие часы, «в 9:00») считаются
 * в часовом поясе пользователя tz (например, 'Europe/Moscow').
 *
 * У события: reminds — за сколько минут до начала напомнить ([60, 10]), snooze — отложено до.
 * У задачи: reminder = {
 *   at: [ISO…]            — конкретные моменты («в 9, 14 и 21», «через 30 минут», «3 раза»),
 *   every: минут | null   — повторять, пока задача не выполнена,
 *   from: ISO             — от какого момента отсчитывать повтор,
 *   window: ['10:00', '19:00'] | null — повторять только в эти часы,
 *   until: ISO | null, keepAfter — до срока; после срока (keepAfter) — не чаще раза в час,
 *   snooze: ISO | null    — отложено до,
 *   quiet: ['23:30', '07:00'] — тихие часы, tz — часовой пояс,
 * }
 * Без reminder задача напоминает в начале блока «Когда делаю» (plan) и за час до срока, если у срока есть время.
 * Задача события без своего блока молчит: о ней напоминает само событие.
 * alarmAt — следующий момент напоминания (ISO), alarmSig — по каким данным он посчитан.
 */

/* global occursOn, fromKey, toKey, addDays, toMin, iso, parseIso, normalizeReminder, DEFAULT_QUIET */

const MINUTE = 60000;
const LATE_LIMIT = 15 * MINUTE; // опоздавшее больше чем на 15 минут не показываем, просто идём дальше

/* ---------- Часовые пояса ---------- */

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(tz);
}

/** Дата и время «на часах» в поясе tz: { key: 'YYYY-MM-DD', hm: 'HH:MM', min — минут от полуночи }. */
function localParts(ms, tz) {
  const p = Object.fromEntries(dtf(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return { key: `${p.year}-${p.month}-${p.day}`, hm: `${hh}:${p.minute}`, min: +hh * 60 + +p.minute };
}

/** Смещение пояса tz от UTC в минутах в момент ms. */
function tzOffset(ms, tz) {
  const p = Object.fromEntries(dtf(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/** Момент, когда в поясе tz на часах дата key и время hm. */
function zonedMs(key, hm, tz) {
  const [y, m, d] = key.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ms = guess - tzOffset(guess, tz) * MINUTE;
  ms = guess - tzOffset(ms, tz) * MINUTE; // уточнение около перевода часов
  return ms;
}

const nextKey = (key, n = 1) => toKey(addDays(fromKey(key), n));

/* ---------- Правила ---------- */

function inQuiet(min, quiet) {
  const qs = toMin(quiet[0]);
  const qe = toMin(quiet[1]);
  if (qs === qe) return false;
  return qs > qe ? (min >= qs || min < qe) : (min >= qs && min < qe);
}

/** Следующий повтор правила every строго позже after, с учётом окна и тихих часов. */
function nextEvery(r, after, tz) {
  const anchor = parseIso(r.from) ?? after;
  const until = parseIso(r.until) ?? Infinity;
  let step = r.every * MINUTE;
  let base = anchor;
  const firstAfter = (b, s) => b + (Math.floor((after - b) / s) + 1) * s;
  let t = after < anchor ? anchor + step : firstAfter(base, step);
  if (t > until) {
    if (!r.keepAfter) return null;
    // Срок прошёл, а задача не сделана — напоминаем дальше, но не чаще раза в час
    step = Math.max(step, 60 * MINUTE);
    base = until;
    t = after < until ? until : firstAfter(base, step);
  }
  const quiet = r.quiet || DEFAULT_QUIET;
  for (let guard = 0; guard < 20; guard++) {
    const { key, min } = localParts(t, tz);
    if (r.window) {
      const ws = toMin(r.window[0]);
      const we = toMin(r.window[1]);
      if (min < ws) { t = zonedMs(key, r.window[0], tz); continue; }
      if (min > we) { t = zonedMs(nextKey(key), r.window[0], tz); continue; }
    }
    if (inQuiet(min, quiet)) {
      const endsToday = toMin(quiet[0]) > toMin(quiet[1]) ? min < toMin(quiet[1]) : true;
      t = zonedMs(endsToday ? key : nextKey(key), quiet[1], tz);
      continue;
    }
    return t;
  }
  return t;
}

/** Начало вхождения события (все-дневное — в 9:00) с днём key. */
const occurrenceStart = (ev, key, tz) => zonedMs(key, ev.start || '09:00', tz);

/** Ближайшее напоминание о событии строго позже after. */
function nextEventAlarm(ev, after, tz) {
  const snooze = parseIso(ev.snooze);
  if (snooze != null && snooze > after) return snooze;
  const offs = Array.isArray(ev.reminds) ? ev.reminds : [];
  // В точное время — независимо от начала
  let best = null;
  for (const s of ev.remindAt || []) {
    const t = parseIso(s);
    if (t != null && t > after && (best == null || t < best)) best = t;
  }
  if (!offs.length) return best;
  const maxOff = Math.max(...offs) * MINUTE;
  let key = nextKey(localParts(after, tz).key, -1);
  for (let i = 0; i < 800; i++, key = nextKey(key)) {
    if (ev.until && key > ev.until) break;
    if (ev.repeat === 'none' && key > ev.date) break;
    if (key < ev.date) { key = nextKey(ev.date, -1); continue; }
    if (!occursOn(ev, key)) continue;
    const start = occurrenceStart(ev, key, tz);
    if (best != null && start - maxOff > best) break;
    for (const off of offs) {
      const t = start - off * MINUTE;
      if (t > after && (best == null || t < best)) best = t;
    }
    if (ev.repeat === 'none') break;
  }
  return best;
}

/** От чего считать «за N минут»: срок со временем, иначе начало блока «Когда делаю». */
function taskAnchor(task, tz) {
  if (task.due && task.time) return zonedMs(task.due, task.time, tz);
  if (task.plan?.start) return zonedMs(task.plan.date, task.plan.start, tz);
  return null;
}

/** Разовые напоминания задачи: точные моменты и «за N минут до срока». */
function taskSingles(task, tz) {
  const r = task.reminder || {};
  const out = (r.at || []).map(parseIso).filter((t) => t != null);
  const anchor = taskAnchor(task, tz);
  if (anchor != null) for (const m of r.before || []) out.push(anchor - m * MINUTE);
  return out;
}

/** Ближайшее напоминание о задаче строго позже after. */
function nextTaskAlarm(task, after, tz) {
  if (task.done) return null;
  const r = task.reminder;
  if (!r) {
    const plan = task.plan?.start ? zonedMs(task.plan.date, task.plan.start, tz) : null;
    // Задачи события без своего времени напоминают через само событие
    const deadline = task.due && task.time && (!task.eventId || plan != null)
      ? zonedMs(task.due, task.time, tz) - 60 * MINUTE : null;
    const next = [plan, deadline].filter((t) => t != null && t > after);
    return next.length ? Math.min(...next) : null;
  }
  const zone = r.tz || tz;
  const snooze = parseIso(r.snooze);
  if (snooze != null && snooze > after) return snooze;
  const singles = taskSingles(task, zone);
  let best = null;
  for (const t of singles) if (t > after && (best == null || t < best)) best = t;
  if (r.every) {
    // Повтор «если не отметил» начинается после последнего названного напоминания
    const last = singles.length ? Math.max(...singles) : null;
    const rule = last != null && last > (parseIso(r.from) ?? -Infinity) ? { ...r, from: iso(last) } : r;
    const t = nextEvery(rule, after, zone);
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

function nextAlarm(kind, item, after, tz) {
  return kind === 'event' ? nextEventAlarm(item, after, tz) : nextTaskAlarm(item, after, tz);
}

/** От каких данных зависит расписание напоминаний объекта. */
function alarmSig(kind, item) {
  const f = kind === 'event'
    ? [item.date, item.start, item.endDate, item.repeat, item.until, item.exdates, item.reminds, item.snooze, ...(item.remindAt?.length ? [item.remindAt] : [])]
    : [item.done, item.due, item.time, item.eventId, item.plan, item.reminder];
  return JSON.stringify(f);
}

/** Пересчитывает alarmAt, если с прошлого раза поменялось то, от чего он зависит. */
function refreshAlarm(kind, item, now, tz) {
  const sig = alarmSig(kind, item);
  if (item.alarmSig === sig) return false;
  const next = nextAlarm(kind, item, now, tz);
  item.alarmAt = next == null ? null : iso(next);
  item.alarmSig = sig;
  return true;
}

/**
 * Что пора напомнить: для каждого объекта с наступившим alarmAt — показать ли (fire) и следующий момент (next).
 * Один и тот же разбор делают сервер (каждую минуту) и устройство без push.
 */
function dueAlarms(list, now, tzOf) {
  const out = [];
  for (const { kind, item } of list) {
    const at = parseIso(item.alarmAt);
    if (at == null || at > now) continue;
    const tz = tzOf(item);
    const next = nextAlarm(kind, item, now, tz);
    out.push({ kind, item, at, fire: now - at <= LATE_LIMIT && !(kind === 'task' && item.done), next: next == null ? null : iso(next) });
  }
  return out;
}

/* ---------- Тексты ---------- */

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function dayLabel(key, now, tz) {
  const today = localParts(now, tz).key;
  if (key === today) return 'сегодня';
  if (key === nextKey(today)) return 'завтра';
  if (key === nextKey(today, -1)) return 'вчера';
  const d = fromKey(key);
  return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

/** Заголовок и текст уведомления. */
function alarmText(kind, item, at, now, tz) {
  if (kind === 'task') {
    let body = 'Отметьте, когда сделаете';
    if (item.due) {
      const deadline = zonedMs(item.due, item.time || '23:59', tz);
      const when = `${dayLabel(item.due, now, tz)}${item.time ? `, ${item.time}` : ''}`;
      // В пределах 5 минут от срока — «Срок: сейчас», позже — «Срок прошёл»
      const mins = Math.round((deadline - now) / MINUTE);
      if (item.time && Math.abs(now - deadline) < 5 * MINUTE) body = `Срок: сейчас, ${item.time}`;
      else if (item.time && mins > 0 && mins < 180) body = `Через ${mins} мин · ${when}`; // «за 15 минут до созвона»
      else body = deadline < now ? `Срок прошёл: ${when}` : `Срок: ${when}`;
    }
    // Напоминание в начале блока «Когда делаю»
    const planStart = item.plan?.start ? zonedMs(item.plan.date, item.plan.start, tz) : null;
    if (planStart != null && Math.abs(at - planStart) < MINUTE) {
      body = `Пора начинать${item.plan.end ? ` · до ${item.plan.end}` : ''}${item.due ? ` · ${body.charAt(0).toLowerCase()}${body.slice(1)}` : ''}`;
    }
    return { title: `☑ ${item.title}`, body };
  }
  // Ищем вхождение, к которому относится напоминание: ближайшее начало не раньше момента напоминания
  let key = localParts(at, tz).key;
  for (let i = 0; i < 400 && !(occursOn(item, key) && occurrenceStart(item, key, tz) >= at - MINUTE); i++) key = nextKey(key);
  const start = occurrenceStart(item, key, tz);
  const mins = Math.round((start - now) / MINUTE);
  const when = item.start ? `${dayLabel(key, now, tz)} в ${item.start}` : `${dayLabel(key, now, tz)}, весь день`;
  let lead = '';
  if (item.start && mins > 0 && mins < 120) lead = `Через ${mins} мин · `;
  else if (item.start && mins <= 0 && mins > -15) lead = 'Начинается · ';
  return { title: item.title, body: lead + when.charAt(0).toUpperCase() + when.slice(1) };
}

/* ---------- Из быстрой строки ---------- */

/** Равномерно расставляет count напоминаний на день key (до срока или до 20:00). */
function spreadTimes(count, key, dueTime, now, tz) {
  let start = Math.max(now + 15 * MINUTE, zonedMs(key, '10:00', tz));
  let end = dueTime ? zonedMs(key, dueTime, tz) - 30 * MINUTE : zonedMs(key, '20:00', tz);
  if (end - start < (count - 1) * 30 * MINUTE) end = Math.max(end, zonedMs(key, '23:00', tz));
  if (end - start < (count - 1) * 15 * MINUTE) start = now + 5 * MINUTE;
  if (count === 1 || end <= start) return [start];
  const round = (t) => Math.round(t / (5 * MINUTE)) * 5 * MINUTE;
  return Array.from({ length: count }, (_, i) => round(start + ((end - start) * i) / (count - 1)));
}

/**
 * Правило напоминаний задачи из разобранной фразы (parseQuick): every, window, times, count, inMinutes, nag, remindWord.
 * dueKey/dueTime — срок задачи (если есть).
 */
function reminderFromParse(p, { now, tz, quiet = DEFAULT_QUIET, dueKey = null, dueTime = null }) {
  const day = dueKey || localParts(now, tz).key;
  const at = [];
  for (const hm of p.times || []) at.push(zonedMs(day, hm, tz));
  if (p.inMinutes) at.push(now + p.inMinutes * MINUTE);
  if (p.count) at.push(...spreadTimes(p.count, day, dueTime, now, tz));
  // «напомни в 13:20, повторяй» — повторять через 15 минут после первого напоминания; просто «пока не сделаю» — каждый час
  const before = dueTime && Array.isArray(p.before) ? p.before : [];
  const every = p.every || (p.nag ? (at.length === 1 || before.length ? 15 : 60) : null);
  // «напомни позвонить маме в 18» — ровно в 18, а не за час
  if (p.remindWord && !every && !at.length && dueTime) at.push(zonedMs(day, dueTime, tz));
  if (!at.length && !before.length && !every) return null;
  const deadline = dueKey ? zonedMs(dueKey, dueTime || '23:59', tz) : null;
  return normalizeReminder({
    at: at.map(iso),
    before,
    every,
    // Повтор начинается с первого названного напоминания, а не с момента, когда задачу записали
    from: iso(every && at.length ? Math.min(...at) : now),
    window: p.window || null,
    until: every && deadline ? iso(deadline) : null,
    keepAfter: Boolean(every && deadline),
    quiet,
    tz,
  });
}

/** «30 мин», «1 ч», «1 день», «в момент» (0). */
function beforeLabel(m) {
  if (m === 0) return '0 мин';
  if (m % 1440 === 0) return m === 1440 ? 'день' : `${m / 1440} дн.`;
  if (m % 60 === 0) return `${m / 60} ч`;
  return `${m} мин`;
}
const listRu = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}` : xs[0] || '');

/** Короткое описание правила: «каждый час с 10:00 до 19:00», «в 09:00, 14:00, 21:00». */
function describeReminder(r, now, tz) {
  if (!r) return '';
  const parts = [];
  const future = (r.at || []).map(parseIso).filter((t) => t > now);
  if (future.length) {
    const sameDay = future.every((t) => localParts(t, tz).key === localParts(future[0], tz).key);
    parts.push(sameDay
      ? `${future.length > 1 ? `${future.length} раза: ` : ''}${dayLabel(localParts(future[0], tz).key, now, tz)} в ${future.map((t) => localParts(t, tz).hm).join(', ')}`
      : future.map((t) => `${dayLabel(localParts(t, tz).key, now, tz)} ${localParts(t, tz).hm}`).join(', '));
  }
  if (r.before?.length) parts.push(`за ${listRu(r.before.map(beforeLabel))} до срока`);
  if (r.every) {
    const e = r.every;
    const step = e % 60 === 0 ? (e === 60 ? 'каждый час' : `каждые ${e / 60} ч`) : `каждые ${e} мин`;
    parts.push(`${step}${r.window ? ` с ${r.window[0]} до ${r.window[1]}` : ''}, пока не сделано`);
  }
  return parts.join('; ');
}

if (typeof module !== 'undefined') {
  module.exports = {
    localParts, tzOffset, zonedMs, nextAlarm, nextEventAlarm, nextTaskAlarm,
    alarmSig, refreshAlarm, dueAlarms, alarmText, spreadTimes, reminderFromParse, describeReminder, inQuiet, dayLabel, nextKey,
    taskSingles, taskAnchor, beforeLabel,
  };
}
