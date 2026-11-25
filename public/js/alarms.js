// "Otobüsüm yaklaşınca haber ver" and "İneceğim durağa yaklaşınca uyar" alarms.
import { store } from './store.js';
import { api } from './api.js';
import { onUserPos, startLocation } from './map.js';
import { haversine, toast, esc, icon, fmtDist } from './ui.js';

let pollTimer = null;
let dest = loadDest(); // {name, lat, lng, radius}
let unsubPos = null;

function loadDest() {
  try {
    return JSON.parse(localStorage.getItem('ykmaps:dest') || 'null');
  } catch {
    return null;
  }
}
function saveDest() {
  try {
    if (dest) localStorage.setItem('ykmaps:dest', JSON.stringify(dest));
    else localStorage.removeItem('ykmaps:dest');
  } catch {
    /* ignore */
  }
}

export async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
  } catch {
    /* ignore */
  }
}

export async function notify(title, body, url) {
  navigator.vibrate?.([300, 150, 300, 150, 600]);
  beep();
  toast(`${title} — ${body}`, 6000);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: title, renotify: true, vibrate: [300, 150, 300], data: { url } };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch {
    /* ignore */
  }
}

// ---------- bus approaching ----------

async function checkBusAlarms() {
  const alarms = store.get().alarms;
  if (!alarms.length) return stopPolling();
  const byStop = new Map();
  for (const a of alarms) {
    if (Date.now() - a.created > 3 * 3600 * 1000) {
      store.removeAlarm(a.id); // expire after 3h
      continue;
    }
    if (!byStop.has(a.stop)) byStop.set(a.stop, []);
    byStop.get(a.stop).push(a);
  }
  for (const [stop, list] of byStop) {
    try {
      const { arrivals } = await api.arrivals(stop);
      for (const a of list) {
        const next = arrivals.find((x) => x.line === a.line && x.minutes != null);
        if (next && next.minutes <= a.minutes) {
          store.removeAlarm(a.id);
          notify(`${a.line} yaklaşıyor!`, `${a.stopName} durağına ${next.minutes <= 0 ? 'geliyor' : `${next.minutes} dk`} (${next.time || ''})`, `#/stop/${stop}`);
        }
      }
    } catch {
      /* try again next tick */
    }
  }
  renderBar();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(checkBusAlarms, 30000);
  checkBusAlarms();
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

export async function addBusAlarm({ stop, stopName, line, minutes }) {
  await ensureNotifyPermission();
  store.addAlarm({ stop, stopName, line, minutes });
  toast(`${line} için alarm kuruldu: ${minutes} dk kala haber vereceğim`);
  startPolling();
  renderBar();
}

export function hasBusAlarm(stop, line) {
  return store.get().alarms.find((a) => a.stop === stop && a.line === line);
}

// ---------- get-off / destination alarm ----------

export async function setDestAlarm(target) {
  await ensureNotifyPermission();
  dest = { radius: 400, ...target };
  saveDest();
  watchDest();
  await startLocation();
  toast(`${target.name} durağına yaklaşınca uyaracağım. Uygulamayı açık tutun.`, 4000);
  renderBar();
}

export function clearDestAlarm() {
  dest = null;
  saveDest();
  unsubPos?.();
  unsubPos = null;
  renderBar();
}

export function getDestAlarm() {
  return dest;
}

let lastDist = null;
function watchDest() {
  unsubPos?.();
  if (!dest) return;
  unsubPos = onUserPos((p) => {
    if (!dest) return;
    lastDist = haversine(p, dest);
    if (lastDist <= dest.radius) {
      const name = dest.name;
      clearDestAlarm();
      notify('İnme zamanı!', `${name} durağına yaklaştınız (${fmtDist(lastDist)})`);
    } else renderBar();
  });
}

// ---------- status bar ----------

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* ignore */
  }
}

export function renderBar() {
  const bar = document.getElementById('alarmBar');
  const alarms = store.get().alarms;
  const parts = [];
  if (alarms.length) parts.push(alarms.map((a) => `${esc(a.line)} @ ${esc(a.stopName)} (≤${a.minutes} dk)`).join(', '));
  if (dest) parts.push(`İniş: ${esc(dest.name)}${lastDist != null ? ` · ${fmtDist(lastDist)}` : ''}`);
  if (!parts.length) {
    bar.hidden = true;
    keepAwake(false);
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `${icon('bell')}<span style="flex:1">${parts.join(' · ')}</span>${icon('close')}`;
  keepAwake(!!dest);
  bar.onclick = async (e) => {
    if (!e.target.closest('.ic:last-child')) return;
    const { actionSheet } = await import('./ui.js');
    const opts = alarms.map((a) => ({ label: `${a.line} — ${a.stopName} alarmını sil`, value: a.id, icon: 'trash' }));
    if (dest) opts.push({ label: `İniş alarmını kapat (${dest.name})`, value: 'dest', icon: 'trash' });
    if (opts.length > 1) opts.push({ label: 'Hepsini kapat', value: 'all', icon: 'trash', danger: true });
    const v = await actionSheet('Alarmlar', opts);
    if (v === 'all') {
      alarms.forEach((a) => store.removeAlarm(a.id));
      clearDestAlarm();
    } else if (v === 'dest') clearDestAlarm();
    else if (v) store.removeAlarm(v);
    renderBar();
  };
}

export function initAlarms() {
  if (store.get().alarms.length) startPolling();
  if (dest) {
    watchDest();
    startLocation();
  }
  store.subscribe(() => {
    if (store.get().alarms.length) startPolling();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (store.get().alarms.length) checkBusAlarms();
      if (dest) keepAwake(true);
    }
  });
  renderBar();
}
