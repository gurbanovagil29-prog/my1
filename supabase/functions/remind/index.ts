// @ts-nocheck
// Серверная функция напоминаний календаря. Сгенерировано scripts/build-edge.js — не правьте вручную,
// а измените исходники (core.js, alarms.js, webpush.js, reminder-server.js, scripts/edge-entry.js) и запустите npm run build:edge.

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

/** Индекс дня недели, где понедельник = 0. */
const wdIndex = (d) => (d.getDay() + 6) % 7;

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const toMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
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
  if (!offs.length) return null;
  const maxOff = Math.max(...offs) * MINUTE;
  let best = null;
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
  let best = null;
  for (const s of r.at || []) {
    const t = parseIso(s);
    if (t != null && t > after && (best == null || t < best)) best = t;
  }
  if (r.every) {
    const t = nextEvery(r, after, zone);
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
    ? [item.date, item.start, item.endDate, item.repeat, item.until, item.exdates, item.reminds, item.snooze]
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
      if (item.time && Math.abs(now - deadline) < 5 * MINUTE) body = `Срок: сейчас, ${item.time}`;
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
  const every = p.every || (p.nag ? 60 : null);
  // «напомни позвонить маме в 18» — ровно в 18, а не за час
  if (p.remindWord && !every && !at.length && dueTime) at.push(zonedMs(day, dueTime, tz));
  if (!at.length && !every) return null;
  const deadline = dueKey ? zonedMs(dueKey, dueTime || '23:59', tz) : null;
  return normalizeReminder({
    at: at.map(iso),
    every,
    from: iso(now),
    window: p.window || null,
    until: every && deadline ? iso(deadline) : null,
    keepAfter: Boolean(every && deadline),
    quiet,
    tz,
  });
}

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
    alarmSig, refreshAlarm, dueAlarms, alarmText, spreadTimes, reminderFromParse, describeReminder, inQuiet,
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
 * }
 * push(subscription, payloadString, vapid) → Response
 */

/* global dueAlarms, nextAlarm, alarmText, generateVapidKeys, hmacSha256, b64url, iso */

const ACTION_SNOOZE_MAX = 7 * 24 * 60;

function createReminderServer({ db, push, now = () => Date.now(), actionUrl, subject }) {
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
    const subs = await db.subscriptions([...new Set(rows.map((r) => r.user_id))]);
    const subsOf = (userId) => subs.filter((s) => s.user_id === userId);
    const tzOf = (userId) => subsOf(userId)[0]?.tz || 'UTC';
    const k = await keys();
    const vapid = { publicKey: k.public_key, privateJwk: k.private_jwk, subject };
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
      const payload = JSON.stringify({
        ...text,
        kind: row.kind,
        id: row.id,
        user: row.user_id,
        tag: `${row.kind}:${row.id}`,
        token: await sign(row.user_id, row.kind, row.id),
        actionUrl,
      });
      for (const s of subsOf(row.user_id)) {
        try {
          const res = await push(s, payload, vapid);
          if (res.status === 404 || res.status === 410) await db.deleteSubscription(s.endpoint);
          else if (res.ok) sent += 1;
        } catch {
          // Один недоступный адрес не мешает остальным
        }
      }
    }
    return { due: rows.length, sent };
  }

  /** Кнопки в уведомлении: «Сделал» и «Отложить». Проверяем подпись — менять можно только своё напоминание. */
  async function action({ action: kind, user, type, id, token, minutes }) {
    if (!user || !type || !id || !token) return { status: 400, body: { error: 'bad request' } };
    if (token !== await sign(user, type, id)) return { status: 403, body: { error: 'bad token' } };
    const row = await db.getItem(user, type, id);
    if (!row) return { status: 404, body: { error: 'not found' } };
    const t = now();
    const data = { ...row.data };
    const tzRow = (await db.subscriptions([user]))[0];
    const tz = tzRow?.tz || 'UTC';
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

  return { publicKey, runDue, action, sign, testPush };
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
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// GET — публичный ключ для подписки браузера; POST от расписания — разослать напоминания;
// POST с action — кнопка «Сделал» / «Отложить» из уведомления; action: 'test' — «Проверить push» (нужен вход в аккаунт)
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method === 'GET') return json({ publicKey: await server.publicKey() });
    const body = await req.json().catch(() => ({}));
    if (body.action === 'test') {
      const r = await server.testPush((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
      return json(r.body, r.status);
    }
    if (body.action === 'done' || body.action === 'snooze') {
      const r = await server.action(body);
      return json(r.body, r.status);
    }
    return json(await server.runDue());
  } catch (err) {
    console.error(err);
    return json({ error: String(err?.message || err) }, 500);
  }
});
