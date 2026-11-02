import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadVapid, vapidHeader, encrypt, sendPush, cleanSubscription, b64u, unb64u } from '../lib/webpush.js';

// Gegenstück des Browsers: Nachricht nach RFC 8291 entschlüsseln
function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const shared = uaEcdh.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2);
  return pt.subarray(0, -1).toString();
}

test('Web Push: Verschlüsselung lässt sich wie im Browser entschlüsseln', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
  const msg = JSON.stringify({ title: 'Morgen 86 am Amisbühl', body: 'Föhn? Nein. Äää' });
  assert.equal(decrypt(encrypt(sub, msg), ua, auth), msg);
  assert.throws(() => encrypt({ endpoint: sub.endpoint, keys: { p256dh: 'x', auth: 'y' } }, 'x'));
});

test('Web Push: VAPID-Schlüssel bleiben, Signatur ist gültig', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-vapid-')), file = path.join(dir, 'vapid.json');
  const v = loadVapid(file);
  assert.deepEqual(loadVapid(file), v);
  assert.equal(unb64u(v.publicKey).length, 65);
  const h = vapidHeader('https://web.push.apple.com/abc/def', v, 'https://example.org', Date.UTC(2026, 10, 1));
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publicKey);
  const [head, body, sig] = jwt.split('.');
  const claims = JSON.parse(unb64u(body));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://example.org');
  const pub = unb64u(v.publicKey);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Web Push: nur echte Push-Dienste, abgelaufene Abos erkannt', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
  assert.ok(cleanSubscription({ endpoint: 'https://web.push.apple.com/QAbc', keys }));
  assert.ok(cleanSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }));
  assert.equal(cleanSubscription({ endpoint: 'https://evil.example/x', keys }), null);
  assert.equal(cleanSubscription({ endpoint: 'http://web.push.apple.com/x', keys }), null);
  assert.equal(cleanSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'abc', auth: keys.auth } }), null);
  const v = loadVapid(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'afc-vapid-')), 'v.json'));
  let seen;
  const r = await sendPush({ endpoint: 'https://web.push.apple.com/QAbc', keys }, { title: 't', tag: 'good:2026-11-02' }, v, { fetchImpl: async (u, o) => { seen = o; return { status: 410 }; } });
  assert.deepEqual([r.ok, r.gone], [false, true]);
  assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.headers.Topic, 'good2026-11-02');
  assert.match(seen.headers.Authorization, /^vapid t=/);
});
