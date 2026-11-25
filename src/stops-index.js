'use strict';
// Builds and queries a city-wide stop index (code -> name, district, lat, lng, lines)
// by crawling every line's stop list + map pins. Used for "nearby stops".
const fs = require('fs');
const path = require('path');
const I = require('./iett');
const P = require('./parse');
const { haversine, norm } = require('./util');

const FILE = process.env.STOPS_FILE || path.join(__dirname, '..', 'data', 'stops.json');
const MAX_AGE = 3 * 24 * 3600 * 1000; // lines change often -> refresh every 3 days

let index = null; // { updated, stops: Map(code -> {code,name,district,lat,lng,lines:Set}) }
let grid = null; // Map(cellKey -> [stop])
let building = null;
const CELL = 0.01; // ~1.1 km

function cellKey(lat, lng) {
  return `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
}

function rebuildGrid() {
  grid = new Map();
  for (const s of index.stops.values()) {
    if (s.lat == null) continue;
    const k = cellKey(s.lat, s.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const stops = new Map();
    for (const [code, [name, district, lat, lng, lines]] of Object.entries(raw.stops || {})) {
      stops.set(code, { code, name, district, lat, lng, lines: new Set(lines) });
    }
    index = { updated: raw.updated || 0, stops, lineCount: raw.lineCount || 0 };
    rebuildGrid();
    return true;
  } catch {
    index = { updated: 0, stops: new Map(), lineCount: 0 };
    grid = new Map();
    return false;
  }
}

function save(idx) {
  const out = { updated: idx.updated, lineCount: idx.lineCount, stops: {} };
  const codes = [...idx.stops.keys()].sort();
  for (const c of codes) {
    const s = idx.stops.get(c);
    out.stops[c] = [s.name, s.district, s.lat, s.lng, [...s.lines].sort((a, b) => a.localeCompare(b, 'tr', { numeric: true }))];
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, FILE);
}

async function crawlLine(code, stops) {
  const html = await I.iettGet('/tr/RouteStation/GetStationForRoute', { hatkod: code, hatstart: '', hatend: '', langid: 1 });
  const dirs = P.parseRouteStops(html).filter((d) => d.stops.length);
  if (!dirs.length) return 0;
  const pins = await Promise.all(
    ['G', 'D'].map((d) => I.iettGet('/tr/RouteStation/GetRoutePinV2', { q: `${code}_${d}_D0` }, { type: 'json' }).then(P.parsePins).catch(() => null))
  );
  let n = 0;
  dirs.forEach((d, i) => {
    const pin = pins.find((p) => p && p.places.length === d.stops.length && p.places[0]?.name === d.stops[0]?.name) || (pins[i]?.places.length === d.stops.length ? pins[i] : null);
    d.stops.forEach((s, j) => {
      let rec = stops.get(s.code);
      if (!rec) {
        rec = { code: s.code, name: s.name, district: s.district, lat: null, lng: null, lines: new Set() };
        stops.set(s.code, rec);
      }
      rec.lines.add(code);
      if (pin && rec.lat == null) {
        rec.lat = pin.places[j].lat;
        rec.lng = pin.places[j].lng;
      }
      n++;
    });
  });
  return n;
}

async function build({ concurrency = 4, log = () => {} } = {}) {
  if (building) return building;
  building = (async () => {
    const lines = await I.allLines({ fresh: true });
    log(`${lines.length} hat bulundu, duraklar taranıyor...`);
    const stops = new Map();
    let i = 0;
    let done = 0;
    let failed = 0;
    async function worker() {
      while (i < lines.length) {
        const l = lines[i++];
        try {
          await crawlLine(l.code, stops);
        } catch {
          failed++;
        }
        done++;
        if (done % 50 === 0) log(`  ${done}/${lines.length} hat, ${stops.size} durak`);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (stops.size < 1000) throw new Error(`Durak indeksi çok küçük (${stops.size}); kaydedilmedi`);
    const idx = { updated: Date.now(), stops, lineCount: lines.length };
    save(idx);
    index = idx;
    rebuildGrid();
    log(`Bitti: ${stops.size} durak, ${lines.length} hat (${failed} hata)`);
    return { stops: stops.size, lines: lines.length, failed };
  })().finally(() => {
    building = null;
  });
  return building;
}

function ensureLoaded() {
  if (!index) load();
  return index;
}

function isStale() {
  ensureLoaded();
  return Date.now() - index.updated > MAX_AGE;
}

function publicStop(s, dist) {
  return { code: s.code, name: s.name, district: s.district, lat: s.lat, lng: s.lng, lines: [...s.lines], ...(dist != null ? { distance: Math.round(dist) } : {}) };
}

function nearby(lat, lng, radius = 600, limit = 40) {
  ensureLoaded();
  const out = [];
  const span = Math.ceil(radius / 1000 / 1.1) + 1;
  const cy = Math.floor(lat / CELL);
  const cx = Math.floor(lng / CELL);
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      for (const s of grid.get(`${cy + dy}:${cx + dx}`) || []) {
        const d = haversine(lat, lng, s.lat, s.lng);
        if (d <= radius) out.push([d, s]);
      }
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, limit).map(([d, s]) => publicStop(s, d));
}

function inBounds(s, w, n, e, limit = 400) {
  ensureLoaded();
  const out = [];
  for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) {
    for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) {
      for (const st of grid.get(`${y}:${x}`) || []) {
        if (st.lat >= s && st.lat <= n && st.lng >= w && st.lng <= e) out.push(st);
        if (out.length >= limit) return out.map((x) => publicStop(x));
      }
    }
  }
  return out.map((x) => publicStop(x));
}

function get(code) {
  ensureLoaded();
  const s = index.stops.get(String(code));
  return s ? publicStop(s) : null;
}

function searchStops(q, limit = 20) {
  ensureLoaded();
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const s of index.stops.values()) {
    const n = norm(`${s.name} ${s.district}`);
    if (words.every((w) => n.includes(w))) out.push(s);
    if (out.length >= limit) break;
  }
  return out.map((s) => publicStop(s));
}

function status() {
  ensureLoaded();
  return { updated: index.updated, stops: index.stops.size, lines: index.lineCount, building: !!building, stale: isStale() };
}

module.exports = { load, build, nearby, inBounds, get, searchStops, status, isStale, FILE };
