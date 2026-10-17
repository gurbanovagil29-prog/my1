'use strict';

/*
 * Логика без DOM: даты, повторы, разбор фраз быстрого добавления, импорт/экспорт.
 * Подключается в браузере как обычный скрипт и в Node — для тестов.
 */

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WD_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const REPEAT_LABELS = {
  none: 'Не повторять',
  daily: 'Каждый день',
  weekdays: 'По будням (пн–пт)',
  weekly: 'Каждую неделю',
  monthly: 'Каждый месяц',
  yearly: 'Каждый год',
};

/* ---------- Даты ---------- */

const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const today = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const addMonths = (d, n) => {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  return new Date(y, m, Math.min(d.getDate(), daysInMonth(y, m)));
};
/** Индекс дня недели, где понедельник = 0. */
const wdIndex = (d) => (d.getDay() + 6) % 7;
const startOfWeek = (d) => addDays(d, -wdIndex(d));
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayDiff = (a, b) => Math.round((b - a) / 86400000);

const toMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (m) => {
  const v = Math.max(0, Math.min(1439, Math.round(m)));
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
};
const snap = (v, step) => Math.round(v / step) * step;

/* ---------- Повторы ---------- */

function occursOn(ev, key, date = fromKey(key)) {
  if (key < ev.date) return false;
  if (ev.until && key > ev.until) return false;
  if (ev.exdates && ev.exdates.includes(key)) return false;
  const base = fromKey(ev.date);
  switch (ev.repeat) {
    case 'daily': return true;
    case 'weekdays': return wdIndex(date) < 5;
    case 'weekly': return date.getDay() === base.getDay();
    case 'monthly': return date.getDate() === base.getDate();
    case 'yearly': return date.getDate() === base.getDate() && date.getMonth() === base.getMonth();
    default: return key === ev.date;
  }
}

/** Конец события в минутах от полуночи (без конца — час, максимум до 24:00). */
function endMinutes(ev) {
  const s = toMin(ev.start);
  let e = ev.end ? toMin(ev.end) : s + 60;
  if (e <= s) e = s + 30;
  return Math.min(e, 1440);
}

function compareOccurrences(a, b) {
  return (a.ev.start ? 1 : 0) - (b.ev.start ? 1 : 0)
    || (a.ev.start || '').localeCompare(b.ev.start || '')
    || a.ev.title.localeCompare(b.ev.title, 'ru');
}

/** Все вхождения событий в диапазоне дат (включительно): Map<'YYYY-MM-DD', [{ev, key}]>. */
function collect(events, from, to) {
  const map = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const key = toKey(d);
    const list = [];
    for (const ev of events) if (occursOn(ev, key, d)) list.push({ ev, key });
    list.sort(compareOccurrences);
    map.set(key, list);
  }
  return map;
}

/** Ближайшая дата события начиная с from (или дата начала, если вхождений впереди нет). */
function nextOccurrence(ev, from, horizon = 800) {
  let d = fromKey(ev.date) > from ? fromKey(ev.date) : from;
  for (let i = 0; i < horizon; i++, d = addDays(d, 1)) {
    const key = toKey(d);
    if (ev.until && key > ev.until) break;
    if (occursOn(ev, key, d)) return key;
  }
  return null;
}

/* ---------- Быстрое добавление ---------- */

const MONTH_STEMS = [['янв', 0], ['фев', 1], ['мар', 2], ['апр', 3], ['мая', 4], ['май', 4], ['июн', 5], ['июл', 6], ['авг', 7], ['сен', 8], ['окт', 9], ['ноя', 10], ['дек', 11]];
const WD_STEMS = [['пон', 0], ['пн', 0], ['вт', 1], ['ср', 2], ['чет', 3], ['чт', 3], ['пят', 4], ['пт', 4], ['суб', 5], ['сб', 5], ['вос', 6], ['вс', 6]];
const WD_WORDS = 'понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс';

