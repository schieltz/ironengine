'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, fakeLocalStorage } = require('./harness');
const V4_FIXTURE = require('./fixtures/state-v4.json');   // real saved state from schema v4
const v4State = () => structuredClone(V4_FIXTURE);
/* v1-shaped save: the v4 fixture minus everything later versions added */
const v1State = () => {
  const s = v4State();
  delete s.v; delete s.archive; delete s.meso.fb; delete s.meso.dates;
  return s;
};

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
    const w2d3 = st.meso.log.w2d3.map(e => e.sets);

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
    for (const i of [3, 4, 5, 6, 7]) assert.ok(st.meso.log.w2d3[i].why.length > 10);
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
    const legacy = v1State();
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
  app.call(`ST.meso.log.${k}[${i}].sets.forEach((s,j)=>{ s.reps=${JSON.stringify(reps)}[j]; s.st='logged'; }); await save();`);

describe('provisional prescriptions (looking ahead never freezes numbers)', () => {
  test('week 3 viewed early still updates once week 2 is logged', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await pickWeek(3);');
    assert.deepEqual(app.state().meso.log.w3d3[3].sets, [rirOnly(120, 2), rirOnly(120, 2), rirOnly(120, 2)]);
    assert.match(app.state().meso.log.w3d3[3].why, /Preview/);

    await app.call('await pickWeek(2);');
    await logReps(app, 'w2d3', 3, [11, 10, 9]);
    await app.call('await pickWeek(3);');
    const st = app.state();
    assert.deepEqual(st.meso.log.w3d3[3].sets, [target(120, 12), target(120, 11), target(120, 10), rirOnly(120, 2)]);
    assert.match(st.meso.log.w3d3[3].why, /R1/);
  });

  test('tapping the deload week from week 2 never produces 0 lb sets', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await pickWeek(6);');
    const w6 = app.state().meso.log.w6d3.flatMap(e => e.sets);
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
    assert.equal(st.meso.log.w3d3[3].sets[0].w, 125);
    assert.deepEqual(st.meso.log.w3d3[5].sets.slice(0, 2), [target(120, 9), target(120, 9)]);
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
    assert.deepEqual(app.state().meso.log.w3d2[2].sets, [target(120, 12), target(120, 11)]);

    await logReps(app, 'w3d2', 2, [12, 11]);
    await app.call('await pickWeek(4);');
    assert.deepEqual(app.state().meso.log.w4d2[2].sets, [target(120, 13), target(120, 12), rirOnly(120, 1)]);
  });

  test('feedback given after peeking at next week still takes effect', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('selDay=2; await pickWeek(3); await pickWeek(2);');
    await giveFeedback(app, 2, { ...NEUTRAL, workload: 3 });        // "too much" -> hold sets
    await app.call('await pickWeek(3);');
    assert.equal(app.state().meso.log.w3d2[2].sets.length, 2);
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
    const legacy = v1State();
    const pain = { ...NEUTRAL, pain: 3 };
    legacy.meso.days[1][2].feedback = pain;                          // bench Wed: latest logged in week 3
    legacy.meso.days[0][0].feedback = NEUTRAL;                       // Mon ex 0: logged in week 2
    legacy.meso.log.w3d1 = legacy.meso.log.w2d1.map(sets => sets.map(s => ({ ...s, st: null })));
    ls.data.set('ironengine:state2', JSON.stringify(legacy));

    const app = await bootApp({ now: NOW, localStorage: ls });
    const st = app.state();
    assert.equal(st.v, app.run('SCHEMA_VERSION'));
    assert.deepEqual(st.meso.log.w3d2[2].fb, pain);
    assert.deepEqual(st.meso.log.w2d1[0].fb, NEUTRAL);               // week 3 Mon untouched, so week 2
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
    const legacy = v1State();
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
  const set0 = app => app.state().meso.log.w2d3[3].sets[0];   // close-grip bench, set 1 (target 11)

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
    const s = () => app.state().meso.log.w2d3[3].sets[2];     // the new set: RIR target only
    await app.call('await tapLog(3,2);');
    assert.equal(s().st, null);
    await app.call('await tapLog(3,2);');
    assert.equal(s().st, 'skipped');
    await app.call('await tapLog(3,2);');
    assert.equal(s().st, null);
  });

  test('"Skip remaining sets" (exercise menu) skips only the sets not yet logged', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await tapLog(3,0); openExMenu(3);');
    assert.match(app.els.get('modalRoot').innerHTML, /Skip remaining sets/);
    await app.call('await skipRest(3); openExMenu(3);');
    assert.deepEqual(app.state().meso.log.w2d3[3].sets.map(s => s.st), ['logged', 'skipped', 'skipped']);
    assert.doesNotMatch(app.els.get('modalRoot').innerHTML, /Skip remaining sets/);
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

describe('app opens where you left off (S2)', () => {
  test('mid-session: reopens on that session', async () => {
    const app = await bootApp({ now: NOW });
    assert.deepEqual([app.run('selWeek'), app.run('selDay')], [2, 3]);
  });

  test('finished session: reopens on the next one', async () => {
    const ls = fakeLocalStorage();
    const a = await bootApp({ now: NOW, localStorage: ls });
    await a.call('for (let i=0;i<8;i++) await skipRest(i);');
    const b = await bootApp({ now: NOW, localStorage: ls });
    assert.deepEqual([b.run('selWeek'), b.run('selDay')], [3, 1]);
  });

  test('browsing ahead does not move the resume point', async () => {
    const ls = fakeLocalStorage();
    const a = await bootApp({ now: NOW, localStorage: ls });
    await a.call('await pickWeek(5); await pickDay(1);');
    const b = await bootApp({ now: NOW, localStorage: ls });
    assert.deepEqual([b.run('selWeek'), b.run('selDay')], [2, 3]);
  });

  test('new meso opens on week 1 day 1', async () => {
    const ls = fakeLocalStorage();
    const a = await bootApp({ now: NOW, localStorage: ls, confirm: () => true });
    await a.call('await makeDraft(); await activateDraft();');
    const b = await bootApp({ now: NOW, localStorage: ls });
    assert.deepEqual([b.run('selWeek'), b.run('selDay')], [1, 1]);
  });
});

describe('schema v5: sessions are lists of entries with permanent slot ids', () => {
  const bootFromV4 = async () => {
    const ls = fakeLocalStorage();
    ls.data.set('ironengine:state2', JSON.stringify(v4State()));
    return bootApp({ now: NOW, localStorage: ls });
  };

  test('v4 save upgrades: entries carry slot, name, sets, feedback, why', async () => {
    const old = v4State();
    const st = (await bootFromV4()).state();
    const ids = st.meso.days.flat().map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, 'slot ids unique');
    assert.equal(st.meso.seq, ids.length);

    const e = st.meso.log.w2d2[2];
    assert.equal(e.slot, st.meso.days[1][2].id);
    assert.equal(e.name, 'Bench Press (Close Grip)');
    assert.deepEqual(e.sets, old.meso.log.w2d2[2]);
    assert.deepEqual(e.fb, old.meso.fb.w2d2[2]);
    assert.equal(st.meso.log.w2d3[3].why, old.meso.days[2][3]._why.w2d3);

    assert.equal(st.meso.fb, undefined);
    assert.ok(st.meso.days.flat().every(s => !('_why' in s)));
  });

  test('upgraded data prescribes exactly what v4 did', async () => {
    const old = v4State();
    const st = (await bootFromV4()).state();
    for (const k of Object.keys(old.meso.log)) {
      assert.deepEqual(st.meso.log[k].map(e => e.sets), old.meso.log[k], k);
    }
  });
});

