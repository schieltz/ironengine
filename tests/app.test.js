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

describe('state schema', () => {
  test('fresh seed is stamped with the current schema version', async () => {
    const app = await bootApp({ now: NOW });
    assert.equal(app.state().v, app.run('SCHEMA_VERSION'));
  });

  test('unversioned (legacy) save loads intact and is re-saved with a version', async () => {
    const ls = fakeLocalStorage();
    const seed = await bootApp({ now: NOW });
    const legacy = seed.state();
    delete legacy.v;
    legacy.meso.name = 'legacy meso';
    ls.data.set('ironengine:state2', JSON.stringify(legacy));

    const app = await bootApp({ now: NOW, localStorage: ls });
    assert.equal(app.state().meso.name, 'legacy meso');
    assert.equal(JSON.parse(ls.data.get('ironengine:state2')).v, app.run('SCHEMA_VERSION'));
  });
});

describe('storage failures never overwrite saved data', () => {
  test('corrupt saved JSON: raw data untouched, saving blocked, recovery sheet shown', async () => {
    const ls = fakeLocalStorage();
    const corrupt = '{"v":1,"meso":{"name":"MY REAL DATA"';
    ls.data.set('ironengine:state2', corrupt);
    const app = await bootApp({ now: NOW, localStorage: ls });
    await app.call('await pickWeek(3); await save();');
    assert.equal(ls.data.get('ironengine:state2'), corrupt);
    assert.match(app.els.get('modalRoot').innerHTML, /Couldn't read saved data/);
  });

  test('saved data from a newer app version is not overwritten', async () => {
    const ls = fakeLocalStorage();
    const future = JSON.stringify({ v: 99, meso: { name: 'future' }, hist: {} });
    ls.data.set('ironengine:state2', future);
    const app = await bootApp({ now: NOW, localStorage: ls });
    assert.equal(ls.data.get('ironengine:state2'), future);
    assert.match(app.els.get('modalRoot').innerHTML, /newer app version/);
  });

  test('window.storage read error: nothing written back', async () => {
    const writes = [];
    const ws = { async get() { throw new Error('network blip'); }, async set(k, v) { writes.push(k); } };
    const app = await bootApp({ now: NOW, windowStorage: ws });
    await app.call('await save();');
    assert.deepEqual(writes, []);
    assert.match(app.els.get('modalRoot').innerHTML, /network blip/);
  });

  for (const [label, get] of [
    ['returns null', async () => null],
    ['throws "not found"', async () => { throw new Error('Key not found'); }],
  ]) {
    test(`window.storage get() ${label} for a first run: seed is saved`, async () => {
      const data = new Map();
      await bootApp({ now: NOW, windowStorage: { get, async set(k, v) { data.set(k, v); } } });
      assert.equal(JSON.parse(data.get('state2')).meso.name, 'New meso plan');
    });
  }

  test('"Start fresh" keeps the unreadable data under a backup key first', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('ironengine:state2', '{broken');
    const app = await bootApp({ now: NOW, localStorage: ls, confirm: () => true });
    await app.call('await startFresh();');
    const backups = [...ls.data.keys()].filter(k => k.startsWith('ironengine:state2.unreadable-'));
    assert.equal(backups.length, 1);
    assert.equal(ls.data.get(backups[0]), '{broken');
    assert.equal(JSON.parse(ls.data.get('ironengine:state2')).meso.name, 'New meso plan');
    assert.equal(app.els.get('modalRoot').innerHTML, '');
  });

  test('declining "Start fresh" changes nothing', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('ironengine:state2', '{broken');
    const app = await bootApp({ now: NOW, localStorage: ls, confirm: () => false });
    await app.call('await startFresh();');
    assert.equal(ls.data.get('ironengine:state2'), '{broken');
    assert.equal(ls.data.size, 1);
  });

  test('failed write shows a banner; it clears once saving works again', async () => {
    const ls = fakeLocalStorage();
    const app = await bootApp({ now: NOW, localStorage: ls });
    ls.failWrites = true;
    await app.call('await save();');
    assert.match(app.els.get('banner').innerHTML, /Last save failed/);
    ls.failWrites = false;
    await app.call('await save();');
    assert.equal(app.els.get('banner').innerHTML, '');
  });

  test('no storage at all: banner says nothing is being saved', async () => {
    const app = await bootApp({ now: NOW });
    assert.equal(app.run('store.mode'), 'memory');
    assert.match(app.els.get('banner').innerHTML, /nothing is being saved/);
  });
});

/* log every set of exercise i in session k at the given reps */
const logReps = (app, k, i, reps) =>
  app.call(`ST.meso.log.${k}[${i}].forEach((s,j)=>{ s.reps=${JSON.stringify(reps)}[j]; s.st='logged'; }); await save();`);

describe('provisional prescriptions (looking ahead never freezes numbers)', () => {
  test('week 3 viewed early still updates once week 2 is logged', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await pickWeek(3);');
    assert.deepEqual(app.state().meso.log.w3d3[3], [rirOnly(120, 2), rirOnly(120, 2), rirOnly(120, 2)]);
    assert.match(app.state().meso.days[2][3]._why.w3d3, /Preview/);

    await app.call('await pickWeek(2);');
    await logReps(app, 'w2d3', 3, [11, 10, 9]);
    await app.call('await pickWeek(3);');
    const st = app.state();
    assert.deepEqual(st.meso.log.w3d3[3], [target(120, 12), target(120, 11), target(120, 10), rirOnly(120, 2)]);
    assert.match(st.meso.days[2][3]._why.w3d3, /R1/);
  });

  test('tapping the deload week from week 2 never produces 0 lb sets', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await pickWeek(6);');
    const w6 = app.state().meso.log.w6d3.flat();
    assert.ok(w6.length > 0);
    assert.ok(w6.every(s => s.w > 0), JSON.stringify(w6.map(s => s.w)));
  });

  test('a touched exercise stays frozen while untouched ones keep updating', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await pickWeek(3); await upd(3,0,"w","125");');   // edit bench weight in week 3
    const frozen = app.state().meso.log.w3d3[3];
    await app.call('await pickWeek(2);');
    await logReps(app, 'w2d3', 3, [11, 10, 9]);
    await logReps(app, 'w2d3', 5, [8, 8]);                             // barbell row, untouched in week 3
    await app.call('await pickWeek(3);');
    const st = app.state();
    assert.deepEqual(st.meso.log.w3d3[3], frozen);
    assert.equal(st.meso.log.w3d3[3][0].w, 125);
    assert.deepEqual(st.meso.log.w3d3[5].slice(0, 2), [target(120, 9), target(120, 9)]);
  });

  test('navigating without changes does not rewrite storage', async () => {
    const ls = fakeLocalStorage();
    const app = await bootApp({ now: NOW, localStorage: ls });
    await app.call('await pickWeek(3); await pickWeek(2);');
    const writes = ls.calls.filter(c => c[0] === 'setItem' && c[1] === 'ironengine:state2').length;
    await app.call('await pickWeek(3); await pickWeek(2);');
    assert.equal(ls.calls.filter(c => c[0] === 'setItem' && c[1] === 'ironengine:state2').length, writes);
  });
});