const stemIndex = (stems, word) => {
  const w = (word || '').toLowerCase();
  for (const [stem, i] of stems) if (w.startsWith(stem)) return i;
  return -1;
};
const monthFromWord = (w) => stemIndex(MONTH_STEMS, w);
const weekdayFromWord = (w) => stemIndex(WD_STEMS, w);

/** Ближайший день недели wd (пн = 0), начиная с base включительно. */
const nextWeekday = (base, wd) => addDays(base, (wd - wdIndex(base) + 7) % 7);

function applyPeriod(h, period) {
  if (!period) return h;
  const p = period.toLowerCase();
  if ((p === 'дня' || p === 'вечера') && h < 12) return h + 12;
  if (p === 'ночи' && h === 12) return 0;
  return h;
}

/**
 * Разбирает фразу вида «завтра в 15 встреча с Аней» или «по пятницам с 19 до 21 спортзал».
 * Возвращает { title, date, start, end, repeat, allDay, matched } — matched показывает, что что-то распознано.
 */
function parseQuick(input, base = today()) {
  const r = { title: '', date: null, start: null, end: null, repeat: 'none', allDay: false, matched: false };
  let s = ` ${String(input).replace(/\s+/g, ' ').trim()} `;
  const PERIOD = '(?: (утра|дня|вечера|ночи))?';

  // Каждое правило ищет фразу целиком (с границами по пробелам) и при успехе вырезает её из текста.
  const take = (src, fn) => {
    const re = new RegExp(`(?<=\\s)(?:${src})(?=[\\s,.!?;])`, 'giu');
    for (const m of s.matchAll(re)) {
      if (fn(m) === false) continue;
      s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
      r.matched = true;
      return true;
    }
    return false;
  };
  const validTime = (h, m) => h >= 0 && h < 24 && m >= 0 && m < 60;
  const setDate = (d) => { if (!r.date) r.date = d; };

  // Повторы
  take('каждый день|ежедневно', () => { r.repeat = 'daily'; });
  take('по будням|каждый будний день|по рабочим дням', () => { r.repeat = 'weekdays'; });
  take('каждую неделю|еженедельно', () => { r.repeat = 'weekly'; });
  take('каждый месяц|ежемесячно', () => { r.repeat = 'monthly'; });
  take('каждый год|ежегодно', () => { r.repeat = 'yearly'; });
  take('(?:каждый|каждую|каждое|по) (понедельник(?:ам)?|вторник(?:ам)?|сред(?:у|ам)|четверг(?:ам)?|пятниц(?:у|ам)|суббот(?:у|ам)|воскресень(?:е|ям))', (m) => {
    r.repeat = 'weekly';
    setDate(nextWeekday(base, weekdayFromWord(m[1])));
  });

  take('(?:на )?(?:весь|целый) день', () => { r.allDay = true; });

  // Интервалы времени
  take(`с (\\d{1,2})(?:[:.](\\d{2}))? до (\\d{1,2})(?:[:.](\\d{2}))?${PERIOD}`, (m) => {
    let h1 = +m[1]; const m1 = +(m[2] || 0);
    let h2 = +m[3]; const m2 = +(m[4] || 0);
    if (m[5]) {
      const h2p = applyPeriod(h2, m[5]);
      if (h2p !== h2 && h1 < 12 && h1 + 12 <= h2p) h1 += 12;
      h2 = h2p;
    }
    if (!validTime(h1, m1) || !validTime(h2, m2)) return false;
    r.start = `${pad(h1)}:${pad(m1)}`;
    r.end = `${pad(h2)}:${pad(m2)}`;
  });
  if (!r.start) {
    take('(?:(?:в|с) )?(\\d{1,2}):(\\d{2}) ?[-–—] ?(\\d{1,2})(?::(\\d{2}))?', (m) => {
      const h1 = +m[1]; const m1 = +m[2]; const h2 = +m[3]; const m2 = +(m[4] || 0);
      if (!validTime(h1, m1) || !validTime(h2, m2)) return false;
      r.start = `${pad(h1)}:${pad(m1)}`;
      r.end = `${pad(h2)}:${pad(m2)}`;
    });
  }

  // Время с предлогом: «в 15», «в 9:30», «к 7 вечера», «в полдень»
  if (!r.start) take('в полдень', () => { r.start = '12:00'; });
  if (!r.start) {
    take(`(?:в|к) (\\d{1,2})(?:[:.](\\d{2}))?(?: ?(?:ч|час(?:а|ов)?))?${PERIOD}`, (m) => {
      const rest = s.slice(m.index + m[0].length).trim().split(' ')[0];
      if (!m[2] && monthFromWord(rest) >= 0) return false; // «в 15 октября» — это дата
      const h = applyPeriod(+m[1], m[3]); const min = +(m[2] || 0);
      if (!validTime(h, min)) return false;
      r.start = `${pad(h)}:${pad(min)}`;
    });
  }

  // Даты
  const makeDate = (d, mo, y) => {
    let year = y ?? base.getFullYear();
    let date = new Date(year, mo, d);
    if (y == null && date < base) date = new Date(++year, mo, d);
    return date.getDate() === d && date.getMonth() === mo ? date : null;
  };
  take('(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?', (m) => {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    const d = makeDate(+m[1], +m[2] - 1, y);
    if (!d) return false;
    setDate(d);
  });
  take('(\\d{1,2}) ([а-яё]+)(?: (\\d{4}))?', (m) => {
    const mo = monthFromWord(m[2]);
    if (mo < 0) return false;
    const d = makeDate(+m[1], mo, m[3] ? +m[3] : null);
    if (!d) return false;
    setDate(d);
  });
  take('сегодня', () => setDate(base));
  take('послезавтра', () => setDate(addDays(base, 2)));
  take('завтра', () => setDate(addDays(base, 1)));
  take('через (?:(\\d+) )?(дн(?:я|ей)|день|недел(?:ю|и|ь)|месяц(?:а|ев)?)', (m) => {
    const n = m[1] ? +m[1] : 1;
    const unit = m[2].toLowerCase();
    if (unit.startsWith('нед')) setDate(addDays(base, n * 7));
    else if (unit.startsWith('мес')) setDate(addMonths(base, n));
    else setDate(addDays(base, n));
  });
  take(`(?:(во?|в следующ(?:ий|ую|ее)|в эт(?:от|у|о)) )?(${WD_WORDS})`, (m) => {
    const wd = weekdayFromWord(m[2]);
    if (m[1] && /след/i.test(m[1])) setDate(nextWeekday(addDays(startOfWeek(base), 7), wd));
    else setDate(nextWeekday(base, wd));
  });

  // Время без предлога: «15:30»
  if (!r.start) {
    take(`(\\d{1,2}):(\\d{2})${PERIOD}`, (m) => {
      const h = applyPeriod(+m[1], m[3]); const min = +m[2];
      if (!validTime(h, min)) return false;
      r.start = `${pad(h)}:${pad(min)}`;
    });
  }

  if (r.allDay) { r.start = null; r.end = null; }
  if (r.start && !r.end) r.end = fromMin(toMin(r.start) + 60);
  if (r.start && r.end && toMin(r.end) <= toMin(r.start)) r.end = fromMin(toMin(r.start) + 60);

  let title = s.replace(/\s+/g, ' ').trim()
    .replace(/^(?:в|во|на|к)\s+/i, '')
    .replace(/[\s,]+(?:в|во|на|к)$/i, '')
    .replace(/^[,.\s-]+|[,\s-]+$/g, '');
  r.title = title ? title[0].toUpperCase() + title.slice(1) : '';
  return r;
}

