// Small UI helpers shared by all views.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const METRO = {
  M1: '#e2231a', M1A: '#e2231a', M1B: '#e2231a', M2: '#00953a', M3: '#00a4e0', M4: '#e4007c', M5: '#6b2c91', M6: '#b88a51',
  M7: '#f49ac1', M8: '#0072bc', M9: '#f5c500', M10: '#8bc53f', M11: '#8a7967', M12: '#2a9d8f', M14: '#5c5c5c',
  T1: '#0072bc', T3: '#8a6534', T4: '#f7941d', T5: '#7f3f98', F1: '#5ab031', F2: '#5ab031', F4: '#5ab031',
  TF1: '#00b4a0', TF2: '#00b4a0', B1: '#3d5aa8', MARMARAY: '#3d5aa8',
};
const METROBUS = new Set(['34', '34A', '34AS', '34B', '34BZ', '34C', '34G', '34U', '34Z']);

export function lineColor(code, mode) {
  const c = String(code || '').toUpperCase();
  if (METRO[c]) return METRO[c];
  if (mode === 'walking') return '#7c8594';
  if (METROBUS.has(c) || mode === 'metrobus') return '#d6372b';
  if (mode === 'marmaray') return '#3d5aa8';
  if (mode === 'metro') return '#e2231a';
  if (mode === 'tram') return '#0072bc';
  if (mode === 'taksiDolmus' || mode === 'minibus') return '#d39a00';
  if (['shatlari', 'ido', 'turyol', 'dentur', 'ferry'].includes(mode)) return '#1f4e9c';
  if (mode === 'funi' || mode === 'tele') return '#5ab031';
  return '#2563c9';
}

export function modeIcon(mode) {
  if (mode === 'walking') return 'walk';
  if (['metro', 'marmaray', 'funi'].includes(mode)) return 'train';
  if (mode === 'tram') return 'tram';
  if (['shatlari', 'ido', 'turyol', 'dentur', 'ferry'].includes(mode)) return 'ship';
  if (mode === 'tele') return 'cable';
  return 'bus';
}

export function lineBadge(code, mode, extra = '') {
  return `<span class="badge ${extra}" style="--c:${lineColor(code, mode)}">${icon(modeIcon(mode || 'bus'))}<b>${esc(code)}</b></span>`;
}

export function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
}

export function fmtDist(m) {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function fmtMin(n) {
  if (n == null) return '';
  if (n <= 0) return 'Şimdi';
  if (n < 60) return `${n} dk`;
  return `${Math.floor(n / 60)} sa ${n % 60} dk`;
}

export function istNow() {
  // Current time in Istanbul as a Date whose local fields are Istanbul's.
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
}

export function haversine(a, b) {
  const R = 6371000;
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function titleCase(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/(^|[\s\-(/.])(\p{L})/gu, (m, p, c) => p + c.toLocaleUpperCase('tr'));
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function loading(text = 'Yükleniyor…') {
  return `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
}

export function errorBox(e, retryLabel = 'Tekrar dene') {
  return `<div class="error-box">${icon('alert')}<p>${esc(e?.message || e || 'Bir hata oluştu')}</p><button class="btn small" data-retry>${esc(retryLabel)}</button></div>`;
}

export function empty(text, ic = 'info') {
  return `<div class="empty">${icon(ic)}<p>${esc(text)}</p></div>`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Simple modal action sheet. Returns a promise of the chosen value (or null). */
export function actionSheet(title, options) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>
      ${options.map((o, i) => `<button class="modal-opt ${o.danger ? 'danger' : ''}" data-i="${i}">${o.icon ? icon(o.icon) : ''}<span>${esc(o.label)}</span></button>`).join('')}
      <button class="modal-opt cancel" data-i="-1">Vazgeç</button></div>`;
    const close = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) close(Number(b.dataset.i) >= 0 ? options[Number(b.dataset.i)].value : null);
      else if (e.target === wrap) close(null);
    });
    document.body.appendChild(wrap);
  });
}

/** Prompt with a text input inside our modal style. */
export function promptModal(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<form class="modal-card"><h3>${esc(title)}</h3>
      <input class="input" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
      <div class="row-btns"><button type="button" class="btn ghost" data-cancel>Vazgeç</button><button class="btn">Kaydet</button></div></form>`;
    const form = wrap.querySelector('form');
    const close = (v) => {
      wrap.remove();
      resolve(v);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      close(form.v.value.trim() || null);
    });
    wrap.querySelector('[data-cancel]').onclick = () => close(null);
    wrap.addEventListener('click', (e) => e.target === wrap && close(null));
    document.body.appendChild(wrap);
    setTimeout(() => form.v.focus(), 50);
  });
}
