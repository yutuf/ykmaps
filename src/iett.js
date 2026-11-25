'use strict';
// Data access for iett.istanbul + nasilgiderim.iett.gov.tr (+ best-effort İBB SOAP for live vehicles).
const P = require('./parse');
const { norm, trUpper, decodeEntities, TTLCache } = require('./util');

const IETT = 'https://iett.istanbul';
const PLANNER = 'https://nasilgiderim.iett.gov.tr';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36';

const cache = new TTLCache(5000);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

async function request(url, { method = 'GET', body, headers = {}, timeout = 20000, type = 'text', retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'tr-TR,tr;q=0.9', ...headers },
        signal: ctrl.signal,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) throw Object.assign(new Error(`Bulunamadı (${res.status})`), { status: 404 });
      if (!res.ok) throw Object.assign(new Error(`Kaynak hata verdi: HTTP ${res.status}`), { status: res.status >= 500 ? 502 : res.status });
      const t = await res.text();
      if (type === 'json') {
        if (!t.trim()) throw Object.assign(new Error('Boş yanıt'), { status: 502 });
        return JSON.parse(t);
      }
      return t;
    } catch (e) {
      lastErr = e;
      if (e.status === 404 || e.status === 400) break;
      // Flaky home networks: quick connect failures are retried after a short pause.
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr.name === 'AbortError') throw Object.assign(new Error('Kaynak zaman aşımına uğradı'), { status: 504 });
  throw lastErr;
}

const qs = (o) => new URLSearchParams(o).toString();
const iettGet = (path, params, opts) => request(`${IETT}${path}?${qs(params)}`, { ...opts, headers: { 'X-Requested-With': 'XMLHttpRequest' } });

// ---------- search ----------

function requestKey(q) {
  const fixed = trUpper(q).trim().replace(/\s+/g, ' ');
  if (!fixed) return '';
  return fixed.split(' ')[0];
}

async function rawSearch(key) {
  return cache.get(`search:${key}`, 30 * MIN, async () => {
    const json = await iettGet('/tr/RouteStation/GetSearchItems', { key, langid: 1 }, { type: 'json' });
    return P.parseSearchItems(json);
  });
}

function score(itemNorm, codeNorm, qn) {
  if (codeNorm && codeNorm === qn) return 0;
  if (codeNorm && codeNorm.startsWith(qn)) return 1 + codeNorm.length / 100;
  if (itemNorm.startsWith(qn)) return 2;
  if (itemNorm.includes(' ' + qn)) return 3;
  return 4;
}

async function search(q, { limit = 25 } = {}) {
  const key = requestKey(q);
  if (!key) return { lines: [], stops: [], places: [] };
  const qn = norm(q);
  const words = qn.split(' ').filter(Boolean);
  const matchesAll = (s) => {
    const n = norm(s);
    return words.every((w) => n.includes(w));
  };
  const [iett, places] = await Promise.allSettled([rawSearch(key), placeSearch(q)]);
  const res = iett.status === 'fulfilled' ? iett.value : { lines: [], stops: [] };
  const lines = res.lines
    .filter((l) => matchesAll(`${l.code} ${l.name}`))
    .map((l) => ({ ...l, _s: score(norm(l.name), norm(l.code), qn) }))
    .sort((a, b) => a._s - b._s || a.code.localeCompare(b.code, 'tr', { numeric: true }))
    .slice(0, limit)
    .map(({ _s, ...l }) => l);
  const stops = res.stops
    .filter((s) => matchesAll(`${s.name} ${s.district} ${s.code}`))
    .map((s) => ({ ...s, _s: s.code === q.trim() ? 0 : score(norm(s.name), '', qn) }))
    .sort((a, b) => a._s - b._s || a.name.localeCompare(b.name, 'tr'))
    .slice(0, limit)
    .map(({ _s, ...s }) => s);
  return {
    lines,
    stops,
    places: places.status === 'fulfilled' ? places.value : [],
    error: iett.status === 'rejected' ? iett.reason.message : undefined,
  };
}

/** All lines (enumerated through the search endpoint). */
const fs = require('fs');
const path = require('path');
const LINES_FILE = process.env.LINES_FILE || path.join(__dirname, '..', 'data', 'lines.json');

