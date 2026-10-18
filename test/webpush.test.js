'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wp = require('../webpush.js');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Расшифровка aes128gcm по RFC 8291 средствами node:crypto — независимо от webpush.js. */
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const ecdh = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, ecdh), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'последняя запись помечена разделителем 2');
  return plain.subarray(0, plain.length - 1).toString();
}

test('содержимое уведомления шифруется по RFC 8291', async () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: '☑ Позвонить маме', body: 'Срок: сегодня, 18:00' });
  const body = Buffer.from(await wp.encryptPayload(msg, wp.b64url.encode(ua.getPublicKey()), wp.b64url.encode(auth)));
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(decrypt(body, ua, auth), msg);
});

test('подпись VAPID проверяется публичным ключом', async () => {
  const keys = await wp.generateVapidKeys();
  const header = await wp.vapidAuthorization('https://web.push.apple.com/abc', { ...keys, subject: 'mailto:me@example.com' });
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = jwt.split('.');
  const raw = wp.b64url.decode(k);
  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: wp.b64url.encode(raw.slice(1, 33)), y: wp.b64url.encode(raw.slice(33)) },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(wp.b64url.decode(sig))));
  const claims = JSON.parse(Buffer.from(wp.b64url.decode(c)).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:me@example.com');
});
