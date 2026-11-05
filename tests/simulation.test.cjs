'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Ref = require('../js/references.js');
const Colour = require('../js/colour.js');
const Report = require('../js/report.js');
const Sim = require('../js/simulation.js');

const refs = Ref.buildReferences(Ref.DEFAULT_ACTIVE, {});
const CALIBRATIONS = {
  'normal': { dark: { c: 90, r: 30, g: 30, b: 25 }, white: { c: 12000, r: 4300, g: 4100, b: 3600 } },
  // What the real board gave with its LED stuck on: no dark reading, Clear maxed out.
  'LED stuck': { dark: { c: 0, r: 0, g: 0, b: 0 }, white: { c: 21504, r: 10756, g: 12450, b: 11333 } }
};

test('there are 10 cases, each with a valid level for every parameter', () => {
  assert.strictEqual(Sim.CASES.length, 10);
  for (const c of Sim.CASES) {
    for (const p of Ref.LIBRARY) {
      assert.ok(Number.isInteger(c[p.id]) && c[p.id] >= 0 && c[p.id] < p.levels.length, `${p.id} = ${c[p.id]}`);
    }
  }
});

test('all 10 cases give different results on the default five pads', () => {
  const seen = Sim.CASES.map(c => Ref.DEFAULT_ACTIVE.map(id => c[id]).join());
  assert.strictEqual(new Set(seen).size, 10);
});

test('"different" never repeats the last case and can reach all the others', () => {
  for (let last = 0; last < 10; last++) {
    const picked = new Set();
    for (let i = 0; i < 500; i++) picked.add(Sim.pickCase('different', last));
    assert.ok(!picked.has(last));
    assert.strictEqual(picked.size, 9);
  }
});

test('"same" repeats the last case, and picks any case when there is no last one', () => {
  for (let last = 0; last < 10; last++) assert.strictEqual(Sim.pickCase('same', last), last);
  const first = Sim.pickCase('same', null);
  assert.ok(first >= 0 && first < 10);
});

test('pads are read in order and wrap around if fewer than 5 are enabled', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(slot => Sim.padFor(1, slot, refs).paramId), Ref.DEFAULT_ACTIVE);
  assert.strictEqual(Sim.padFor(1, 0, refs).key, 'GLU:2');
  const two = Ref.buildReferences(['GLU', 'PRO'], {});
  assert.deepStrictEqual([0, 1, 2].map(slot => Sim.padFor(1, slot, two).paramId), ['GLU', 'PRO', 'GLU']);
});

for (const [name, calibration] of Object.entries(CALIBRATIONS)) {
  test(`every pad of every case always comes out as its own level (${name} calibration)`, () => {
    Sim.CASES.forEach((_, index) => {
      for (let slot = 0; slot < 5; slot++) {
        const pad = Sim.padFor(index, slot, refs);
        for (let run = 0; run < 20; run++) {
          const readings = Sim.scanReadings(pad, calibration, refs);
          assert.strictEqual(readings.length, 5);
          const { mean, wobble } = Colour.average(readings);
          const result = Colour.classify(Colour.normalize(mean, calibration), refs);
          assert.strictEqual(result.best.ref.key, pad.key);
          assert.strictEqual(result.verdict, 'match', `${pad.key} was a close call`);
          assert.ok(wobble < 0.08, 'would trigger the "readings changed" warning');
        }
      }
    });
  });
}

test('the same pad gives different raw numbers each time, like a real sensor', () => {
  const pad = Sim.padFor(0, 0, refs);
  const a = Sim.scanReadings(pad, CALIBRATIONS.normal, refs), b = Sim.scanReadings(pad, CALIBRATIONS.normal, refs);
  assert.notDeepStrictEqual(a, b);
  assert.notDeepStrictEqual(a[0], a[1]);
});

function pdfText(simulated) {
  const calibration = CALIBRATIONS.normal;
  const scans = [0, 1, 2, 3, 4].map(slot => {
    const readings = Sim.scanReadings(Sim.padFor(0, slot, refs), calibration, refs);
    const { mean, wobble } = Colour.average(readings);
    const rgb = Colour.normalize(mean, calibration);
    return { readings, mean, wobble, rgb, warnings: [], simulated, result: Colour.classify(rgb, refs), chosen: null };
  });
  const bytes = Report.makePDF({ created: 'now', sensorId: '44', calibratedAt: 'now', scans, references: refs, simulated });
  return Buffer.from(bytes).toString('latin1');
}

test('the PDF says so when its readings were simulated, and only then', () => {
  assert.ok(pdfText(true).includes('SIMULATED READINGS'));
  assert.ok(!pdfText(false).includes('SIMULATED READINGS'));
});

test('the pretend board acts like a real one: it connects, calibrates, reads and obeys the LED', async () => {
  const board = new Sim.PretendBoard();
  const live = [];
  board.onLive = counts => live.push(counts);
  await board.open();
  const { dark, white } = await board.calibrate();
  const light = x => x.r + x.g + x.b;
  // The same checks calibrate() in app.js makes: bright enough, LED clearly changes things, not too bright.
  assert.ok(light(white) >= 300);
  assert.ok(light(white) - light(dark) >= 0.1 * light(white));
  assert.ok(Math.max(white.r, white.g, white.b) < 16000);
  const on = await board.readOnce();
  assert.strictEqual(await board.setLed(false), false);
  const off = await board.readOnce();
  assert.ok(light(on) - light(off) > 0.1 * light(on), 'the LED switch must not trigger the wiring warning');
  assert.strictEqual(await board.setLed(true), true);
  await new Promise(r => setTimeout(r, 600));
  assert.ok(live.length >= 1, 'live readings arrive');
  await board.close();
  const count = live.length;
  await new Promise(r => setTimeout(r, 400));
  assert.strictEqual(live.length, count, 'live readings stop after closing');
});

test('every case still comes out right with the pretend board calibration', async () => {
  const board = new Sim.PretendBoard();
  const calibration = await board.calibrate();
  Sim.CASES.forEach((_, index) => {
    for (let slot = 0; slot < 5; slot++) {
      const pad = Sim.padFor(index, slot, refs);
      const { mean } = Colour.average(Sim.scanReadings(pad, calibration, refs));
      const result = Colour.classify(Colour.normalize(mean, calibration), refs);
      assert.strictEqual(result.best.ref.key, pad.key);
      assert.strictEqual(result.verdict, 'match');
    }
  });
});
