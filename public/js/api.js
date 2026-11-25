// Thin client for the YKMaps server API (with a small memory cache + offline fallback).
const mem = new Map();

async function get(path, { ttl = 0, signal } = {}) {
  const hit = mem.get(path);
  if (ttl && hit && Date.now() - hit.t < ttl) return hit.v;
  let res;
  try {
    res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (hit) return { ...hit.v, _stale: true };
    throw new Error('Bağlantı yok. İnternet bağlantınızı kontrol edin.');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Sunucu hatası (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || `Hata (${res.status})`);
  mem.set(path, { t: Date.now(), v: data });
  return data;
}

async function send(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Bağlantı yok. İnternet bağlantınızı kontrol edin.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Hata (${res.status})`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  search: (q, o) => get(`/api/search?q=${enc(q)}`, { ttl: 60000, ...o }),
  lines: () => get('/api/lines', { ttl: 3600000 }),
  line: (code) => get(`/api/line/${enc(code)}`, { ttl: 300000 }),
  schedule: (code) => get(`/api/line/${enc(code)}/schedule`, { ttl: 600000 }),
  vehicles: (code) => get(`/api/line/${enc(code)}/vehicles`),
  stop: (code) => get(`/api/stop/${enc(code)}`, { ttl: 600000 }),
  arrivals: (code, o) => get(`/api/stop/${enc(code)}/arrivals`, o),
  nearby: (lat, lng, r = 600) => get(`/api/nearby?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&r=${r}`),
  bbox: (b) => get(`/api/stops/bbox?s=${b.s.toFixed(4)}&w=${b.w.toFixed(4)}&n=${b.n.toFixed(4)}&e=${b.e.toFixed(4)}`, { ttl: 300000 }),
  plan: (p) => get(`/api/plan?${new URLSearchParams(p)}`),
  announcements: (page = 0) => get(`/api/announcements?page=${page}`, { ttl: 300000 }),
  announcement: (id) => get(`/api/announcement/${enc(id)}`, { ttl: 3600000 }),
  status: () => get('/api/status'),
  sweep: (p) => get(`/api/plan/sweep?${new URLSearchParams(p)}`),
  push: {
    key: () => get('/api/push/key', { ttl: 3600000 }),
    subscribe: (subscription) => send('POST', '/api/push/subscribe', { subscription }),
    test: (sub) => send('POST', '/api/push/test', { sub }),
    watch: (sub, lines) => send('POST', '/api/push/watch', { sub, lines }),
    alarms: (sub) => send('GET', `/api/push/alarms?sub=${enc(sub)}`),
    addAlarm: (a) => send('POST', '/api/push/alarms', a),
    removeAlarm: (id, sub) => send('DELETE', `/api/push/alarms/${enc(id)}?sub=${enc(sub)}`),
  },
};
