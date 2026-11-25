'use strict';
// Server-side alarms + favourite-line watching, delivered with Web Push so they
// work while the app is closed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const W = require('./webpush');
const I = require('./iett');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const VAPID_FILE = path.join(DIR, 'vapid.json');
const STATE_FILE = path.join(DIR, 'push.json');
const ALARM_TTL = 3 * 3600 * 1000;

let vapid = null;
let state = { subs: {}, alarms: [], lastAnnId: 0 };
let saveTimer = null;
const log = (...a) => console.log('[push]', ...a);

function load() {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  } catch {
    vapid = W.generateVapidKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
    log('Yeni VAPID anahtarı oluşturuldu');
  }
  try {
    state = { subs: {}, alarms: [], lastAnnId: 0, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    /* first run */
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function publicKey() {
  return { key: vapid.publicKey };
}

function subscribe(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw err('Geçersiz abonelik');
  }
  const id = hash(sub.endpoint);
  const prev = state.subs[id];
  state.subs[id] = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, created: prev?.created || Date.now(), lines: prev?.lines || [], seen: prev?.seen || {} };
  save();
  return { id };
}

function needSub(id) {
  const s = state.subs[id];
  if (!s) throw err('Abonelik bulunamadı', 404);
  return s;
}

function addAlarm({ sub, stop, stopName, line, minutes }) {
  needSub(sub);
  if (!/^\d{1,9}$/.test(String(stop)) || !line || String(line).length > 12) throw err('Geçersiz alarm');
  const m = Math.max(1, Math.min(60, Number(minutes) || 5));
  state.alarms = state.alarms.filter((a) => !(a.sub === sub && a.stop === String(stop) && a.line === String(line)));
  const a = { id: `s${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, sub, stop: String(stop), stopName: String(stopName || '').slice(0, 80), line: String(line), minutes: m, created: Date.now() };
  state.alarms.push(a);
  save();
  ensureAlarmLoop();
  return a;
}

function removeAlarm(id, sub) {
  const before = state.alarms.length;
  state.alarms = state.alarms.filter((a) => !(a.id === id && a.sub === sub));
  save();
  return { removed: before - state.alarms.length };
}

function listAlarms(sub) {
  return { alarms: state.alarms.filter((a) => a.sub === sub) };
}

function setWatch(sub, lines) {
  const s = needSub(sub);
  const clean = [...new Set((Array.isArray(lines) ? lines : []).map((l) => String(l).toUpperCase()).filter((l) => /^[0-9A-ZÇĞİÖŞÜ.\-/]{1,12}$/.test(l)))].slice(0, 50);
  s.lines = clean;
  save();
  checkLines(true).catch(() => {}); // prime "seen" so only *new* alerts notify
  return { lines: clean };
}

async function notify(subId, payload) {
  const s = state.subs[subId];
  if (!s) return false;
  try {
    const r = await W.send(s.sub, payload, vapid, { subject: process.env.VAPID_SUBJECT || 'mailto:ykmaps@localhost' });
    if (r.gone) {
      log('Abonelik süresi dolmuş, siliniyor', subId);
      delete state.subs[subId];
      state.alarms = state.alarms.filter((a) => a.sub !== subId);
      save();
    } else if (!r.ok) log('Gönderilemedi', r.status);
    return r.ok;
  } catch (e) {
    log('Gönderim hatası', e.message);
    return false;
  }
}

async function test(sub) {
  needSub(sub);
  const ok = await notify(sub, { title: 'YKMaps', body: 'Bildirimler çalışıyor 👍', url: '#/settings', tag: 'test' });
  if (!ok) throw err('Bildirim gönderilemedi', 502);
  return { ok };
}

// ---------- loops ----------

let alarmTimer = null;
function ensureAlarmLoop() {
  if (alarmTimer || !state.alarms.length) return;
  alarmTimer = setInterval(checkAlarms, 30000);
  checkAlarms();
}

async function checkAlarms() {
  const now = Date.now();
  const expired = state.alarms.filter((a) => now - a.created > ALARM_TTL);
  for (const a of expired) {
    notify(a.sub, { title: `${a.line} alarmı sona erdi`, body: `${a.stopName}: 3 saat içinde yaklaşan ${a.line} görülmedi.`, url: `#/stop/${a.stop}`, tag: a.id });
  }
  state.alarms = state.alarms.filter((a) => now - a.created <= ALARM_TTL);
  if (!state.alarms.length) {
    clearInterval(alarmTimer);
    alarmTimer = null;
    save();
    return;
  }
  const stops = [...new Set(state.alarms.map((a) => a.stop))];
  for (const stop of stops) {
    let arr;
    try {
      arr = (await I.arrivals(stop)).arrivals;
    } catch {
      continue;
    }
    for (const a of state.alarms.filter((x) => x.stop === stop)) {
      const next = arr.find((x) => x.line === a.line && x.minutes != null);
      if (next && next.minutes <= a.minutes) {
        const second = arr.filter((x) => x.line === a.line && x.minutes != null)[1];
        const ok = await notify(a.sub, {
          title: `🚌 ${a.line} yaklaşıyor — ${next.minutes <= 0 ? 'geliyor!' : `${next.minutes} dk`}`,
          body: `${a.stopName} durağına ${next.time ? `${next.time}'de` : 'birazdan'} varıyor.${second ? ` Sonraki: ${second.minutes} dk.` : ''}`,
          url: `#/stop/${a.stop}`,
          tag: a.id,
        });
        // Keep the alarm when delivery fails (flaky network) and retry on the next tick, up to 4 times.
        a.tries = (a.tries || 0) + 1;
        if (ok || a.tries >= 4) state.alarms = state.alarms.filter((x) => x.id !== a.id);
      }
    }
  }
  save();
}

