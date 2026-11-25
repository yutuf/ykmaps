// Nearby (home), search, all lines, favorites, announcements and settings views.
/* global L */
import { api } from '../api.js';
import { store } from '../store.js';
import { render, setSheet, isCurrent, liveInterval, navigate, onLeave } from '../core.js';
import { addToView, getUserPos, startLocation, onUserPos, fit, getMap, flyTo, stopMarker, refreshTiles } from '../map.js';
import { ensureNotifyPermission } from '../alarms.js';
import { planTo, planFrom } from './plan.js';
import {
  esc, icon, lineBadge, loading, errorBox, empty, titleCase, toast, fmtDist, fmtMin, debounce, modeIcon, actionSheet, promptModal, $, $$,
} from '../ui.js';

// ---------------- Nearby ----------------

export async function viewNearby(token) {
  setSheet('half');
  const places = store.get().places;
  let center = null;
  let usingMapCenter = false;

  render(`
    <div class="view-head"><div style="flex:1"><h2>Yakınımdaki duraklar</h2><div class="sub" id="nearSub">Konum bekleniyor…</div></div>
      <button class="btn small ghost" id="mapCenterBtn">${icon('pin')} Harita merkezi</button></div>
    <div class="quick-places" id="qp">
      ${['Ev', 'İş'].map((lbl) => {
        const p = places.find((x) => x.label === lbl);
        return `<button class="qp" data-label="${lbl}">${icon(lbl === 'Ev' ? 'home' : 'work')}<b>${lbl}</b><small>${p ? esc(p.name) : 'Ayarla'}</small></button>`;
      }).join('')}
      ${places.filter((p) => !['Ev', 'İş'].includes(p.label)).slice(0, 4).map((p) => `<button class="qp" data-id="${esc(p.id)}">${icon('pin')}<b>${esc(p.label)}</b><small>${esc(p.name)}</small></button>`).join('')}
    </div>
    <div id="nearList">${loading('Konumunuz alınıyor…')}</div>
  `);

  $$('#qp .qp').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.id ? places.find((x) => x.id === b.dataset.id) : places.find((x) => x.label === b.dataset.label);
      if (p) return planTo({ name: p.label, lat: p.lat, lng: p.lng });
      const choice = await actionSheet(`${b.dataset.label} adresini ayarla`, [
        { label: 'Şu anki konumum', value: 'here', icon: 'gps' },
        { label: 'Harita merkezindeki nokta', value: 'center', icon: 'pin' },
        { label: 'Arayarak seç', value: 'search', icon: 'search' },
      ]);
      if (choice === 'here' || choice === 'center') {
        const pos = choice === 'here' ? getUserPos() || (await startLocation()) : getMap().getCenter();
        if (!pos) return toast('Konum alınamadı');
        store.savePlace({ label: b.dataset.label, name: choice === 'here' ? 'Kayıtlı konum' : 'Haritadan seçildi', lat: pos.lat, lng: pos.lng });
        toast(`${b.dataset.label} kaydedildi`);
        viewNearby(token);
      } else if (choice === 'search') {
        navigate(`#/search?save=${encodeURIComponent(b.dataset.label)}`);
      }
    };
  });

  $('#mapCenterBtn').onclick = () => {
    usingMapCenter = true;
    const c = getMap().getCenter();
    load({ lat: c.lat, lng: c.lng });
  };

  let stops = [];
  let arrivals = new Map();

  async function load(pos) {
    center = pos;
    try {
      const r = await api.nearby(pos.lat, pos.lng, 700);
      if (!isCurrent(token)) return;
      stops = r.stops.slice(0, 15);
      $('#nearSub').textContent = usingMapCenter ? 'Harita merkezine göre' : stops.length ? `${stops.length} durak, ${fmtDist(stops[stops.length - 1]?.distance)} içinde` : '';
      if (!r.index.stops) {
        $('#nearList').innerHTML = `<div class="note">${icon('info')}<span>Durak indeksi henüz oluşturuluyor (ilk çalıştırmada birkaç dakika sürer). Bu sırada arama yapabilirsiniz.</span></div>`;
        return;
      }
      drawStops();
      drawMap();
      loadArrivals();
    } catch (e) {
      if (!isCurrent(token)) return;
      $('#nearList').innerHTML = errorBox(e);
      $('#nearList [data-retry]').onclick = () => load(pos);
    }
  }

  function drawMap() {
    const b = L.latLngBounds([[center.lat, center.lng]]);
    stops.forEach((s) => {
      addToView(stopMarker(s, { label: titleCase(s.name) }).on('click', () => navigate(`#/stop/${s.code}`)));
      if (s.distance < 450) b.extend([s.lat, s.lng]);
    });
    fit(b);
  }

  function drawStops() {
    if (!stops.length) {
      $('#nearList').innerHTML = empty('Yakınınızda durak bulunamadı. Haritayı kaydırıp "Harita merkezi"ne dokunun.', 'near');
      return;
    }
    $('#nearList').innerHTML = stops
      .map((s) => {
        const arr = arrivals.get(s.code);
        let arrHtml = '';
        if (arr === undefined) arrHtml = '';
        else if (arr === null) arrHtml = '<div class="near-arr"><span class="s" style="font-size:12px;color:var(--muted)">Varış bilgisi alınamadı</span></div>';
        else {
          const seen = new Set();
          const firsts = arr.filter((a) => (seen.has(a.line) ? false : seen.add(a.line))).slice(0, 5);
          arrHtml = `<div class="near-arr">${firsts.length ? firsts.map((a) => `<span class="na">${lineBadge(a.line, 'bus', 'sm')}<b class="m">${esc(fmtMin(a.minutes))}</b></span>`).join('') : '<span style="font-size:12px;color:var(--muted)">Şu an yaklaşan araç yok</span>'}</div>`;
        }
        return `<div class="near-card" data-code="${s.code}">
          <div class="hd">${icon('bus')}<div class="t">${esc(titleCase(s.name))}</div><div class="d">${fmtDist(s.distance)}</div></div>
          <div class="mini-lines">${s.lines.slice(0, 14).map((l) => `<span class="ml">${esc(l)}</span>`).join('')}${s.lines.length > 14 ? `<span class="ml">+${s.lines.length - 14}</span>` : ''}</div>
          ${arrHtml}
        </div>`;
      })
      .join('');
    $$('#nearList .near-card').forEach((c) => (c.onclick = () => navigate(`#/stop/${c.dataset.code}`)));
  }

  async function loadArrivals() {
    const targets = stops.slice(0, 8);
    await Promise.all(
      targets.map(async (s, i) => {
        await new Promise((r) => setTimeout(r, i * 120));
        try {
          const r = await api.arrivals(s.code);
          arrivals.set(s.code, r.arrivals);
        } catch {
          arrivals.set(s.code, null);
        }
        if (isCurrent(token)) drawStops();
      })
    );
  }

  const p = getUserPos();
  if (p) load(p);
  const pos = p || (await startLocation());
  if (!isCurrent(token)) return;
  if (!pos) {
    $('#nearSub').textContent = 'Konum izni yok';
    $('#nearList').innerHTML = `<div class="empty">${icon('gps')}<p>Yakındaki durakları görmek için konum izni verin ya da haritayı kaydırıp "Harita merkezi"ne dokunun.</p>
      <button class="btn small" id="askLoc">Konumu aç</button></div>${favStopsHtml()}`;
    $('#askLoc').onclick = () => startLocation({ fly: true }).then((x) => x ? load(x) : toast('Konum izni verilmedi'));
  } else if (!p) load(pos);

  // Re-centre when the user walks > 150 m.
  const unsub = onUserPos((np) => {
    if (!usingMapCenter && center && Math.hypot(np.lat - center.lat, np.lng - center.lng) > 0.0015) load(np);
  });
  onLeave(unsub);
  liveInterval(() => stops.length && loadArrivals(), 30000);
}

