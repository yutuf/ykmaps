'use strict';
// Parsers that turn iett.istanbul / nasilgiderim responses into clean JSON.
const { decodeEntities, text } = require('./util');

function attr(html, id) {
  const re = new RegExp(`value="([^"]*)"\\s+id="${id}"|id="${id}"\\s+value="([^"]*)"`);
  const m = html.match(re);
  return m ? decodeEntities(m[1] ?? m[2]) : '';
}

/** "MECİDİYEKÖY - Şişli - AVCILAR Yönü" -> { name, district, direction } */
function splitStopName(full) {
  const parts = decodeEntities(full).split(' - ').map((s) => s.trim());
  let direction = '';
  let district = '';
  if (parts.length >= 2 && /Yönü$/i.test(parts[parts.length - 1])) {
    direction = parts.pop().replace(/\s*Yönü$/i, '');
  }
  if (parts.length >= 2) district = parts.pop();
  return { name: parts.join(' - '), district, direction };
}

function parseSearchItems(json) {
  const list = (json && json.list) || [];
  const lines = [];
  const stops = [];
  for (const it of list) {
    if (it.Stationcode) {
      stops.push({ code: String(it.Stationcode), ...splitStopName(it.Name) });
    } else if (it.Code && !/</.test(it.Code)) {
      lines.push({ code: decodeEntities(it.Code), name: decodeEntities(it.Name) });
    }
  }
  return { lines, stops };
}

/** Live arrivals for a stop (GetStationInfo). */
function parseArrivals(html) {
  const out = [];
  const re = /<div class="content">\s*<span>([^<]*)<\/span>\s*<p>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    const line = text(m[1]);
    const p = m[2];
    const bMatch = p.match(/<b>([\s\S]*?)<\/b>/);
    const info = text(bMatch ? bMatch[1] : p);
    const dest = text(bMatch ? p.slice(0, bMatch.index) : '');
    const t = info.match(/\((\d{1,2}:\d{2})\)/);
    const mins = info.match(/(\d+)\s*dk/);
    if (!line || (!t && !mins)) continue;
    out.push({
      line,
      dest,
      time: t ? t[1] : null,
      minutes: mins ? Number(mins[1]) : null,
      // "B işaretli saatler henüz sefere başlamamış veya sinyal sorunlu araçları ifade eder"
      unreliable: /\bB\b/.test(info.replace(/\(.*?\)/g, '').replace(/dk/g, '')),
      raw: info,
    });
  }
  out.sort((a, b) => (a.minutes ?? 999) - (b.minutes ?? 999));
  return out;
}

/** Stop lists per direction (GetStationForRoute / GetFastStation). */
function parseRouteStops(html) {
  const blocks = html.split(/class="line-pass-header[^"]*">/).slice(1);
  return blocks.map((b) => {
    const header = text(b.slice(0, b.indexOf('<')));
    const stops = [];
    const re = /dkod=(\d+)[^>]*>\s*<p>\s*(\d+)\.\s*([\s\S]*?)<span>\s*-?\s*([\s\S]*?)<\/span>/g;
    let m;
    while ((m = re.exec(b))) {
      stops.push({ code: m[1], seq: Number(m[2]), name: text(m[3]), district: text(m[4]) });
    }
    return { header, stops };
  });
}

/** Planned departures (GetScheduledDepartureTimes). */
function parseSchedule(html) {
  const tables = html.split(/<table class="line-table">/).slice(1);
  return tables.map((t) => {
    const title = text((t.match(/<th class="routedetailstartend"[^>]*>([\s\S]*?)<\/th>/) || [])[1]);
    const headRow = (t.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
    const heads = [...headRow.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((x) => text(x[1]));
    const cols = heads.map(() => []);
    const body = (t.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
    for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => text(x[1]));
      cells.forEach((c, i) => {
        if (c && cols[i]) cols[i].push(c);
      });
    }
    const pick = (re) => {
      const i = heads.findIndex((h) => re.test(h));
      return i >= 0 ? cols[i] : [];
    };
    return {
      title,
      weekday: pick(/İş|Hafta ?içi|Work/i),
      saturday: pick(/Cumartesi|Saturday/i),
      sunday: pick(/Pazar|Sunday/i),
    };
  });
}

/** Lines that serve a stop (GetRouteByStation -> {html}). */
function parseStationLines(json) {
  const html = (json && json.html) || '';
  const out = [];
  const seen = new Set();
  const re = /hkod=([^&"]+)[\s\S]*?<span>([\s\S]*?)<\/span>\s*<p>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    const code = decodeURIComponent(decodeEntities(m[1]));
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: text(m[3]) });
  }
  return out;
}

/** StationDetail page -> stop metadata. */
function parseStationPage(html) {
  const lat = parseFloat(attr(html, 'slat'));
  const lng = parseFloat(attr(html, 'slng'));
  return {
    code: attr(html, 'dkod'),
    name: attr(html, 'sname'),
    district: attr(html, 'sdis'),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function parseWktLines(wkt) {
  const pts = [];
  for (const seg of String(wkt || '').split('|')) {
    const m = seg.match(/\(([^)]*)\)/);
    if (!m) continue;
    for (const pair of m[1].split(',')) {
      const [lng, lat] = pair.trim().split(/\s+/).map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const last = pts[pts.length - 1];
        if (!last || last[0] !== lat || last[1] !== lng) pts.push([+lat.toFixed(6), +lng.toFixed(6)]);
      }
    }
  }
  return pts;
}

