'use strict';

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
   digestMessage, dayAgenda, agendaLine, phraseToItem, describePhraseItem, nextKey, DEFAULT_QUIET */

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
          ]],
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

  const send = (chatId, text, buttons = null) => telegram.call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
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
    if (cb.message) {
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