function favStopsHtml() {
  const favs = store.get().favStops;
  if (!favs.length) return '';
  return `<div class="section-title">Favori duraklar</div><div class="list">${favs
    .map((s) => `<a class="item" href="#/stop/${s.code}"><div class="item-ic stop">${icon('bus')}</div><div class="grow"><div class="t">${esc(titleCase(s.name))}</div><div class="s">${esc(titleCase(s.district))}</div></div>${icon('chev', 'chev')}</a>`)
    .join('')}</div>`;
}

// ---------------- Search ----------------

export function viewSearch(token, query) {
  setSheet('full');
  const saveLabel = query.get('save'); // picking a place to save as Ev/İş
  const input = $('#searchInput');
  const q0 = query.get('q') || '';
  if (document.activeElement !== input) input.value = q0;
  render(`<div id="sres"></div>`);
  const box = $('#sres');

  const drawRecents = () => {
    const rec = store.get().recents;
    box.innerHTML = `${saveLabel ? `<div class="note">${icon('info')}<span>"${esc(saveLabel)}" olarak kaydedilecek yeri arayın.</span></div>` : ''}
      ${rec.length ? `<div class="section-title">Son bakılanlar <button class="btn small ghost" id="clr">Temizle</button></div><div class="list">${rec.map(recentHtml).join('')}</div>` : empty('Hat numarası (ör. 500T), durak adı veya bir yer yazın.', 'search')}`;
    $('#clr')?.addEventListener('click', () => {
      store.clearRecents();
      drawRecents();
    });
  };

  const run = async (q) => {
    if (!isCurrent(token)) return;
    history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}${saveLabel ? `&save=${encodeURIComponent(saveLabel)}` : ''}`);
    if (q.trim().length < 1) return drawRecents();
    box.innerHTML = loading('Aranıyor…');
    try {
      const r = await api.search(q);
      if (!isCurrent(token) || input.value !== q) return;
      const sections = [];
      if (!saveLabel && r.lines.length) {
        sections.push(`<div class="section-title">Hatlar</div><div class="list">${r.lines
          .slice(0, 12)
          .map((l) => `<a class="item" href="#/line/${encodeURIComponent(l.code)}">${lineBadge(l.code)}<div class="grow"><div class="s" style="color:var(--text);white-space:normal">${esc(titleCase(l.name))}</div></div>${icon('chev', 'chev')}</a>`)
          .join('')}</div>`);
      }
      if (r.stops.length) {
        sections.push(`<div class="section-title">Duraklar</div><div class="list">${r.stops
          .slice(0, 15)
          .map((s, i) => `<button class="item" data-stop="${i}"><div class="item-ic stop">${icon('bus')}</div><div class="grow"><div class="t">${esc(titleCase(s.name))}</div>
            <div class="s">${esc(titleCase(s.district))}${s.direction ? ` · ${esc(titleCase(s.direction))} yönü` : ''} · ${esc(s.code)}</div>
            ${s.lines ? `<div class="mini-lines">${s.lines.slice(0, 10).map((l) => `<span class="ml">${esc(l)}</span>`).join('')}</div>` : ''}</div>${icon('chev', 'chev')}</button>`)
          .join('')}</div>`);
      }
      if (r.places.length) {
        sections.push(`<div class="section-title">Yerler</div><div class="list">${r.places
          .slice(0, 15)
          .map((p, i) => `<button class="item" data-place="${i}"><div class="item-ic">${icon(p.type === 'poi' ? 'pin' : modeIcon(p.type))}</div><div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.district || '')}</div></div>${icon('route', 'chev')}</button>`)
          .join('')}</div>`);
      }
      box.innerHTML = sections.join('') || empty('Sonuç bulunamadı', 'search');
      $$('#sres [data-stop]').forEach((b) => {
        b.onclick = () => {
          const s = r.stops[Number(b.dataset.stop)];
          if (saveLabel) {
            if (s.lat == null) return toast('Bu durağın konumu bilinmiyor');
            store.savePlace({ label: saveLabel, name: titleCase(s.name), lat: s.lat, lng: s.lng });
            toast(`${saveLabel} kaydedildi`);
            return navigate('#/favorites');
          }
          navigate(`#/stop/${s.code}`);
        };
      });
      $$('#sres [data-place]').forEach((b) => {
        b.onclick = () => placeActions(r.places[Number(b.dataset.place)], saveLabel);
      });
    } catch (e) {
      if (!isCurrent(token)) return;
      box.innerHTML = errorBox(e);
      box.querySelector('[data-retry]').onclick = () => run(q);
    }
  };
  const deb = debounce(run, 280);
  const onInput = () => deb(input.value);
  input.addEventListener('input', onInput);
  onLeave(() => input.removeEventListener('input', onInput));
  if (q0) run(q0);
  else drawRecents();
}

