'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../src/parse');
const { norm, decodeEntities } = require('../src/util');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('arrivals', () => {
  const a = P.parseArrivals(fx('arrivals.html'));
  assert.ok(a.length > 5);
  assert.deepStrictEqual(Object.keys(a[0]).sort(), ['dest', 'line', 'minutes', 'raw', 'time', 'unreliable']);
  assert.strictEqual(a[0].line, '34G');
  assert.strictEqual(a[0].minutes, 1);
  assert.match(a[1].dest, /SÖĞÜTLÜÇEŞME/);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].minutes >= a[i - 1].minutes);
});

test('route stops per direction', () => {
  const d = P.parseRouteStops(fx('route-stops.html'));
  assert.strictEqual(d.length, 2);
  assert.strictEqual(d[0].stops.length, 64);
  assert.strictEqual(d[1].stops.length, 66);
  assert.deepStrictEqual(d[0].stops[1], { code: '205471', seq: 2, name: '23 NİSAN CADDESİ', district: 'Tuzla' });
});

test('pins align with stop list', () => {
  const pin = P.parsePins(JSON.parse(fx('pin.json')));
  const d = P.parseRouteStops(fx('route-stops.html'));
  assert.strictEqual(pin.places.length, d[0].stops.length);
  assert.strictEqual(pin.places[0].name, d[0].stops[0].name);
  assert.ok(pin.shape.length > 100);
  assert.ok(pin.shape.every(([lat, lng]) => lat > 40 && lat < 42 && lng > 27 && lng < 30));
});

test('schedule', () => {
  const s = P.parseSchedule(fx('schedule.html'));
  assert.strictEqual(s.length, 2);
  assert.match(s[0].title, /KALKIŞ/);
  assert.ok(s[0].weekday.length > 50);
  assert.ok(s[0].weekday.every((t) => /^\d\d:\d\d$/.test(t)));
  assert.ok(s[0].sunday.length > 0);
});

test('station lines + page', () => {
  const l = P.parseStationLines(JSON.parse(fx('station-lines.json')));
  assert.ok(l.find((x) => x.code === '34BZ'));
  const st = P.parseStationPage(fx('station-page.html'));
  assert.strictEqual(st.code, '121221');
  assert.ok(st.lat > 41 && st.lng > 28);
});

test('announcements', () => {
  const a = P.parseAnnouncements(fx('announcements.html'));
  assert.ok(a.length >= 5);
  assert.ok(a.every((x) => /^\d+$/.test(x.id) && x.title));
  const p = P.parseAnnouncements(fx('announcements-page.html'));
  assert.ok(p.length >= 5 && /\d{4}/.test(p[0].date));
  const d = P.parseAnnouncementDetail(fx('announcement-detail.html'));
  assert.match(d.body, /HT6/);
});

test('trip plan', () => {
  const r = P.parsePlan(JSON.parse(fx('plan.json')));
  assert.ok(r.itineraries.length > 0);
  const it = r.itineraries[0];
  assert.ok(it.duration > 0);
  assert.ok(it.legs.some((l) => l.mode !== 'walking' && l.line));
  assert.ok(it.legs.every((l) => l.shape.length >= 2));
});

test('polyline decode', () => {
  assert.deepStrictEqual(P.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('helpers', () => {
  assert.strictEqual(norm('MECİDİYEKÖY Şişli'), 'mecidiyekoy sisli');
  assert.strictEqual(decodeEntities('S&#214;Ğ&#220;T &amp; x'), 'SÖĞÜT & x');
  assert.deepStrictEqual(P.splitStopName('MECİDİYEKÖY - Şişli - AVCILAR Yönü'), { name: 'MECİDİYEKÖY', district: 'Şişli', direction: 'AVCILAR' });
});
