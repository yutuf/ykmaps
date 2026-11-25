// Line detail: route map, stops per direction, timetable, alerts, live vehicles.
/* global L */
import { api } from '../api.js';
import { store } from '../store.js';
import { render, setSheet, isCurrent, liveInterval, navigate } from '../core.js';
import { addToView, routeLine, vehicleMarker, fit, getUserPos, getMap } from '../map.js';
import { setDestAlarm } from '../alarms.js';
import { esc, icon, lineBadge, loading, errorBox, titleCase, toast, haversine, fmtDist, istNow, $, $$ } from '../ui.js';

export async function viewLine(token, code, query) {
  render(loading('Hat yükleniyor…'));
  setSheet('half');
  let data;
  try {
    data = await api.line(code);
  } catch (e) {
    if (!isCurrent(token)) return;
    render(errorBox(e));
    $('[data-retry]').onclick = () => viewLine(token, code, query);
    return;
  }
  if (!isCurrent(token)) return;
  store.addRecent({ type: 'line', code: data.code, name: data.name });

  let dir = Math.min(Number(query.get('dir')) || 0, data.directions.length - 1);
  let tab = query.get('tab') || 'stops';
  let vehicles = [];
  let vehLayer = null;
  let routeLayers = [];
  let schedule = null;
  let day = dayType();
  let vehNoteShown = false;

  render(`
    <div class="view-head">
      ${lineBadge(data.code)}
      <div style="flex:1;min-width:0"><div class="kicker"><span class="label">Hat ${esc(data.code)}</span></div><h2 style="font-size:19px">${esc(titleCase(data.name))}</h2>
        <div class="sub" id="vehInfo"></div></div>
      <button class="star-btn ${store.isFavLine(data.code) ? 'on' : ''}" id="favBtn" aria-label="Favori">${icon(store.isFavLine(data.code) ? 'star' : 'star-o')}</button>
    </div>
    ${data.alerts.map((a) => `<div class="alert-card">${icon('alert')}<span>${esc(a)}</span></div>`).join('')}
    ${data.directions.length > 1 ? `<button class="dir-switch" id="dirBtn">${icon('swap')}<div class="grow" id="dirText"></div></button>` : `<div class="dir-switch"><div class="grow" id="dirText"></div></div>`}
    <div class="seg" id="tabs">
      <button data-tab="stops">Duraklar</button><button data-tab="times">Sefer Saatleri</button><button data-tab="info">Bilgi</button>
    </div>
    <div id="tabBody"></div>
  `);

  $('#favBtn').onclick = () => {
    const on = store.toggleFavLine(data);
    $('#favBtn').className = `star-btn ${on ? 'on' : ''}`;
    $('#favBtn').innerHTML = icon(on ? 'star' : 'star-o');
    toast(on ? 'Favorilere eklendi' : 'Favorilerden çıkarıldı');
  };
  if ($('#dirBtn')) {
    $('#dirBtn').onclick = () => {
      dir = (dir + 1) % data.directions.length;
      history.replaceState(null, '', `#/line/${encodeURIComponent(code)}?dir=${dir}&tab=${tab}`);
      drawMap(true);
      drawTab();
    };
  }
  $$('#tabs button').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      history.replaceState(null, '', `#/line/${encodeURIComponent(code)}?dir=${dir}&tab=${tab}`);
      drawTab();
    };
  });

  function drawMap(refit) {
    routeLayers.forEach((l) => l.remove());
    routeLayers = [];
    const bounds = L.latLngBounds([]);
    data.directions.forEach((d, i) => {
      if (i === dir || !d.shape.length) return;
      routeLayers.push(addToView(routeLine(d.shape, '#8a9792', { weight: 4, opacity: 0.45, dashArray: '6 8' })));
    });
    const d = data.directions[dir];
    if (d.shape.length) {
      routeLayers.push(addToView(routeLine(d.shape, '#ffffff', { weight: 9, opacity: 0.9 })));
      routeLayers.push(addToView(routeLine(d.shape, d.color || '#2563c9', { weight: 5 })));
      d.shape.forEach((p) => bounds.extend(p));
    }
    d.stops.forEach((s, i) => {
      if (s.lat == null) return;
      bounds.extend([s.lat, s.lng]);
      const first = i === 0 || i === d.stops.length - 1;
      const m = L.circleMarker([s.lat, s.lng], { pane: 'stops', radius: first ? 7 : 5, weight: 2.5, color: d.color || '#2563c9', fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${s.seq}. ${esc(titleCase(s.name))}`, { direction: 'top' })
        .on('click', () => navigate(`#/stop/${s.code}`));
      routeLayers.push(addToView(m));
    });
    $('#dirText').innerHTML = `${esc(titleCase(d.from))} → ${esc(titleCase(d.to))}<small>${d.stops.length} durak${data.directions.length > 1 ? ' · yönü değiştirmek için dokun' : ''}</small>`;
    if (refit) fit(bounds);
  }

  function nearestStopIdx(d) {
    const p = getUserPos();
    if (!p) return -1;
    let best = -1;
    let bestD = Infinity;
    d.stops.forEach((s, i) => {
      if (s.lat == null) return;
      const x = haversine(p, s);
      if (x < bestD) {
        bestD = x;
        best = i;
      }
    });
    return bestD < 2000 ? best : -1;
  }

  function drawTab() {
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'stops') drawStops();
    else if (tab === 'times') drawTimes();
    else drawInfo();
  }

  function drawStops() {
    const d = data.directions[dir];
    const near = nearestStopIdx(d);
    const vehAt = new Map();
    for (const v of vehicles) if (v.nearStop) vehAt.set(v.nearStop, (vehAt.get(v.nearStop) || 0) + 1);
    const p = getUserPos();
    $('#tabBody').innerHTML = `<ul class="timeline" style="--c:${d.color || '#2563c9'}">
      ${d.stops
        .map(
          (s, i) => `<li data-code="${s.code}" class="${i === near ? 'near-me' : ''}">
          <div class="grow"><div class="t">${s.seq}. ${esc(titleCase(s.name))}</div>
          <div class="s">${esc(titleCase(s.district))}${i === near && p ? ` · <span class="tag">Size en yakın (${fmtDist(haversine(p, s))})</span>` : ''}</div></div>
          ${vehAt.get(s.code) ? `<svg class="ic bus-here" aria-label="Araç burada"><use href="#i-bus"/></svg>` : ''}
          <button class="alarm-btn" data-off="${i}" aria-label="Bu durakta ineceğim, uyar" title="Bu durakta ineceğim">${icon('flag')}</button>
        </li>`
        )
        .join('')}
    </ul>`;
    $$('#tabBody li').forEach((li) => {
      li.onclick = (e) => {
        if (e.target.closest('[data-off]')) return;
        navigate(`#/stop/${li.dataset.code}`);
      };
    });
    $$('#tabBody [data-off]').forEach((b) => {
      b.onclick = () => {
        const s = d.stops[Number(b.dataset.off)];
        if (s.lat == null) return toast('Bu durağın konumu bilinmiyor');
        setDestAlarm({ name: titleCase(s.name), lat: s.lat, lng: s.lng });
      };
    });
    if (near > 3) {
      const li = $$('#tabBody li')[near];
      li?.scrollIntoView({ block: 'center' });
    }
  }

  async function drawTimes() {
    const body = $('#tabBody');
    if (!schedule) {
      body.innerHTML = loading('Sefer saatleri alınıyor…');
      try {
        schedule = await api.schedule(code);
      } catch (e) {
        if (tab !== 'times') return;
        body.innerHTML = errorBox(e);
        body.querySelector('[data-retry]').onclick = drawTimes;
        return;
      }
      if (!isCurrent(token) || tab !== 'times') return;
    }
    const d = data.directions[dir];
    const tables = schedule.directions;
    if (!tables.length) {
      body.innerHTML = '<div class="empty"><p>Bu hat için planlı sefer saati yayınlanmamış.</p></div>';
      return;
    }
    const norm = (s) => String(s).toLocaleUpperCase('tr').replace(/[^A-ZÇĞİÖŞÜ0-9]/g, '');
    let t = tables.find((x) => norm(x.title).startsWith(norm(d.from))) || tables[Math.min(dir, tables.length - 1)];
    const list = t[day] || [];
    const now = istNow();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const isToday = day === dayType();
    const mins = toMinutes(list);
    const nextIdx = isToday ? mins.findIndex((m) => m >= nowMin) : -1;
    const byHour = new Map();
    list.forEach((tm, i) => {
      const h = tm.slice(0, 2);
      if (!byHour.has(h)) byHour.set(h, []);
      byHour.get(h).push([tm, i]);
    });
    const lastMin = mins.length ? mins[mins.length - 1] : null;
    const toLast = isToday && lastMin != null ? lastMin - nowMin : null;
    const firstLast = list.length
      ? `<div class="first-last"><div><span class="label">İlk sefer</span><b>${list[0]}</b></div>
         <div class="${toLast != null && toLast >= 0 && toLast <= 60 ? 'warn' : ''}"><span class="label">Son sefer</span><b>${list[list.length - 1]}</b>${toLast != null && toLast >= 0 && toLast <= 120 ? `<small>${toLast} dk kaldı</small>` : ''}</div>
         <div><span class="label">Sefer</span><b>${list.length}</b></div></div>`
      : '';
    const nextTxt = nextIdx >= 0 ? `Sonraki sefer <b>${list[nextIdx]}</b> (${mins[nextIdx] - nowMin} dk sonra)` : isToday ? 'Bugün için sefer kalmadı' : '';
    body.innerHTML = `
      <div class="seg" id="days">
        <button data-day="weekday">İş Günü</button><button data-day="saturday">Cumartesi</button><button data-day="sunday">Pazar</button>
      </div>
      <div class="sub" style="margin:4px 0 2px"><b>${esc(titleCase(t.title))}</b>${nextTxt ? ` · ${nextTxt}` : ''}</div>
      ${firstLast}
      ${list.length ? '' : '<div class="empty"><p>Bu gün için sefer yok.</p></div>'}
      ${[...byHour.entries()]
        .map(
          ([h, items]) => `<div class="sched-hour">${h}:00</div><div class="sched-grid">${items
            .map(([tm, i]) => `<span class="${isToday && nextIdx >= 0 && i < nextIdx ? 'past' : ''} ${i === nextIdx ? 'next' : ''}">${tm}</span>`)
            .join('')}</div>`
        )
        .join('')}
      <div class="note">${icon('info')}<span>Saatler ilk duraktan kalkış saatleridir. Resmi tatillerde genellikle Pazar tarifesi uygulanır.</span></div>`;
    $$('#days button').forEach((b) => {
      b.classList.toggle('on', b.dataset.day === day);
      b.onclick = () => {
        day = b.dataset.day;
        drawTimes();
      };
    });
    if (nextIdx > 8) body.querySelector('.sched-grid span.next')?.scrollIntoView({ block: 'center' });
  }

  function drawInfo() {
    const shareUrl = `${location.origin}/#/line/${encodeURIComponent(code)}`;
    $('#tabBody').innerHTML = `
      <div class="kv"><span class="k">Hat kodu</span><span class="v">${esc(data.code)}</span></div>
      <div class="kv"><span class="k">Hat adı</span><span class="v">${esc(titleCase(data.name))}</span></div>
      ${data.directions.map((d) => `<div class="kv"><span class="k">${esc(titleCase(d.from))} →</span><span class="v">${d.stops.length} durak</span></div>`).join('')}
      ${data.variants.length ? `<div class="section-title">Ek seferler / güzergah çeşitleri</div>${data.variants.map((v) => `<div class="kv"><span class="v" style="text-align:left">${esc(titleCase(v.name))}</span></div>`).join('')}` : ''}
      <div class="row-btns" style="justify-content:stretch;margin-top:12px">
        <button class="btn ghost block" id="shareBtn">${icon('share')} Paylaş</button>
        <a class="btn ghost block" href="https://iett.istanbul/RouteDetail?hkod=${encodeURIComponent(code)}" target="_blank" rel="noopener">İETT sayfası</a>
      </div>
      <div class="note">${icon('info')}<span>Veriler İETT'den canlı alınır ve sunucuda kısa süre önbelleklenir; hat değişiklikleri birkaç saat içinde yansır.</span></div>`;
    $('#shareBtn').onclick = async () => {
      try {
        if (navigator.share) await navigator.share({ title: `${data.code} ${titleCase(data.name)}`, url: shareUrl });
        else {
          await navigator.clipboard.writeText(shareUrl);
          toast('Bağlantı kopyalandı');
        }
      } catch {
        /* cancelled */
      }
    };
  }

  async function loadVehicles() {
    try {
      const r = await api.vehicles(code);
      if (!isCurrent(token)) return;
      vehLayer?.remove();
      vehLayer = L.layerGroup();
      vehicles = r.available ? r.vehicles : [];
      for (const v of vehicles) {
        vehicleMarker(v, code)
          .bindTooltip(`${esc(code)} · ${esc(v.id)}${v.time ? ` · ${esc(v.time)}` : ''}`)
          .addTo(vehLayer);
      }
      addToView(vehLayer);
      const info = $('#vehInfo');
      if (info) {
        info.innerHTML = r.available
          ? `<span class="live-dot"></span> ${vehicles.length} araç canlı izleniyor`
          : `${data.directions.reduce((n, d) => n + d.stops.length, 0)} durak · <a href="#/stop/${data.directions[dir].stops[0]?.code}" style="color:var(--brand)">canlı varış için durağa dokun</a>`;
      }
      if (!r.available && !vehNoteShown) vehNoteShown = true;
      if (tab === 'stops' && vehicles.length) drawStops();
    } catch {
      /* ignore */
    }
  }

  drawMap(true);
  drawTab();
  loadVehicles();
  liveInterval(loadVehicles, 20000);
  getMap().invalidateSize();
}

function dayType() {
  const d = istNow().getDay();
  return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday';
}

function toMinutes(list) {
  // Times after midnight at the end of the list belong to the same service day.
  let prev = -1;
  let add = 0;
  return list.map((t) => {
    const [h, m] = t.split(':').map(Number);
    let v = h * 60 + m + add;
    if (v < prev - 600) {
      add += 1440;
      v += 1440;
    }
    prev = v;
    return v;
  });
}
