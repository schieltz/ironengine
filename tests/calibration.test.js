'use strict';
/*
 * Calibration against RP Hypertrophy: 700+ real cases from the owner's RP export
 * (tools/rp-calibration.js). Each case replays one exercise's week through the engine and
 * compares the result with what RP actually prescribed next. The floors below are the
 * agreement the current rules reach; a rule change must not drop below them (raise them
 * when a change improves agreement).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine } = require('./harness');

const FIXTURE = path.join(__dirname, 'fixtures', 'rp-calibration.json');
const E = loadEngine({ now: Date.parse('2026-09-27T12:00:00Z') });

const FLOORS = {
  weight: 0.75,        // share of RP-targeted sets where the engine's weight matches RP's
  weightAndReps: 0.63, // ... where weight and rep target both match
  setCount: 0.19,      // share of exercises where next week's set count matches RP's
  deloadWeight: 0.00,  // deload: first set's weight matches RP's
  deloadSets: 0.15,    // deload: set count matches RP's
};

function run(cases) {
  const m = { sets: 0, weight: 0, both: 0, ex: 0, count: 0, dl: 0, dlWeight: 0, dlSets: 0 };
  for (const c of cases) {
    const prev = c.prev.map(([w, reps, st]) => ({ w, reps, st }));
    const logged = prev.filter(s => s.st === 'logged');
    if (!logged.length) continue;
    const fb = c.fb && { soreness: c.fb[0], pump: c.fb[1], workload: c.fb[2] };
    const ex = { name: c.ex, equip: c.eq };
    const out = E.prescribe(ex, prev, c.wk, fb, { day: c.day, days: c.days, allowAdd: c.first, bodyweight: 0 }).sets;
    if (c.dl) {
      m.dl++;
      if (out[0] && c.rp[0][0] != null && out[0].w === c.rp[0][0]) m.dlWeight++;
      if (out.length === c.rp.length) m.dlSets++;
      continue;
    }
    m.ex++;
    if (out.length === c.rp.length) m.count++;
    c.rp.forEach(([w, tgt], i) => {
      if (tgt == null || i >= logged.length || (w == null && c.eq !== 'Bodyweight Only')) return;
      m.sets++;
      const o = out[i];
      if (o && o.w === w) { m.weight++; if (o.tgt === tgt) m.both++; }
    });
  }
  return {
    n: m, weight: m.weight / m.sets, weightAndReps: m.both / m.sets, setCount: m.count / m.ex,
    deloadWeight: m.dlWeight / m.dl, deloadSets: m.dlSets / m.dl,
  };
}

test('agreement with RP prescriptions stays at or above the calibrated floors', t => {
  if (!fs.existsSync(FIXTURE)) { t.skip('no tests/fixtures/rp-calibration.json'); return; }
  const { cases } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const r = run(cases);
  const pct = x => (100 * x).toFixed(1) + '%';
  t.diagnostic(`RP agreement over ${r.n.sets} targeted sets / ${r.n.ex} exercises / ${r.n.dl} deloads: `
    + `weight ${pct(r.weight)}, weight+reps ${pct(r.weightAndReps)}, set count ${pct(r.setCount)}, `
    + `deload weight ${pct(r.deloadWeight)}, deload sets ${pct(r.deloadSets)}`);
  for (const [k, floor] of Object.entries(FLOORS)) {
    assert.ok(r[k] >= floor, `${k} ${pct(r[k])} fell below its floor ${pct(floor)}`);
  }
});