async function placeActions(p, saveLabel) {
  if (saveLabel) {
    store.savePlace({ label: saveLabel, name: p.name, lat: p.lat, lng: p.lng });
    toast(`${saveLabel} kaydedildi`);
    return navigate('#/favorites');
  }
  store.addRecent({ type: 'place', name: p.name, lat: p.lat, lng: p.lng, district: p.district });
  flyTo(p.lat, p.lng, 17);
  const opts = [
    { label: 'Buraya git', value: 'to', icon: 'route' },
    { label: 'Buradan başla', value: 'from', icon: 'route' },
    { label: 'Yakındaki duraklar', value: 'near', icon: 'near' },
    { label: 'Yer olarak kaydet', value: 'save', icon: 'star-o' },
  ];
  if (/^\d+$/.test(p.id || '')) opts.unshift({ label: 'Canlı varış süreleri', value: 'stop', icon: 'clock' });
  const v = await actionSheet(p.name, opts);
  if (v === 'to') planTo({ name: p.name, lat: p.lat, lng: p.lng });
  else if (v === 'from') planFrom({ name: p.name, lat: p.lat, lng: p.lng });
  else if (v === 'stop') navigate(`#/stop/${p.id}`);
  else if (v === 'near') {
    navigate('#/');
    setTimeout(() => $('#mapCenterBtn')?.click(), 400);
  } else if (v === 'save') {
    const label = await promptModal('Yer adı', p.name, 'Ev, İş, Okul…');
    if (label) {
      store.savePlace({ label, name: p.name, lat: p.lat, lng: p.lng });
      toast('Kaydedildi');
    }
  }
}

