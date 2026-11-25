// Trip planner ("Nasıl Giderim"): multimodal routes via İETT's planner.
/* global L */
import { api } from '../api.js';
import { store } from '../store.js';
import { render, setSheet, isCurrent, onLeave, navigate } from '../core.js';
import { addToView, routeLine, pointMarker, fit, getUserPos, startLocation, getMap, clearView } from '../map.js';
import { setDestAlarm } from '../alarms.js';
import {
  esc, icon, lineBadge, loading, errorBox, empty, titleCase, toast, fmtTime, fmtDist, debounce, lineColor, modeIcon, istNow, promptModal, $, $$,
} from '../ui.js';

// Planner state survives navigation between list and detail.
const S = {
  from: null, // {name, lat, lng, me?}
  to: null,
  opt: 'time',
  when: 'now', // now | depart | arrive
  time: '',
  date: '',
  results: null,
  key: '',
  sel: -1,
};

const OPTS = [
  ['time', 'En hızlı'],
  ['transfers', 'Az aktarma'],
  ['walk', 'Az yürüme'],
  ['metro', 'Raylı öncelikli'],
];

function parsePoint(v, name) {
  if (!v) return null;
  const [lat, lng] = v.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, name: name || `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
}

export async function viewPlan(token, query) {
  const f = parsePoint(query.get('from'), query.get('fromName'));
  const t = parsePoint(query.get('to'), query.get('toName'));
  if (f) S.from = f;
  if (t) S.to = t;
  if (query.get('from') || query.get('to')) {
    S.results = null;
    S.sel = -1;
    history.replaceState(null, '', '#/plan');
  }
  if (!S.from) {
    const p = getUserPos();
    S.from = { name: 'Konumum', me: true, ...(p ? { lat: p.lat, lng: p.lng } : {}) };
  }
  if (S.sel >= 0 && S.results) return drawDetail(token);
  drawForm(token);
}

function fieldLabel(p) {
  return p ? (p.me ? 'Konumum' : p.name) : '';
}

function drawForm(token) {
  setSheet(S.results ? 'half' : 'full');
  const now = istNow();
  const pad = (n) => String(n).padStart(2, '0');
  if (!S.time) S.time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (!S.date) S.date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  render(`
    <div class="view-head"><h2>Nasıl Giderim?</h2></div>
    <div class="plan-form">
      <div class="plan-fields">
        <div class="plan-field"><span class="dot"></span><input id="fromIn" placeholder="Nereden?" value="${esc(fieldLabel(S.from))}" autocomplete="off">
          <button id="fromMe" aria-label="Konumum">${icon('gps')}</button><button id="fromMap" aria-label="Haritadan seç">${icon('pin')}</button></div>
        <div class="plan-field"><span class="dot to"></span><input id="toIn" placeholder="Nereye?" value="${esc(fieldLabel(S.to))}" autocomplete="off">
          <button id="toMap" aria-label="Haritadan seç">${icon('pin')}</button></div>
      </div>
      <button class="swap-btn" id="swapBtn" aria-label="Yer değiştir">${icon('swap')}</button>
    </div>
    <div id="suggest"></div>
    <div class="plan-opts">
      <select id="whenSel" aria-label="Zaman">
        <option value="now">Şimdi çık</option><option value="depart">Kalkış saati</option><option value="arrive">Varış saati</option>
      </select>
      <input type="time" id="timeIn" value="${esc(S.time)}" ${S.when === 'now' ? 'hidden' : ''}>
      <input type="date" id="dateIn" value="${esc(S.date)}" ${S.when === 'now' ? 'hidden' : ''}>
    </div>
    <div class="chips scroll" id="optChips">${OPTS.map(([k, l]) => `<button class="chip ${S.opt === k ? 'on' : ''}" data-opt="${k}">${l}</button>`).join('')}</div>
    <div id="results"></div>
  `);
  $('#whenSel').value = S.when;

  const quick = () => {
    const places = store.get().places;
    const favs = store.get().favStops.filter((s) => s.lat != null).slice(0, 4);
    if (!places.length && !favs.length) return '';
    return `<div class="section-title">Kayıtlı yerler</div><div class="quick-places">
      ${places.map((p) => `<button class="qp" data-qp="${esc(p.id)}">${icon(p.label === 'Ev' ? 'home' : p.label === 'İş' ? 'work' : 'pin')}<b>${esc(p.label || p.name)}</b><small>${esc(p.name)}</small></button>`).join('')}
      ${favs.map((s) => `<button class="qp" data-qs="${esc(s.code)}">${icon('bus')}<b>${esc(titleCase(s.name))}</b><small>Durak</small></button>`).join('')}
    </div>`;
  };

  let active = null; // 'from' | 'to'
  const sug = $('#suggest');
  const showQuick = () => {
    sug.innerHTML = quick();
    $$('#suggest [data-qp]').forEach((b) => {
      b.onclick = () => {
        const p = store.get().places.find((x) => x.id === b.dataset.qp);
        choose(active || (S.to ? 'from' : 'to'), { name: p.label || p.name, lat: p.lat, lng: p.lng });
      };
    });
    $$('#suggest [data-qs]').forEach((b) => {
      b.onclick = () => {
        const s = store.get().favStops.find((x) => x.code === b.dataset.qs);
        choose(active || (S.to ? 'from' : 'to'), { name: titleCase(s.name), lat: s.lat, lng: s.lng });
      };
    });
  };

  const choose = (which, p) => {
    S[which] = p;
    S.results = null;
    $(`#${which}In`).value = fieldLabel(p);
    sug.innerHTML = '';
    active = null;
    drawPoints();
    maybePlan(token);
  };

  const doSuggest = debounce(async (which, q) => {
    if (q.trim().length < 2) return showQuick();
    sug.innerHTML = `<div class="suggest-list">${loading('Aranıyor…')}</div>`;
    try {
      const r = await api.search(q);
      if (active !== which) return;
      const items = [];
      for (const p of r.places) items.push({ name: p.name, sub: [p.district, placeType(p.type)].filter(Boolean).join(' · '), lat: p.lat, lng: p.lng, ic: p.type === 'poi' ? 'pin' : modeIcon(p.type) });
      for (const s of r.stops) if (s.lat != null) items.push({ name: titleCase(s.name), sub: `Durak · ${titleCase(s.district)}${s.direction ? ` · ${titleCase(s.direction)} yönü` : ''}`, lat: s.lat, lng: s.lng, ic: 'bus' });
      sug.innerHTML = items.length
        ? `<div class="suggest-list">${items
            .slice(0, 25)
            .map((it, i) => `<button class="item" data-i="${i}"><div class="item-ic">${icon(it.ic)}</div><div class="grow"><div class="t">${esc(it.name)}</div><div class="s">${esc(it.sub)}</div></div></button>`)
            .join('')}</div>`
        : `<div class="suggest-list">${empty('Sonuç bulunamadı', 'search')}</div>`;
      $$('#suggest [data-i]').forEach((b) => {
        b.onclick = () => {
          const it = items[Number(b.dataset.i)];
          choose(which, { name: it.name, lat: it.lat, lng: it.lng });
        };
      });
    } catch (e) {
      sug.innerHTML = `<div class="suggest-list">${errorBox(e)}</div>`;
    }
  }, 300);

  for (const which of ['from', 'to']) {
    const inp = $(`#${which}In`);
    inp.addEventListener('focus', () => {
      active = which;
      setSheet('full');
      if (S[which]?.me) inp.value = '';
      inp.select();
      if (!inp.value) showQuick();
    });
    inp.addEventListener('input', () => doSuggest(which, inp.value));
  }
  $('#fromMe').onclick = async () => {
    const p = getUserPos() || (await startLocation());
    if (!p) return toast('Konum alınamadı. Konum iznini kontrol edin.');
    choose('from', { name: 'Konumum', me: true, lat: p.lat, lng: p.lng });
  };
  const pick = (which) => {
    toast(`${which === 'from' ? 'Başlangıç' : 'Varış'} noktası için haritaya dokunun`);
    setSheet('peek');
    const map = getMap();
    const h = (e) => {
      choose(which, { name: 'Haritada seçilen nokta', lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) });
      setSheet('half');
    };
    map.once('click', h);
    onLeave(() => map.off('click', h));
  };
  $('#fromMap').onclick = () => pick('from');
  $('#toMap').onclick = () => pick('to');
  $('#swapBtn').onclick = () => {
    [S.from, S.to] = [S.to, S.from];
    S.results = null;
    drawForm(token);
    drawPoints();
    maybePlan(token);
  };
  $('#whenSel').onchange = (e) => {
    S.when = e.target.value;
    $('#timeIn').hidden = $('#dateIn').hidden = S.when === 'now';
    S.results = null;
    maybePlan(token);
  };
  $('#timeIn').onchange = (e) => {
    S.time = e.target.value;
    S.results = null;
    maybePlan(token);
  };
  $('#dateIn').onchange = (e) => {
    S.date = e.target.value;
    S.results = null;
    maybePlan(token);
  };
  $$('#optChips .chip').forEach((b) => {
    b.onclick = () => {
      S.opt = b.dataset.opt;
      $$('#optChips .chip').forEach((x) => x.classList.toggle('on', x === b));
      S.results = null;
      maybePlan(token);
    };
  });

  drawPoints();
  if (S.results) drawResults(token);
  else if (S.from && S.to) maybePlan(token);
  else {
    if (!S.to) showQuick();
    if (S.from?.me && S.from.lat == null) {
      startLocation().then((p) => {
        if (p && S.from?.me) {
          S.from = { name: 'Konumum', me: true, lat: p.lat, lng: p.lng };
          drawPoints();
        }
      });
    }
  }
}

