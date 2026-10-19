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
