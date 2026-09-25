'use strict';
/*
 * Headless loader for index.html. No dependencies, no build step.
 *   loadEngine() - runs ONLY the pure engine block (R1-R8 + seeding) in a sandbox
 *   bootApp()    - runs the whole inline script against a minimal DOM stub
 * Both take a fixed clock so date-dependent rules (staleness) are deterministic.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML_PATH = process.env.IRONENGINE_HTML || path.join(__dirname, '..', 'index.html');
const ENGINE_BEGIN = '@engine:begin';
const ENGINE_END = '@engine:end';

function readHtml() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

function inlineScripts(html = readHtml()) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ attrs: m[1], body: m[2] });
  return out;
}

function appScript(html = readHtml()) {
  const scripts = inlineScripts(html);
  if (scripts.length !== 1) throw new Error(`expected exactly 1 <script> in index.html, found ${scripts.length}`);
  return scripts[0].body;
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/* The engine block is everything between the @engine:begin and @engine:end comments. */
function engineSource(src = appScript()) {
  for (const m of [ENGINE_BEGIN, ENGINE_END]) {
    if (countOf(src, m) !== 1) throw new Error(`"${m}" marker must appear exactly once`);
  }
  const start = src.lastIndexOf('/*', src.indexOf(ENGINE_BEGIN));
  const end = src.indexOf('*/', src.indexOf(ENGINE_END)) + 2;
  if (start < 0 || end <= start) throw new Error('engine markers out of order');
  return src.slice(start, end);
}

/* Replace Date in a sandbox so Date.now() and new Date() both return `now`. */
function freezeClock(ctx, now) {
  vm.runInContext(`(() => {
    const Real = Date, NOW = ${Number(now)};
    class FixedDate extends Real {
      constructor(...a) { super(...(a.length ? a : [NOW])); }
      static now() { return NOW; }
    }
    globalThis.Date = FixedDate;
  })();`, ctx);
}

/* Objects built inside a vm context carry that context's prototypes, which
   breaks assert.deepStrictEqual. structuredClone rebuilds them in this realm. */
const plain = v => (v === undefined ? v : structuredClone(v));

function loadEngine({ now = Date.now() } = {}) {
  const ctx = vm.createContext({});
  freezeClock(ctx, now);
  vm.runInContext(engineSource(), ctx, { filename: 'index.html#engine' });
  const fns = vm.runInContext('({ roundLoad, weeksSince, startingSets, prescribe, rirFor })', ctx);
  const consts = vm.runInContext('({ RIR_RAMP, DELOAD_RIR, RULES })', ctx);
  const wrap = f => (...args) => plain(f(...args));
  return {
    roundLoad: fns.roundLoad,
    rirFor: fns.rirFor,
    weeksSince: fns.weeksSince,
    startingSets: wrap(fns.startingSets),
    prescribe: wrap(fns.prescribe),
    RIR_RAMP: plain(consts.RIR_RAMP),
    DELOAD_RIR: consts.DELOAD_RIR,
    RULES: plain(consts.RULES),
  };
}

function fakeElement() {
  return {
    innerHTML: '', textContent: '',
    classList: { add() {}, remove() {} },
  };
}

/* In-memory Web Storage stand-in that records every call. Set failWrites to simulate a full disk. */
function fakeLocalStorage() {
  const data = new Map();
  const calls = [];
  return {
    calls, data, failWrites: false,
    getItem(k) { calls.push(['getItem', k]); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) {
      calls.push(['setItem', k]);
      if (this.failWrites && k !== '__t') throw new Error('QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem(k) { calls.push(['removeItem', k]); data.delete(k); },
  };
}

/* Boots the full app script. `windowStorage` simulates the Claude artifact API;
   `localStorage` simulates a browser. Omit both for the in-memory fallback.
   `confirm` answers window.confirm(); by default any confirm() call fails the test. */
async function bootApp({ now = Date.now(), windowStorage, localStorage, confirm } = {}) {
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, fakeElement());
      return els.get(id);
    },
  };
  const confirms = [];
  const sandbox = {
    document, console, navigator: {}, setTimeout: () => 0, clearTimeout() {},
    location: { reload() {} },
    confirm: msg => {
      confirms.push(msg);
      if (!confirm) throw new Error(`unexpected confirm(): ${msg}`);
      return confirm(msg);
    },
  };
  sandbox.window = sandbox;
  if (windowStorage) sandbox.storage = windowStorage;
  if (localStorage) sandbox.localStorage = localStorage;
  const ctx = vm.createContext(sandbox);
  freezeClock(ctx, now);
  vm.runInContext(appScript(), ctx, { filename: 'index.html' });
  await settle();
  const run = code => vm.runInContext(code, ctx);
  return {
    ctx, els, run, confirms,
    state: () => plain(run('ST')),
    call: async code => { await run(`(async () => { ${code} })()`); await settle(); },
  };
}

/* init() is async and not awaited by the page; let its promise chain drain. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
}

module.exports = {
  HTML_PATH, readHtml, inlineScripts, appScript, engineSource,
  loadEngine, bootApp, fakeLocalStorage, plain,
};