/* ---------- Импорт / экспорт ---------- */

const icsEscape = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (key) => key.replace(/-/g, '');
const icsDateTime = (key, time) => `${icsDate(key)}T${time.replace(':', '')}00`;

function toICS(events) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Everyday Calendar//RU', 'CALSCALE:GREGORIAN'];
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.id}@everyday-calendar`, `DTSTAMP:${now}`);
    if (ev.start) {
      lines.push(`DTSTART:${icsDateTime(ev.date, ev.start)}`, `DTEND:${icsDateTime(ev.date, fromMin(endMinutes(ev)))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.date)}`, `DTEND;VALUE=DATE:${icsDate(toKey(addDays(fromKey(ev.date), 1)))}`);
    }
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);
    if (ev.notes) lines.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
    if (ev.repeat && ev.repeat !== 'none') {
      const until = ev.until ? `;UNTIL=${icsDate(ev.until)}${ev.start ? 'T235959' : ''}` : '';
      const rule = ev.repeat === 'weekdays' ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : `FREQ=${ev.repeat.toUpperCase()}`;
      lines.push(`RRULE:${rule}${until}`);
      for (const ex of ev.exdates || []) {
        lines.push(ev.start ? `EXDATE:${icsDateTime(ex, ev.start)}` : `EXDATE;VALUE=DATE:${icsDate(ex)}`);
      }
    }
    if (ev.remind != null) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${ev.remind}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

const icsUnescape = (t) => t.replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1');

/** Разбирает DTSTART/DTEND/EXDATE: даты, локальное время и UTC (…Z) переводит в локальные дату и время. */
function parseIcsStamp(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  const d = m[7]
    ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))
    : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return { date: toKey(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

function fromICS(text, makeId) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let cur = null;
  let inAlarm = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'BEGIN:VALARM') { inAlarm = true; continue; }
    if (line === 'END:VALARM') { inAlarm = false; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.date) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).split(';')[0].toUpperCase();
    const value = line.slice(i + 1);
    if (inAlarm) {
      const t = name === 'TRIGGER' && value.match(/^-P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
      if (t) cur.remind = (+(t[1] || 0)) * 1440 + (+(t[2] || 0)) * 60 + (+(t[3] || 0));
      continue;
    }
    if (name === 'SUMMARY') cur.title = icsUnescape(value);
    else if (name === 'DESCRIPTION') cur.notes = icsUnescape(value);
    else if (name === 'DTSTART') {
      const st = parseIcsStamp(value);
      if (st) { cur.date = st.date; cur.start = st.time; }
    } else if (name === 'DTEND') {
      const st = parseIcsStamp(value);
      if (st && st.time) cur.end = st.time;
    } else if (name === 'EXDATE') {
      for (const v of value.split(',')) { const st = parseIcsStamp(v); if (st) cur.exdates.push(st.date); }
    } else if (name === 'RRULE') {
      const rule = Object.fromEntries(value.split(';').map((p) => p.split('=')));
      const freq = (rule.FREQ || '').toLowerCase();
      if (freq === 'weekly' && rule.BYDAY === 'MO,TU,WE,TH,FR') cur.repeat = 'weekdays';
      else if (['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) cur.repeat = freq;
      if (rule.UNTIL) { const st = parseIcsStamp(rule.UNTIL); if (st) cur.until = st.date; }
    }
  }
  return out.map((e) => normalizeEvent({ ...e, id: makeId() }));
}

/** Приводит событие к ожидаемой форме; возвращает null для мусора. */
function normalizeEvent(e) {
  if (!e || typeof e !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return null;
  const time = (t) => (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null);
  const start = time(e.start);
  return {
    id: String(e.id),
    title: String(e.title || 'Без названия').slice(0, 300),
    date: e.date,
    start,
    end: start ? time(e.end) : null,
    repeat: REPEAT_LABELS[e.repeat] ? e.repeat : 'none',
    until: /^\d{4}-\d{2}-\d{2}$/.test(e.until || '') ? e.until : null,
    exdates: Array.isArray(e.exdates) ? e.exdates.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) : [],
    color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#4f6bed',
    remind: Number.isFinite(e.remind) && e.remind >= 0 ? e.remind : null,
    notes: String(e.notes || ''),
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    toKey, fromKey, addDays, addMonths, startOfWeek, wdIndex, toMin, fromMin, endMinutes,
    occursOn, collect, nextOccurrence, parseQuick, toICS, fromICS, normalizeEvent,
  };
}
