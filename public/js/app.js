// YKMaps entry: map, router, global UI wiring.
/* global L */
import { initMap, startLocation, getUserPos, flyTo, onLongPress, onStopClick, setBgStopsApi, getMap } from './map.js';
import { beginView, setBack, setActiveTab, initSheetDrag, navigate, positionCtrls } from './core.js';
import { api } from './api.js';
import { initAlarms } from './alarms.js';
import { viewStop } from './views/stop.js';
import { viewLine } from './views/line.js';
import { viewPlan, planTo, planFrom } from './views/plan.js';
import { viewNearby, viewSearch, viewLines, viewFavorites, viewNews, viewNewsDetail, viewSettings, applyTheme, syncLineWatch } from './views/home.js';
import { store } from './store.js';
import { $, esc, toast } from './ui.js';

applyTheme();
initMap($('#map'));
initSheetDrag();
initAlarms();
setBgStopsApi((b) => api.bbox(b));
onStopClick((s) => navigate(`#/stop/${s.code}`));
let lastFavKey = store.get().favLines.map((l) => l.code).join(',');
store.subscribe((st) => {
  const k = st.favLines.map((l) => l.code).join(',');
  if (k !== lastFavKey) {
    lastFavKey = k;
    if (st.settings.lineWatch) syncLineWatch();
  }
});

// Long-press on the map: plan from/to that point.
onLongPress((ll) => {
  const lat = +ll.lat.toFixed(6);
  const lng = +ll.lng.toFixed(6);
  const html = `<div class="map-popup"><b>Seçilen nokta</b>
    <button class="btn" data-a="to">Buraya git</button>
    <button class="btn ghost" data-a="from">Buradan başla</button></div>`;
  const pop = L.popup({ closeButton: false }).setLatLng(ll).setContent(html).openOn(getMap());
  const el = pop.getElement();
  el.querySelector('[data-a="to"]').onclick = () => {
    getMap().closePopup();
    planTo({ name: 'Haritada seçilen nokta', lat, lng });
  };
  el.querySelector('[data-a="from"]').onclick = () => {
    getMap().closePopup();
    planFrom({ name: 'Haritada seçilen nokta', lat, lng });
  };
});

$('#locateBtn').onclick = async () => {
  const p = getUserPos() || (await startLocation());
  if (p) flyTo(p.lat, p.lng, 17);
  else toast('Konum alınamadı. Tarayıcı konum iznini kontrol edin.');
};

// Search box
const input = $('#searchInput');
input.addEventListener('focus', () => {
  if (!location.hash.startsWith('#/search')) navigate(`#/search?q=${encodeURIComponent(input.value)}`);
});
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  input.blur();
});
$('#backBtn').onclick = () => {
  if (history.length > 1) history.back();
  else navigate('#/');
};

const TOP = { '': 'near', lines: 'lines', plan: 'plan', favorites: 'fav', news: 'news' };

function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, qs = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(qs);
  const token = beginView();
  const head = parts[0] || '';
  setActiveTab(TOP[head] || (head === 'stop' || head === 'line' ? '' : ''));
  setBack(!(head in TOP) || parts.length > 1);
  if (head !== 'search' && document.activeElement !== input) input.value = '';
  document.title = 'YKMaps';
  switch (head) {
    case '':
      return viewNearby(token);
    case 'search':
      return viewSearch(token, query);
    case 'lines':
      return viewLines(token);
    case 'line':
      document.title = `${parts[1]} · YKMaps`;
      return viewLine(token, parts[1], query);
    case 'stop':
      return viewStop(token, parts[1]);
    case 'plan':
      return viewPlan(token, query);
    case 'favorites':
      return viewFavorites(token);
    case 'news':
      return parts[1] ? viewNewsDetail(token, parts[1]) : viewNews(token);
    case 'settings':
      return viewSettings(token);
    default:
      $('#view').innerHTML = `<div class="empty"><p>Sayfa bulunamadı: ${esc(raw)}</p><a class="btn small" href="#/">Ana sayfa</a></div>`;
  }
}

window.addEventListener('hashchange', route);
route();
positionCtrls();

// PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  navigator.serviceWorker.addEventListener?.('message', (e) => {
    if (e.data?.url) navigate(e.data.url);
  });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__installPrompt = e;
});
