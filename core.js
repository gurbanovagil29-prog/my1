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

/** Сколько дней длится событие (многодневное — от date до endDate включительно). */
const spanDays = (ev) => (ev.endDate && ev.endDate > ev.date ? dayDiff(fromKey(ev.date), fromKey(ev.endDate)) + 1 : 1);

function compareOccurrences(a, b) {
  return (b.len > 1) - (a.len > 1)
    || a.key.localeCompare(b.key)
    || b.len - a.len
    || (a.ev.start ? 1 : 0) - (b.ev.start ? 1 : 0)
    || (a.ev.start || '').localeCompare(b.ev.start || '')
    || a.ev.title.localeCompare(b.ev.title, 'ru');
}

/**
 * Все вхождения событий в диапазоне дат (включительно): Map<'YYYY-MM-DD', [{ ev, key, day, index, len }]>.
 * key — день начала вхождения (по нему считаются исключения и привязанные задачи), day — день, на который
 * оно попало, index — номер этого дня внутри многодневного события (0 — первый), len — длина в днях.
 */
function collect(events, from, to) {
  const map = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) map.set(toKey(d), []);
  for (const ev of events) {
    const len = spanDays(ev);
    // Многодневное вхождение может начаться раньше диапазона и захватить его начало
    for (let d = addDays(from, 1 - len); d <= to; d = addDays(d, 1)) {
      const key = toKey(d);
      if (!occursOn(ev, key, d)) continue;
      for (let i = 0; i < len; i++) {
        const list = map.get(toKey(addDays(d, i)));
        if (list) list.push({ ev, key, day: toKey(addDays(d, i)), index: i, len });
      }
    }
  }
  for (const list of map.values()) list.sort(compareOccurrences);
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
const WD_WORDS = 'понедельнику|вторнику|среде|четвергу|пятнице|субботе|воскресенью|понедельника|понедельник|вторника|вторник|среды|среду|среда|четверга|четверг|пятницы|пятницу|пятница|субботы|субботу|суббота|воскресенья|воскресенье|пн|вт|ср|чт|пт|сб|вс';

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
 * Возвращает { title, date, endDate, spanDays, start, end, repeat, allDay, tag, priority, matched }:
 * endDate — последний день многодневного события («с пятницы до воскресенья», «на выходных»),
 * spanDays — длительность из «на 3 дня» (конец считается от даты начала), tag — метка категории из «#работа»,
 * priority = 1 для «!» или «важно», matched показывает, что что-то распознано.
 * Поля напоминаний (every, window, times, count, inMinutes, before, nag, remindWord) описаны у r ниже.
 */
