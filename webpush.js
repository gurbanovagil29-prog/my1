'use strict';

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