async function allLines({ fresh = false } = {}) {
  if (!fresh) {
    try {
      const st = fs.statSync(LINES_FILE);
      if (Date.now() - st.mtimeMs < 3 * 24 * HOUR) {
        return cache.get('allLinesFile', 1 * HOUR, async () => JSON.parse(fs.readFileSync(LINES_FILE, 'utf8')));
      }
    } catch {
      /* no file yet */
    }
  }
  return cache.get('allLines', 12 * HOUR, async () => {
    const keys = ['A', 'E', 'I', 'İ', 'O', 'U', 'Ö', 'Ü', 'Ç', 'Ş', 'Y', 'R', 'K', 'M', 'L', 'N', 'T'];
    const map = new Map();
    for (const k of keys) {
      const r = await rawSearch(k);
      for (const l of r.lines) map.set(l.code, l);
    }
    const list = [...map.values()].sort((a, b) => a.code.localeCompare(b.code, 'tr', { numeric: true }));
    if (list.length > 300) {
      try {
        fs.mkdirSync(path.dirname(LINES_FILE), { recursive: true });
        fs.writeFileSync(LINES_FILE, JSON.stringify(list));
      } catch {
        /* read-only FS is fine */
      }
    }
    return list;
  });
}

async function placeSearch(q) {
  if (String(q).trim().length < 3) return [];
  return cache.get(`place:${norm(q)}`, 6 * HOUR, async () => {
    const json = await request(`${PLANNER}/search?${qs({ query: q })}`, { type: 'json', timeout: 8000, retries: 2 });
    const out = [];
    for (const s of json.stops || []) {
      out.push({ id: s.stopId, name: s.stopName, district: s.district || '', lat: s.point[0], lng: s.point[1], type: s.routeType || 'stop' });
    }
    for (const s of json.pois || []) {
      out.push({ id: s.stopId, name: s.stopName, district: s.district || '', lat: s.point[0], lng: s.point[1], type: 'poi' });
    }
    return out;
  });
}

// ---------- stops ----------

async function stop(code) {
  if (!/^\d{1,9}$/.test(code)) throw Object.assign(new Error('Geçersiz durak kodu'), { status: 400 });
  return cache.get(`stop:${code}`, 6 * HOUR, async () => {
    const [page, linesJson] = await Promise.all([
      iettGet('/StationDetail', { dkod: code, stationname: 'durak' }),
      iettGet('/tr/RouteStationAgent/GetRouteByStation', { dcode: code, langid: 1, debug: 0 }, { type: 'json' }).catch(() => ({ html: '' })),
    ]);
    const info = P.parseStationPage(page);
    if (!info.code) throw Object.assign(new Error('Durak bulunamadı'), { status: 404 });
    return { ...info, lines: P.parseStationLines(linesJson) };
  });
}

async function arrivals(code) {
  if (!/^\d{1,9}$/.test(code)) throw Object.assign(new Error('Geçersiz durak kodu'), { status: 400 });
  return cache.get(`arr:${code}`, 15 * SEC, async () => {
    const html = await iettGet('/tr/RouteStation/GetStationInfo', { dcode: code, langid: 1 });
    return { code, updated: Date.now(), arrivals: P.parseArrivals(html) };
  });
}

// ---------- lines ----------

const LINE_RE = /^[0-9A-ZÇĞİÖŞÜ.\-/]{1,12}$/i;
function checkLine(code) {
  if (!LINE_RE.test(code)) throw Object.assign(new Error('Geçersiz hat kodu'), { status: 400 });
  return trUpper(code);
}

async function lineInfo(code) {
  code = checkLine(code);
  const r = await rawSearch(code).catch(() => ({ lines: [] }));
  return r.lines.find((l) => l.code === code) || { code, name: '' };
}

