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

/** Simple TTL cache with in-flight de-duplication. */
class TTLCache {
  constructor(max = 2000) {
    this.max = max;
    this.map = new Map();
  }
  async get(key, ttlMs, loader) {
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && hit.exp > now) {
      return hit.promise;
    }
    const promise = Promise.resolve().then(loader);
    this.map.set(key, { exp: now + ttlMs, promise });
    promise.catch(() => {
      // Do not cache failures.
      if (this.map.get(key)?.promise === promise) this.map.delete(key);
    });
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    return promise;
  }
}

module.exports = { decodeEntities, text, norm, trUpper, haversine, TTLCache };