async function checkLines(silent = false) {
  const watched = new Map(); // line -> [subId]
  for (const [id, s] of Object.entries(state.subs)) for (const l of s.lines || []) watched.set(l, [...(watched.get(l) || []), id]);
  if (!watched.size) return;
  for (const [line, subs] of watched) {
    let alerts;
    try {
      alerts = await I.lineAlerts(line);
    } catch {
      continue;
    }
    for (const subId of subs) {
      const s = state.subs[subId];
      if (!s) continue;
      const seen = new Set(s.seen[line] || []);
      const first = !s.seen[line];
      for (const text of alerts) {
        const h = hash(text);
        if (seen.has(h)) continue;
        seen.add(h);
        if (!silent && !first) await notify(subId, { title: `⚠️ ${line} hattında değişiklik`, body: text.slice(0, 220), url: `#/line/${encodeURIComponent(line)}`, tag: `alert-${line}-${h}` });
      }
      s.seen[line] = [...seen].slice(-30);
    }
  }
  // New İETT announcements that mention a watched line.
  try {
    const anns = await I.announcements(0);
    const maxId = Math.max(0, ...anns.map((a) => Number(a.id)));
    if (state.lastAnnId && !silent) {
      for (const a of anns.filter((x) => Number(x.id) > state.lastAnnId)) {
        let text = a.title;
        try {
          text += ` ${(await I.announcement(a.id)).body}`;
        } catch {
          /* title only */
        }
        for (const [line, subs] of watched) {
          const re = new RegExp(`(^|[^0-9A-ZÇĞİÖŞÜ])${line.replace(/[.\-/]/g, '\\$&')}([^0-9A-ZÇĞİÖŞÜ]|$)`, 'i');
          if (!re.test(text)) continue;
          for (const subId of subs) await notify(subId, { title: `📢 ${line}: ${a.title}`, body: 'İETT duyurusu — okumak için dokunun.', url: `#/news/${a.id}`, tag: `ann-${a.id}` });
        }
      }
    }
    if (maxId) state.lastAnnId = Math.max(state.lastAnnId || 0, maxId);
  } catch {
    /* ignore */
  }
  save();
}

function start() {
  load();
  ensureAlarmLoop();
  setTimeout(() => checkLines().catch(() => {}), 20000);
  setInterval(() => checkLines().catch(() => {}), 10 * 60 * 1000).unref();
  log(`hazır: ${Object.keys(state.subs).length} abone, ${state.alarms.length} alarm`);
}

module.exports = { start, load, publicKey, subscribe, addAlarm, removeAlarm, listAlarms, setWatch, test, _state: () => state };