async function line(code) {
  code = checkLine(code);
  return cache.get(`line:${code}`, 3 * HOUR, async () => {
    const [info, stopsHtml, pinG, pinD, status, variants] = await Promise.all([
      lineInfo(code),
      iettGet('/tr/RouteStation/GetStationForRoute', { hatkod: code, hatstart: '', hatend: '', langid: 1 }),
      iettGet('/tr/RouteStation/GetRoutePinV2', { q: `${code}_G_D0` }, { type: 'json' }).catch(() => []),
      iettGet('/tr/RouteStation/GetRoutePinV2', { q: `${code}_D_D0` }, { type: 'json' }).catch(() => []),
      iettGet('/tr/RouteStation/GetLineStatus', { rcode: code }, { type: 'json' }).catch(() => []),
      iettGet('/tr/RouteStation/GetAllRoute', { rcode: code }, { type: 'json' }).catch(() => []),
    ]);
    const dirs = P.parseRouteStops(stopsHtml).filter((d) => d.stops.length);
    const pins = [P.parsePins(pinG), P.parsePins(pinD)];
    const directions = dirs.map((d, i) => {
      // Pins come in the same order as the stop list; pick the matching direction by first-stop name.
      let pin = pins[i] || pins[0];
      const first = d.stops[0]?.name;
      const alt = pins.find((p) => p.places[0]?.name === first && p.places.length === d.stops.length);
      if (alt) pin = alt;
      const usable = pin && pin.places.length === d.stops.length;
      const stops = d.stops.map((s, j) => ({
        ...s,
        lat: usable ? pin.places[j].lat : null,
        lng: usable ? pin.places[j].lng : null,
      }));
      const fromName = stops[0]?.name || '';
      const toName = stops[stops.length - 1]?.name || '';
      return {
        id: i === 0 ? 'G' : 'D',
        title: `${fromName} → ${toName}`,
        from: fromName,
        to: toName,
        color: pin?.color || (i === 0 ? '#ec202a' : '#049ae5'),
        shape: pin?.shape || [],
        stops,
      };
    });
    if (!directions.length) throw Object.assign(new Error('Hat bulunamadı'), { status: 404 });
    const alerts = (Array.isArray(status) ? status : []).map((s) => String(s).replace(/\?/g, "'").trim()).filter(Boolean);
    const vars = [];
    const seen = new Set();
    for (const v of Array.isArray(variants) ? variants : []) {
      if (!v.GUZERGAH_GUZERGAH_KODU || seen.has(v.GUZERGAH_GUZERGAH_KODU)) continue;
      seen.add(v.GUZERGAH_GUZERGAH_KODU);
      vars.push({ id: v.GUZERGAH_GUZERGAH_KODU, name: String(v.GUZERGAH_ADI || '').replace(/\s+/g, ' ').trim() });
    }
    return { code, name: info.name || `${directions[0].from} - ${directions[0].to}`, directions, alerts, variants: vars, updated: Date.now() };
  });
}

async function lineAlerts(code) {
  code = checkLine(code);
  return cache.get(`alerts:${code}`, 5 * MIN, async () => {
    const status = await iettGet('/tr/RouteStation/GetLineStatus', { rcode: code }, { type: 'json' });
    return (Array.isArray(status) ? status : []).map((s) => String(s).replace(/\?/g, "'").trim()).filter(Boolean);
  });
}

