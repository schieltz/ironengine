'use strict';
/* sw.js (offline support): network first, saved copy when offline or slow; never touches data. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadWorker({ fetchImpl }) {
  const handlers = {}, store = new Map(), timers = [];
  const cache = {
    addAll: async urls => urls.forEach(u => store.set(u, { body: 'cached ' + u, ok: true, clone() { return this; } })),
    put: async (k, v) => { store.set(k, v); },
    match: async k => store.get(k),
  };
  const ctx = vm.createContext({
    self: { addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting: () => {}, clients: { claim: () => {} } },
    caches: { open: async () => cache, keys: async () => ['old-cache', 'ironengine-v1'], delete: async () => true },
    fetch: fetchImpl, Response: { error: () => ({ error: true }) }, Promise, Error,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  vm.runInContext(SRC, ctx, { filename: 'sw.js' });
  const fire = async (type, event) => { let p; handlers[type]({ ...event, waitUntil: x => { p = x; }, respondWith: x => { p = x; } }); return p; };
  return { handlers, store, timers, fire };
}
const navigate = { request: { method: 'GET', mode: 'navigate', url: 'https://x/ironengine/' } };

describe('offline support (sw.js)', () => {
  test('installing saves the app page', async () => {
    const w = loadWorker({ fetchImpl: async () => ({ ok: true }) });
    await w.fire('install', {});
    assert.ok(w.store.has('./index.html'));
  });

  test('online: serves the network copy and refreshes the saved one', async () => {
    const fresh = { ok: true, body: 'new version', clone() { return this; } };
    const w = loadWorker({ fetchImpl: async () => fresh });
    assert.equal(await w.fire('fetch', navigate), fresh);
    assert.equal(w.store.get('./index.html'), fresh);
  });

  test('offline: opens the saved copy', async () => {
    const w = loadWorker({ fetchImpl: async () => { throw new TypeError('offline'); } });
    await w.fire('install', {});
    assert.equal((await w.fire('fetch', navigate)).body, 'cached ./index.html');
  });

  test('slow network: falls back after 3 s', async () => {
    const w = loadWorker({ fetchImpl: () => new Promise(() => {}) });
    await w.fire('install', {});
    const pending = w.fire('fetch', navigate);
    await new Promise(r => setImmediate(r));
    const timer = w.timers.find(t => t.ms === 3000);
    assert.ok(timer, 'a 3 s timeout is armed');
    timer.fn();
    assert.equal((await pending).body, 'cached ./index.html');
  });

  test('only opening the app is handled; other requests pass through', async () => {
    const w = loadWorker({ fetchImpl: async () => ({ ok: true }) });
    assert.equal(await w.fire('fetch', { request: { method: 'GET', mode: 'cors', url: 'https://x/other.json' } }), undefined);
  });

  test('index.html registers it only for self-hosted https (never inside Claude)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /if\(!window\.storage&&'serviceWorker' in navigator&&\(location\.protocol==='https:'/);
    assert.match(html, /navigator\.serviceWorker\.register\('sw\.js'\)\.catch/);
  });
});