function placeType(t) {
  return { bus: 'Otobüs durağı', metro: 'Metro', tram: 'Tramvay', metrobus: 'Metrobüs', ferry: 'İskele', marmaray: 'Marmaray', poi: '' }[t] ?? '';
}

function drawPoints() {
  clearView();
  const b = L.latLngBounds([]);
  if (S.from?.lat != null) {
    addToView(pointMarker(S.from.lat, S.from.lng, 'from'));
    b.extend([S.from.lat, S.from.lng]);
  }
  if (S.to?.lat != null) {
    addToView(pointMarker(S.to.lat, S.to.lng, 'to'));
    b.extend([S.to.lat, S.to.lng]);
  }
  if (b.isValid()) fit(b);
}

async function maybePlan(token) {
  const res = $('#results');
  if (!res) return;
  if (S.from?.me && S.from.lat == null) {
    const p = getUserPos() || (await startLocation());
    if (p) S.from = { name: 'Konumum', me: true, lat: p.lat, lng: p.lng };
  }
  if (!S.from || S.from.lat == null || !S.to || S.to.lat == null) return;
  const [y, m, d] = (S.date || '').split('-');
  const params = { from: `${S.from.lat},${S.from.lng}`, to: `${S.to.lat},${S.to.lng}`, opt: S.opt };
  if (S.when !== 'now') {
    params.time = S.time;
    params.date = `${d}-${m}-${y}`;
    if (S.when === 'arrive') params.arriveBy = '1';
  }
  const key = JSON.stringify(params);
  S.key = key;
  setSheet('half');
  res.innerHTML = loading('En iyi rotalar hesaplanıyor…');
  try {
    const r = await api.plan(params);
    if (!isCurrent(token) || S.key !== key) return;
    S.results = r;
    S.sel = -1;
    drawResults(token);
  } catch (e) {
    if (!isCurrent(token) || S.key !== key) return;
    res.innerHTML = errorBox(e);
    res.querySelector('[data-retry]').onclick = () => maybePlan(token);
  }
}