function parseQuick(input, base = today()) {
  const r = {
    title: '', date: null, endDate: null, spanDays: 0, start: null, end: null,
    repeat: 'none', allDay: false, tag: null, priority: 0, matched: false,
    // Напоминания: every — повтор в минутах, window — часы повтора, times — «в 9, 14 и 21», count — «3 раза»,
    // inMinutes — «через 30 минут», before — «за час и за 10 минут» (для событий),
    // nag — «пока не сделаю», remindWord — во фразе есть «напомни»
    every: null, window: null, times: null, count: 0, inMinutes: 0, before: null, nag: false, remindWord: false,
    // mention — «@защита»: к какому событию привязать задачу; range — время задано промежутком «с 19 до 23»
    mention: null, range: false,
  };
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
  const makeDate = (d, mo, y) => {
    let year = y ?? base.getFullYear();
    let date = new Date(year, mo, d);
    if (y == null && date < base) date = new Date(++year, mo, d);
    return date.getDate() === d && date.getMonth() === mo ? date : null;
  };
  const fullYear = (y) => (y ? (y.length === 2 ? 2000 + +y : +y) : null);
  const setRange = (a, b) => {
    if (!a || !b) return false;
    if (b < a) b = new Date(b.getFullYear() + 1, b.getMonth(), b.getDate()); // «с 28 декабря по 3 января»
    setDate(a);
    r.endDate = b;
    return true;
  };

  // Метка категории: «#работа», событие-срок: «@защита»
  take('#([^\\s#@,.!?;]+)', (m) => { r.tag = m[1]; });
  take('@([^\\s#@,!?;]+)', (m) => { r.mention = m[1].replace(/[._]+$/, ''); });

  // Важность: «!», «важно», «срочно» или восклицательный знак в конце
  if (/!\s*$/.test(s)) { s = s.replace(/!+\s*$/, ' '); r.priority = 1; r.matched = true; }
  take('!+|важно|срочно', () => { r.priority = 1; });

  // Напоминания. Идут раньше времени и повторов: «каждый час», «в 9, 14 и 21», «с 10 до 19» здесь значат другое
  const REMIND = '(?:(?:напоминай|напоминать|напомни(?:ть)?|пиши)(?: мне)? )?';
  const unitMinutes = (n, unit) => {
    const u = unit.toLowerCase();
    if (u.startsWith('пол')) return 30;
    if (u.startsWith('ч')) return (n || 1) * 60;
    if (u.startsWith('д') || u.startsWith('сут')) return (n || 1) * 1440;
    return n || 1;
  };
  take(',? ?пока не (?:сделаю|скажу|отмечу|выполню)', () => { r.nag = true; });
  take(`${REMIND}(?:каждые|каждый|каждую|раз в) (?:(\\d+) )?(минут[уы]?|мин|час(?:а|ов)?|ч|полчаса)`, (m) => {
    r.every = Math.max(5, unitMinutes(m[1] ? +m[1] : 0, m[2]));
  });
  take(`${REMIND}(?:каждые полчаса|ежечасно)`, (m) => { r.every = /полчаса/i.test(m[0]) ? 30 : 60; });
  if (r.every) {
    take('с (\\d{1,2})(?::(\\d{2}))? до (\\d{1,2})(?::(\\d{2}))?', (m) => {
      const a = +m[1]; const b = +m[3];
      if (a > 23 || b > 23 || a >= b) return false;
      r.window = [`${pad(a)}:${m[2] || '00'}`, `${pad(b)}:${m[4] || '00'}`];
    });
  }
  const UNIT = '(?:\\d+ )?(?:минут[уы]?|мин|час(?:а|ов)?|день|дня|дней|сутки|полчаса)';
  take(`(?:напомни(?:ть)?|напоминание)(?: мне)? за ${UNIT}(?:(?:,|,? и) за ${UNIT})*`, (m) => {
    r.before = [...m[0].matchAll(/за (?:(\d+) )?([а-яё]+)/giu)].map((x) => unitMinutes(x[1] ? +x[1] : 0, x[2]));
  });
  const COUNT = { два: 2, две: 2, дважды: 2, три: 3, трижды: 3, четыре: 4, пять: 5 };
  take('напомни(?:ть)?(?: мне)? (\\d+|два|две|три|четыре|пять|дважды|трижды)(?: раза?)?', (m) => {
    const n = COUNT[m[1].toLowerCase()] || +m[1];
    if (!(n >= 1 && n <= 10)) return false;
    r.count = n;
  });
  const T = '\\d{1,2}(?::\\d{2})?';
  take(`${REMIND}в ${T}(?:(?:, ?${T})+(?:,? и ${T})?| и ${T})`, (m) => {
    const times = [...m[0].matchAll(/(\d{1,2})(?::(\d{2}))?/g)].map((x) => [+x[1], +(x[2] || 0)]);
    if (times.some(([hh, mm]) => hh > 23 || mm > 59)) return false;
    r.times = [...new Set(times.map(([hh, mm]) => `${pad(hh)}:${pad(mm)}`))].sort();
  });
  take('через (?:(\\d+) )?(минут[уы]?|мин|час(?:а|ов)?|полчаса)', (m) => {
    r.inMinutes = unitMinutes(m[1] ? +m[1] : 0, m[2]);
  });
  take('напомни(?:ть)?(?: мне)?|напоминай|напоминать', () => { r.remindWord = true; });

  // Повторы
  take('каждый день|ежедневно', () => { r.repeat = 'daily'; });
  take('по будням|каждый будний день|по рабочим дням', () => { r.repeat = 'weekdays'; });
  take('каждую неделю|еженедельно', () => { r.repeat = 'weekly'; });
  take('каждый месяц|ежемесячно', () => { r.repeat = 'monthly'; });
  take('каждый год|ежегодно', () => { r.repeat = 'yearly'; });
  // «каждую пятницу», «по пятницам» (но не «по пятницу» — это конец периода «со среды по пятницу»)
  take('(?:каждый|каждую|каждое) (понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|по (понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям)', (m) => {
    r.repeat = 'weekly';
    setDate(nextWeekday(base, weekdayFromWord(m[1] || m[2])));
  });

  take('(?:на )?(?:весь|целый) день', () => { r.allDay = true; });

  // Периоды на несколько дней. Идут до времени, чтобы «с 10 по 15 октября» не стало «с 10:00»
  take(`со? (${WD_WORDS}) (?:по|до) (${WD_WORDS})`, (m) => {
    const a = nextWeekday(base, weekdayFromWord(m[1]));
    return setRange(a, nextWeekday(a, weekdayFromWord(m[2])));
  });
  take('с (\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))? (?:по|до) (\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?', (m) => (
    setRange(makeDate(+m[1], +m[2] - 1, fullYear(m[3])), makeDate(+m[4], +m[5] - 1, fullYear(m[6] || m[3])))
  ));
  take('с (\\d{1,2})(?: ([а-яё]+))? (?:по|до) (\\d{1,2}) ([а-яё]+)(?: (\\d{4}))?', (m) => {
    const mo2 = monthFromWord(m[4]);
    const mo1 = m[2] ? monthFromWord(m[2]) : mo2;
    if (mo1 < 0 || mo2 < 0) return false;
    const y = m[5] ? +m[5] : null;
    return setRange(makeDate(+m[1], mo1, y), makeDate(+m[3], mo2, y));
  });
  take('(?:(?:на|в|во) )?(?:(следующие|следующих|эти|этих) )?выходн(?:ые|ых)', (m) => {
    const next = m[1] && /след/i.test(m[1]);
    const sat = next ? addDays(startOfWeek(base), 12) : (wdIndex(base) === 6 ? base : nextWeekday(base, 5));
    setDate(sat);
    if (wdIndex(sat) === 5) r.endDate = addDays(sat, 1);
  });
  take('(?:на )?(?:всю|целую) (?:(эту|следующую) )?неделю', (m) => {
    if (m[1] && /след/i.test(m[1])) {
      const mon = addDays(startOfWeek(base), 7);
      setRange(mon, addDays(mon, 6));
    } else {
      setDate(base);
      if (wdIndex(base) < 6) r.endDate = addDays(startOfWeek(base), 6);
    }
  });
  take('до конца (недели|месяца)', (m) => {
    r.endDate = m[1].toLowerCase() === 'недели' ? addDays(startOfWeek(base), 6) : new Date(base.getFullYear(), base.getMonth() + 1, 0);
  });
  take('на (?:(\\d+) )?(дн(?:я|ей)|день|недел(?:ю|и|ь))', (m) => {
    const n = (m[1] ? +m[1] : 1) * (m[2].toLowerCase().startsWith('нед') ? 7 : 1);
    if (n < 2 || n > 366) return false;
    r.spanDays = n;
  });

  // Интервалы времени
  take(`с (\\d{1,2})(?:[:.](\\d{2}))? до (\\d{1,2})(?:[:.](\\d{2}))?${PERIOD}`, (m) => {
    if (monthFromWord(s.slice(m.index + m[0].length).trim().split(' ')[0]) >= 0) return false;
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
    r.range = true;
  });
  if (!r.start) {
    take('(?:(?:в|с) )?(\\d{1,2}):(\\d{2}) ?[-–—] ?(\\d{1,2})(?::(\\d{2}))?', (m) => {
      const h1 = +m[1]; const m1 = +m[2]; const h2 = +m[3]; const m2 = +(m[4] || 0);
      if (!validTime(h1, m1) || !validTime(h2, m2)) return false;
      r.start = `${pad(h1)}:${pad(m1)}`;
      r.end = `${pad(h2)}:${pad(m2)}`;
      r.range = true;
    });
  }

  // Время с предлогом: «в 15», «в 9:30», «к 7 вечера», «в полдень»
  if (!r.start) take('в полдень', () => { r.start = '12:00'; });
  if (!r.start) {
    // После «до» точка означает дату («до 15.10»), поэтому минуты — только через двоеточие
    take(`(?:(?:в|к) (\\d{1,2})(?:[:.](\\d{2}))?|до (\\d{1,2})(?::(\\d{2}))?(?![.\\d]))(?: ?(?:ч|час(?:а|ов)?))?${PERIOD}`, (m) => {
      const hh = m[1] ?? m[3];
      const mm = m[2] ?? m[4];
      const rest = s.slice(m.index + m[0].length).trim().split(' ')[0];
      if (!mm && monthFromWord(rest) >= 0) return false; // «в 15 октября» — это дата
      const h = applyPeriod(+hh, m[5]); const min = +(mm || 0);
      if (!validTime(h, min)) return false;
      r.start = `${pad(h)}:${pad(min)}`;
    });
  }

  // Даты
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
  take(`(?:(во?|до|к|в следующ(?:ий|ую|ее)|в эт(?:от|у|о)) )?(${WD_WORDS})`, (m) => {
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
  if (r.endDate && r.date && r.endDate <= r.date) r.endDate = null;
  if (r.start && !r.end) r.end = fromMin(toMin(r.start) + 60);
  if (r.start && r.end && toMin(r.end) <= toMin(r.start)) r.end = fromMin(toMin(r.start) + 60);

  let title = s.replace(/\s+/g, ' ').trim()
    .replace(/^(?:в|во|на|к|до|с|со|по)\s+/i, '')
    .replace(/[\s,]+(?:в|во|на|к|до|с|со|по)$/i, '')
    .replace(/^[,.\s-]+|[,\s-]+$/g, '');
  r.title = title ? title[0].toUpperCase() + title.slice(1) : '';
  return r;
}

/* ---------- Импорт / экспорт ---------- */

const icsEscape = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (key) => key.replace(/-/g, '');
const icsDateTime = (key, time) => `${icsDate(key)}T${time.replace(':', '')}00`;

/** categoryOf(ev) — необязательное имя категории для поля CATEGORIES. */
function toICS(events, categoryOf) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Everyday Calendar//RU', 'CALSCALE:GREGORIAN'];
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.id}@everyday-calendar`, `DTSTAMP:${now}`);
    const last = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
    if (ev.start) {
      lines.push(`DTSTART:${icsDateTime(ev.date, ev.start)}`, `DTEND:${icsDateTime(last, fromMin(endMinutes(ev)))}`);
    } else {
      // В .ics конец события «на весь день» указывается следующим днём
      lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.date)}`, `DTEND;VALUE=DATE:${icsDate(toKey(addDays(fromKey(last), 1)))}`);
    }
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);
    if (categoryOf) lines.push(`CATEGORIES:${icsEscape(categoryOf(ev))}`);
    if (ev.notes) lines.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
    if (ev.repeat && ev.repeat !== 'none') {
      const until = ev.until ? `;UNTIL=${icsDate(ev.until)}${ev.start ? 'T235959' : ''}` : '';
      const rule = ev.repeat === 'weekdays' ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : `FREQ=${ev.repeat.toUpperCase()}`;
      lines.push(`RRULE:${rule}${until}`);
      for (const ex of ev.exdates || []) {
        lines.push(ev.start ? `EXDATE:${icsDateTime(ex, ev.start)}` : `EXDATE;VALUE=DATE:${icsDate(ex)}`);
      }
    }
    for (const m of ev.reminds || []) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
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
      if (cur && cur.date) {
        if (cur.endKey && cur.endKey > cur.date) cur.endDate = cur.endKey;
        delete cur.endKey;
        out.push(cur);
      }
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
      if (t) (cur.reminds ||= []).push((+(t[1] || 0)) * 1440 + (+(t[2] || 0)) * 60 + (+(t[3] || 0)));
      continue;
    }
    if (name === 'SUMMARY') cur.title = icsUnescape(value);
    else if (name === 'DESCRIPTION') cur.notes = icsUnescape(value);
    else if (name === 'CATEGORIES') cur.category = icsUnescape(value.split(/(?<!\\),/)[0]);
    else if (name === 'DTSTART') {
      const st = parseIcsStamp(value);
      if (st) { cur.date = st.date; cur.start = st.time; }
    } else if (name === 'DTEND') {
      const st = parseIcsStamp(value);
      if (st && st.time) cur.end = st.time;
      if (st) cur.endKey = st.time ? st.date : toKey(addDays(fromKey(st.date), -1));
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
  return out.map((e) => ({ ...normalizeEvent({ ...e, id: makeId() }), category: e.category || null }));
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
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(e.endDate || '') && e.endDate > e.date ? e.endDate : null,
    repeat: REPEAT_LABELS[e.repeat] ? e.repeat : 'none',
    until: /^\d{4}-\d{2}-\d{2}$/.test(e.until || '') ? e.until : null,
    exdates: Array.isArray(e.exdates) ? e.exdates.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) : [],
    cal: typeof e.cal === 'string' ? e.cal : '',
    // За сколько минут до начала напомнить; старое поле remind (одно число) превращается в список
    reminds: [...new Set((Array.isArray(e.reminds) ? e.reminds : (e.remind != null ? [e.remind] : []))
      .filter((m) => Number.isFinite(m) && m >= 0 && m <= 7 * 1440).map(Math.round))].sort((a, b) => b - a),
    snooze: isIsoOrNull(e.snooze),
    alarmAt: isIsoOrNull(e.alarmAt),
    alarmSig: typeof e.alarmSig === 'string' ? e.alarmSig : null,
    alarmLast: isIsoOrNull(e.alarmLast),
    notes: String(e.notes || ''),
  };
}