function recentHtml(r) {
  if (r.type === 'line') return `<a class="item" href="#/line/${encodeURIComponent(r.code)}">${lineBadge(r.code)}<div class="grow"><div class="s" style="color:var(--text)">${esc(titleCase(r.name))}</div></div>${icon('clock', 'chev')}</a>`;
  if (r.type === 'stop') return `<a class="item" href="#/stop/${r.code}"><div class="item-ic stop">${icon('bus')}</div><div class="grow"><div class="t">${esc(titleCase(r.name))}</div><div class="s">${esc(titleCase(r.district || ''))}</div></div>${icon('clock', 'chev')}</a>`;
  return `<a class="item" href="#/plan?to=${r.lat},${r.lng}&toName=${encodeURIComponent(r.name)}"><div class="item-ic">${icon('pin')}</div><div class="grow"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.district || '')}</div></div>${icon('route', 'chev')}</a>`;
}

// ---------------- All lines ----------------

export async function viewLines(token) {
  setSheet('full');
  render(`<div class="view-head"><h2>Tüm hatlar</h2></div>
    <input class="input" id="lineFilter" placeholder="Hat no veya güzergah filtrele (ör. 15, Kadıköy)" autocomplete="off" inputmode="search">
    <div class="letters" id="letters"></div>
    <div id="favLines"></div>
    <div id="lineList">${loading('Hat listesi yükleniyor…')}</div>`);
  const favs = store.get().favLines;
  if (favs.length) {
    $('#favLines').innerHTML = `<div class="section-title">Favori hatlar</div><div class="list">${favs.map((l) => `<a class="item" href="#/line/${encodeURIComponent(l.code)}">${lineBadge(l.code)}<div class="grow"><div class="s" style="color:var(--text)">${esc(titleCase(l.name))}</div></div>${icon('chev', 'chev')}</a>`).join('')}</div>`;
  }
  let lines;
  try {
    lines = await api.lines();
  } catch (e) {
    if (!isCurrent(token)) return;
    $('#lineList').innerHTML = errorBox(e);
    $('#lineList [data-retry]').onclick = () => viewLines(token);
    return;
  }
  if (!isCurrent(token)) return;
  let prefix = '';
  let limit = 120;
  const firstChars = [...new Set(lines.map((l) => l.code[0]))].sort((a, b) => a.localeCompare(b, 'tr', { numeric: true }));
  $('#letters').innerHTML = [`<button data-p="" class="on">Tümü</button>`, ...firstChars.map((c) => `<button data-p="${esc(c)}">${esc(c)}</button>`)].join('');
  const norm = (x) => String(x).replace(/İ/g, 'i').replace(/I/g, 'ı').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const draw = () => {
    const f = norm($('#lineFilter').value.trim());
    const words = f.split(/\s+/).filter(Boolean);
    const list = lines.filter((l) => (!prefix || l.code.startsWith(prefix)) && (!words.length || words.every((w) => norm(`${l.code} ${l.name}`).includes(w))));
    list.sort((a, b) => {
      if (f) {
        const ea = norm(a.code) === f ? 0 : norm(a.code).startsWith(f) ? 1 : 2;
        const eb = norm(b.code) === f ? 0 : norm(b.code).startsWith(f) ? 1 : 2;
        if (ea !== eb) return ea - eb;
      }
      return a.code.localeCompare(b.code, 'tr', { numeric: true });
    });
    $('#lineList').innerHTML = `<div class="section-title">${list.length} hat</div><div class="list">${list
      .slice(0, limit)
      .map((l) => `<a class="item" href="#/line/${encodeURIComponent(l.code)}">${lineBadge(l.code)}<div class="grow"><div class="s" style="color:var(--text);white-space:normal">${esc(titleCase(l.name))}</div></div>${icon('chev', 'chev')}</a>`)
      .join('')}</div>${list.length > limit ? `<button class="btn ghost block" id="more">Daha fazla göster (${list.length - limit})</button>` : ''}`;
    $('#more')?.addEventListener('click', () => {
      limit += 200;
      draw();
    });
  };
  $('#lineFilter').addEventListener('input', debounce(() => {
    limit = 120;
    draw();
  }, 150));
  $$('#letters button').forEach((b) => {
    b.onclick = () => {
      prefix = b.dataset.p;
      limit = 120;
      $$('#letters button').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
  });
  draw();
}

// ---------------- Favorites ----------------

export function viewFavorites(token) {
  setSheet('full');
  const s = store.get();
  render(`
    <div class="view-head"><h2>Favoriler</h2></div>
    <div class="section-title">Yerlerim <button class="btn small ghost" id="addPlace">+ Ekle</button></div>
    ${s.places.length ? `<div class="list">${s.places
      .map((p) => `<div class="item" data-place="${esc(p.id)}"><div class="item-ic">${icon(p.label === 'Ev' ? 'home' : p.label === 'İş' ? 'work' : 'pin')}</div><div class="grow"><div class="t">${esc(p.label)}</div><div class="s">${esc(p.name)}</div></div>
        <button class="alarm-btn" data-del-place="${esc(p.id)}" aria-label="Sil">${icon('trash')}</button></div>`)
      .join('')}</div>` : `<div class="note">${icon('info')}<span>Ev ve iş adresinizi kaydedin; tek dokunuşla rota alın.</span></div>`}
    <div class="section-title">Duraklar</div>
    ${s.favStops.length ? `<div class="list" id="favStops">${s.favStops
      .map((x) => `<div class="item" data-stop="${x.code}"><div class="item-ic stop">${icon('bus')}</div><div class="grow"><div class="t">${esc(titleCase(x.name))}</div><div class="s" data-arr="${x.code}">${esc(titleCase(x.district))}</div></div>
        <button class="alarm-btn" data-del-stop="${x.code}" aria-label="Sil">${icon('trash')}</button></div>`)
      .join('')}</div>` : `<div class="note">${icon('star-o')}<span>Durak sayfasında yıldıza dokunarak favorilere ekleyin.</span></div>`}
    <div class="section-title">Hatlar</div>
    ${s.favLines.length ? `<div class="list">${s.favLines
      .map((l) => `<div class="item" data-line="${esc(l.code)}">${lineBadge(l.code)}<div class="grow"><div class="s" style="color:var(--text)">${esc(titleCase(l.name))}</div></div>
        <button class="alarm-btn" data-del-line="${esc(l.code)}" aria-label="Sil">${icon('trash')}</button></div>`)
      .join('')}</div>` : `<div class="note">${icon('star-o')}<span>Hat sayfasında yıldıza dokunarak favorilere ekleyin.</span></div>`}
  `);
  $('#addPlace').onclick = async () => {
    const label = await promptModal('Yer adı', '', 'Ev, İş, Okul, Spor salonu…');
    if (label) navigate(`#/search?save=${encodeURIComponent(label)}`);
  };
  $$('[data-place]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-del-place]')) return;
      const p = s.places.find((x) => x.id === el.dataset.place);
      planTo({ name: p.label, lat: p.lat, lng: p.lng });
    };
  });
  $$('[data-stop]').forEach((el) => {
    el.onclick = (e) => !e.target.closest('[data-del-stop]') && navigate(`#/stop/${el.dataset.stop}`);
  });
  $$('[data-line]').forEach((el) => {
    el.onclick = (e) => !e.target.closest('[data-del-line]') && navigate(`#/line/${encodeURIComponent(el.dataset.line)}`);
  });
  $$('[data-del-place]').forEach((b) => (b.onclick = () => (store.removePlace(b.dataset.delPlace), viewFavorites(token))));
  $$('[data-del-stop]').forEach((b) => (b.onclick = () => (store.toggleFavStop({ code: b.dataset.delStop }), viewFavorites(token))));
  $$('[data-del-line]').forEach((b) => (b.onclick = () => (store.toggleFavLine({ code: b.dataset.delLine }), viewFavorites(token))));

  // Live summary for favourite stops.
  const loadArr = () =>
    s.favStops.slice(0, 10).forEach(async (x) => {
      try {
        const r = await api.arrivals(x.code);
        if (!isCurrent(token)) return;
        const seen = new Set();
        const firsts = r.arrivals.filter((a) => (seen.has(a.line) ? false : seen.add(a.line))).slice(0, 4);
        const el = document.querySelector(`[data-arr="${x.code}"]`);
        if (el) el.innerHTML = firsts.length ? firsts.map((a) => `<b>${esc(a.line)}</b> ${esc(fmtMin(a.minutes))}`).join(' · ') : 'Yaklaşan araç yok';
      } catch {
        /* ignore */
      }
    });
  loadArr();
  liveInterval(loadArr, 30000);
  // Map: show favourite stops
  const b = L.latLngBounds([]);
  s.favStops.filter((x) => x.lat != null).forEach((x) => {
    addToView(stopMarker(x, { label: titleCase(x.name) }).on('click', () => navigate(`#/stop/${x.code}`)));
    b.extend([x.lat, x.lng]);
  });
  s.places.forEach((p) => b.extend([p.lat, p.lng]));
  if (b.isValid()) fit(b);
}