function legSummary(it) {
  return it.legs
    .map((l) => {
      if (l.mode !== 'walking') return lineBadge(l.line || l.modeName, l.mode, 'sm');
      if (l.distance > 80 || it.legs.length === 1) return `<span class="badge walk sm">${icon('walk')}${Math.max(1, Math.round((l.end - l.start) / 60000))}′</span>`;
      return null;
    })
    .filter(Boolean)
    .join(icon('chev', 'sep'));
}

function drawResults(token) {
  const res = $('#results');
  const r = S.results;
  if (!r.itineraries.length) {
    res.innerHTML = empty(r.error === 'NO_ROUTE_POSSIBLE' ? 'Bu iki nokta arasında toplu taşıma rotası bulunamadı. Farklı bir saat veya seçenek deneyin.' : 'Rota bulunamadı.', 'route');
    return;
  }
  res.innerHTML = r.itineraries
    .map(
      (it, i) => `<div class="itin" data-i="${i}">
      <div class="top"><div class="dur">${it.duration}<small> dk</small></div><div class="when">${fmtTime(it.start)} – ${fmtTime(it.end)}</div></div>
      <div class="legs">${legSummary(it)}</div>
      <div class="meta"><span>${icon('walk')}${fmtDist(it.walk)}</span>${it.fare ? `<span>₺${Number(it.fare).toFixed(2).replace('.', ',')}</span>` : ''}<span>${it.transfers ? `${it.transfers} aktarma` : 'Aktarmasız'}</span></div>
    </div>`
    )
    .join('') + `<div class="note">${icon('info')}<span>Rotalar İETT Nasıl Giderim servisinden alınır; ücretler tam İstanbulkart tarifesine göre tahminidir.</span></div>`;
  $$('#results .itin').forEach((el) => {
    el.onclick = () => {
      S.sel = Number(el.dataset.i);
      drawDetail(token);
    };
    el.onmouseenter = () => previewItin(r.itineraries[Number(el.dataset.i)], false);
  });
  previewItin(r.itineraries[0], true);
}