/* ---------- Напоминания (правило задачи; расчёт — в alarms.js) ---------- */

const DEFAULT_QUIET = ['23:30', '07:00'];
const iso = (ms) => new Date(ms).toISOString();
const parseIso = (s) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);
const isIsoOrNull = (s) => (parseIso(s) == null ? null : iso(parseIso(s)));

/** Приводит reminder задачи к ожидаемой форме; пустое правило — null. */
function normalizeReminder(r) {
  if (!r || typeof r !== 'object') return null;
  const hm = (t) => (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null);
  const pair = (p) => (Array.isArray(p) && hm(p[0]) && hm(p[1]) ? [p[0], p[1]] : null);
  const at = (Array.isArray(r.at) ? r.at : []).map(parseIso).filter((x) => x != null)
    .sort((a, b) => a - b).slice(0, 30).map(iso);
  const every = Number.isFinite(r.every) && r.every >= 5 ? Math.min(Math.round(r.every), 24 * 60) : null;
  const snooze = parseIso(r.snooze);
  if (!at.length && !every && snooze == null) return null;
  return {
    at,
    every,
    from: every ? iso(parseIso(r.from) ?? Date.now()) : null,
    window: every ? pair(r.window) : null,
    until: every && parseIso(r.until) != null ? iso(parseIso(r.until)) : null,
    keepAfter: Boolean(every && r.keepAfter),
    snooze: snooze == null ? null : iso(snooze),
    quiet: pair(r.quiet) || DEFAULT_QUIET.slice(),
    tz: typeof r.tz === 'string' && r.tz ? r.tz : null,
  };
}

