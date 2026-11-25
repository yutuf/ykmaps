// Core view plumbing: bottom sheet, per-view cleanup, navigation helpers.
import { $ } from './ui.js';
import { clearView, getMap } from './map.js';

export const viewEl = () => $('#view');
const sheet = () => $('#sheet');

let cleanups = [];
let viewToken = 0;

/** Register a cleanup for the current view (timers, listeners). */
export function onLeave(fn) {
  cleanups.push(fn);
}

/** Called by the router before rendering a new view. Returns a token to detect stale async renders. */
export function beginView() {
  cleanups.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
  cleanups = [];
  clearView();
  getMap().closePopup();
  viewEl().scrollTop = 0;
  return ++viewToken;
}

export const isCurrent = (token) => token === viewToken;

export function render(html) {
  viewEl().innerHTML = html;
}

export function setSheet(state) {
  const s = sheet();
  if (matchMedia('(min-width: 900px)').matches) return;
  s.dataset.state = state;
  positionCtrls();
}

export function getSheetState() {
  return sheet().dataset.state;
}

export function positionCtrls() {
  const s = sheet();
  const ctrls = $('#mapCtrls');
  const apply = () => {
    if (matchMedia('(min-width: 900px)').matches) return;
    const h = s.getBoundingClientRect().height;
    const tab = $('#tabbar').getBoundingClientRect().height;
    ctrls.style.bottom = `${h + tab + 12}px`;
  };
  apply();
  setTimeout(apply, 300);
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else location.hash = hash;
}

export function setBack(show) {
  $('#backBtn').hidden = !show;
}

export function setActiveTab(tab) {
  document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
}

/** Interval that pauses while the page is hidden; auto-cleared on view leave. */
export function liveInterval(fn, ms) {
  let t = null;
  const start = () => {
    if (t == null) t = setInterval(fn, ms);
  };
  const stop = () => {
    clearInterval(t);
    t = null;
  };
  const vis = () => {
    if (document.visibilityState === 'visible') {
      fn();
      start();
    } else stop();
  };
  document.addEventListener('visibilitychange', vis);
  start();
  onLeave(() => {
    stop();
    document.removeEventListener('visibilitychange', vis);
  });
  return { stop, start };
}

// ---------- sheet drag ----------
export function initSheetDrag() {
  const s = sheet();
  const handle = $('#sheetHandle');
  let startY = 0;
  let startH = 0;
  let dragging = false;
  const states = () => {
    const vh = window.innerHeight;
    const full = s.parentElement.getBoundingClientRect().height - $('#tabbar').getBoundingClientRect().height - 80;
    return { peek: 168, half: vh * 0.52, full };
  };
  const down = (e) => {
    dragging = true;
    startY = e.clientY;
    startH = s.getBoundingClientRect().height;
    s.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!dragging) return;
    const h = Math.max(120, Math.min(states().full, startH - (e.clientY - startY)));
    s.style.height = `${h}px`;
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    s.classList.remove('dragging');
    const h = s.getBoundingClientRect().height;
    const moved = Math.abs(e.clientY - startY);
    s.style.height = '';
    const st = states();
    let next;
    if (moved < 6) {
      // tap on handle cycles states
      next = { peek: 'half', half: 'full', full: 'peek' }[s.dataset.state] || 'half';
    } else {
      next = Object.entries(st).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
    }
    setSheet(next);
  };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);

  // Swipe down on the content when scrolled to top collapses the sheet.
  const body = viewEl();
  let ty = null;
  body.addEventListener('touchstart', (e) => {
    ty = body.scrollTop <= 0 ? e.touches[0].clientY : null;
  }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (ty == null) return;
    const dy = e.touches[0].clientY - ty;
    if (dy > 70 && body.scrollTop <= 0) {
      ty = null;
      setSheet(s.dataset.state === 'full' ? 'half' : 'peek');
    } else if (dy < -40 && s.dataset.state === 'peek') {
      ty = null;
      setSheet('half');
    }
  }, { passive: true });
  window.addEventListener('resize', positionCtrls);
  positionCtrls();
}