async function schedule(code) {
  code = checkLine(code);
  return cache.get(`sched:${code}`, 3 * HOUR, async () => {
    const html = await request(`${IETT}/tr/RouteStation/GetScheduledDepartureTimes`, {
      method: 'POST',
      body: qs({ rstart: '', rend: '', timeschule: '', freq: '', lngid: 1, hCode: code }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const tables = P.parseSchedule(html);
    return { code, directions: tables };
  });
}

// ---------- live vehicles (İBB SOAP, works from Turkish IPs) ----------

const SOAP_URL = 'https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx';
let soapBlockedUntil = 0;

async function vehicles(code) {
  code = checkLine(code);
  if (Date.now() < soapBlockedUntil) return { available: false, vehicles: [], reason: 'İBB canlı konum servisine şu an erişilemiyor' };
  return cache.get(`veh:${code}`, 15 * SEC, async () => {
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetHatOtoKonum_json xmlns="http://tempuri.org/"><HatKodu>${code.replace(/[<>&]/g, '')}</HatKodu></GetHatOtoKonum_json></soap:Body></soap:Envelope>`;
    try {
      const xml = await request(SOAP_URL, {
        method: 'POST',
        body: envelope,
        timeout: 8000,
        retries: 2,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://tempuri.org/GetHatOtoKonum_json"' },
      });
      const m = xml.match(/<GetHatOtoKonum_jsonResult>([\s\S]*?)<\/GetHatOtoKonum_jsonResult>/);
      const arr = m ? JSON.parse(decodeEntities(m[1]) || '[]') : [];
      const list = arr
        .map((v) => ({
          id: v.kapino || v.KapiNo || '',
          lat: parseFloat(v.enlem || v.Enlem),
          lng: parseFloat(v.boylam || v.Boylam),
          direction: v.yon || '',
          route: v.guzergahkodu || '',
          nearStop: v.yakinDurakKodu ? String(v.yakinDurakKodu) : '',
          time: String(v.son_konum_zamani || v.son_konum_saati || v.Saat || '').replace(/^.*\s(\d{1,2}:\d{2}).*$/, '$1'),
        }))
        .filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
      return { available: true, vehicles: list, updated: Date.now() };
    } catch (e) {
      soapBlockedUntil = Date.now() + 5 * MIN;
      return { available: false, vehicles: [], reason: 'İBB canlı konum servisine erişilemedi (bu servis yalnızca Türkiye IP adreslerinden çalışır)' };
    }
  });
}

// ---------- trip planning ----------

const OPTS = new Set(['time', 'walk', 'transfers', 'metro']);

async function plan({ from, to, time, date, opt = 'time', arriveBy = false }) {
  const ll = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
  if (!ll.test(from || '') || !ll.test(to || '')) throw Object.assign(new Error('Başlangıç/varış koordinatı geçersiz'), { status: 400 });
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
  const pad = (n) => String(n).padStart(2, '0');
  if (!/^\d{2}:\d{2}$/.test(time || '')) time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (!/^\d{2}-\d{2}-\d{4}$/.test(date || '')) date = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  if (!OPTS.has(opt)) opt = 'time';
  const url = `${PLANNER}/router?from=${from}&to=${to}&time=${time}&date=${date}&isArrival=${arriveBy ? 'true' : 'false'}&optimizefor=${opt}`;
  return cache.get(`plan:${url}`, 1 * MIN, async () => {
    const json = await request(url, { type: 'json', timeout: 30000, retries: 2 });
    return P.parsePlan(json);
  });
}

// ---------- announcements ----------

async function announcements(page = 0) {
  page = Math.max(0, Math.min(50, parseInt(page, 10) || 0));
  return cache.get(`ann:${page}`, 10 * MIN, async () => {
    if (page === 0) {
      const [home, list] = await Promise.all([
        iettGet('/tr/Announcement/GetAnnouncementForHomepage', { lang: 1 }).catch(() => ''),
        request(`${IETT}/tr/Announcement`, {
          method: 'POST',
          body: qs({ Page: 0, lngid: 1 }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        }).catch(() => ''),
      ]);
      return mergeAnn(P.parseAnnouncements(home), P.parseAnnouncements(list));
    }
    const html = await request(`${IETT}/tr/Announcement`, {
      method: 'POST',
      body: qs({ Page: page, lngid: 1 }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    });
    return P.parseAnnouncements(html);
  });
}

function mergeAnn(a, b) {
  const map = new Map();
  for (const x of [...a, ...b]) if (!map.has(x.id)) map.set(x.id, x);
  return [...map.values()].sort((x, y) => Number(y.id) - Number(x.id));
}

async function announcement(id) {
  if (!/^\d{1,7}$/.test(id)) throw Object.assign(new Error('Geçersiz duyuru'), { status: 400 });
  return cache.get(`anndet:${id}`, 1 * HOUR, async () => P.parseAnnouncementDetail(await request(`${IETT}/Announcement/Detail/${id}`)));
}

module.exports = { search, allLines, placeSearch, stop, arrivals, line, lineAlerts, schedule, vehicles, plan, announcements, announcement, request, iettGet, rawSearch, _cache: cache };
