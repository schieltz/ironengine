#!/usr/bin/env node
'use strict';
/*
 * Builds tests/fixtures/rp-calibration.json from an RP Hypertrophy data export.
 *   node tools/rp-calibration.js ~/Downloads/rp-training-data.json
 *
 * Each case is one exercise going from one week to the next inside an RP meso:
 * what was done (in IRON ENGINE's set shape) and what RP prescribed next.
 * Anonymized on purpose: no ids, dates, bodyweight, meso names or notes.
 *
 * Weighted bodyweight exercises (dips, pull-ups): RP stores total load (bodyweight + added),
 * so these cases keep totals and the calibration test runs the engine with bodyweight 0.
 * Plain bodyweight exercises: RP stores bodyweight as the load; those weights are blanked
 * (IRON ENGINE records no weight for them), so no case reveals bodyweight.
 */
const fs = require('node:fs');
const path = require('node:path');

const MG = { 1: 'CHEST', 2: 'BACK', 3: 'TRICEPS', 4: 'BICEPS', 5: 'SHOULDERS', 6: 'QUADS', 7: 'GLUTES', 8: 'HAMSTRINGS', 9: 'CALVES' };
const src = process.argv[2];
if (!src) { console.error('usage: node tools/rp-calibration.js <rp-export.json>'); process.exit(1); }
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'rp-calibration.json');

/* equipment per exercise name, from IRON ENGINE's own catalog */
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const catalog = html.slice(html.indexOf('const CATALOG=['), html.indexOf('].map(([name,mg,equip,last])'));
const EQUIP = {};
for (const m of catalog.matchAll(/\[("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),'([A-Z]+)','([^']+)'/g)) {
  EQUIP[m[1].slice(1, -1).replace(/\\'/g, "'")] = m[3];
}

const byPos = (a, b) => a.position - b.position;
const fbOf = g => (g && g.status !== 'unprogrammed' && g.pump != null)
  ? [g.soreness < 0 ? null : g.soreness, g.pump, g.workload] : null;
const prevSet = s => s.status === 'complete' && s.reps != null
  ? [s.weight, s.reps, 'logged']
  : [s.weightTarget, null, s.status === 'skipped' ? 'skipped' : null];

const cases = [];
const mesos = JSON.parse(fs.readFileSync(src, 'utf8')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
for (const m of mesos) {
  const W = m.weeks.map(w => w.days.slice().sort(byPos));
  const last = W.length - 1;
  for (let wi = 0; wi < last; wi++) {
    W[wi].forEach((d0, di) => {
      const d1 = W[wi + 1][di];
      if (!d1) return;
      const ex1 = d1.exercises.slice().sort(byPos);
      for (const e0 of d0.exercises.slice().sort(byPos)) {
        const e1 = ex1.find(e => e.exerciseId === e0.exerciseId);
        if (!e1 || !e0.sets.length || !e1.sets.length) continue;
        const mg = MG[e0.muscleGroupId];
        const eq = EQUIP[e0.name] || null, bw = eq === 'Bodyweight Only' || /nordic/i.test(e0.name);
        const blank = pair => bw ? [null, pair[1], ...pair.slice(2)] : pair;
        cases.push({
          ex: e0.name,
          eq: eq || (bw ? 'Bodyweight Only' : null),
          mg: mg || null,
          wk: wi + 2,                                   // the week being prescribed (1-based)
          day: di + 1, days: W[wi].length,
          dl: wi + 1 === last,                          // prescribing the deload week
          first: ex1.find(e => e.muscleGroupId === e1.muscleGroupId) === e1,
          fb: fbOf(d0.muscleGroups.find(g => g.muscleGroupId === e0.muscleGroupId)),
          prev: e0.sets.slice().sort(byPos).map(prevSet).map(blank),
          rp: e1.sets.slice().sort(byPos).map(s => blank([s.weightTarget, s.repsTarget])),
        });
      }
    });
  }
}
fs.writeFileSync(out, JSON.stringify({
  about: 'RP Hypertrophy prescriptions for calibration: week N as done -> RP targets for week N+1. '
    + 'prev: [weight, reps, status]; rp: [weightTarget, repsTarget]; fb: [soreness, pump, workload] '
    + 'from the session before (same scales as IRON ENGINE). Weighted bodyweight exercises use total load.',
  mesos: mesos.length, cases,
}) + '\n');
console.log(`wrote ${cases.length} cases from ${mesos.length} mesos to ${path.relative(process.cwd(), out)}`);
