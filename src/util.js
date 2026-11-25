'use strict';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode HTML entities (&#214; &#x2F; &amp; ...). */
function decodeEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Strip tags, decode entities, collapse whitespace. */
function text(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Turkish-aware normalisation for search comparisons. */
function norm(s) {
  return String(s || '')
    .replace(/İ/g, 'i').replace(/I/g, 'ı')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Turkish upper case (for sending queries to IETT, which stores names upper case). */
function trUpper(s) {
  return String(s || '').toLocaleUpperCase('tr');
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * TTL cache with in-flight de-duplication and optional stale-while-revalidate:
 * with `stale` > 0, an expired value younger than ttl + stale is returned at
 * once while a single background refresh replaces it (failures keep the old one).
 */
class TTLCache {
  constructor(max = 2000) {
    this.max = max;
    this.map = new Map();
  }
  async get(key, ttlMs, loader, { stale = 0 } = {}) {
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && hit.exp > now) return hit.promise;
    if (hit && hit.done && stale > 0 && hit.exp + stale > now) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        Promise.resolve()
          .then(loader)
          .then((value) => this.map.set(key, { exp: Date.now() + ttlMs, promise: Promise.resolve(value), done: true, value }))
          .catch(() => {
            hit.refreshing = false;
          });
      }
      return hit.value;
    }
    const entry = { exp: now + ttlMs, done: false };
    entry.promise = Promise.resolve().then(loader);
    entry.promise.then(
      (value) => {
        entry.done = true;
        entry.value = value;
      },
      () => {
        // Do not cache failures.
        if (this.map.get(key) === entry) this.map.delete(key);
      }
    );
    this.map.set(key, entry);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return entry.promise;
  }
}

module.exports = { decodeEntities, text, norm, trUpper, haversine, TTLCache };
