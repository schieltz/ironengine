'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readHtml, inlineScripts, appScript, engineSource, loadEngine } = require('./harness');

const NOW = Date.parse('2026-09-25T12:00:00Z');
const E = loadEngine({ now: NOW });
const DAY = 86400000;
const isoDaysAgo = d => new Date(NOW - d * DAY).toISOString().slice(0, 10);

/* input sets, same shape seedState() uses */
const L = (w, reps) => ({ w, reps, st: 'logged' });
const S = w => ({ w, reps: null, st: 'skipped' });
const EX = { name: 'Test Exercise', mg: 'CHEST', equip: 'Barbell', note: null, feedback: null };

/* expected prescription shapes */
const target = (w, tgt) => ({ w, tgt, rir: null, st: null, reps: null });
const rirOnly = (w, rir) => ({ w, tgt: null, rir, st: null, reps: null });

const FB = { soreness: 2, pain: 0, pump: 1, workload: 1 }; // neutral answers
const fb = over => ({ ...FB, ...over });

describe('script integrity', () => {
  test('full inline script parses', () => {
    assert.doesNotThrow(() => new vm.Script(appScript(), { filename: 'index.html' }));
  });

  test('single self-contained file: no external scripts or stylesheets', () => {
    const html = readHtml();
    assert.equal(inlineScripts(html).filter(s => /\bsrc\s*=/.test(s.attrs)).length, 0);
    assert.doesNotMatch(html, /<link[^>]+rel=["']?stylesheet/i);
    assert.doesNotMatch(html, /@import\s/);
  });

  test('engine block is pure: no DOM, storage, or app-state references', () => {
    const code = engineSource().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const ident of ['document', 'window', 'localStorage', 'store', 'ST', 'render', 'save']) {
      assert.doesNotMatch(code, new RegExp(`\\b${ident}\\b`), `engine references ${ident}`);
    }
  });
});

describe('VERIFIED vs RP (ground truth: change only with new RP screenshots)', () => {
  test('close-grip bench 120x10, 120x9 -> 120x11, 120x10, +1 set at 120 @ 2 RIR', () => {
    const p = E.prescribe(EX, [L(120, 10), L(120, 9)], 2, null);
    assert.deepEqual(p.sets, [target(120, 11), target(120, 10), rirOnly(120, 2)]);
  });

  test('DB incline 60x5, 60x4 -> 60x6, then 55 @ 2 RIR (load cut on sub-floor set)', () => {
    const p = E.prescribe(EX, [L(60, 5), L(60, 4)], 2, null);
    assert.deepEqual(p.sets.slice(0, 2), [target(60, 6), rirOnly(55, 2)]);
    assert.match(p.why, /R3/);
  });

  test('DB incline set count matches RP', {
    todo: 'HANDOFF lists 2 sets (60x6, 55@2RIR); engine emits 3 because R2 adds a set after the R3 cut. Needs the RP screenshot to settle.',
  }, () => {
    const p = E.prescribe(EX, [L(60, 5), L(60, 4)], 2, null);
    assert.equal(p.sets.length, 2);
  });

  test('all sets skipped -> same weights re-prescribed, RIR target only', () => {
    const p = E.prescribe(EX, [S(120), S(120)], 2, null);
    assert.deepEqual(p.sets, [rirOnly(120, 2), rirOnly(120, 2)]);
    assert.match(p.why, /R6/);
  });

  test('all sets skipped keeps each set\'s own weight', () => {
    const p = E.prescribe(EX, [S(120), S(175)], 3, null);
    assert.deepEqual(p.sets, [rirOnly(120, 2), rirOnly(175, 2)]);
  });
});

describe('R3 load-cut thresholds (spec: later set <=4 reps or >=3 below set 1)', () => {
  test('2 reps below set 1 and above floor -> no cut', () => {
    const p = E.prescribe(EX, [L(100, 7), L(100, 5)], 2, null);
    assert.deepEqual(p.sets.slice(0, 2), [target(100, 8), target(100, 6)]);
  });

  test('3 reps below set 1 -> cut', () => {
    const p = E.prescribe(EX, [L(100, 8), L(100, 5)], 2, null);
    assert.deepEqual(p.sets[1], rirOnly(90, 2));
  });

  /* 60 -> 55 only proves a 4.2%-12.5% cut. The 8% itself is inferred; pinned here so
     calibration changes it deliberately, not by accident. 200 discriminates 5/8/10%. */
  test('cut coefficient is 8% (inferred, not RP-verified)', () => {
    const p = E.prescribe(EX, [L(200, 10), L(200, 4)], 2, null);
    assert.deepEqual(p.sets[1], rirOnly(185, 2));
  });

  test('set 1 is never cut, even at <=4 reps', () => {
    const p = E.prescribe(EX, [L(100, 4), L(100, 4)], 2, null);
    assert.deepEqual(p.sets[0], target(100, 5));
  });
});

describe('R4 pain gate', () => {
  for (const pain of [2, 3]) {
    test(`pain=${pain} (moderate+) -> reps held, no set added`, () => {
      const p = E.prescribe(EX, [L(100, 10), L(100, 9)], 3, fb({ pain }));
      assert.deepEqual(p.sets, [target(100, 10), target(100, 9)]);
      assert.match(p.why, /R4/);
    });
  }

  test('pain=1 (low) -> normal progression', () => {
    const p = E.prescribe(EX, [L(100, 10), L(100, 9)], 3, fb({ pain: 1 }));
    assert.deepEqual(p.sets, [target(100, 11), target(100, 10), rirOnly(100, 2)]);
  });

  test('pain gate overrides "not enough" workload', () => {
    const p = E.prescribe(EX, [L(100, 10)], 3, fb({ pain: 2, workload: 0 }));
    assert.equal(p.sets.length, 1);
  });
});

describe('R5 workload', () => {
  test('"too much" -> reps +1, set count held', () => {
    const p = E.prescribe(EX, [L(100, 10), L(100, 9)], 3, fb({ workload: 3 }));
    assert.deepEqual(p.sets, [target(100, 11), target(100, 10)]);
    assert.match(p.why, /R5/);
  });

  test('"not enough" -> +2 sets', () => {
    const p = E.prescribe(EX, [L(100, 10), L(100, 9)], 3, fb({ workload: 0 }));
    assert.deepEqual(p.sets.slice(2), [rirOnly(100, 2), rirOnly(100, 2)]);
  });
});

describe('R7 deload (week 6)', () => {
  const cases = [[4, 2], [3, 2], [2, 1], [1, 1]];
  for (const [logged, expected] of cases) {
    test(`${logged} logged sets -> ${expected} set(s) at 8 RIR, same weights`, () => {
      const prev = Array.from({ length: logged }, (_, i) => L(100 + i * 5, 8));
      const p = E.prescribe(EX, prev, 6, null);
      assert.deepEqual(p.sets, prev.slice(0, expected).map(s => rirOnly(s.w, 8)));
      assert.match(p.why, /R7/);
    });
  }

  test('deload ignores feedback gates', () => {
    const p = E.prescribe(EX, [L(100, 8), L(100, 8)], 6, fb({ workload: 0, soreness: 0, pump: 0 }));
    assert.equal(p.sets.length, 1);
  });
});

describe('R8 soreness gate', () => {
  test('still sore -> reps +1, no set added', () => {
    const p = E.prescribe(EX, [L(100, 10), L(100, 9)], 3, fb({ soreness: 3 }));
    assert.deepEqual(p.sets, [target(100, 11), target(100, 10)]);
    assert.match(p.why, /R8/);
  });

  test('still sore overrides "not enough" workload', () => {
    const p = E.prescribe(EX, [L(100, 10)], 3, fb({ soreness: 3, workload: 0 }));
    assert.equal(p.sets.length, 1);
  });

  test('never sore + low pump -> +2 sets', () => {
    const p = E.prescribe(EX, [L(100, 10)], 3, fb({ soreness: 0, pump: 0 }));
    assert.equal(p.sets.length, 3);
  });

  test('never sore + moderate pump -> +1 set', () => {
    const p = E.prescribe(EX, [L(100, 10)], 3, fb({ soreness: 0, pump: 1 }));
    assert.equal(p.sets.length, 2);
  });

  test('healed just on time -> standard +1 set', () => {
    const p = E.prescribe(EX, [L(100, 10)], 3, fb({ soreness: 2 }));
    assert.equal(p.sets.length, 2);
  });
});

describe('cross-meso seeding (startingSets, week 1 @ 3 RIR)', () => {
  test('recent history -> last weight, 2 sets, RIR only', () => {
    const hist = { Bench: { w: 175, date: isoDaysAgo(21) } };
    const p = E.startingSets('Bench', hist, 3, 2);
    assert.deepEqual(p.sets, [rirOnly(175, 3), rirOnly(175, 3)]);
    assert.match(p.why, /Seeded/);
  });

  test('exactly 8 weeks old -> not discounted (rule is >8)', () => {
    const hist = { Bench: { w: 300, date: isoDaysAgo(56) } };
    assert.equal(E.startingSets('Bench', hist, 3, 2).sets[0].w, 300);
  });

  test('>8 weeks stale -> minus 10%, rounded to 5 lb', () => {
    const hist = { A: { w: 300, date: isoDaysAgo(63) }, B: { w: 175, date: isoDaysAgo(120) } };
    const a = E.startingSets('A', hist, 3, 2);
    assert.deepEqual(a.sets.map(s => s.w), [270, 270]);
    assert.match(a.why, /discounted 10%/);
    assert.equal(E.startingSets('B', hist, 3, 2).sets[0].w, 160); // 157.5 -> 160
  });

  test('no history -> null weight, user enters it', () => {
    const p = E.startingSets('Never Done', {}, 3, 2);
    assert.deepEqual(p.sets, [rirOnly(null, 3), rirOnly(null, 3)]);
    assert.match(p.why, /No history/);
  });

  test('maintenance-priority slot -> 1 starting set', () => {
    const hist = { Row: { w: 120, date: isoDaysAgo(7) } };
    const p = E.startingSets('Row', hist, 3, 1);
    assert.equal(p.sets.length, 1);
    assert.match(p.why, /Maintenance/);
  });
});

describe('roundLoad', () => {
  test('rounds to nearest 5 lb', () => {
    assert.equal(E.roundLoad(55.2), 55);
    assert.equal(E.roundLoad(57.5), 60);
    assert.equal(E.roundLoad(92), 90);
  });
});

describe('transparency: every prescription carries a "why"', () => {
  const prevs = [[L(120, 10), L(120, 9)], [L(60, 5), L(60, 4)], [S(120), S(120)], [L(100, 8)]];
  const fbs = [null, fb({}), fb({ pain: 2 }), fb({ soreness: 3 }), fb({ workload: 3 }), fb({ workload: 0 })];
  test('prescribe() across weeks 2-6 x feedback states', () => {
    for (const prev of prevs) for (const f of fbs) for (let wk = 2; wk <= 6; wk++) {
      const p = E.prescribe(EX, prev, wk, f);
      assert.ok(typeof p.why === 'string' && p.why.length > 10, `empty why: wk${wk} ${JSON.stringify(prev)}`);
    }
  });

  test('startingSets() for all history states', () => {
    const hist = { R: { w: 100, date: isoDaysAgo(7) }, O: { w: 100, date: isoDaysAgo(90) } };
    for (const name of ['R', 'O', 'none']) for (const n of [1, 2]) {
      assert.ok(E.startingSets(name, hist, 3, n).why.length > 10);
    }
  });
});