describe('swap an exercise mid-meso (Phase 2)', () => {
  const ROW = 5;                                   // w2d3 slot 5: Barbell Bent Over Row (R6: 120 x2)
  const PD = 'Pulldown (Normal Grip)';
  const logAt = (app, ei, pairs) => app.call(pairs.map(([w, r], j) =>
    `await upd(${ei},${j},"w","${w}"); await upd(${ei},${j},"reps","${r}"); await tapLog(${ei},${j});`).join(''));

  test('"just today": only this session changes, seeded fresh, and says so', async () => {
    const app = await bootApp({ now: NOW });
    await app.call(`await swapEntry(${ROW},"${PD}","today");`);
    const st = app.state(), e = st.meso.log.w2d3[ROW];
    assert.equal(e.name, PD);
    assert.deepEqual(e.sets, [rirOnly(null, 2), rirOnly(null, 2)]);   // last week's set count
    assert.match(e.why, /New in this slot.*No history/);
    assert.equal(st.meso.days[2][ROW].name, 'Barbell Bent Over Row');
    assert.match(app.els.get('main').innerHTML, /swapped in today for Barbell Bent Over Row/);
  });

  test('"just today" on a session not started yet survives revisits', async () => {
    const app = await bootApp({ now: NOW });
    await app.call(`await pickWeek(3); await swapEntry(${ROW},"${PD}","today"); await pickWeek(2); await pickWeek(3);`);
    const st = app.state();
    assert.equal(st.meso.log.w3d3[ROW].name, PD);
    assert.equal(st.meso.days[2][ROW].name, 'Barbell Bent Over Row');
  });

  test('the week after a one-off swap goes back to the original (missed week, R6)', async () => {
    const app = await bootApp({ now: NOW });
    await app.call(`await swapEntry(${ROW},"${PD}","today");`);
    await logAt(app, ROW, [[100, 10], [100, 9]]);
    await app.call('await pickWeek(3);');
    const e = app.state().meso.log.w3d3[ROW];
    assert.equal(e.name, 'Barbell Bent Over Row');
    assert.deepEqual(e.sets, [rirOnly(120, 2), rirOnly(120, 2)]);
    assert.match(e.why, /different exercise.*R6/);
  });

  test('"rest of meso": plan changes and the new exercise progresses normally next week', async () => {
    const app = await bootApp({ now: NOW });
    await app.call(`await swapEntry(${ROW},"${PD}","meso");`);
    assert.equal(app.state().meso.days[2][ROW].name, PD);
    await logAt(app, ROW, [[100, 10], [100, 9]]);
    await app.call('await pickWeek(3);');
    const e = app.state().meso.log.w3d3[ROW];
    assert.equal(e.name, PD);
    assert.deepEqual(e.sets, [target(100, 11), target(100, 10), rirOnly(100, 2)]);
  });

  test('a swapped-in exercise seeds from earlier sessions of this meso', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('ST.meso.dates.w2d2="2026-09-23";');                 // recent, so not stale
    await app.call(`await swapEntry(${ROW},"Chest Supported Row","today");`);   // Wed w2: 65x11,8
    const e = app.state().meso.log.w2d3[ROW];
    assert.deepEqual(e.sets.map(s => s.w), [65, 65]);
    assert.match(e.why, /last top set: <b>65<\/b>/);
  });

  test('sets already logged today are never replaced', async () => {
    const app = await bootApp({ now: NOW });
    const before = app.state().meso.log.w2d3[0];                        // DB lateral raise, logged
    await app.call('await swapEntry(0,"Cable Lateral Raise (Single-Arm)","today");');
    assert.deepEqual(app.state().meso.log.w2d3[0], before);
    await app.call('await swapEntry(0,"Cable Lateral Raise (Single-Arm)","meso");');
    assert.deepEqual(app.state().meso.log.w2d3[0], before);
    await app.call('await pickWeek(3);');
    const e = app.state().meso.log.w3d3[0];
    assert.equal(e.name, 'Cable Lateral Raise (Single-Arm)');
    assert.equal(e.sets.length, 3);
  });

  test('swapping back to the original restores normal prescriptions', async () => {
    const app = await bootApp({ now: NOW });
    const original = app.state().meso.log.w2d3[ROW].sets;
    await app.call(`await swapEntry(${ROW},"${PD}","today"); await swapEntry(${ROW},"Barbell Bent Over Row","today");`);
    const e = app.state().meso.log.w2d3[ROW];
    assert.deepEqual(e.sets, original);
    assert.equal(e.u, undefined);
  });

  test('picker offers same-muscle exercises, never the current one', async () => {
    const app = await bootApp({ now: NOW });
    await app.call(`openExMenu(${ROW}); openEntrySwap(${ROW});`);
    const list = app.els.get('swapList').innerHTML;
    assert.match(list, /Pulldown \(Normal Grip\)/);
    assert.doesNotMatch(list, /doSwap\('Barbell Bent Over Row'\)/);
    assert.doesNotMatch(list, /Machine Chest Press/);
  });

  test('typing in search updates only the list, so the keyboard stays open', async () => {
    const app = await bootApp({ now: NOW });
    await app.call(`openEntrySwap(${ROW});`);
    const sheet = app.els.get('modalRoot').innerHTML;
    await app.call('swapCtx.q="pulldown"; renderSwapList();');
    assert.equal(app.els.get('modalRoot').innerHTML, sheet);
    assert.match(app.els.get('swapList').innerHTML, /Pulldown/);
    assert.doesNotMatch(app.els.get('swapList').innerHTML, /Pullup/);
  });
});