// ---------------- Announcements ----------------

export async function viewNews(token) {
  setSheet('full');
  render(`<div class="view-head"><h2>İETT Duyuruları</h2></div><div id="news">${loading()}</div>`);
  let page = 0;
  let all = [];
  const load = async () => {
    try {
      const items = await api.announcements(page);
      if (!isCurrent(token)) return;
      const ids = new Set(all.map((x) => x.id));
      all = all.concat(items.filter((x) => !ids.has(x.id)));
      $('#news').innerHTML = `<div class="list">${all
        .map((a) => `<a class="item" href="#/news/${a.id}"><div class="item-ic">${icon('megaphone')}</div><div class="grow"><div class="t" style="white-space:normal">${esc(a.title)}</div><div class="s">${esc(a.date)}</div></div>${icon('chev', 'chev')}</a>`)
        .join('')}</div>${items.length ? '<button class="btn ghost block" id="moreNews">Daha eski duyurular</button>' : ''}`;
      $('#moreNews')?.addEventListener('click', () => {
        page += 1;
        $('#moreNews').disabled = true;
        load();
      });
    } catch (e) {
      if (!isCurrent(token)) return;
      $('#news').innerHTML = errorBox(e);
      $('#news [data-retry]').onclick = load;
    }
  };
  load();
}

