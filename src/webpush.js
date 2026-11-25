'use strict';
// Minimal, dependency-free Web Push sender (RFC 8291 aes128gcm + RFC 8292 VAPID).
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function hkdf(salt, ikm, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

/** Generate a VAPID key pair: { publicKey, privateKey } as base64url (raw P-256). */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(publicKey, privateKey) {
  const pub = fromB64u(publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(fromB64u(privateKey)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

function vapidHeader(endpoint, vapid, subject, ttlSec = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapidPrivateKeyObject(vapid.publicKey, vapid.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/**
 * Encrypt a payload for a push subscription (RFC 8291).
 * `opts.salt` / `opts.asPrivate` exist only for deterministic tests.
 */
function encrypt(payload, keys, opts = {}) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(fromB64u(opts.asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ? fromB64u(opts.salt) : crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record delimiter
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body]);
}

/**
 * Send a push message. Resolves { ok, status, gone } — `gone` means the
 * subscription expired and should be deleted.
 */
async function send(subscription, data, vapid, { subject = 'mailto:ykmaps@localhost', ttl = 600, urgency = 'high' } = {}) {
  const body = encrypt(JSON.stringify(data), subscription.keys);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: vapidHeader(subscription.endpoint, vapid, subject),
    },
    body,
  });
  await res.arrayBuffer().catch(() => {});
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

module.exports = { generateVapidKeys, vapidHeader, encrypt, send, _b64u: b64u };
