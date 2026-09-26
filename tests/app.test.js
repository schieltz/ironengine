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

/* answer the feedback sheet for exercise ei in the current session */
const giveFeedback = (app, ei, f) => app.call(
  `openFeedback(${ei}); Object.assign(fbState, ${JSON.stringify(f)}); await saveFB();`);
const NEUTRAL = { soreness: 2, pain: 0, pump: 1, workload: 1 };

describe('feedback belongs to one session (C2)', () => {
  test('pain in week 2 holds week 3 only; week 4 progresses normally', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('selDay=2; await pickWeek(2);');
    await giveFeedback(app, 2, { ...NEUTRAL, pain: 2 });            // close-grip bench, Wed
    await app.call('await pickWeek(3);');
    assert.deepEqual(app.state().meso.log.w3d2[2], [target(120, 12), target(120, 11)]);

    await logReps(app, 'w3d2', 2, [12, 11]);
    await app.call('await pickWeek(4);');
    assert.deepEqual(app.state().meso.log.w4d2[2], [target(120, 13), target(120, 12), rirOnly(120, 1)]);
  });

  test('feedback given after peeking at next week still takes effect', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('selDay=2; await pickWeek(3); await pickWeek(2);');
    await giveFeedback(app, 2, { ...NEUTRAL, workload: 3 });        // "too much" -> hold sets
    await app.call('await pickWeek(3);');
    assert.equal(app.state().meso.log.w3d2[2].length, 2);
  });

  test('the feedback checkmark shows only in the session it was given', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('selDay=2; await pickWeek(2);');
    await giveFeedback(app, 2, NEUTRAL);
    assert.equal(app.els.get('main').innerHTML.split('✓ Feedback').length - 1, 1);
    await app.call('await pickWeek(3);');
    assert.equal(app.els.get('main').innerHTML.split('✓ Feedback').length - 1, 0);
  });

  test('v1 migration moves legacy per-exercise feedback to its latest logged session', async () => {
    const ls = fakeLocalStorage();
    const legacy = (await bootApp({ now: NOW })).state();
    delete legacy.v; delete legacy.meso.fb;
    const pain = { ...NEUTRAL, pain: 3 };
    legacy.meso.days[1][2].feedback = pain;                          // bench Wed: logged in week 2
    legacy.meso.days[0][0].feedback = NEUTRAL;                       // Mon ex 0: logged in week 2
    legacy.meso.log.w3d1 = legacy.meso.log.w2d1.map(sets => sets.map(s => ({ ...s, st: null })));
    ls.data.set('ironengine:state2', JSON.stringify(legacy));

    const app = await bootApp({ now: NOW, localStorage: ls });
    const st = app.state();
    assert.equal(st.v, app.run('SCHEMA_VERSION'));
    assert.deepEqual(st.meso.fb.w2d2[2], pain);
    assert.deepEqual(st.meso.fb.w2d1[0], NEUTRAL);                   // week 3 Mon untouched, so week 2
    assert.ok(st.meso.days.flat().every(ex => !('feedback' in ex)));
  });
});

describe('destructive actions and backups (C3)', () => {
  test('Reset asks first; declining keeps everything', async () => {
    let answer = false;
    const app = await bootApp({ now: NOW, confirm: () => answer });
    await app.call('ST.meso.name="mine"; ST.hist.X={w:1,date:"2026-09-01"}; await doReset();');
    assert.equal(app.state().meso.name, 'mine');
    answer = true;
    await app.call('await doReset();');
    assert.equal(app.state().meso.name, 'New meso plan');
    assert.equal(app.state().hist.X, undefined);
  });

  test('Activate asks first, then archives the old meso with every set', async () => {
    let answer = false;
    const app = await bootApp({ now: NOW, confirm: () => answer });
    await app.call('await makeDraft(); await activateDraft();');
    assert.equal(app.state().meso.name, 'New meso plan');
    assert.ok(app.state().draft);

    const oldMeso = app.state().meso;
    answer = true;
    await app.call('await activateDraft();');
    const st = app.state();
    assert.equal(st.archive.length, 1);
    assert.deepEqual(st.archive[0].log, oldMeso.log);
    assert.equal(st.archive[0].archivedAt, '2026-09-25');
    assert.equal(st.meso.curWeek, 1);
    assert.equal(st.draft, null);
  });

  test('Discard draft asks first', async () => {
    let answer = false;
    const app = await bootApp({ now: NOW, confirm: () => answer });
    await app.call('await makeDraft(); await discardDraft();');
    assert.ok(app.state().draft);
    answer = true;
    await app.call('await discardDraft();');
    assert.equal(app.state().draft, null);
  });

  test('backup file round-trips into a fresh install', async () => {
    const src = await bootApp({ now: NOW });
    await src.call('ST.meso.name="backed up"; ST.hist.Y={w:50,date:"2026-09-02"};');
    const json = src.run('backupJSON()');
    const dst = await bootApp({ now: NOW, confirm: () => true });
    await dst.call(`await importText(${JSON.stringify(json)});`);
    assert.deepEqual(dst.state(), src.state());
  });

  test('import rejects junk and newer versions without touching data', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true });
    const before = app.state();
    for (const text of ['not json', '{"hello":1}', JSON.stringify({ ...before, v: 99 })]) {
      await app.call(`await importText(${JSON.stringify(text)});`);
      assert.deepEqual(app.state(), before);
    }
  });

  test('import accepts an old unversioned clipboard export and migrates it', async () => {
    const legacy = (await bootApp({ now: NOW })).state();
    delete legacy.v; delete legacy.archive; delete legacy.meso.fb;
    legacy.meso.name = 'old export';
    const app = await bootApp({ now: NOW, confirm: () => true });
    await app.call(`await importText(${JSON.stringify(JSON.stringify(legacy))});`);
    const st = app.state();
    assert.equal(st.meso.name, 'old export');
    assert.equal(st.v, app.run('SCHEMA_VERSION'));
    assert.deepEqual(st.archive, []);
  });

  test('restoring a backup clears a load error and keeps the unreadable data', async () => {
    const backup = (await bootApp({ now: NOW })).run('backupJSON()');
    const ls = fakeLocalStorage();
    ls.data.set('ironengine:state2', '{broken');
    const app = await bootApp({ now: NOW, localStorage: ls, confirm: () => true });
    await app.call(`await importText(${JSON.stringify(backup)});`);
    assert.equal(JSON.parse(ls.data.get('ironengine:state2')).meso.name, 'New meso plan');
    assert.ok([...ls.data.values()].includes('{broken'));
    assert.equal(app.run('loadError'), null);
  });
});

