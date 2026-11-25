'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TTLCache } = require('../src/util');

test('stale-while-revalidate returns old value at once and refreshes in background', async () => {
  const c = new TTLCache();
  let n = 0;
  const load = async () => ++n;
  assert.strictEqual(await c.get('k', 10, load, { stale: 1000 }), 1);
  await new Promise((r) => setTimeout(r, 20)); // expired, still within the stale window
  assert.strictEqual(await c.get('k', 10, load, { stale: 1000 }), 1); // old value, instantly
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(await c.get('k', 10, load, { stale: 1000 }), 2); // refreshed
});

test('failed loads are not cached and failed refreshes keep the old value', async () => {
  const c = new TTLCache();
  await assert.rejects(c.get('x', 1000, async () => { throw new Error('boom'); }));
  assert.strictEqual(await c.get('x', 1000, async () => 'ok'), 'ok');
  assert.strictEqual(await c.get('y', 5, async () => 'old', { stale: 1000 }), 'old');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(await c.get('y', 5, async () => { throw new Error('down'); }, { stale: 1000 }), 'old');
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(await c.get('y', 5, async () => 'new', { stale: 1000 }), 'old'); // retried in background
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(await c.get('y', 5, async () => 'newer', { stale: 1000 }), 'new');
});
