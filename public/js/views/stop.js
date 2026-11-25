// Stop detail: live arrivals ("Otobüsüm nerede"), lines serving the stop, alarms.
import { api } from '../api.js';
import { store } from '../store.js';
import { render, setSheet, isCurrent, liveInterval, onLeave, navigate } from '../core.js';
import { addToView, stopMarker, flyTo, getUserPos } from '../map.js';
import { addBusAlarm, hasBusAlarm } from '../alarms.js';
import { esc, icon, lineBadge, loading, errorBox, fmtMin, titleCase, actionSheet, toast, fmtDist, haversine, $, $$ } from '../ui.js';

export async function viewStop(token, code) {
  render(loading('Durak yükleniyor…'));
  setSheet('half');
  let info;
  try {
    info = await api.stop(code);
  } catch (e) {
    if (!isCurrent(token)) return;
    render(errorBox(e));
    $('[data-retry]').onclick = () => viewStop(token, code);
    return;
  }
  if (!isCurrent(token)) return;
  store.addRecent({ type: 'stop', code, name: info.name, district: info.district });

  if (info.lat != null) {
    addToView(stopMarker(info, { big: true, label: info.name }));
    flyTo(info.lat, info.lng, 17);
  }

  let filter = null;
  let lastData = null;
  let countdown = store.get().settings.refresh;
  const pos = getUserPos();
  const dist = pos && info.lat != null ? haversine(pos, info) : null;

  render(`
    <div class="view-head">
      <div class="item-ic stop">${icon('bus')}</div>
      <div style="flex:1;min-width:0">
        <h2>${esc(titleCase(info.name))}</h2>
        <div class="sub">${esc(titleCase(info.district || ''))} · Durak ${esc(code)}${dist != null ? ` · ${fmtDist(dist)}` : ''}</div>
      </div>
      <button class="star-btn ${store.isFavStop(code) ? 'on' : ''}" id="favBtn" aria-label="Favori">${icon(store.isFavStop(code) ? 'star' : 'star-o')}</button>
    </div>
    <div class="chips scroll" id="lineChips"></div>
    <div class="refresh-line"><span><span class="live-dot"></span> Canlı · <span id="cd"></span></span>
      <button id="refreshBtn">${icon('refresh')} Yenile</button></div>
    <div id="arrivals">${loading('Varış süreleri alınıyor…')}</div>
    <div class="section-title">Bu duraktan geçen hatlar</div>
    <div id="stopLines"></div>
    <div class="row-btns" style="justify-content:stretch;margin-top:14px">
      <button class="btn ghost block" id="fromHere">${icon('route')} Buradan</button>
      <button class="btn block" id="toHere">${icon('route')} Buraya git</button>
    </div>
    <div class="note">${icon('info')}<span>Varış süreleri İETT'nin tahminidir; trafiğe göre değişebilir. "B" işaretli süreler henüz sefere başlamamış ya da sinyali sorunlu araçlardır.</span></div>
  `);

  $('#favBtn').onclick = () => {
    const on = store.toggleFavStop({ ...info, code });
    $('#favBtn').className = `star-btn ${on ? 'on' : ''}`;
    $('#favBtn').innerHTML = icon(on ? 'star' : 'star-o');
    toast(on ? 'Favorilere eklendi' : 'Favorilerden çıkarıldı');
  };
  const planLink = (k) => `#/plan?${k}=${info.lat},${info.lng}&${k}Name=${encodeURIComponent(titleCase(info.name))}`;
  $('#fromHere').onclick = () => navigate(planLink('from'));
  $('#toHere').onclick = () => navigate(planLink('to'));

  renderLines();

  function renderLines() {
    const lines = info.lines || [];
    $('#stopLines').innerHTML = lines.length
      ? `<div class="list">${lines
          .map((l) => `<a class="item" href="#/line/${encodeURIComponent(l.code)}">${lineBadge(l.code)}<div class="grow"><div class="s" style="color:var(--text)">${esc(titleCase(l.name || ''))}</div></div>${icon('chev', 'chev')}</a>`)
          .join('')}</div>`
      : '<div class="empty"><p>Hat bilgisi bulunamadı</p></div>';
  }

  function renderChips(arrivals) {
    const codes = [...new Set([...arrivals.map((a) => a.line), ...(info.lines || []).map((l) => l.code)])];
    $('#lineChips').innerHTML = codes.length > 1
      ? [`<button class="chip ${!filter ? 'on' : ''}" data-f="">Tümü</button>`, ...codes.map((c) => `<button class="chip ${filter === c ? 'on' : ''}" data-f="${esc(c)}">${esc(c)}</button>`)].join('')
      : '';
    $$('#lineChips .chip').forEach((b) => {
      b.onclick = () => {
        filter = b.dataset.f || null;
        draw();
      };
    });
  }

  function draw() {
    if (!lastData) return;
    const arr = lastData.arrivals.filter((a) => !filter || a.line === filter);
    renderChips(lastData.arrivals);
    const groups = new Map();
    for (const a of arr) {
      const key = `${a.line}|${a.dest}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const el = $('#arrivals');
    if (!groups.size) {
      el.innerHTML = `<div class="empty">${icon('clock')}<p>${filter ? `${esc(filter)} için` : 'Bu durağa'} şu an yaklaşan araç görünmüyor.</p>
        ${filter ? `<a class="btn small ghost" href="#/line/${encodeURIComponent(filter)}?tab=times">Sefer saatlerine bak</a>` : ''}</div>`;
      return;
    }
    el.innerHTML = [...groups.values()]
      .map((g) => {
        const a = g[0];
        const rest = g.slice(1, 4).map((x) => `${x.minutes != null ? `${x.minutes} dk` : x.time}${x.unreliable ? ' (B)' : ''}`);
        const alarm = hasBusAlarm(code, a.line);
        return `<div class="arr-row">
          <a href="#/line/${encodeURIComponent(a.line)}">${lineBadge(a.line)}</a>
          <div class="grow"><div class="dest">${esc(titleCase(a.dest) || (info.lines.find((l) => l.code === a.line)?.name ? titleCase(info.lines.find((l) => l.code === a.line).name) : ''))}</div>
            ${rest.length ? `<div class="dest">Sonraki: ${esc(rest.join(', '))}</div>` : ''}</div>
          <div class="arr-times"><div class="big ${a.minutes != null && a.minutes <= 2 ? 'soon' : ''}">${esc(fmtMin(a.minutes))}${a.unreliable ? '<small title="Sefere başlamamış/sinyal sorunlu">B</small>' : ''}</div><div class="next">${esc(a.time || '')}</div></div>
          <button class="alarm-btn ${alarm ? 'on' : ''}" data-alarm="${esc(a.line)}" aria-label="${esc(a.line)} için alarm">${icon('bell')}</button>
        </div>`;
      })
      .join('');
    $$('#arrivals [data-alarm]').forEach((b) => {
      b.onclick = async () => {
        const line = b.dataset.alarm;
        const ex = hasBusAlarm(code, line);
        if (ex) {
          store.removeAlarm(ex.id);
          toast('Alarm kaldırıldı');
          return draw();
        }
        const m = await actionSheet(`${line} yaklaşınca haber ver`, [2, 5, 10, 15].map((n) => ({ label: `${n} dakika kala`, value: n, icon: 'bell' })));
        if (m) {
          await addBusAlarm({ stop: code, stopName: titleCase(info.name), line, minutes: m });
          draw();
        }
      };
    });
  }

  async function load() {
    try {
      lastData = await api.arrivals(code);
      if (!isCurrent(token)) return;
      draw();
    } catch (e) {
      if (!isCurrent(token)) return;
      if (!lastData) {
        $('#arrivals').innerHTML = errorBox(e);
        $('#arrivals [data-retry]').onclick = load;
      } else toast(e.message);
    }
    countdown = store.get().settings.refresh;
  }

  $('#refreshBtn').onclick = load;
  load();
  liveInterval(() => {
    countdown -= 1;
    const cd = $('#cd');
    if (cd) cd.textContent = `${Math.max(0, countdown)} sn sonra yenilenecek`;
    if (countdown <= 0) load();
  }, 1000);
  const unsub = store.subscribe(() => draw());
  onLeave(unsub);
}