describe('your own exercises and notes (Phase 3)', () => {
  const create = (app, f) => app.call(`openNewEx(null); Object.assign(newEx, ${JSON.stringify(f)}); await saveNewEx();`);
  const MACHINE_ROW = { name: 'Rogue Row Machine', mg: 'BACK', equip: 'Machine' };

  test('create an exercise: it joins the library, marked as yours, gym-only by equipment', async () => {
    const app = await bootApp({ now: NOW });
    await create(app, MACHINE_ROW);
    const c = app.state().custom[0];
    assert.deepEqual(c, { ...MACHINE_ROW, home: false, last: null, custom: true });
    await app.call("setView('library'); libHome=false; renderLibrary();");
    assert.match(app.els.get('libList').innerHTML, /Rogue Row Machine<span class="badge-mine">MINE/);
  });

  test('home answer overrides the equipment default', async () => {
    const app = await bootApp({ now: NOW });
    await create(app, { ...MACHINE_ROW, home: true });
    assert.equal(app.state().custom[0].home, true);
  });

  for (const [label, f, err] of [
    ['a duplicate of a built-in (any case)', { name: 'pulldown (normal grip)', mg: 'BACK', equip: 'Cable' }, /already in the library/],
    ['unsafe characters', { name: 'Row <b>', mg: 'BACK', equip: 'Cable' }, /can't contain/],
    ['no muscle group', { name: 'Thing', equip: 'Cable' }, /muscle group/],
  ]) {
    test(`rejects ${label}`, async () => {
      const app = await bootApp({ now: NOW });
      await create(app, f);
      assert.deepEqual(app.state().custom, []);
      assert.match(app.run('newEx.err'), err);
    });
  }

  test('created from the swap picker, it carries straight on to the swap', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('openEntrySwap(5); openNewEx(swapCtx);');
    assert.equal(app.run('newEx.mg'), 'BACK');                        // picker's muscle group carried over
    await app.call(`Object.assign(newEx, ${JSON.stringify(MACHINE_ROW)}); await saveNewEx();`);
    assert.match(app.els.get('modalRoot').innerHTML, /Barbell Bent Over Row → <b>Rogue Row Machine/);
    await app.call('await swapEntry(5,"Rogue Row Machine","today");');
    assert.equal(app.state().meso.log.w2d3[5].name, 'Rogue Row Machine');
    assert.match(app.els.get('main').innerHTML, /Machine<span class="badge-gym">GYM<\/span>\s+· swapped in today/);
  });

  test('delete: allowed when unused, blocked while in the current meso', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true });
    await create(app, MACHINE_ROW);
    await create(app, { ...MACHINE_ROW, name: 'Spare Row' });
    await app.call('await swapEntry(5,"Rogue Row Machine","meso");');
    await app.call('await deleteCustom("Rogue Row Machine"); await deleteCustom("Spare Row");');
    assert.deepEqual(app.state().custom.map(c => c.name), ['Rogue Row Machine']);
  });

  test('notes: set on the plan slot, shown every week, rendered as text', async () => {
    let answer = 'Pause 1s <b>at top</b>';
    const app = await bootApp({ now: NOW, prompt: () => answer });
    await app.call('await editNote(3);');
    assert.equal(app.state().meso.days[2][3].note, 'Pause 1s <b>at top</b>');
    assert.match(app.els.get('main').innerHTML, /📌 Pause 1s &lt;b&gt;at top&lt;\/b&gt;/);
    await app.call('await pickWeek(3);');
    assert.match(app.els.get('main').innerHTML, /📌 Pause 1s/);
    answer = '';
    await app.call('await editNote(3);');
    assert.equal(app.state().meso.days[2][3].note, null);
  });

  test('v5 saves upgrade with an empty custom library', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('ironengine:state2', JSON.stringify(v4State()));
    const app = await bootApp({ now: NOW, localStorage: ls });
    assert.deepEqual(app.state().custom, []);
  });
});

