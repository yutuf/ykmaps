#!/usr/bin/env node
'use strict';
// YKMaps — İstanbul toplu taşıma: tiny zero-dependency server (API proxy + PWA).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const I = require('./src/iett');
const stopsIndex = require('./src/stops-index');
const push = require('./src/push-service');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const type = headers['Content-Type'] || '';
  const gzip = buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '') && /json|text|javascript|svg|manifest/.test(type);
  const out = gzip ? zlib.gzipSync(buf) : buf;
  res.writeHead(status, {
    ...headers,
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    Vary: 'Accept-Encoding',
    'Content-Length': out.length,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : out);
}

function json(req, res, status, data, maxAge = 0) {
  send(req, res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const routes = [
  ['/api/status', async () => ({ ok: true, index: stopsIndex.status(), time: Date.now() })],
  [/^\/api\/search$/, async (m, q) => {
    const lat = num(q.get('lat'));
    const lng = num(q.get('lng'));
    const r = await I.search(q.get('q') || '', { near: lat != null && lng != null ? { lat, lng } : null });
    if (!r.stops.length && r.error) r.stops = stopsIndex.searchStops(q.get('q') || '');
    // Enrich stops with coordinates from the local index when available.
    r.stops = r.stops.map((s) => {
      const x = stopsIndex.get(s.code);
      return x ? { ...s, lat: x.lat, lng: x.lng, lines: x.lines } : s;
    });
    return r;
  }, 60],
  ['/api/lines', async () => I.allLines(), 3600],
  [/^\/api\/line\/([^/]+)$/, async (m) => I.line(decodeURIComponent(m[1])), 300],
  [/^\/api\/line\/([^/]+)\/schedule$/, async (m) => I.schedule(decodeURIComponent(m[1])), 600],
  [/^\/api\/line\/([^/]+)\/alerts$/, async (m) => I.lineAlerts(decodeURIComponent(m[1])), 60],
  [/^\/api\/line\/([^/]+)\/vehicles$/, async (m) => I.vehicles(decodeURIComponent(m[1]))],
  [/^\/api\/stop\/(\d+)$/, async (m) => {
    const code = m[1];
    const local = stopsIndex.get(code);
    if (local) {
      // Instant: everything we need is in the local index (+ line names from the line list).
      const names = new Map((await I.allLines().catch(() => [])).map((l) => [l.code, l.name]));
      I.stop(code).catch(() => {}); // warm the cache with İETT's own record in the background
      return { code, name: local.name, district: local.district, lat: local.lat, lng: local.lng, lines: local.lines.map((c) => ({ code: c, name: names.get(c) || '' })) };
    }
    try {
      const s = await I.stop(code);
      if (local) {
        const known = new Set(s.lines.map((l) => l.code));
        for (const c of local.lines) if (!known.has(c)) s.lines.push({ code: c, name: '' });
        if (s.lat == null) Object.assign(s, { lat: local.lat, lng: local.lng });
        if (local.district) s.district = local.district; // index keeps Turkish characters
      }
      return s;
    } catch (e) {
      if (local) return { ...local, lines: local.lines.map((c) => ({ code: c, name: '' })) };
      throw e;
    }
  }, 600],
  [/^\/api\/stop\/(\d+)\/arrivals$/, async (m) => I.arrivals(m[1])],
  ['/api/nearby', async (m, q) => {
    const lat = num(q.get('lat'));
    const lng = num(q.get('lng'));
    if (lat == null || lng == null) throw Object.assign(new Error('lat/lng gerekli'), { status: 400 });
    const r = Math.min(3000, num(q.get('r')) || 600);
    return { stops: stopsIndex.nearby(lat, lng, r, Math.min(100, num(q.get('limit')) || 40)), index: stopsIndex.status() };
  }],
  ['/api/stops/bbox', async (m, q) => {
    const [s, w, n, e] = ['s', 'w', 'n', 'e'].map((k) => num(q.get(k)));
    if ([s, w, n, e].some((v) => v == null)) throw Object.assign(new Error('s,w,n,e gerekli'), { status: 400 });
    if ((n - s) * (e - w) > 0.02) return { stops: [], tooLarge: true };
    return { stops: stopsIndex.inBounds(s, w, n, e) };
  }, 300],
  ['/api/plan', async (m, q) =>
    I.plan({
      from: q.get('from'),
      to: q.get('to'),
      time: q.get('time'),
      date: q.get('date'),
      opt: q.get('opt') || 'time',
      arriveBy: q.get('arriveBy') === '1',
    })],
  ['/api/plan/sweep', async (m, q) =>
    I.planSweep({
      from: q.get('from'),
      to: q.get('to'),
      time: q.get('time'),
      date: q.get('date'),
      opt: q.get('opt') || 'time',
      window: Number(q.get('window')) || 120,
      step: Number(q.get('step')) || 10,
    })],
  ['/api/announcements', async (m, q) => I.announcements(q.get('page') || 0), 300],
  [/^\/api\/announcement\/(\d+)$/, async (m) => I.announcement(m[1]), 3600],
];

// Routes that change state (Web Push). [method, pattern, fn(match, body, query)]
const writeRoutes = [
  ['GET', '/api/push/key', async () => push.publicKey()],
  ['POST', '/api/push/subscribe', async (m, b) => push.subscribe(b.subscription)],
  ['POST', '/api/push/test', async (m, b) => push.test(b.sub)],
  ['POST', '/api/push/watch', async (m, b) => push.setWatch(b.sub, b.lines)],
  ['GET', '/api/push/alarms', async (m, b, q) => push.listAlarms(q.get('sub'))],
  ['POST', '/api/push/alarms', async (m, b) => push.addAlarm(b)],
  ['DELETE', /^\/api\/push\/alarms\/([\w-]+)$/, async (m, b, q) => push.removeAlarm(m[1], q.get('sub'))],
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        reject(Object.assign(new Error('İstek çok büyük'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Geçersiz JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  for (const [method, pattern, fn] of writeRoutes) {
    if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) continue;
    const m = typeof pattern === 'string' ? (url.pathname === pattern ? [pattern] : null) : url.pathname.match(pattern);
    if (!m) continue;
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return json(req, res, 200, await fn(m, body, url.searchParams));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(`[api] ${req.method} ${url.pathname}:`, e.message);
      return json(req, res, status, { error: e.message || 'Hata' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'Desteklenmeyen istek' });
  for (const [pattern, fn, maxAge] of routes) {
    const m = typeof pattern === 'string' ? (url.pathname === pattern ? [pattern] : null) : url.pathname.match(pattern);
    if (!m) continue;
    try {
      const data = await fn(m, url.searchParams);
      return json(req, res, 200, data, maxAge);
    } catch (e) {
      const status = e.status || 502;
      if (status >= 500) console.error(`[api] ${url.pathname}${url.search}:`, e.message);
      return json(req, res, status, { error: e.message || 'Hata' });
    }
  }
  return json(req, res, 404, { error: 'Bulunamadı' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html'; // SPA fallback
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(req, res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file);
    const noCache = ext === '.html' || p === '/sw.js' || ext === '.webmanifest';
    send(req, res, 200, buf, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed');
  return serveStatic(req, res, url);
});

function maybeRebuildIndex() {
  if (process.env.DISABLE_CRAWL === '1') return;
  if (!stopsIndex.isStale()) return;
  console.log('[index] Durak indeksi eski/yok, arka planda güncelleniyor...');
  stopsIndex.build({ concurrency: 3, log: (m) => console.log('[index]', m) }).catch((e) => console.error('[index] hata:', e.message));
}

if (require.main === module) {
  stopsIndex.load();
  if (process.env.DISABLE_PUSH !== '1') push.start();
  server.listen(PORT, HOST, () => {
    const st = stopsIndex.status();
    console.log(`YKMaps çalışıyor: http://localhost:${PORT}  (durak indeksi: ${st.stops} durak)`);
    setTimeout(maybeRebuildIndex, 5000);
    setInterval(maybeRebuildIndex, 6 * 3600 * 1000).unref();
  });
}

module.exports = { server };
