'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { build, OUT } = require('../scripts/build-edge.js');

test('собранная функция совпадает с исходниками (npm run build:edge)', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '..', OUT), 'utf8'), build());
});

test('функция работает целиком: ключи, рассылка и кнопки — через PostgREST', async () => {
  const SUPA = 'https://proj.supabase.co';
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const b64 = (b) => Buffer.from(b).toString('base64url');

  const store = {
    keys: [],
    items: [{
      user_id: 'u1', kind: 'task', id: 't1',
      data: { id: 't1', title: 'Позвонить маме', done: false, due: null, time: null, reminder: { at: [], every: 60, from: '2026-10-18T09:00:00.000Z', window: null, until: null, keepAfter: false, snooze: null, quiet: ['23:30', '07:00'], tz: 'Europe/Moscow' }, alarmAt: '2026-10-18T10:00:00.000Z' },
    }],
    subs: [{ endpoint: 'https://push.example/sub1', user_id: 'u1', p256dh: b64(ua.getPublicKey()), auth: b64(auth), tz: 'Europe/Moscow', updated_at: '2026-10-18T00:00:00Z' }],
  };
  const calls = [];
  const pushes = [];

  const fakeFetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const ok = (data, status = 200) => new Response(data === null ? '' : JSON.stringify(data), { status });
    if (url.origin === 'https://push.example') {
      pushes.push({ headers: init.headers, body: Buffer.from(init.body) });
      return new Response('', { status: 201 });
    }
    assert.equal(init.headers.apikey, 'sb_secret_test');
    const table = url.pathname.replace('/rest/v1/', '');
    const p = url.searchParams;
    if (table === 'push_keys') {
      if (method === 'POST') { store.keys.push(JSON.parse(init.body)); return ok(null, 201); }
      return ok(store.keys);
    }
    if (table === 'push_subscriptions') return ok(store.subs);
    if (table === 'items') {
      if (method === 'GET' && p.get('data->>alarmAt')) {
        const lim = p.get('data->>alarmAt').replace('lte.', '');
        return ok(store.items.filter((r) => r.data.alarmAt && r.data.alarmAt <= lim));
      }
      const match = (r) => r.user_id === p.get('user_id').slice(3) && r.kind === p.get('kind').slice(3) && r.id === p.get('id').slice(3);
      if (method === 'GET') return ok(store.items.filter(match));
      if (method === 'PATCH') {
        const guard = p.get('data->>alarmAt');
        const rows = store.items.filter((r) => match(r) && (!guard || r.data.alarmAt === guard.slice(3)));
        for (const r of rows) r.data = JSON.parse(init.body).data;
        return ok(init.headers.Prefer === 'return=representation' ? rows : null);
      }
    }
    return new Response('not found', { status: 404 });
  };

  let handler;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: SUPA, SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }) })[k] },
    serve: (h) => { handler = h; },
  };
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-')), 'index.mjs');
  fs.writeFileSync(tmp, build());
  try {
    await import(pathToFileURL(tmp).href);

    // GET: публичный ключ (создаётся при первом обращении)
    const keyRes = await handler(new Request(`${SUPA}/functions/v1/remind`));
    const { publicKey } = await keyRes.json();
    assert.match(publicKey, /^[A-Za-z0-9_-]{87}$/);
    assert.equal(store.keys.length, 1);
    assert.equal(keyRes.headers.get('access-control-allow-origin'), '*');

    // POST от расписания: напоминание уходит, alarmAt сдвигается на час
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-10-18T10:00:30Z');
    let run;
    try {
      run = await (await handler(new Request(`${SUPA}/functions/v1/remind`, { method: 'POST', body: '{}' }))).json();
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(run, { due: 1, sent: 1 });
    assert.equal(store.items[0].data.alarmAt, '2026-10-18T11:00:00.000Z');
    assert.ok(calls.some((c) => c.startsWith('PATCH /rest/v1/items?user_id=eq.u1&kind=eq.task&id=eq.t1&data-%3E%3EalarmAt=eq.')), calls.join('\n'));

    // Уведомление зашифровано для этой подписки и подписано VAPID
    assert.equal(pushes.length, 1);
    assert.match(pushes[0].headers.Authorization, /^vapid t=.+, k=/);
    const body = pushes[0].body;
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 21 + body[20]);
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const ikm = hmac(hmac(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
    const cipher = body.subarray(21 + body[20]);
    d.setAuthTag(cipher.subarray(cipher.length - 16));
    const msg = JSON.parse(Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]).subarray(0, -1).toString());
    assert.equal(msg.title, '☑ Позвонить маме');
    assert.equal(msg.actionUrl, `${SUPA}/functions/v1/remind`);

    // Кнопка «Сделал» из уведомления
    const done = await handler(new Request(`${SUPA}/functions/v1/remind`, {
      method: 'POST',
      body: JSON.stringify({ action: 'done', user: msg.user, type: msg.kind, id: msg.id, token: msg.token }),
    }));
    assert.equal(done.status, 200);
    assert.equal(store.items[0].data.done, true);
    assert.equal(store.items[0].data.alarmAt, null);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.Deno;
  }
});