/* ---------- Задачи ---------- */

/**
 * Срок задачи: { date, time }. Если задача привязана к событию — это начало события
 * (для повторяющегося — того вхождения, к которому привязана). Без срока — null.
 */
function taskDeadline(task, ev) {
  if (task.eventId && ev) {
    return { date: ev.repeat === 'none' ? ev.date : (task.eventKey || ev.date), time: ev.start || null };
  }
  return task.due ? { date: task.due, time: task.time || null } : null;
}

function normalizePlan(p) {
  if (!p || typeof p !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return null;
  const hm = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
  const start = hm(p.start);
  const end = start ? hm(p.end) : null;
  return { date: p.date, start, end: end && end > start ? end : null };
}

function normalizeTask(t) {
  if (!t || typeof t !== 'object' || !t.id) return null;
  const isKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const due = isKey(t.due) ? t.due : null;
  return {
    id: String(t.id),
    title: String(t.title || 'Без названия').slice(0, 300),
    due,
    time: due && typeof t.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) ? t.time : null,
    cal: typeof t.cal === 'string' ? t.cal : '',
    priority: t.priority ? 1 : 0,
    done: Boolean(t.done),
    doneAt: t.done && Number.isFinite(t.doneAt) ? t.doneAt : null,
    eventId: t.eventId ? String(t.eventId) : null,
    eventKey: t.eventId && isKey(t.eventKey) ? t.eventKey : null,
    // «Когда делаю»: день и, если задано, промежуток времени
    plan: normalizePlan(t.plan),
    reminder: normalizeReminder(t.reminder),
    alarmAt: isIsoOrNull(t.alarmAt),
    alarmSig: typeof t.alarmSig === 'string' ? t.alarmSig : null,
    alarmLast: isIsoOrNull(t.alarmLast),
    notes: String(t.notes || ''),
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    toKey, fromKey, addDays, addMonths, startOfWeek, wdIndex, toMin, fromMin, endMinutes, spanDays,
    occursOn, collect, nextOccurrence, parseQuick, toICS, fromICS, normalizeEvent, taskDeadline, normalizeTask,
    normalizeReminder, normalizePlan, DEFAULT_QUIET, iso, parseIso, pad,
  };
}
