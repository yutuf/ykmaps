'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const W = require('../src/webpush');

// RFC 8291 Appendix A test vector.
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expected:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 test vector', () => {
  const out = W.encrypt(V.plaintext, { p256dh: V.uaPublic, auth: V.auth }, { salt: V.salt, asPrivate: V.asPrivate });
  assert.strictEqual(out.toString('base64url'), V.expected);
});

test('VAPID JWT verifies with the public key', () => {
  const keys = W.generateVapidKeys();
  const h = W.vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:x@y');
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.strictEqual(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.strictEqual(claims.aud, 'https://fcm.googleapis.com');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});
