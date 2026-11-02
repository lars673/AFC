// Web Push ohne fremde Dienste und ohne Zusatzpakete: Benachrichtigungen an die installierte AFC-App
// (iPhone ab iOS 16.4 vom Home-Bildschirm, Mac-Safari, Chrome, Firefox).
// Verschlüsselung nach RFC 8291 (aes128gcm), Absenderausweis nach RFC 8292 (VAPID, ES256).
// Der Server von Apple, Google oder Mozilla stellt die Nachricht zu; er sieht nur verschlüsselte Daten.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const b64u = buf => Buffer.from(buf).toString('base64url');
export const unb64u = s => Buffer.from(String(s || ''), 'base64url');

/** VAPID-Schlüssel laden oder einmalig erzeugen (bleiben in data/vapid.json, sonst müssten alle Geräte neu abonnieren). */
export function loadVapid(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.publicKey && j.privateKey) return j;
  } catch { /* neu erzeugen */ }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const j = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), created: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(j, null, 1), { mode: 0o600 });
  return j;
}

function vapidKeyObject(v) {
  const pub = unb64u(v.publicKey);
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: v.privateKey } });
}

/** Authorization-Kopfzeile für einen Push-Dienst (gültig 12 Stunden). */
export function vapidHeader(endpoint, v, subject = 'https://github.com/lars673/AFC', now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: vapidKeyObject(v), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

/** Nachricht für ein Abo verschlüsseln (ein Datensatz, aes128gcm). */
export function encrypt(sub, payload, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPub = unb64u(sub.keys?.p256dh), auth = unb64u(sub.keys?.auth);
  if (uaPub.length !== 65 || auth.length < 16) throw new Error('Abo ohne gültige Schlüssel');
  const as = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) as.generateKeys();
  const asPub = as.getPublicKey();
  const shared = as.computeSecret(uaPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = asPub.length;
  return Buffer.concat([head, asPub, ct]);
}

/**
 * Nachricht senden. Ergebnis: { ok, status, gone } – gone = Abo existiert nicht mehr (löschen).
 * msg: { title, body, url, tag }
 */
export async function sendPush(sub, msg, vapid, { fetchImpl = globalThis.fetch, ttl = 12 * 3600, urgency = 'normal' } = {}) {
  const body = encrypt(sub, JSON.stringify(msg));
  try {
    const r = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: vapidHeader(sub.endpoint, vapid), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency, ...(msg.tag ? { Topic: String(msg.tag).replace(/[^\w-]/g, '').slice(0, 32) } : {}) },
      body, signal: AbortSignal.timeout(20000)
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) { return { ok: false, status: 0, gone: false, error: String(e.message || e) }; }
}

// Nur die bekannten Push-Dienste von Apple, Google, Mozilla und Microsoft
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/i;

/** Abo aus dem Browser prüfen: nur https-Adressen bekannter Art, Schlüssel in richtiger Länge. */
export function cleanSubscription(s) {
  try {
    const u = new URL(s?.endpoint);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !PUSH_HOSTS.test(u.hostname)) return null;
    if (unb64u(s.keys?.p256dh).length !== 65 || unb64u(s.keys?.auth).length < 16) return null;
    return { endpoint: u.href.slice(0, 1000), keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } };
  } catch { return null; }
}
