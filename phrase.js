'use strict';

/*
 * Фраза → событие или задача, как в быстрой строке календаря, но без DOM: нужен Telegram-боту
 * (серверная функция remind) и проверяется тестами. Правила те же, что у быстрой строки в app.js:
 * «задача:», повторяющиеся напоминания и «@событие» делают задачу, остальное — событие;
 * «!» или «важно» у события — закрепить в обратном отсчёте.
 */

/* global parseQuick, normalizePlan, collect, addDays, fromKey, toKey, toMin, localParts, zonedMs, reminderFromParse,
   describeReminder, dayLabel, DEFAULT_QUIET, endMinutes, fromMin, nextKey */

const PHRASE_TASK_PREFIX = /^\s*(?:задача|todo|\[\s?\])\s*[:\-–]?\s*/i;
const phraseNorm = (t) => String(t).toLowerCase().replace(/ё/g, 'е');

/** Календарь по метке «#раб»: точное совпадение названия или его начало. */
function calendarByTag(calendars, tag) {
  if (!tag) return null;
  const t = phraseNorm(tag);
  return calendars.find((c) => phraseNorm(c.name) === t) || calendars.find((c) => phraseNorm(c.name).startsWith(t)) || null;
}

/** «@защ» подходит к «Защита проекта»: каждая часть метки — начало какого-нибудь слова названия. */
function phraseMentionMatches(title, mention) {
  const words = phraseNorm(title).split(/[^a-zа-я0-9]+/).filter(Boolean);
  const parts = phraseNorm(mention).split(/[_.\-]+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => words.some((w) => w.startsWith(p)));
}

/** Ближайшее вхождение события с подходящим названием, начинающееся не раньше after (мс). */
function phraseMention(mention, events, after, tz) {
  const today = fromKey(localParts(after, tz).key);
  for (const [key, list] of collect(events, addDays(today, -1), addDays(today, 120))) {
    for (const o of list) {
      if (o.index > 0 || !phraseMentionMatches(o.ev.title, mention)) continue;
      if (zonedMs(key, o.ev.start || '00:00', tz) >= after) return { ev: o.ev, key };
    }
  }
  return null;
}

/**
 * Разбирает фразу. Возвращает { kind: 'event' | 'task', item, cal, linkTitle } или { error }.
 * calendars — [{ id, name }], events — свои события (для «@»), newId() — новый id.
 */
function phraseToItem(text, { now, tz, calendars = [], events = [], quiet = DEFAULT_QUIET, defaultRemind = 10, newId }) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'Пустая фраза' };
  const todayKey = localParts(now, tz).key;
  const base = fromKey(todayKey);
  const r = parseQuick(raw.replace(PHRASE_TASK_PREFIX, ''), base);
  const tagged = calendarByTag(calendars, r.tag);
  const fallback = calendars.find((c) => c.id === 'personal') || calendars[0] || { id: 'personal', name: 'Личное' };
  const hasDate = Boolean(r.date || r.endDate);
  const date = r.date || base;
  let endDate = r.spanDays ? addDays(date, r.spanDays - 1) : r.endDate;
  if (endDate && endDate <= date) endDate = null;
  const isTask = PHRASE_TASK_PREFIX.test(raw) || Boolean(r.every || r.times || r.count || r.inMinutes || r.nag || r.mention);

  if (!isTask) {
    const cal = tagged || fallback;
    return {
      kind: 'event',
      cal,
      item: {
        id: newId(), title: r.title || 'Без названия', date: toKey(date), endDate: endDate ? toKey(endDate) : null,
        start: r.start, end: r.end, repeat: r.repeat, until: null, exdates: [], cal: cal.id,
        reminds: r.before || (r.start ? [defaultRemind] : []), notes: '', pin: Boolean(r.priority),
      },
    };
  }

  let link = null;
  if (r.mention) {
    const after = hasDate || r.start ? zonedMs(toKey(date), r.start ? (r.range ? r.end : r.start) : '00:00', tz) : now;
    link = phraseMention(r.mention, events, Math.max(after, now), tz);
    if (!link) return { error: `Не нашёл событие «@${r.mention}» в ближайшие 4 месяца` };
  }
  // С «@» или промежутком «с 19 до 23» дата и время — это блок «Когда делаю»
  const plan = (link || r.range) && (hasDate || r.start)
    ? normalizePlan({ date: hasDate ? toKey(date) : todayKey, start: r.start, end: r.range ? r.end : null })
    : null;
  let dl = null;
  if (link) dl = { date: link.key, time: link.ev.start || null };
  else if (!plan) {
    if (!hasDate && r.inMinutes) {
      const p = localParts(now + r.inMinutes * 60000, tz);
      dl = { date: p.key, time: p.hm };
    } else if (!hasDate && !r.start) dl = r.times || r.count ? { date: todayKey, time: null } : null;
    else dl = { date: toKey(endDate || (hasDate ? date : base)), time: r.start };
  }
  const cal = tagged || (link ? { id: link.ev.cal } : fallback);
  return {
    kind: 'task',
    cal,
    item: {
      id: newId(), title: r.title || 'Без названия', due: dl?.date || null, time: dl?.time || null, cal: cal.id,
      priority: r.priority, done: false, doneAt: null,
      eventId: link ? link.ev.id : null, eventKey: link && link.ev.repeat !== 'none' ? link.key : null,
      plan, reminder: reminderFromParse(r, { now, tz, quiet, dueKey: dl?.date || null, dueTime: dl?.time || null }), notes: '',
    },
    linkTitle: link ? link.ev.title : null,
  };
}