describe('change a day\'s exercises (Phase 5)', () => {
  const names = (st, k) => st.meso.log[k].map(e => e.name);
  const planNames = (st, d) => st.meso.days[d - 1].map(s => s.name);

  test('move: today, the plan, and later sessions follow; past sessions keep their order', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await moveEntry(4,-1);');                           // incline above close-grip bench
    let st = app.state();
    assert.deepEqual(names(st, 'w2d3').slice(3, 5), ['Dumbbell Press (High Incline)', 'Bench Press (Close Grip)']);
    assert.deepEqual(planNames(st, 3).slice(3, 5), ['Dumbbell Press (High Incline)', 'Bench Press (Close Grip)']);
    assert.deepEqual(names(st, 'w1d3').slice(3, 5), ['Bench Press (Close Grip)', 'Dumbbell Press (High Incline)']);
    await logReps(app, 'w2d3', 4, [11, 10, 9]);                        // bench, now 5th
    await app.call('await pickWeek(3);');
    st = app.state();
    assert.deepEqual(names(st, 'w3d3').slice(3, 5), ['Dumbbell Press (High Incline)', 'Bench Press (Close Grip)']);
    assert.deepEqual(st.meso.log.w3d3[4].sets, [target(120, 12), target(120, 11), target(120, 10), rirOnly(120, 2)]);
  });

  test('remove from plan: gone from today and later weeks, kept in history', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true });
    await app.call('await removeEntry(7);');                            // Zercher, untouched today
    await app.call('await pickWeek(3);');
    const st = app.state();
    for (const k of ['w2d3', 'w3d3']) assert.ok(!names(st, k).includes('Zercher Squat'), k);
    assert.ok(!planNames(st, 3).includes('Zercher Squat'));
    assert.ok(names(st, 'w1d3').includes('Zercher Squat'));
  });

  test('remove keeps sets already logged today', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true });
    await app.call('await removeEntry(0);');                            // DB lateral raise, logged
    await app.call('await pickWeek(3);');
    const st = app.state();
    assert.equal(names(st, 'w2d3')[0], 'Dumbbell Lateral Raise');
    assert.ok(!names(st, 'w3d3').includes('Dumbbell Lateral Raise'));
  });

  test('declining the remove confirmation changes nothing', async () => {
    const app = await bootApp({ now: NOW, confirm: () => false });
    const before = app.state();
    await app.call('await removeEntry(7);');
    assert.deepEqual(app.state(), before);
  });

  test('add "just today": this session only, seeded, gone next week', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await addEntry("Hammer Curl","today");');
    let st = app.state();
    const e = st.meso.log.w2d3.find(x => x.name === 'Hammer Curl');
    assert.equal(e.u, 1);
    assert.ok(e.sets.length === 2 && e.sets.every(s => s.w === 20), JSON.stringify(e.sets)); // Wed w2: 20x8,7,7
    assert.ok(!planNames(st, 3).includes('Hammer Curl'));
    await app.call('await pickWeek(3);');
    assert.ok(!names(app.state(), 'w3d3').includes('Hammer Curl'));
  });

  test('add to the plan: in later weeks and progressing from today', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await addEntry("Hammer Curl","meso");');
    const i = app.state().meso.log.w2d3.findIndex(x => x.name === 'Hammer Curl');
    await app.call(`for (const j of [0,1]) { await upd(${i},j,"w","25"); await upd(${i},j,"reps","12"); await tapLog(${i},j); }`);
    await app.call('await pickWeek(3);');
    const st = app.state(), e = st.meso.log.w3d3.find(x => x.name === 'Hammer Curl');
    assert.deepEqual(e.sets, [target(25, 13), target(25, 13), rirOnly(25, 2)]);
    assert.ok(planNames(st, 3).includes('Hammer Curl'));
  });

  test('"+ Add exercise" opens the picker across all muscles', async () => {
    const app = await bootApp({ now: NOW });
    assert.match(app.els.get('main').innerHTML, /openAdd\(\)/);
    await app.call('openAdd();');
    assert.match(app.els.get('modalRoot').innerHTML, /<h2>Add exercise<\/h2>/);
    assert.match(app.els.get('swapList').innerHTML, /Stair Calves/);
    assert.match(app.els.get('swapList').innerHTML, /Pulldown/);
  });

  test('Builder: add, move, remove, priority and notes carry into the new meso', async () => {
    const app = await bootApp({ now: NOW, confirm: () => true, prompt: () => 'Slow eccentric' });
    await app.call(`await makeDraft(); bdDay=1;
      await draftRemove(5);                  // drop Romanian Deadlift
      await draftMove(0,1);                  // pushdown first
      await togglePri(0);                    // pushdown -> maintenance
      await editDraftNote(1);
      await draftAdd("Hammer Curl");
      await activateDraft();`);
    const st = app.state(), mon = st.meso.days[0];
    assert.deepEqual(mon.map(s => s.name), ['Cable Triceps Pushdown (Bar)', 'Dip (Weighted, Triceps-Focused)',
      'Cable Upright Row', 'Cable Curl', 'Hammer Curl', 'Bench Press (Medium Grip)']);   // curl joins the biceps
    assert.equal(mon[0].pri, 0);
    assert.equal(mon[1].note, 'Slow eccentric');
    assert.equal(new Set(st.meso.days.flat().map(s => s.id)).size, st.meso.days.flat().length);
    assert.equal(st.meso.log.w1d1[0].sets.length, 1);                  // maintenance starts at 1 set
    assert.equal(st.meso.log.w1d1[1].sets.length, 2);
  });
});