export async function viewNewsDetail(token, id) {
  setSheet('full');
  render(loading());
  try {
    const a = await api.announcement(id);
    if (!isCurrent(token)) return;
    const title = (await api.announcements(0).catch(() => [])).find?.((x) => x.id === id)?.title || a.title;
    const lineCodes = [...new Set((`${title} ${a.body}`.match(/\b([0-9]{1,3}[A-ZÇĞİÖŞÜ]{0,4}|[A-Z]{1,3}[0-9]{1,3}[A-Z]?)\b(?=\s*(numaralı|hat|,|ve|\/))/g) || []))].slice(0, 12);
    render(`<div class="view-head"><div style="flex:1"><h2>${esc(title)}</h2><div class="sub">${esc(a.date)}</div></div></div>
      ${lineCodes.length ? `<div class="chips" style="margin-bottom:10px">${lineCodes.map((c) => `<a class="chip" href="#/line/${encodeURIComponent(c)}">${icon('bus')}${esc(c)}</a>`).join('')}</div>` : ''}
      <div class="news-body">${esc(a.body)}</div>
      <a class="btn ghost block" style="margin-top:14px" href="https://iett.istanbul/Announcement/Detail/${encodeURIComponent(id)}" target="_blank" rel="noopener">İETT'de aç</a>`);
  } catch (e) {
    if (!isCurrent(token)) return;
    render(errorBox(e));
    $('[data-retry]').onclick = () => viewNewsDetail(token, id);
  }
}

