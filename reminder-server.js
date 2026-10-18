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

  return { publicKey, runDue, action, sign };
}

if (typeof module !== 'undefined') {
  module.exports = { createReminderServer };
}
