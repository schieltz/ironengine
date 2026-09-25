'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, fakeLocalStorage } = require('./harness');

const NOW = Date.parse('2026-09-25T12:00:00Z');
const target = (w, tgt) => ({ w, tgt, rir: null, st: null, reps: null });
const rirOnly = (w, rir) => ({ w, tgt: null, rir, st: null, reps: null });

/* Simulates the Claude artifact API: get() of a missing key throws. */
function fakeWindowStorage() {
  const data = new Map();
  return {
    data,
    async get(k) { if (!data.has(k)) throw new Error('not found'); return { key: k, value: data.get(k) }; },
    async set(k, v) { data.set(k, v); return { key: k, value: v }; },
  };
}

/* localStorage that fails the test if touched at all. */
function forbiddenLocalStorage() {
  const touched = [];
  const trap = name => (...a) => { touched.push([name, ...a]); throw new Error(`localStorage.${name} must not run`); };
  return { touched, getItem: trap('getItem'), setItem: trap('setItem'), removeItem: trap('removeItem') };
}

describe('boot', () => {
  test('fresh install seeds the RP-screenshot meso at week 2 day 3', async () => {
    const app = await bootApp({ now: NOW });
    assert.equal(app.run('selWeek'), 2);
    assert.equal(app.run('selDay'), 3);
    assert.match(app.els.get('main').innerHTML, /Bench Press \(Close Grip\)/);
  });
});

describe('VERIFIED fixtures through the real ensureDay() path on the seed (w1d3 -> w2d3)', () => {
  test('w2d3 prescriptions match RP', async () => {
    const app = await bootApp({ now: NOW });
    const st = app.state();
    const day = st.meso.days[2].map(e => e.name);
    const w2d3 = st.meso.log.w2d3;

    assert.equal(day[3], 'Bench Press (Close Grip)');
    assert.deepEqual(w2d3[3], [target(120, 11), target(120, 10), rirOnly(120, 2)]);

    assert.equal(day[4], 'Dumbbell Press (High Incline)');
    assert.deepEqual(w2d3[4].slice(0, 2), [target(60, 6), rirOnly(55, 2)]);

    assert.equal(day[5], 'Barbell Bent Over Row');
    assert.deepEqual(w2d3[5], [rirOnly(120, 2), rirOnly(120, 2)]);
    assert.deepEqual(w2d3[6], [rirOnly(300, 2), rirOnly(300, 2)]);
    assert.deepEqual(w2d3[7], [rirOnly(120, 2), rirOnly(120, 2)]);
  });

  test('each prescribed exercise has a stored "why"', async () => {
    const app = await bootApp({ now: NOW });
    const st = app.state();
    for (const i of [3, 4, 5, 6, 7]) assert.ok(st.meso.days[2][i]._why.w2d3.length > 10);
  });
});

describe('storage adapter', () => {
  test('window.storage present -> localStorage is never touched', async () => {
    const ws = fakeWindowStorage();
    const ls = forbiddenLocalStorage();
    await bootApp({ now: NOW, windowStorage: ws, localStorage: ls });
    assert.deepEqual(ls.touched, []);
    assert.ok(ws.data.has('state2'), 'state saved through window.storage');
  });

  test('window.storage absent -> localStorage with ironengine: prefix, reload restores state', async () => {
    const ls = fakeLocalStorage();
    const first = await bootApp({ now: NOW, localStorage: ls });
    await first.call('ST.meso.name = "persisted"; await save();');
    assert.ok(ls.data.has('ironengine:state2'));

    const second = await bootApp({ now: NOW, localStorage: ls });
    assert.equal(second.state().meso.name, 'persisted');
  });
});

describe('Engine tab', () => {
  test('shows the live RULES coefficients, not hand-copied numbers', async () => {
    const app = await bootApp({ now: NOW });
    await app.call("setView('engine');");
    const html = app.els.get('main').innerHTML;
    const R = app.run('RULES');
    assert.ok(html.includes(`≤${R.floorReps} reps`));
    assert.ok(html.includes(`~${Math.round(R.cutPct * 100)}%`));
    assert.ok(html.includes(`>${R.staleWeeks} wks`));
    assert.doesNotMatch(html, /\$\{/, 'unrendered template');
  });
});