/** GetRoutePinV2 -> { color, shape, places } */
function parsePins(json) {
  const first = Array.isArray(json) ? json[0] : null;
  if (!first) return { color: null, shape: [], places: [] };
  return {
    color: first.lineColor || null,
    shape: parseWktLines(first.line),
    places: (first.stationPlaces || []).map((p) => ({
      name: decodeEntities(p.stationName),
      district: decodeEntities(p.stationCity),
      lat: +parseFloat(p.lat).toFixed(6),
      lng: +parseFloat(p.lng).toFixed(6),
    })),
  };
}

/** Announcement lists (homepage swiper or paged list). */
function parseAnnouncements(html) {
  const out = [];
  const seen = new Set();
  const swiper = /href="\/Announcement\/Detail\/(\d+)"[\s\S]*?<span>([\s\S]*?)<\/span>\s*<small>([\s\S]*?)<\/small>/g;
  const paged = /href="\/Announcement\/Detail\/(\d+)"[\s\S]*?<div class="date">([\s\S]*?)<\/div>\s*<div class="info">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = swiper.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title: text(m[2]), date: text(m[3]) });
  }
  while ((m = paged.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title: text(m[3]), date: text(m[2]) });
  }
  return out;
}

function parseAnnouncementDetail(html) {
  const dateM = html.match(/<div class="news-detail-date">([\s\S]*?)<\/div>/);
  const bodyM = html.match(/<div class="news-detail-entry">([\s\S]*?)<div class="row">/);
  const titleM = html.match(/<title>([\s\S]*?)<\/title>/);
  const body = text((bodyM ? bodyM[1] : '').replace(/<\/(p|div)>/gi, '\n'))
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  return {
    id: attr(html, 'announcementid'),
    title: text(titleM ? titleM[1] : '').replace(/\s*[|-]\s*İETT.*$/i, ''),
    date: text(dateM ? dateM[1] : ''),
    body,
  };
}

/** Google encoded polyline -> [[lat,lng]] */
function decodePolyline(str) {
  const pts = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

const MODE_NAMES = {
  walking: 'Yürüme',
  bus: 'Otobüs',
  minibus: 'Minibüs',
  taksiDolmus: 'Dolmuş',
  metro: 'Metro',
  marmaray: 'Marmaray',
  tram: 'Tramvay',
  funi: 'Füniküler',
  tele: 'Teleferik',
  shatlari: 'Şehir Hatları',
  ido: 'İDO',
  turyol: 'Turyol',
  dentur: 'Dentur',
  metrobus: 'Metrobüs',
  ferry: 'Vapur',
};

/** nasilgiderim /router -> normalised itineraries */
function parsePlan(json) {
  if (!json || !Array.isArray(json.routes)) return { error: (json && json.error) || 'NO_DATA', itineraries: [] };
  const itineraries = json.routes.map((r) => {
    const legs = (r.path || []).map((p) => {
      const walking = p.routeId === 'walking' || p.lineId === 'walking';
      let type = walking ? 'walking' : p.type || 'bus';
      if (!walking && /^34/.test(p.lineId || '') && /metrob/i.test(p.lineName || '')) type = 'metrobus';
      const shape = [];
      for (const s of p.sections || []) {
        if (s.polyline) shape.push(...decodePolyline(s.polyline));
      }
      const stops = (p.stops || []).map((s) => ({ id: s.stopId || '', name: s.stopName || '', lat: s.point?.[0], lng: s.point?.[1] }));
      return {
        mode: type,
        modeName: MODE_NAMES[type] || type,
        line: walking ? '' : p.lineId || '',
        lineName: p.lineName || '',
        direction: p.directionName || '',
        alternatives: p.alternateLineId || [],
        distance: p.walkDistance || 0,
        start: p.departureTime,
        end: p.arrivalTime,
        stops,
        shape: shape.length ? shape : stops.filter((s) => s.lat != null).map((s) => [s.lat, s.lng]),
      };
    });
    return {
      start: r.departureTime,
      end: r.arrivalTime,
      duration: Math.round((r.arrivalTime - r.departureTime) / 60000),
      walk: r.walkDistance,
      fare: r.totalFee,
      co2: r.CO2Emission,
      calories: r.caloriesBurned,
      transfers: Math.max(0, legs.filter((l) => l.mode !== 'walking').length - 1),
      legs,
    };
  });
  return { error: json.error || null, itineraries };
}

module.exports = {
  attr,
  splitStopName,
  parseSearchItems,
  parseArrivals,
  parseRouteStops,
  parseSchedule,
  parseStationLines,
  parseStationPage,
  parsePins,
  parseWktLines,
  parseAnnouncements,
  parseAnnouncementDetail,
  decodePolyline,
  parsePlan,
};
