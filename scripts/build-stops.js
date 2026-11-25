#!/usr/bin/env node
'use strict';
// Crawl every İETT line and write data/stops.json (used for "nearby stops").
// Usage: node scripts/build-stops.js
const idx = require('../src/stops-index');
idx
  .build({ concurrency: Number(process.env.CONCURRENCY) || 4, log: (m) => console.log(m) })
  .then((r) => {
    console.log(JSON.stringify(r));
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