describe('log button never destroys entered reps (S3)', () => {
  const set0 = app => app.state().meso.log.w2d3[3][0];   // close-grip bench, set 1 (target 11)

  test('tapping a logged set un-logs it and keeps the reps; tapping again re-logs', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await upd(3,0,"reps","12"); await tapLog(3,0);');
    assert.equal(set0(app).st, 'logged');
    await app.call('await tapLog(3,0);');
    assert.deepEqual([set0(app).st, set0(app).reps], [null, 12]);
    await app.call('await tapLog(3,0);');
    assert.deepEqual([set0(app).st, set0(app).reps], ['logged', 12]);
  });

  test('one tap on an untouched set logs its target reps', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await tapLog(3,0);');
    assert.deepEqual([set0(app).st, set0(app).reps], ['logged', 11]);
  });

  test('a set with no reps and no target needs a second tap to skip', async () => {
    const app = await bootApp({ now: NOW });
    const s = () => app.state().meso.log.w2d3[3][2];     // the new set: RIR target only
    await app.call('await tapLog(3,2);');
    assert.equal(s().st, null);
    await app.call('await tapLog(3,2);');
    assert.equal(s().st, 'skipped');
    await app.call('await tapLog(3,2);');
    assert.equal(s().st, null);
  });

  test('"Skip rest" skips only the sets not yet logged', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await tapLog(3,0); await skipRest(3);');
    assert.deepEqual(app.state().meso.log.w2d3[3].map(s => s.st), ['logged', 'skipped', 'skipped']);
    assert.doesNotMatch(app.els.get('main').innerHTML, /skipRest\(3\)/);
  });
});

describe('cross-meso history = last top set, real dates (S1)', () => {
  const activate = app => app.call('await makeDraft(); await activateDraft();');

  test('logging stamps the session with the local date, once', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await pickWeek(3); await upd(0,0,"reps","9"); await tapLog(0,0);');
    assert.equal(app.state().meso.dates.w3d3, '2026-09-25');
    await app.call('ST.meso.dates.w3d3="2026-09-20"; await tapLog(0,1);');
    assert.equal(app.state().meso.dates.w3d3, '2026-09-20');
  });

  test('a lighter recent top set replaces a heavier old one, dated when trained', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true });
    assert.deepEqual(app.state().hist.Deadlift, { w: 300, date: '2026-07-04' });
    await app.call(`await pickWeek(3);
      for (const j of [0,1]) { await upd(6,j,"w","275"); await upd(6,j,"reps","5"); await tapLog(6,j); }`);
    await activate(app);
    assert.deepEqual(app.state().hist.Deadlift, { w: 275, date: '2026-09-25' });
    assert.match(app.run('startingSets("Deadlift",ST.hist,3,2).why'), /Seeded.*275/);   // not "11 wks ago"
  });

  test('the later session wins even when an earlier one was heavier', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true });
    // close-grip bench: Wed w2 logged 120x12,11; Fri w2 logged here at 115
    await app.call(`for (const j of [0,1]) { await upd(3,j,"w","115"); await tapLog(3,j); }`);
    await activate(app);
    assert.deepEqual(app.state().hist['Bench Press (Close Grip)'], { w: 115, date: '2026-07-19' });
  });

  test('undated sessions borrow the meso\'s latest known date, else null', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true });
    await app.call('ST.meso.dates={w1d3:"2026-07-09"};');
    await activate(app);
    assert.equal(app.state().hist['EZ Bar Curl (Normal Grip)'].date, '2026-07-09');   // from undated w2d3

    const bare = await bootApp({ now: NOW, confirm: () => true });
    await bare.call('ST.meso.dates={};');
    await activate(bare);
    assert.equal(bare.state().hist['EZ Bar Curl (Normal Grip)'].date, null);
  });
});