// ---------------- Settings ----------------

export async function viewSettings(token) {
  setSheet('full');
  const s = store.get().settings;
  render(`
    <div class="view-head"><h2>Ayarlar</h2></div>
    <div class="kv"><span class="k">Tema</span><select id="theme" class="input" style="width:auto;padding:6px 10px"><option value="auto">Otomatik</option><option value="light">Açık</option><option value="dark">Koyu</option></select></div>
    <div class="kv"><span class="k">Canlı yenileme</span><select id="refresh" class="input" style="width:auto;padding:6px 10px">${[15, 20, 30, 60].map((n) => `<option value="${n}">${n} sn</option>`).join('')}</select></div>
    <div class="kv"><span class="k">Bildirimler</span><button class="btn small ghost" id="notif">${'Notification' in window && Notification.permission === 'granted' ? 'Açık ✓' : 'İzin ver'}</button></div>
    <div class="kv" id="installRow" hidden><span class="k">Ana ekrana ekle</span><button class="btn small" id="install">Yükle</button></div>
    <div class="section-title">Veri</div>
    <div class="kv"><span class="k">Durak indeksi</span><span class="v" id="idx">…</span></div>
    <div class="kv"><span class="k">Geçmişi temizle</span><button class="btn small ghost" id="clrRec">Temizle</button></div>
    <div class="section-title">Hakkında</div>
    <div class="note">${icon('info')}<span>YKMaps kişisel kullanım için reklamsız bir İstanbul toplu taşıma uygulamasıdır. Varış süreleri, hatlar, duraklar, sefer saatleri ve duyurular İETT'nin herkese açık web servislerinden; rota planlama İETT Nasıl Giderim servisinden; harita © OpenStreetMap katkıcılarından alınır. İETT ile bağlantılı değildir.</span></div>
  `);
  $('#theme').value = s.theme;
  $('#refresh').value = String(s.refresh);
  $('#theme').onchange = (e) => {
    store.setSetting('theme', e.target.value);
    applyTheme();
  };
  $('#refresh').onchange = (e) => store.setSetting('refresh', Number(e.target.value));
  $('#notif').onclick = async () => {
    const ok = await ensureNotifyPermission();
    $('#notif').textContent = ok ? 'Açık ✓' : 'İzin verilmedi';
  };
  $('#clrRec').onclick = () => {
    store.clearRecents();
    toast('Geçmiş temizlendi');
  };
  if (window.__installPrompt) {
    $('#installRow').hidden = false;
    $('#install').onclick = async () => {
      window.__installPrompt.prompt();
      window.__installPrompt = null;
      $('#installRow').hidden = true;
    };
  }
  try {
    const st = await api.status();
    if (!isCurrent(token)) return;
    const i = st.index;
    $('#idx').textContent = i.stops
      ? `${i.stops.toLocaleString('tr-TR')} durak · ${i.lines} hat · ${new Date(i.updated).toLocaleDateString('tr-TR')}${i.building ? ' · güncelleniyor…' : ''}`
      : i.building ? 'Oluşturuluyor…' : 'Yok';
  } catch {
    $('#idx').textContent = 'Sunucuya ulaşılamadı';
  }
}

export function applyTheme() {
  const t = store.get().settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  refreshTiles();
}