function drawItinOnMap(it) {
  clearView();
  const b = L.latLngBounds([]);
  for (const l of it.legs) {
    if (!l.shape.length) continue;
    const walking = l.mode === 'walking';
    if (!walking) addToView(routeLine(l.shape, '#fff', { weight: 9, opacity: 0.9 }));
    addToView(routeLine(l.shape, walking ? '#6b7280' : lineColor(l.line, l.mode), walking ? { weight: 4, dashArray: '2 8' } : { weight: 5 }));
    l.shape.forEach((p) => b.extend(p));
    if (!walking && l.stops[0]?.lat != null) {
      addToView(L.circleMarker([l.stops[0].lat, l.stops[0].lng], { pane: 'stops', radius: 6, color: lineColor(l.line, l.mode), weight: 3, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(l.stops[0].name)));
    }
  }
  if (S.from?.lat != null) addToView(pointMarker(S.from.lat, S.from.lng, 'from'));
  if (S.to?.lat != null) addToView(pointMarker(S.to.lat, S.to.lng, 'to'));
  return b;
}

function previewItin(it, refit) {
  const b = drawItinOnMap(it);
  if (refit) fit(b);
}

function drawDetail(token) {
  const it = S.results.itineraries[S.sel];
  setSheet('half');
  fit(drawItinOnMap(it));
  const steps = it.legs.map((l, i) => {
    const mins = Math.max(1, Math.round((l.end - l.start) / 60000));
    if (l.mode === 'walking') {
      const target = i === it.legs.length - 1 ? fieldLabel(S.to) : l.stops[l.stops.length - 1]?.name || 'durağa';
      return `<li class="walk"><div class="time">${fmtTime(l.start)}</div><div class="body" style="--c:#9aa3ad">
        <div class="t">${icon('walk')} ${mins} dk yürü</div><div class="s">${fmtDist(l.distance)} · ${esc(target)}</div></div></li>`;
    }
    const first = l.stops[0];
    const last = l.stops[l.stops.length - 1];
    const mid = l.stops.slice(1, -1).filter((s) => s.name);
    const liveStop = /^\d+$/.test(first?.id || '') ? first.id : null;
    const busLike = ['bus', 'metrobus'].includes(l.mode) && /^[0-9A-ZÇĞİÖŞÜ-]+$/i.test(l.line);
    return `<li><div class="time">${fmtTime(l.start)}</div><div class="body" style="--c:${lineColor(l.line, l.mode)}">
      <div class="t">${lineBadge(l.line || l.modeName, l.mode, 'sm')} ${esc(l.lineName ? titleCase(l.lineName) : l.modeName)}</div>
      <div class="s"><b>${esc(first?.name || '')}</b> → <b>${esc(last?.name || '')}</b></div>
      <div class="s">${mins} dk${l.stops.length > 2 ? ` · ${l.stops.length - 1} durak` : ''}${l.alternatives.length ? ` · Alternatif: ${esc(l.alternatives.join(', '))}` : ''}</div>
      ${mid.length ? `<details><summary>Ara duraklar (${mid.length})</summary><ol>${mid.map((s) => `<li>${esc(s.name)}</li>`).join('')}</ol></details>` : ''}
      <div class="chips" style="margin-top:6px">
        ${liveStop ? `<a class="chip" href="#/stop/${liveStop}">${icon('clock')} Canlı varış</a>` : ''}
        ${busLike ? `<a class="chip" href="#/line/${encodeURIComponent(l.line)}">${icon('bus')} Hat</a>` : ''}
        ${last?.lat != null ? `<button class="chip" data-off="${i}">${icon('flag')} İneceğim yerde uyar</button>` : ''}
      </div>
    </div></li>`;
  });
  render(`
    <div class="view-head">
      <button class="star-btn" id="backList" aria-label="Rotalara dön">${icon('back')}</button>
      <div style="flex:1"><h2>${it.duration} dk · ${fmtTime(it.start)} – ${fmtTime(it.end)}</h2>
      <div class="sub">${fmtDist(it.walk)} yürüme · ${it.transfers ? `${it.transfers} aktarma` : 'aktarmasız'}${it.fare ? ` · ₺${Number(it.fare).toFixed(2).replace('.', ',')}` : ''}${it.co2 ? ` · ${it.co2} g CO₂` : ''}</div></div>
    </div>
    <div class="sub" style="margin-bottom:8px">${esc(fieldLabel(S.from))} → ${esc(fieldLabel(S.to))}</div>
    <ul class="steps">${steps.join('')}
      <li><div class="time">${fmtTime(it.end)}</div><div class="body" style="--c:var(--danger)"><div class="t">${icon('flag')} Varış</div><div class="s">${esc(fieldLabel(S.to))}</div></div></li>
    </ul>
    <div class="row-btns" style="justify-content:stretch">
      <button class="btn ghost block" id="saveTo">${icon('star-o')} Varışı kaydet</button>
      <button class="btn block" id="alarmTo">${icon('bell')} Varışta uyar</button>
    </div>
  `);
  $('#backList').onclick = () => {
    S.sel = -1;
    drawForm(token);
  };
  $$('[data-off]').forEach((b) => {
    b.onclick = () => {
      const l = it.legs[Number(b.dataset.off)];
      const last = l.stops[l.stops.length - 1];
      setDestAlarm({ name: last.name, lat: last.lat, lng: last.lng });
    };
  });
  $('#alarmTo').onclick = () => setDestAlarm({ name: fieldLabel(S.to), lat: S.to.lat, lng: S.to.lng, radius: 300 });
  $('#saveTo').onclick = async () => {
    const label = await promptModal('Yer adı', S.to.name === 'Haritada seçilen nokta' ? '' : S.to.name, 'Ev, İş, Okul…');
    if (!label) return;
    store.savePlace({ label, name: S.to.name, lat: S.to.lat, lng: S.to.lng });
    toast(`"${label}" kaydedildi`);
  };
}

/** Allow other views to start a plan. */
export function planTo(p) {
  S.to = p;
  S.results = null;
  S.sel = -1;
  navigate('#/plan');
}
export function planFrom(p) {
  S.from = p;
  S.results = null;
  S.sel = -1;
  navigate('#/plan');
}
