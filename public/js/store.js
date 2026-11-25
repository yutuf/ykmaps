// Local persistence: favorites, recents, alarms, settings.
const KEY = 'ykmaps:v1';

const defaults = {
  favStops: [], // {code, name, district, lat, lng}
  favLines: [], // {code, name}
  places: [], // {id, label, name, lat, lng, icon}  (Ev, İş, ...)
  recents: [], // {type:'line'|'stop'|'place', ...}
  alarms: [], // {id, stop, stopName, line, minutes, created}
  settings: { theme: 'auto', refresh: 20, notify: true },
};

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...structuredClone(defaults), ...raw, settings: { ...defaults.settings, ...(raw.settings || {}) } };
  } catch {
    return structuredClone(defaults);
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode) */
  }
  listeners.forEach((fn) => fn(state));
}

export const store = {
  get: () => state,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  update(fn) {
    fn(state);
    save();
  },

  isFavStop: (code) => state.favStops.some((s) => s.code === code),
  toggleFavStop(stop) {
    store.update((s) => {
      const i = s.favStops.findIndex((x) => x.code === stop.code);
      if (i >= 0) s.favStops.splice(i, 1);
      else s.favStops.unshift({ code: stop.code, name: stop.name, district: stop.district || '', lat: stop.lat, lng: stop.lng });
    });
    return store.isFavStop(stop.code);
  },
  isFavLine: (code) => state.favLines.some((l) => l.code === code),
  toggleFavLine(line) {
    store.update((s) => {
      const i = s.favLines.findIndex((x) => x.code === line.code);
      if (i >= 0) s.favLines.splice(i, 1);
      else s.favLines.unshift({ code: line.code, name: line.name || '' });
    });
    return store.isFavLine(line.code);
  },
  savePlace(place) {
    store.update((s) => {
      const id = place.id || `p${Date.now()}`;
      const i = s.places.findIndex((p) => p.id === id || (place.label && p.label === place.label && ['Ev', 'İş'].includes(place.label)));
      const rec = { ...place, id };
      if (i >= 0) s.places[i] = rec;
      else s.places.push(rec);
    });
  },
  removePlace(id) {
    store.update((s) => {
      s.places = s.places.filter((p) => p.id !== id);
    });
  },
  addRecent(item) {
    store.update((s) => {
      const key = (x) => `${x.type}:${x.code || x.name}`;
      s.recents = [item, ...s.recents.filter((r) => key(r) !== key(item))].slice(0, 15);
    });
  },
  clearRecents() {
    store.update((s) => {
      s.recents = [];
    });
  },
  addAlarm(a) {
    store.update((s) => {
      s.alarms = s.alarms.filter((x) => !(x.stop === a.stop && x.line === a.line));
      s.alarms.push({ ...a, id: `a${Date.now()}`, created: Date.now() });
    });
  },
  removeAlarm(id) {
    store.update((s) => {
      s.alarms = s.alarms.filter((a) => a.id !== id);
    });
  },
  setSetting(k, v) {
    store.update((s) => {
      s.settings[k] = v;
    });
  },
};
