#!/usr/bin/env node
'use strict';
// Summarises data/netprobe.csv: connection success rate per host and hour of day.
// Usage: node scripts/netprobe-report.js [days=7]
const fs = require('fs');
const path = require('path');
const days = Number(process.argv[2]) || 7;
const file = path.join(__dirname, '..', 'data', 'netprobe.csv');
if (!fs.existsSync(file)) {
  console.log('Henüz ölçüm yok (data/netprobe.csv).');
  process.exit(0);
}
const since = Date.now() - days * 86400000;
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  .map(([t, host, ok, tries, ms]) => ({ t: new Date(t), host, ok: +ok, tries: +tries, ms: +ms }))
  .filter((r) => r.t.getTime() >= since);
const hosts = [...new Set(rows.map((r) => r.host))];
const agg = {};
for (const r of rows) {
  const h = r.t.getHours();
  const k = `${r.host}|${h}`;
  agg[k] = agg[k] || { ok: 0, tries: 0 };
  agg[k].ok += r.ok;
  agg[k].tries += r.tries;
}
const short = (h) => h.replace(/^www\./, '').replace('.iett.gov.tr', '').replace('.komoot.io', '').slice(0, 12);
console.log(`Son ${days} gün, ${rows.length} ölçüm — yeni bağlantı başarı oranı (%)\n`);
console.log('saat ' + hosts.map((h) => short(h).padStart(13)).join(''));
for (let h = 0; h < 24; h++) {
  const cells = hosts.map((host) => {
    const a = agg[`${host}|${h}`];
    return (a ? `${Math.round((a.ok / a.tries) * 100)}` : '-').padStart(13);
  });
  if (cells.some((c) => c.trim() !== '-')) console.log(`${String(h).padStart(2, '0')}:00${cells.join('')}`);
}
