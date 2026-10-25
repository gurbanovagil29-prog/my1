// @ts-nocheck
// Серверная функция напоминаний календаря. Сгенерировано scripts/build-edge.js — не правьте вручную,
// а измените исходники (core.js, alarms.js, webpush.js, digest.js, phrase.js, reminder-server.js, scripts/edge-entry.js) и запустите npm run build:edge.

// ===== core.js (нужная серверу часть) =====
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
  // «пока не сделаю», «повторяй, пока я не отмечу, что сделал», «напоминай, пока не скажу»
  take(',? ?(?:(?:и )?(?:повторяй|напоминай|напоминать)(?: мне)?,? ?)?пока (?:я )?не (?:сделаю|скажу|отмечу|выполню|нажму)(?:,? что (?:сделал[аио]?|выполнил[аио]?|готово))?', () => { r.nag = true; });
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
  // «напомни за 30, 15 и 5 минут» — одна единица на несколько чисел
  take('(?:напомни(?:ть)?|напоминай|напоминание)(?: мне)? за (\\d+(?:(?:, ?|,? и )\\d+)+) ?(минут[уы]?|мин|час(?:а|ов)?|ч)', (m) => {
    r.before = [...new Set(m[1].split(/,? и |, ?/).map((n) => unitMinutes(+n, m[2])))].sort((a, b) => b - a);
  });
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
  // «напомни в 13:20» — одно время напоминания (несколько — правило выше)
  take(`(?:напомни(?:ть)?|напоминай|напоминание)(?: мне)? в (${T})`, (m) => {
    const [hh, mm = '0'] = m[1].split(':');
    if (+hh > 23 || +mm > 59) return false;
    r.times = [`${pad(+hh)}:${pad(+mm)}`];
    r.remindWord = true;
  });
  take('через (?:(\\d+) )?(минут[уы]?|мин|час(?:а|ов)?|полчаса)', (m) => {
    r.inMinutes = unitMinutes(m[1] ? +m[1] : 0, m[2]);
  });
  take('напомни(?:ть)?(?: мне)?|напоминай|напоминать', () => { r.remindWord = true; });
  // «…, повторяй» без интервала — напоминать, пока не отмечу
  if (r.remindWord || r.times || r.inMinutes) take(',? ?(?:и )?повторяй(?: напоминание)?', () => { r.nag = true; });

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

  // Время без предлога, но с двоеточием: «13:30 созвон»
  if (!r.start) {
    take('(\\d{1,2}):(\\d{2})', (m) => {
      if (!validTime(+m[1], +m[2])) return false;
      r.start = `${pad(+m[1])}:${m[2]}`;
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
    // Остатки от вырезанных частей: «созвон , , .» → «созвон»
    .replace(/\s+([,.;])/g, '$1')
    .replace(/([,;])(?:\s*[,;.])+/g, '$1')
    .replace(/^(?:в|во|на|к|до|с|со|по)\s+/i, '')
    .replace(/[\s,]+(?:в|во|на|к|до|с|со|по)$/i, '')
    .replace(/^[,.\s-]+|[,;.\s-]+$/g, '');
  r.title = title ? title[0].toUpperCase() + title.slice(1) : '';
  return r;
}

const DEFAULT_QUIET = ['23:30', '07:00'];

const iso = (ms) => new Date(ms).toISOString();

const parseIso = (s) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);

/** Приводит reminder задачи к ожидаемой форме; пустое правило — null. */
function normalizeReminder(r) {
  if (!r || typeof r !== 'object') return null;
  const hm = (t) => (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null);
  const pair = (p) => (Array.isArray(p) && hm(p[0]) && hm(p[1]) ? [p[0], p[1]] : null);
  const at = (Array.isArray(r.at) ? r.at : []).map(parseIso).filter((x) => x != null)
    .sort((a, b) => a - b).slice(0, 30).map(iso);
  const every = Number.isFinite(r.every) && r.every >= 5 ? Math.min(Math.round(r.every), 24 * 60) : null;
  const snooze = parseIso(r.snooze);
  // За сколько минут до срока (или до начала «Когда делаю») напомнить: [30, 15, 5]
  const before = [...new Set((Array.isArray(r.before) ? r.before : []).filter((m) => Number.isFinite(m) && m >= 0 && m <= 7 * 1440).map(Math.round))]
    .sort((a, b) => b - a).slice(0, 10);
  if (!at.length && !before.length && !every && snooze == null) return null;
  return {
    at,
    before,
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

// ===== alarms.js =====

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

// ===== webpush.js =====

/*
 * Отправка Web Push без библиотек — только WebCrypto (работает в Deno на сервере Supabase и в Node для тестов).
 * Шифрование содержимого — RFC 8291 (aes128gcm), подпись отправителя — VAPID (RFC 8292, ES256).
 */

const b64url = {
  encode(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** Пара ключей VAPID: publicKey — для браузера (applicationServerKey), privateJwk — хранится на сервере. */
async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64url.encode(raw), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

/** Заголовок Authorization: vapid t=<JWT>, k=<публичный ключ>. */
async function vapidAuthorization(endpoint, { publicKey, privateJwk, subject }) {
  const header = b64url.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url.encode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url.encode(sig)}, k=${publicKey}`;
}

/** Шифрует payload для подписки (keys.p256dh, keys.auth) — тело запроса aes128gcm. */
async function encryptPayload(payload, p256dh, auth) {
  const uaPublic = b64url.decode(p256dh);
  const authSecret = b64url.decode(auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  // IKM = HKDF(auth, ecdh, "WebPush: info" || 0 || ua_public || as_public)
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const ikm = await hmacSha256(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, Uint8Array.of(1)));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: nonce\0'), Uint8Array.of(1)))).slice(0, 12);

  const plain = concat(enc.encode(payload), Uint8Array.of(2)); // 2 — признак последней записи
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, cipher);
}

/**
 * Отправляет уведомление. subscription — { endpoint, p256dh, auth }, vapid — { publicKey, privateJwk, subject }.
 * Возвращает Response: 201 — принято, 404/410 — подписка больше не действует.
 */
async function sendWebPush(subscription, payload, vapid, { ttl = 3600, urgency = 'high', topic } = {}) {
  const body = await encryptPayload(payload, subscription.p256dh, subscription.auth);
  const headers = {
    Authorization: await vapidAuthorization(subscription.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return fetch(subscription.endpoint, { method: 'POST', headers, body });
}

if (typeof module !== 'undefined') {
  module.exports = { b64url, generateVapidKeys, vapidAuthorization, encryptPayload, sendWebPush, hmacSha256 };
}

// ===== digest.js =====

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

// ===== phrase.js =====

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

// ===== reminder-server.js =====

/*
 * Серверная часть напоминаний (функция Supabase «remind»). База и отправка передаются снаружи,
 * поэтому логику можно проверить тестами в Node.
 *
 * db: {
 *   getKeys() → { public_key, private_jwk, hmac_secret } | null,  insertKeys(row),
 *   dueItems(nowIso) → [{ user_id, kind, id, data }],               — задачи и события с alarmAt ≤ сейчас
 *   subscriptions(userIds) → [{ endpoint, user_id, p256dh, auth, tz }],
 *   claim(row, oldAlarmAt, data) → bool,                            — обновить, только если alarmAt не изменился
 *   deleteSubscription(endpoint), getItem(userId, kind, id) → row | null, updateItem(userId, kind, id, data),
 *   userFromToken(accessToken) → userId | null,                    — кто прислал запрос (вход в аккаунт)
 *   — Telegram, приглашения и утренняя сводка (необязательны: без них эти части молчат):
 *   telegramLinks(userIds) → [{ user_id, chat_id, mode }], telegramLinkByChat(chatId), linkTelegram(userId, chatId, username),
 *   takeTelegramCode(code) → { user_id, tz } | null, prefsOf(userIds) → [{ user_id, tz, digest_time, digest_sent }],
 *   savePrefsTz(userId, tz), digestPrefs() → [prefs], claimDigest(userId, key) → bool,
 *   inviteNotices() → [invite], clearInviteNotice(id, notify) → bool, answerInvite(id, userId, status) → bool,
 *   userItems(userId) → [{ kind, id, data }], insertItem(userId, kind, id, data), deleteItem(userId, kind, id),
 * }
 * push(subscription, payloadString, vapid) → Response
 * telegram: { call(method, params) → result } | null — Bot API (токен бота знает только функция)
 */

/* global dueAlarms, nextAlarm, alarmText, generateVapidKeys, hmacSha256, b64url, iso, localParts, dayLabel, refreshAlarm,
   digestMessage, dayAgenda, agendaLine, phraseToItem, describePhraseItem, nextKey, DEFAULT_QUIET, snoozeFromText */

const ACTION_SNOOZE_MAX = 7 * 24 * 60;

const tgEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const capitalizeRu = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const INVITE_ANSWERS = { a: 'accepted', m: 'maybe', d: 'declined' };
const ANSWER_TEXT = { accepted: 'придёт ✓', maybe: 'может быть ?', declined: 'не сможет ✕' };

function createReminderServer({ db, push, now = () => Date.now(), actionUrl, subject, telegram = null }) {
  let keysPromise = null;

  /** Ключи VAPID и секрет для подписи кнопок создаются при первом обращении и хранятся в базе. */
  function keys() {
    keysPromise ||= (async () => {
      let k = await db.getKeys();
      if (!k) {
        const vapid = await generateVapidKeys();
        const secret = b64url.encode(crypto.getRandomValues(new Uint8Array(32)));
        await db.insertKeys({ id: 1, public_key: vapid.publicKey, private_jwk: vapid.privateJwk, hmac_secret: secret });
        k = await db.getKeys(); // если две функции создали ключи одновременно, берём сохранённые
      }
      return k;
    })().catch((err) => { keysPromise = null; throw err; });
    return keysPromise;
  }

  async function sign(userId, kind, id) {
    const k = await keys();
    return b64url.encode(await hmacSha256(new TextEncoder().encode(k.hmac_secret), new TextEncoder().encode(`${userId}:${kind}:${id}`)));
  }

  async function publicKey() {
    return (await keys()).public_key;
  }

  /** Раз в минуту: отправить наступившие напоминания и посчитать следующие. */
  async function runDue() {
    const t = now();
    const rows = await db.dueItems(iso(t));
    if (!rows.length) return { due: 0, sent: 0 };
    const c = await contacts([...new Set(rows.map((r) => r.user_id))]);
    const { tzOf } = c;
    let sent = 0;
    const list = rows.map((row) => ({ kind: row.kind, item: row.data, row }));
    for (const d of dueAlarms(list, t, (item) => tzOf(list.find((x) => x.item === item).row.user_id))) {
      const { row } = list.find((x) => x.item === d.item);
      const data = { ...row.data, alarmAt: d.next, ...(d.fire ? { alarmLast: iso(t) } : {}) };
      // Забираем напоминание себе: если параллельный запуск уже сдвинул alarmAt, второй раз не шлём
      if (!(await db.claim(row, row.data.alarmAt, data))) continue;
      if (!d.fire) continue;
      const tz = tzOf(row.user_id);
      const text = alarmText(row.kind, row.data, d.at, t, tz);
      const short = row.kind === 'task' ? 't' : 'e';
      sent += await deliver(c, row.user_id, {
        push: {
          ...text,
          kind: row.kind,
          id: row.id,
          user: row.user_id,
          tag: `${row.kind}:${row.id}`,
          token: await sign(row.user_id, row.kind, row.id),
          actionUrl,
        },
        tg: {
          text: `🔔 <b>${tgEscape(text.title)}</b>\n${tgEscape(text.body)}`,
          buttons: [[
            ...(row.kind === 'task' ? [{ text: '✓ Сделал', callback_data: `d:${row.id}` }] : []),
            { text: 'Через 15 мин', callback_data: `s:${short}:${row.id}` },
            { text: 'Через час', callback_data: `h:${short}:${row.id}` },
          ], [{ text: '⏰ Другое время', callback_data: `o:${short}:${row.id}` }]],
        },
      });
    }
    return { due: rows.length, sent };
  }

  /* ---------- Доставка: push и/или Telegram ---------- */

  /** Подписки, привязки Telegram и часовые пояса пользователей. */
  async function contacts(userIds) {
    const [subs, links, prefs] = await Promise.all([
      db.subscriptions(userIds),
      telegram && db.telegramLinks ? db.telegramLinks(userIds) : [],
      db.prefsOf ? db.prefsOf(userIds) : [],
    ]);
    const subsOf = (userId) => subs.filter((s) => s.user_id === userId);
    const linkOf = (userId) => links.find((l) => l.user_id === userId) || null;
    const tzOf = (userId) => subsOf(userId)[0]?.tz || prefs.find((p) => p.user_id === userId)?.tz || 'UTC';
    return { subsOf, linkOf, tzOf };
  }

  /** Отправляет сообщение: push на все устройства и/или в Telegram — как выбрал пользователь. Возвращает, сколько доставлено. */
  async function deliver(c, userId, { push: payload, tg }) {
    let sent = 0;
    const link = c.linkOf(userId);
    if (link && link.mode !== 'push' && tg) {
      try {
        await telegram.call('sendMessage', {
          chat_id: link.chat_id, text: tg.text, parse_mode: 'HTML',
          ...(tg.buttons ? { reply_markup: { inline_keyboard: tg.buttons } } : {}),
        });
        sent += 1;
      } catch {
        // Telegram недоступен — push всё равно уйдёт, если включён
      }
    }
    if (!link || link.mode !== 'telegram') {
      const k = await keys();
      const vapid = { publicKey: k.public_key, privateJwk: k.private_jwk, subject };
      for (const s of c.subsOf(userId)) {
        try {
          const res = await push(s, JSON.stringify(payload), vapid);
          if (res.status === 404 || res.status === 410) await db.deleteSubscription(s.endpoint);
          else if (res.ok) sent += 1;
        } catch {
          // Один недоступный адрес не мешает остальным
        }
      }
    }
    return sent;
  }

  /* ---------- Приглашения на события ---------- */

  function inviteWhen(ev, t, tz) {
    if (!ev?.date) return '';
    const days = ev.endDate ? `${dayLabel(ev.date, t, tz)} – ${dayLabel(ev.endDate, t, tz)}` : dayLabel(ev.date, t, tz);
    return `${days}${ev.start ? `, ${ev.start}${ev.end ? `–${ev.end}` : ''}` : ''}`;
  }

  /** Раз в минуту: сообщить о новых, перенесённых и отменённых приглашениях и об ответах на них. */
  async function runInvites() {
    if (!db.inviteNotices) return 0;
    const rows = await db.inviteNotices();
    if (!rows.length) return 0;
    const t = now();
    const c = await contacts([...new Set(rows.flatMap((r) => [r.owner, r.invitee]))]);
    let sent = 0;
    for (const r of rows) {
      if (!(await db.clearInviteNotice(r.id, r.notify))) continue; // уже сообщил параллельный запуск
      const toOwner = r.notify === 'answered';
      const user = toOwner ? r.owner : r.invitee;
      const tz = c.tzOf(user);
      const ev = r.event || {};
      const title = ev.title || 'Событие';
      const when = inviteWhen(ev, t, tz);
      const who = r.owner_name || 'Друг';
      const msg = {
        new: [`📨 ${who} приглашает: ${title}`, capitalizeRu(when)],
        changed: [`🕒 ${who} перенёс «${title}»`, `Теперь: ${when}`],
        cancelled: [`✕ ${who} отменил «${title}»`, capitalizeRu(when)],
        answered: [`${r.invitee_name || 'Друг'} ${ANSWER_TEXT[r.status] || 'ответил'}`, `«${title}», ${when}`],
      }[r.notify];
      if (!msg) continue;
      const ask = r.notify === 'new' || r.notify === 'changed';
      sent += await deliver(c, user, {
        push: {
          title: msg[0], body: msg[1], kind: 'invite', id: r.id, user, tag: `invite:${r.id}`,
          ...(ask ? { token: await sign(user, 'invite', r.id), actionUrl } : {}),
        },
        tg: {
          text: `<b>${tgEscape(msg[0])}</b>\n${tgEscape(msg[1])}${ev.notes && r.notify === 'new' ? `\n\n${tgEscape(ev.notes)}` : ''}`,
          buttons: ask ? [[
            { text: '✓ Приду', callback_data: `i:${r.id}:a` },
            { text: '? Может быть', callback_data: `i:${r.id}:m` },
            { text: '✕ Не смогу', callback_data: `i:${r.id}:d` },
          ]] : null,
        },
      });
    }
    return sent;
  }

  /* ---------- Утренняя сводка ---------- */

  /** Свои события и задачи пользователя, календари — для фраз и сводки. */
  async function itemsOf(userId) {
    const rows = await db.userItems(userId);
    const of = (kind) => rows.filter((r) => r.kind === kind && r.data).map((r) => ({ ...r.data, id: r.id }));
    return { events: of('event'), tasks: of('task'), calendars: of('calendar') };
  }

  /** Раз в минуту: тем, у кого наступило время сводки (по их часам), — «Сегодня 3 события и 2 задачи». */
  async function runDigests() {
    if (!db.digestPrefs) return 0;
    const t = now();
    let sent = 0;
    for (const p of await db.digestPrefs()) {
      const local = localParts(t, p.tz || 'UTC');
      if (!p.digest_time || local.hm < p.digest_time || p.digest_sent === local.key) continue;
      if (!(await db.claimDigest(p.user_id, local.key))) continue;
      // Функция долго не работала — старую сводку уже не шлём
      const [hh, mm] = p.digest_time.split(':').map(Number);
      const [lh, lm] = local.hm.split(':').map(Number);
      if (lh * 60 + lm - (hh * 60 + mm) > 180) continue;
      const { events, tasks } = await itemsOf(p.user_id);
      const m = digestMessage({ events, tasks, key: local.key });
      const c = await contacts([p.user_id]);
      sent += await deliver(c, p.user_id, {
        push: { title: m.title, body: m.body, kind: 'digest', tag: `digest:${local.key}` },
        tg: { text: [`<b>${tgEscape(m.title)}</b>`, ...m.lines.map(tgEscape)].join('\n') },
      });
    }
    return sent;
  }

  /** Всё, что функция делает раз в минуту. */
  async function tick() {
    const r = await runDue();
    // Приглашения и сводка не должны мешать напоминаниям, даже если что-то не так
    const safe = (fn) => fn().catch((err) => { console.error(err); return -1; });
    return { ...r, invites: await safe(runInvites), digests: await safe(runDigests) };
  }

  /** Кнопки в уведомлении: «Сделал» и «Отложить». Проверяем подпись — менять можно только своё напоминание. */
  async function action({ action: kind, user, type, id, token, minutes }) {
    if (!user || !type || !id || !token) return { status: 400, body: { error: 'bad request' } };
    if (token !== await sign(user, type, id)) return { status: 403, body: { error: 'bad token' } };
    return applyAction(user, type, id, kind, minutes);
  }

  /** «Сделал», «Отложить», ответ на приглашение — из push или из Telegram. */
  async function applyAction(user, type, id, kind, minutes) {
    if (type === 'invite') {
      const status = { accept: 'accepted', maybe: 'maybe', decline: 'declined' }[kind];
      if (!status || !db.answerInvite) return { status: 400, body: { error: 'unknown action' } };
      if (!(await db.answerInvite(id, user, status))) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: { ok: true, status } };
    }
    const row = await db.getItem(user, type, id);
    if (!row) return { status: 404, body: { error: 'not found' } };
    const t = now();
    const data = { ...row.data };
    const tz = (await contacts([user])).tzOf(user);
    if (kind === 'done') {
      if (type !== 'task') return { status: 400, body: { error: 'only tasks can be done' } };
      Object.assign(data, { done: true, doneAt: t, alarmAt: null });
    } else if (kind === 'snooze') {
      const m = Math.min(Math.max(Math.round(+minutes || 15), 1), ACTION_SNOOZE_MAX);
      const until = iso(t + m * 60000);
      if (type === 'task') data.reminder = { ...(data.reminder || { at: [], every: null }), snooze: until };
      else data.snooze = until;
      const next = nextAlarm(type, data, t, tz);
      data.alarmAt = next == null ? null : iso(next);
    } else {
      return { status: 400, body: { error: 'unknown action' } };
    }
    // alarmSig не трогаем: устройство увидит новое правило и само пересчитает расписание
    await db.updateItem(user, type, id, data);
    return { status: 200, body: { ok: true } };
  }

  /** Кнопка «Проверить push»: тестовое уведомление на все устройства пользователя и отчёт по каждому. */
  async function testPush(accessToken) {
    const userId = accessToken ? await db.userFromToken(accessToken) : null;
    if (!userId) return { status: 401, body: { error: 'not signed in' } };
    const subs = await db.subscriptions([userId]);
    const k = await keys();
    const vapid = { publicKey: k.public_key, privateJwk: k.private_jwk, subject };
    const payload = JSON.stringify({ title: '🔔 Проверка', body: 'Push-уведомления работают', tag: 'push-test' });
    const results = [];
    for (const s of subs) {
      try {
        const res = await push(s, payload, vapid);
        if (res.status === 404 || res.status === 410) await db.deleteSubscription(s.endpoint);
        const detail = !res.ok && typeof res.text === 'function' ? await res.text().catch(() => '') : '';
        results.push({ endpoint: s.endpoint, status: res.status, ok: res.ok, error: detail ? detail.slice(0, 200) : null });
      } catch (err) {
        results.push({ endpoint: s.endpoint, status: 0, ok: false, error: String(err?.message || err) });
      }
    }
    return { status: 200, body: { devices: subs.length, sent: results.filter((r) => r.ok).length, results } };
  }

  /* ---------- Telegram-бот ---------- */

  const send = (chatId, text, buttons = null, forceReply = false) => telegram.call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    ...(forceReply ? { reply_markup: { force_reply: true, input_field_placeholder: 'через 40 минут / в 17:30' } } : {}),
  });

  const HELP = [
    'Пишите фразы, как в строке календаря:',
    '• завтра в 15 встреча с Аней',
    '• по пятницам в 19 спортзал #личное',
    '• позвонить маме, напоминай каждый час',
    '• сделать проект в четверг с 19 до 23 @защита',
    '• 24 октября в 10 защита проекта ! — в обратный отсчёт',
    '',
    '/today — дела на сегодня, /tomorrow — на завтра, /week — на неделю',
  ].join('\n');

  function agendaText(events, tasks, key, t, tz, header) {
    const { items } = dayAgenda({ events, tasks, key });
    return [`<b>${tgEscape(header || capitalizeRu(dayLabel(key, t, tz)))}</b>`, ...(items.length ? items.map((i) => tgEscape(agendaLine(i))) : ['Свободно 🎉'])].join('\n');
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const text = String(msg.text || '').trim();
    const t = now();
    const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
    if (start?.[1]) {
      const code = await db.takeTelegramCode(start[1]);
      if (!code) return send(chatId, 'Код устарел или уже использован. Откройте в календаре ☰ → Telegram → «Подключить» ещё раз.');
      await db.linkTelegram(code.user_id, chatId, msg.from?.username || null);
      if (code.tz) await db.savePrefsTz(code.user_id, code.tz);
      return send(chatId, `✅ Готово, календарь подключён!\n\n${HELP}`);
    }
    const link = await db.telegramLinkByChat(chatId);
    if (!link) return send(chatId, 'Чтобы подключить бота, откройте календарь → ☰ → «Telegram» → «Подключить».');
    const user = link.user_id;
    const tz = (await contacts([user])).tzOf(user);
    // Ответ на «⏰ Когда напомнить?» — в вопросе спрятана ссылка с тем, что откладываем
    const ref = (msg.reply_to_message?.entities || []).map((e) => e.url || '').find((u) => u.includes('snooze='));
    if (ref) {
      const [short, id] = ref.split('snooze=')[1].split(':');
      const until = snoozeFromText(text, t, tz);
      if (!until) return send(chatId, '🤔 Не понял время. Напишите, например: «через 40 минут», «в 17:30» или «завтра в 9».');
      const res = await applyAction(user, short === 't' ? 'task' : 'event', id, 'snooze', Math.ceil((until - t) / 60000));
      if (res.status !== 200) return send(chatId, 'Не нашёл это напоминание — возможно, его уже удалили.');
      const p = localParts(until, tz);
      return send(chatId, `⏰ Напомню ${dayLabel(p.key, t, tz)} в ${p.hm}`);
    }
    const today = localParts(t, tz).key;
    const cmd = text.toLowerCase().replace(/@\w+$/, '');
    if (/^\/(start|help)$|^помощь$/.test(cmd)) return send(chatId, HELP);
    if (/^\/(today|tomorrow|week)$|^(сегодня|завтра|неделя)$/.test(cmd)) {
      const { events, tasks } = await itemsOf(user);
      if (/tomorrow|завтра/.test(cmd)) return send(chatId, agendaText(events, tasks, nextKey(today), t, tz));
      if (/week|неделя/.test(cmd)) {
        const days = Array.from({ length: 7 }, (_, i) => nextKey(today, i));
        return send(chatId, days.map((k) => agendaText(events, tasks, k, t, tz)).join('\n\n'));
      }
      return send(chatId, agendaText(events, tasks, today, t, tz));
    }
    const { events, calendars } = await itemsOf(user);
    const res = phraseToItem(text, { now: t, tz, calendars, events, newId: () => crypto.randomUUID() });
    if (res.error) return send(chatId, `🤔 ${tgEscape(res.error)}`);
    refreshAlarm(res.kind, res.item, t, tz);
    await db.insertItem(user, res.kind, res.item.id, res.item);
    const calName = calendars.find((x) => x.id === res.item.cal)?.name;
    return send(chatId, `✓ Добавлено: ${tgEscape(describePhraseItem(res, t, tz, calName))}`,
      [[{ text: 'Отменить', callback_data: `u:${res.kind === 'task' ? 't' : 'e'}:${res.item.id}` }]]);
  }

  async function onCallback(cb) {
    const chatId = cb.message?.chat?.id;
    const link = chatId != null ? await db.telegramLinkByChat(chatId) : null;
    let note = 'Готово';
    if (!link) note = 'Бот не подключён к календарю';
    else {
      const user = link.user_id;
      const [op, a, b] = String(cb.data || '').split(':');
      const type = a === 't' ? 'task' : 'event';
      if (op === 'd') note = (await applyAction(user, 'task', a, 'done')).status === 200 ? '✓ Отмечено как сделанное' : 'Задача не найдена';
      else if (op === 's' || op === 'h') {
        const m = op === 's' ? 15 : 60;
        note = (await applyAction(user, type, b, 'snooze', m)).status === 200 ? `Напомню через ${m === 15 ? '15 минут' : 'час'}` : 'Не найдено';
      } else if (op === 'o') {
        const row = await db.getItem(user, type, b);
        if (!row) note = 'Не найдено';
        else {
          note = 'Когда напомнить?';
          await send(chatId, `⏰ Когда напомнить «${tgEscape(row.data?.title || '')}»?<a href="https://t.me/?snooze=${a}:${b}">\u200b</a>\nОтветьте на это сообщение: «через 40 минут», «в 17:30», «завтра в 9».`, null, true);
        }
      } else if (op === 'u') {
        await db.deleteItem(user, type, b);
        note = 'Отменено, удалил';
      } else if (op === 'i') {
        const status = INVITE_ANSWERS[b];
        const ok = status && (await db.answerInvite(a, user, status));
        note = ok ? { accepted: '✓ Вы придёте — событие появится в календаре', maybe: '? Отметил «может быть»', declined: '✕ Отказ отправлен' }[status] : 'Приглашение отменено или не найдено';
      }
    }
    await telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: note }).catch(() => {});
    if (cb.message && !String(cb.data || '').startsWith('o:')) {
      await telegram.call('editMessageText', {
        chat_id: chatId, message_id: cb.message.message_id, text: `${cb.message.text || ''}\n\n${note}`,
      }).catch(() => {});
    }
  }

  /** Сообщение от Telegram (webhook). */
  async function telegramUpdate(update) {
    if (!telegram) return { status: 503, body: { error: 'telegram is not configured' } };
    try {
      if (update?.message?.text) await onMessage(update.message);
      else if (update?.callback_query) await onCallback(update.callback_query);
    } catch (err) {
      console.error(err);
    }
    return { status: 200, body: { ok: true } }; // иначе Telegram будет присылать то же сообщение снова
  }

  /** Подключение webhook (один раз после настройки): адрес функции и секрет для проверки запросов. */
  async function telegramSetup(url, secret) {
    if (!telegram) return { ok: false, error: 'Нет секрета TELEGRAM_BOT_TOKEN в настройках функции' };
    await telegram.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
    await telegram.call('setMyCommands', {
      commands: [
        { command: 'today', description: 'Дела на сегодня' },
        { command: 'tomorrow', description: 'Дела на завтра' },
        { command: 'week', description: 'Дела на неделю' },
        { command: 'help', description: 'Что умеет бот' },
      ],
    });
    const me = await telegram.call('getMe', {});
    return { ok: true, bot: me.username };
  }

  let botName = null;
  async function telegramInfo() {
    if (!telegram) return { bot: null };
    botName ||= (await telegram.call('getMe', {})).username;
    return { bot: botName };
  }

  return { publicKey, runDue, runInvites, runDigests, tick, action, sign, testPush, telegramUpdate, telegramSetup, telegramInfo };
}

if (typeof module !== 'undefined') {
  module.exports = { createReminderServer };
}

// ===== scripts/edge-entry.js =====
/* ---------- Supabase Edge Function «remind» ---------- */
/* global Deno */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || (() => {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    return keys.default || Object.values(keys)[0];
  } catch {
    return null;
  }
})();

/** Запрос к базе от имени сервера (ключ сервиса обходит правила доступа — только здесь). */
async function rest(path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE_KEY, 'Content-Type': 'application/json' };
  if (SERVICE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || null;

/** Telegram Bot API. Токен бота хранится только в секретах функции. */
const telegram = TELEGRAM_TOKEN ? {
  async call(method, params) {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  },
} : null;

/** Секрет, которым Telegram подписывает запросы к webhook: выводится из токена, отдельно хранить не нужно. */
async function webhookSecret() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`calendar-webhook:${TELEGRAM_TOKEN}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

/** Таблицы из update-2.sql могут быть ещё не созданы — тогда эти части просто молчат. */
const quiet = (fn, fallback) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    console.warn(String(err?.message || err));
    return fallback;
  }
};

const q = encodeURIComponent;
const ALARM = q('data->>alarmAt');
const itemFilter = (u, k, id) => `user_id=eq.${q(u)}&kind=eq.${q(k)}&id=eq.${q(id)}`;

const db = {
  async getKeys() { return (await rest('push_keys?id=eq.1&select=*'))[0] || null; },
  async insertKeys(row) { await rest('push_keys', { method: 'POST', body: row, prefer: 'resolution=ignore-duplicates' }); },
  dueItems(nowIso) {
    return rest(`items?select=user_id,kind,id,data&deleted=is.false&kind=in.(event,task)&${ALARM}=lte.${q(nowIso)}&limit=500`);
  },
  async subscriptions(userIds) {
    if (!userIds.length) return [];
    return rest(`push_subscriptions?select=*&user_id=in.(${userIds.map(q).join(',')})&order=updated_at.desc`);
  },
  async claim(row, oldAlarmAt, data) {
    const res = await rest(`items?${itemFilter(row.user_id, row.kind, row.id)}&${ALARM}=eq.${q(oldAlarmAt)}`,
      { method: 'PATCH', body: { data }, prefer: 'return=representation' });
    return res.length > 0;
  },
  async deleteSubscription(endpoint) { await rest(`push_subscriptions?endpoint=eq.${q(endpoint)}`, { method: 'DELETE' }); },
  async getItem(u, k, id) { return (await rest(`items?select=user_id,kind,id,data&${itemFilter(u, k, id)}&deleted=is.false`))[0] || null; },
  async updateItem(u, k, id, data) { await rest(`items?${itemFilter(u, k, id)}`, { method: 'PATCH', body: { data } }); },
  telegramLinks: quiet(async (ids) => (ids.length ? rest(`telegram_links?select=*&user_id=in.(${ids.map(q).join(',')})`) : []), []),
  async telegramLinkByChat(chatId) { return (await rest(`telegram_links?select=*&chat_id=eq.${q(chatId)}`))[0] || null; },
  async linkTelegram(userId, chatId, username) {
    await rest(`telegram_links?chat_id=eq.${q(chatId)}&user_id=neq.${q(userId)}`, { method: 'DELETE' });
    await rest('telegram_links?on_conflict=user_id', {
      method: 'POST', body: { user_id: userId, chat_id: chatId, username, linked_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates',
    });
  },
  async takeTelegramCode(code) {
    const rows = await rest(`telegram_codes?code=eq.${q(code)}&expires_at=gt.${q(new Date().toISOString())}`, { method: 'DELETE', prefer: 'return=representation' });
    return rows[0] || null;
  },
  prefsOf: quiet(async (ids) => (ids.length ? rest(`user_prefs?select=*&user_id=in.(${ids.map(q).join(',')})`) : []), []),
  async savePrefsTz(userId, tz) {
    await rest('user_prefs?on_conflict=user_id', { method: 'POST', body: { user_id: userId, tz }, prefer: 'resolution=merge-duplicates' });
  },
  digestPrefs: quiet(() => rest('user_prefs?select=*&digest_time=not.is.null'), []),
  async claimDigest(userId, key) {
    const rows = await rest(`user_prefs?user_id=eq.${q(userId)}&or=(digest_sent.is.null,digest_sent.lt.${q(key)})`,
      { method: 'PATCH', body: { digest_sent: key }, prefer: 'return=representation' });
    return rows.length > 0;
  },
  inviteNotices: quiet(() => rest('invites?select=*&notify=not.is.null&limit=200'), []),
  async clearInviteNotice(id, notify) {
    const rows = await rest(`invites?id=eq.${q(id)}&notify=eq.${q(notify)}`, { method: 'PATCH', body: { notify: null }, prefer: 'return=representation' });
    return rows.length > 0;
  },
  async answerInvite(id, userId, status) {
    const rows = await rest(`invites?id=eq.${q(id)}&invitee=eq.${q(userId)}&status=neq.cancelled`,
      { method: 'PATCH', body: { status, notify: 'answered', updated_at: new Date().toISOString() }, prefer: 'return=representation' });
    return rows.length > 0;
  },
  userItems(userId) { return rest(`items?select=kind,id,data&user_id=eq.${q(userId)}&deleted=is.false&kind=in.(event,task,calendar)`); },
  async insertItem(userId, kind, id, data) { await rest('items', { method: 'POST', body: { user_id: userId, kind, id, data } }); },
  async deleteItem(userId, kind, id) { await rest(`items?${itemFilter(userId, kind, id)}`, { method: 'PATCH', body: { deleted: true } }); },
  async userFromToken(token) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
    return res.ok ? (await res.json()).id || null : null;
  },
};

const server = createReminderServer({
  db,
  push: sendWebPush,
  actionUrl: `${SUPABASE_URL}/functions/v1/remind`,
  subject: Deno.env.get('VAPID_SUBJECT') || 'https://gurbanovagil29-prog.github.io/my1/',
  telegram,
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// GET — публичный ключ для подписки браузера; ?telegram=setup — подключить бота, ?telegram — имя бота;
// POST от Telegram (с секретом в заголовке) — сообщение боту; POST от расписания — разослать напоминания;
// POST с action — кнопка «Сделал» / «Отложить» из уведомления; action: 'test' — «Проверить push» (нужен вход в аккаунт)
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.searchParams.has('telegram')) {
      if (url.searchParams.get('telegram') === 'setup') {
        return json(await server.telegramSetup(`${SUPABASE_URL}/functions/v1/remind`, TELEGRAM_TOKEN ? await webhookSecret() : ''));
      }
      return json(await server.telegramInfo());
    }
    if (req.method === 'GET') return json({ publicKey: await server.publicKey() });
    const tgSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (tgSecret != null) {
      if (!TELEGRAM_TOKEN || tgSecret !== await webhookSecret()) return json({ error: 'forbidden' }, 403);
      const r = await server.telegramUpdate(await req.json().catch(() => ({})));
      return json(r.body, r.status);
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === 'test') {
      const r = await server.testPush((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
      return json(r.body, r.status);
    }
    if (body.action === 'done' || body.action === 'snooze') {
      const r = await server.action(body);
      return json(r.body, r.status);
    }
    return json(await server.tick());
  } catch (err) {
    console.error(err);
    return json({ error: String(err?.message || err) }, 500);
  }
});