describe('rep targets follow weight changes (#4)', () => {
  const s0 = app => app.state().meso.log.w2d3[3].sets[0];      // close-grip bench: 120 x 11 target

  test('raising the weight lowers the target, and the new target is what gets logged', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await upd(3,0,"w","130");');
    assert.deepEqual([s0(app).w, s0(app).tgt, s0(app).reps], [130, 8, null]);
    assert.equal(app.els.get('r-3-0').value, 8);
    assert.match(app.els.get('h-3-0').innerHTML, /130 instead of 120: 8 reps instead of 11, same effort at 2 RIR/);
    await app.call('await tapLog(3,0);');
    assert.deepEqual([s0(app).st, s0(app).reps], ['logged', 8]);
  });

  test('lowering raises it; repeated edits are measured from the programmed numbers', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await upd(3,0,"w","110"); await upd(3,0,"w","115"); await upd(3,0,"w","110");');
    assert.equal(s0(app).tgt, 15);
    await app.call('await upd(3,0,"w","120");');
    assert.equal(s0(app).tgt, 11);
    assert.equal(app.els.get('h-3-0').innerHTML, '');
  });

  test('reps you typed yourself, logged sets, and RIR-only sets are left alone', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await upd(3,0,"reps","12"); await upd(3,0,"w","130");');
    assert.deepEqual([s0(app).reps, s0(app).tgt], [12, 11]);
    await app.call('await tapLog(3,1); await upd(3,1,"w","130");');
    assert.equal(app.state().meso.log.w2d3[3].sets[1].reps, 10);
    await app.call('await upd(3,2,"w","130");');                  // new set: RIR target only
    assert.equal(app.state().meso.log.w2d3[3].sets[2].tgt, null);
  });

  test('next week progresses from what you actually did at the new weight', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('for (const j of [0,1]) { await upd(3,j,"w","130"); await tapLog(3,j); } await skipRest(3); await pickWeek(3);');
    assert.deepEqual(app.state().meso.log.w3d3[3].sets.slice(0, 2), [target(130, 9), target(130, 8)]);
  });
});

