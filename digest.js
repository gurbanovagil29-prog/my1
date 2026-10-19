'use strict';

/*
 * Утренняя сводка и список дел на день (для push, Telegram и команд бота /today, /week).
 * Без DOM: работает в серверной функции remind и проверяется тестами.
 */

/* global collect, fromKey, toKey, addDays, taskDeadline, endMinutes, fromMin, toMin, dayLabel */

/** Склонение: 1 событие, 2 события, 5 событий. */
function pluralRu(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/**
 * Дела на день key: события (с повторами и многодневными), блоки «Когда делаю», сроки задач;
 * overdue — несделанные задачи со сроком раньше этого дня.
 */
function dayAgenda({ events, tasks, key }) {
  const d = fromKey(key);
  const evById = new Map(events.map((e) => [e.id, e]));
  const items = [];
  for (const o of collect(events, d, d).get(key) || []) {
    const { ev, index, len } = o;
    let start = ev.start;
    let end = ev.start ? fromMin(endMinutes(ev)) : null;
    if (len > 1 && ev.start && !(ev.end && toMin(ev.end) > toMin(ev.start))) {
      // Сплошной многодневный отрезок: в первый день с начала, в последний — до конца
      start = index === 0 ? ev.start : null;
      end = index === len - 1 ? ev.end : null;
    }
    items.push({ kind: 'event', title: ev.title, start, end, allDay: !start });
  }
  const shown = new Set();
  for (const t of tasks) {
    if (t.done || !t.plan || t.plan.date !== key) continue;
    shown.add(t.id);
    items.push({ kind: 'plan', title: t.title, start: t.plan.start, end: t.plan.end, allDay: !t.plan.start });
  }
  const overdue = [];
  for (const t of tasks) {
    if (t.done) continue;
    const dl = taskDeadline(t, t.eventId ? evById.get(t.eventId) : null);
    if (!dl) continue;
    if (dl.date < key) overdue.push({ title: t.title, date: dl.date });
    else if (dl.date === key && !shown.has(t.id)) items.push({ kind: 'task', title: t.title, start: dl.time, end: null, allDay: !dl.time, due: true });
  }
  items.sort((a, b) => (a.allDay - b.allDay) || String(a.start || '').localeCompare(String(b.start || '')));
  return { items, overdue };
}

/** Строка дела: «10:00–11:00 Созвон», «☑ 18:00 Отчёт (срок)», «весь день: ДР Вари». */
function agendaLine(it) {
  const time = it.start ? `${it.start}${it.end ? `–${it.end}` : ''} ` : '';
  if (it.kind === 'task') return `☑ ${time}${it.title} (срок)`;
  if (it.kind === 'plan') return `☑ ${time}${it.title}`;
  return it.allDay ? `весь день: ${it.title}` : `${time}${it.title}`;
}

/** Утренняя сводка: { title, body, lines } — заголовок и текст для push, строки для Telegram. */
function digestMessage({ events, tasks, key }) {
  const { items, overdue } = dayAgenda({ events, tasks, key });
  const nEv = items.filter((i) => i.kind === 'event').length;
  const nTask = items.filter((i) => i.kind !== 'event').length;
  const late = overdue.length ? `Просрочено: ${overdue.length}` : '';
  if (!items.length) {
    return { title: '☀️ Сегодня свободный день 🎉', body: late || 'Ничего не запланировано — хорошего дня!', lines: overdue.map((o) => `⚠️ ${o.title}`) };
  }
  const counts = [
    nEv ? `${nEv} ${pluralRu(nEv, 'событие', 'события', 'событий')}` : '',
    nTask ? `${nTask} ${pluralRu(nTask, 'задача', 'задачи', 'задач')}` : '',
  ].filter(Boolean).join(' и ');
  const first = items.find((i) => i.start);
  const body = [first ? `Первое — ${first.start} ${first.title}` : `${items[0].title}`, late].filter(Boolean).join(' · ');
  return {
    title: `☀️ Сегодня ${counts}`,
    body,
    lines: [...items.map(agendaLine), ...overdue.map((o) => `⚠️ просрочено: ${o.title}`)],
  };
}

if (typeof module !== 'undefined') {
  module.exports = { pluralRu, dayAgenda, agendaLine, digestMessage };
}
