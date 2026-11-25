// Leaflet map wrapper: base layers, user location, layers per view, stop dots.
/* global L */
import { lineColor, esc } from './ui.js';

const ISTANBUL = [41.015, 28.979];
let map;
let tiles;
let viewLayer; // cleared on every route change
let stopsLayer; // background stop dots when zoomed in
let userMarker;
let accuracyCircle;
let userPos = null;
let watchId = null;
const posListeners = new Set();
let longPressHandler = null;
let stopClickHandler = null;
let bgStopsEnabled = true;

function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function tileUrl() {
  return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
}

export function initMap(el) {
  map = L.map(el, { zoomControl: false, attributionControl: true, tap: true }).setView(ISTANBUL, 12);
  tiles = L.tileLayer(tileUrl(), {
    maxZoom: 19,
    className: 'base-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.createPane('routes').style.zIndex = 410;
  map.createPane('stops').style.zIndex = 420;
  map.createPane('vehicles').style.zIndex = 640;
  stopsLayer = L.layerGroup().addTo(map);
  viewLayer = L.layerGroup().addTo(map);

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshTiles);
  refreshTiles();

  // Long-press / right-click -> "plan from/to here"
  map.on('contextmenu', (e) => longPressHandler && longPressHandler(e.latlng));
  map.on('moveend', loadBgStops);
  return map;
}

export function refreshTiles() {
  document.documentElement.classList.toggle('dark-map', isDark());
}

export function getMap() {
  return map;
}

export function clearView() {
  viewLayer.clearLayers();
}

export function addToView(layer) {
  layer.addTo(viewLayer);
  return layer;
}

export function onLongPress(fn) {
  longPressHandler = fn;
}

export function onStopClick(fn) {
  stopClickHandler = fn;
}

export function setBgStops(enabled) {
  bgStopsEnabled = enabled;
  if (!enabled) stopsLayer.clearLayers();
  else loadBgStops();
}

let bgTimer;
let bgApi;
export function setBgStopsApi(fn) {
  bgApi = fn;
}

function loadBgStops() {
  clearTimeout(bgTimer);
  bgTimer = setTimeout(async () => {
    if (!bgStopsEnabled || !bgApi || map.getZoom() < 16) {
      stopsLayer.clearLayers();
      return;
    }
    const b = map.getBounds();
    try {
      const { stops } = await bgApi({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() });
      stopsLayer.clearLayers();
      for (const s of stops) {
        L.circleMarker([s.lat, s.lng], { pane: 'stops', radius: 6, weight: 2, color: '#fff', fillColor: 'var(--brand)', fillOpacity: 1, className: 'bg-stop' })
          .bindTooltip(esc(s.name), { direction: 'top', offset: [0, -6] })
          .on('click', () => stopClickHandler && stopClickHandler(s))
          .addTo(stopsLayer);
      }
    } catch {
      /* ignore */
    }
  }, 250);
}

// ---------- user location ----------

export function getUserPos() {
  return userPos;
}

export function onUserPos(fn) {
  posListeners.add(fn);
  if (userPos) fn(userPos);
  return () => posListeners.delete(fn);
}

export function startLocation({ fly = false } = {}) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    let resolved = false;
    const done = (v) => {
      if (!resolved) {
        resolved = true;
        resolve(v);
      }
    };
    if (watchId == null) {
      watchId = navigator.geolocation.watchPosition(
        (p) => {
          const first = !userPos;
          userPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
          drawUser();
          posListeners.forEach((fn) => fn(userPos));
          if (first && fly) flyTo(userPos.lat, userPos.lng, 16);
          done(userPos);
        },
        () => done(null),
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    }
    if (userPos) {
      if (fly) flyTo(userPos.lat, userPos.lng, Math.max(map.getZoom(), 16));
      done(userPos);
    }
    setTimeout(() => done(userPos), 12000);
  });
}

function drawUser() {
  const ll = [userPos.lat, userPos.lng];
  if (!userMarker) {
    userMarker = L.marker(ll, {
      icon: L.divIcon({ className: 'user-dot', html: '<span></span>', iconSize: [22, 22] }),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(map);
    accuracyCircle = L.circle(ll, { radius: userPos.acc, color: '#2f7cf6', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
  } else {
    userMarker.setLatLng(ll);
    accuracyCircle.setLatLng(ll).setRadius(Math.min(userPos.acc, 500));
  }
}

// ---------- helpers for views ----------

export function stopMarker(s, { big = false, label } = {}) {
  const html = big ? `<div class="pin"><svg viewBox="0 0 24 24"><use href="#i-bus"/></svg></div>` : '<span></span>';
  const m = L.marker([s.lat, s.lng], {
    pane: 'stops',
    icon: L.divIcon({ className: big ? 'stop-pin' : 'stop-dot', html, iconSize: big ? [34, 42] : [14, 14], iconAnchor: big ? [17, 40] : [7, 7] }),
  });
  if (label) m.bindTooltip(esc(label), { direction: 'top', offset: [0, big ? -38 : -8] });
  return m;
}

export function routeLine(points, color, opts = {}) {
  return L.polyline(points, { pane: 'routes', color, weight: 6, opacity: 0.9, lineJoin: 'round', ...opts });
}

export function vehicleMarker(v, line) {
  return L.marker([v.lat, v.lng], {
    pane: 'vehicles',
    icon: L.divIcon({
      className: 'veh',
      html: `<div class="veh-in" style="--c:${lineColor(line)}"><svg viewBox="0 0 24 24"><use href="#i-bus"/></svg></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    }),
    zIndexOffset: 900,
  });
}

export function pointMarker(lat, lng, kind) {
  return L.marker([lat, lng], {
    pane: 'vehicles',
    icon: L.divIcon({ className: `pt pt-${kind}`, html: `<span>${kind === 'from' ? 'A' : 'B'}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
  });
}

// Area of the map not covered by the top bar / bottom sheet / sidebar.
function overlays() {
  const desktop = matchMedia('(min-width: 900px)').matches;
  if (desktop) return { top: 20, bottom: 20, left: 430, right: 20 };
  const st = document.getElementById('sheet')?.dataset.state || 'half';
  const vh = map.getSize().y;
  const tab = document.getElementById('tabbar')?.getBoundingClientRect().height || 62;
  // Use the target state height (the sheet may still be animating).
  const sheetH = st === 'peek' ? 168 : st === 'half' ? window.innerHeight * 0.52 : vh * 0.85;
  return { top: 70, bottom: Math.min(vh - 220, sheetH + tab + 10), left: 20, right: 20 };
}

export function fit(bounds) {
  if (!bounds || !bounds.isValid || !bounds.isValid()) return;
  const o = overlays();
  map.fitBounds(bounds, { paddingTopLeft: [o.left, o.top], paddingBottomRight: [o.right, o.bottom], maxZoom: 17, animate: false });
}

export function flyTo(lat, lng, zoom = 16) {
  const o = overlays();
  const size = map.getSize();
  // Shift so the point lands in the middle of the visible area.
  const dx = (o.left - o.right) / 2;
  const dy = (o.top - o.bottom) / 2;
  const pt = map.project([lat, lng], zoom).subtract([dx, dy]);
  void size;
  map.setView(map.unproject(pt, zoom), zoom, { animate: false });
}
