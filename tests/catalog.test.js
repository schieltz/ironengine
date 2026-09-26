'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');
const REVIEW = require('./fixtures/library-review-2026-09-26.json');

const NOW = Date.parse('2026-09-26T12:00:00Z');

describe('exercise catalog', () => {
  test('integrity: unique names, known muscle groups and equipment, a color per group', async () => {
    const app = await bootApp({ now: NOW });
    const cat = app.run('CATALOG.map(c => ({ ...c }))'), MGS = app.run('[...MGS]'), EQUIP = app.run('[...EQUIP]');
    const names = cat.map(c => c.name);
    assert.equal(new Set(names).size, names.length, 'duplicate names');
    assert.equal(new Set(names.map(n => n.toLowerCase())).size, names.length, 'names differing only by case');
    for (const c of cat) {
      assert.ok(MGS.includes(c.mg), `${c.name}: unknown group ${c.mg}`);
      assert.ok(EQUIP.includes(c.equip), `${c.name}: unknown equipment ${c.equip}`);
      assert.doesNotMatch(c.name, /["<>\\]/, `${c.name}: unsafe characters`);
    }
    const html = require('node:fs').readFileSync(require('./harness').HTML_PATH, 'utf8');
    for (const mg of MGS) assert.match(html, new RegExp(`--mg-${mg}:`), `no color for ${mg}`);
  });

  test('matches the 2026-09-26 review: every kept name in, every removed name out', async () => {
    const app = await bootApp({ now: NOW });
    const names = new Set(app.run('CATALOG.map(c => c.name)'));
    for (const n of [...REVIEW.kept, ...REVIEW.addedFromNotes]) assert.ok(names.has(n), `missing ${n}`);
    for (const n of REVIEW.removed) assert.ok(!names.has(n), `should be removed: ${n}`);
    for (const mg of REVIEW.newGroups) assert.ok(app.run('MGS').includes(mg));
    assert.equal(names.size, 98 + REVIEW.kept.length + REVIEW.addedFromNotes.length);
  });

  test('home tagging: your single-leg machines count as home, other machines do not', async () => {
    const app = await bootApp({ now: NOW });
    const home = n => app.run(`CAT_BY_NAME[${JSON.stringify(n)}].home`);
    assert.equal(home('Leg Extension (Single Leg)'), true);
    assert.equal(home('Seated Leg Curl (Single Leg)'), true);
    assert.equal(home('Hack Squat'), false);
    assert.equal(home('Dumbbell Lu Raise'), true);
  });

  test('a custom exercise that later becomes built-in is listed once', async () => {
    const app = await bootApp({ now: NOW });
    await app.call('ST.custom.push({name:"Hack Squat",mg:"QUADS",equip:"Machine",home:false,last:null,custom:true});');
    assert.equal(app.run('libAll().filter(c => c.name === "Hack Squat").length'), 1);
    assert.equal(app.run('libByName("Hack Squat").custom'), undefined);
  });

  test('new groups show up as filters in the Library and picker', async () => {
    const app = await bootApp({ now: NOW });
    await app.call("setView('library');");
    assert.match(app.els.get('main').innerHTML, /libMg='TRAPS'/);
    assert.match(app.els.get('main').innerHTML, /libMg='ABS'/);
    await app.call("libMg='ABS'; libHome=false; renderLibraryList();");
    assert.match(app.els.get('libList').innerHTML, /Cable Crunch/);
  });
});

describe('search finds exercises the way you type them', () => {
  const cases = [
    ['skull crusher', 'EZ Bar Skullcrusher'],
    ['weighted dips', 'Dip (Weighted, Triceps-Focused)'],
    ['weighted dips', 'Dip (Weighted, Chest-Focused)'],
    ['seated row', 'Seated Cable Row'],
    ['narrow grip bench', 'Bench Press (Close Grip)'],
    ['nordic', 'Nordic Curl'],
    ['rdl', 'Romanian Deadlift'],
    ['db lateral raises', 'Dumbbell Lateral Raise'],
    ['chin up', 'Chinup (Underhand Grip)'],
    ['45 degree', 'Back Raise (45 degree)'],
  ];
  for (const [q, name] of cases) {
    test(`"${q}" finds ${name}`, async () => {
      const app = await bootApp({ now: NOW });
      assert.equal(app.run(`matchesQuery(${JSON.stringify(name)}, ${JSON.stringify(q)})`), true);
    });
  }

  test('every word must match, so results stay narrow', async () => {
    const app = await bootApp({ now: NOW });
    const hits = q => Array.from(app.run(`CATALOG.filter(c => matchesQuery(c.name, ${JSON.stringify(q)})).map(c => c.name)`));
    assert.deepEqual(hits('weighted dips').sort(), ['Dip (Weighted, Chest-Focused)', 'Dip (Weighted, Triceps-Focused)']);
    assert.deepEqual(hits('narrow grip bench'), ['Bench Press (Close Grip)']);
    assert.ok(!hits('seated row').includes('Seated Leg Curl'));
  });
});