describe('remove sets (#2)', () => {
  const bench = app => app.state().meso.log.w2d3[3];

  test('"−" removes the last set, and it stays removed on revisits', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await removeSet(3); await pickWeek(3); await pickWeek(2);');
    assert.deepEqual(bench(app).sets, [target(120, 11), target(120, 10)]);
    assert.equal(bench(app).u, 1);
  });

  test('a logged last set is removed only after confirming', async () => {
    let answer = false;
    const app = await bootApp({ now: NOW, confirm: () => answer });
    await app.call('await removeSet(3); await tapLog(3,1); await removeSet(3);');
    assert.equal(bench(app).sets.length, 2);
    answer = true;
    await app.call('await removeSet(3);');
    assert.equal(bench(app).sets.length, 1);
  });

  test('one set minimum: the button is disabled and nothing is removed', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await removeSet(3); await removeSet(3); await removeSet(3);');
    assert.equal(bench(app).sets.length, 1);
    assert.match(app.els.get('main').innerHTML, /onclick="removeSet\(3\)" aria-label="Remove last set" disabled/);
  });

  test('next week progresses from the sets you kept', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await removeSet(3); await tapLog(3,0); await tapLog(3,1); await pickWeek(3);');
    assert.deepEqual(app.state().meso.log.w3d3[3].sets, [target(120, 12), target(120, 11), rirOnly(120, 2)]);
  });
});

describe('added exercises join their muscle group (#3)', () => {
  const names = (st, k) => st.meso.log[k].map(e => e.name);

  test('a shoulder exercise lands after the last shoulder exercise, today and in the plan', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await addEntry("Arnold Press","meso");');
    const st = app.state();
    assert.deepEqual(names(st, 'w2d3').slice(0, 3), ['Dumbbell Lateral Raise', 'Cable Upright Row', 'Arnold Press']);
    assert.equal(st.meso.days[2][2].name, 'Arnold Press');
    await app.call('await pickWeek(3);');
    assert.equal(names(app.state(), 'w3d3')[2], 'Arnold Press');
  });

  test('"just today" joins the group too', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await addEntry("Pulldown (Parallel Grip)","today");');
    assert.deepEqual(names(app.state(), 'w2d3').slice(5, 8), ['Barbell Bent Over Row', 'Deadlift', 'Pulldown (Parallel Grip)']);
  });

  test('a group the day doesn\'t have goes at the end', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('await addEntry("Dumbbell Shrug","today");');
    assert.equal(names(app.state(), 'w2d3').at(-1), 'Dumbbell Shrug');
  });
});
