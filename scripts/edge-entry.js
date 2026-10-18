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