/** Описание добавленного для ответа бота: «Встреча с Аней · завтра, 15:00–16:00 · Личное». */
function describePhraseItem({ kind, item, cal, linkTitle }, now, tz, calName) {
  const name = calName || cal?.name || '';
  if (kind === 'event') {
    const when = item.endDate
      ? `${dayLabel(item.date, now, tz)} – ${dayLabel(item.endDate, now, tz)}`
      : dayLabel(item.date, now, tz);
    const time = item.start ? `, ${item.start}–${fromMin(endMinutes(item))}` : (item.endDate ? '' : ', весь день');
    return [`${item.title}`, `${when}${time}`, name, item.pin ? '📌 в обратном отсчёте' : ''].filter(Boolean).join(' · ');
  }
  const parts = [`☑ ${item.title}`];
  if (item.plan) parts.push(`когда делаю: ${dayLabel(item.plan.date, now, tz)}${item.plan.start ? `, ${item.plan.start}${item.plan.end ? `–${item.plan.end}` : ''}` : ''}`);
  if (linkTitle) parts.push(`к «${linkTitle}»`);
  else if (item.due) parts.push(`срок: ${dayLabel(item.due, now, tz)}${item.time ? `, ${item.time}` : ''}`);
  if (name) parts.push(name);
  if (item.reminder) parts.push(`🔔 ${describeReminder(item.reminder, now, tz)}`);
  return parts.join(' · ');
}

/**
 * «Когда напомнить?» — ответ словами: «через 40 минут», «в 17:30», «завтра в 9», «40».
 * Возвращает момент (мс) в будущем или null, если не понятно.
 */
function snoozeFromText(text, now, tz) {
  const raw = String(text || '').trim();
  const todayKey = localParts(now, tz).key;
  const bare = raw.match(/^(\d{1,3})\s*(?:м|мин|минут[уы]?)?$/i);
  if (bare && +bare[1] > 0) return now + +bare[1] * 60000;
  const short = raw.match(/^(\d{1,3})\s*(ч|час(?:а|ов)?|д|дн(?:я|ей)?|день)$/i);
  if (short && +short[1] > 0) return now + +short[1] * (/^д/i.test(short[2]) ? 1440 : 60) * 60000;
  const r = parseQuick(` ${raw} `, fromKey(todayKey));
  if (r.inMinutes) return now + r.inMinutes * 60000;
  if (r.date || r.start) {
    const key = r.date ? toKey(r.date) : todayKey;
    let at = zonedMs(key, r.start || '09:00', tz);
    // «в 9», а 9 уже прошло — значит завтра
    if (!r.date && at <= now) at = zonedMs(nextKey(todayKey), r.start, tz);
    return at > now ? at : null;
  }
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = { phraseToItem, describePhraseItem, calendarByTag, phraseMentionMatches, snoozeFromText };
}
