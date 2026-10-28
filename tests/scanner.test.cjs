'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Ref = require('../js/references.js');
const Colour = require('../js/colour.js');
const Serial = require('../js/serial.js');
const Report = require('../js/report.js');

const calibration = { dark: { c: 90, r: 30, g: 30, b: 25 }, white: { c: 12000, r: 4300, g: 4100, b: 3600 } };
// Turn a reference colour into the counts the sensor would report for it.
const countsFor = rgb => ({
  c: 5000,
  r: Math.round(30 + rgb[0] * 4270), g: Math.round(30 + rgb[1] * 4070), b: Math.round(25 + rgb[2] * 3575)
});

test('white card and dark reading map to 1 and 0', () => {
  assert.deepStrictEqual(Colour.normalize(calibration.white, calibration), [1, 1, 1]);
  assert.deepStrictEqual(Colour.normalize(calibration.dark, calibration), [0, 0, 0]);
  const lab = Colour.toLab([1, 1, 1]);
  // The standard formula's 4-decimal constants leave white a hair (~0.01) off perfect grey.
  assert.ok(Math.abs(lab[0] - 100) < 0.05 && Math.abs(lab[1]) < 0.05 && Math.abs(lab[2]) < 0.05);
});

test('every default reference is recognised as itself, without being told the parameter', () => {
  const refs = Ref.buildReferences(Ref.DEFAULT_ACTIVE, {});
  for (const ref of refs) {
    const rgb = Colour.normalize(countsFor(ref.rgb), calibration);
    const result = Colour.classify(rgb, refs);
    assert.strictEqual(result.best.ref.key, ref.key, `${ref.paramName} ${ref.label}`);
    assert.notStrictEqual(result.verdict, 'nomatch');
  }
});

test('a colour far from everything is "no match"', () => {
  const refs = Ref.buildReferences(Ref.DEFAULT_ACTIVE, {});
  assert.strictEqual(Colour.classify([0.02, 0.02, 0.6], refs).verdict, 'nomatch'); // deep blue
});

test('look-alike pads give a close call naming both parameters', () => {
  const refs = Ref.buildReferences(['NIT', 'LEU'], {});
  // Halfway between the two off-white "Negative" colours.
  const nit = refs.find(r => r.key === 'NIT:0').rgb, leu = refs.find(r => r.key === 'LEU:0').rgb;
  const result = Colour.classify(nit.map((v, i) => (v + leu[i]) / 2), refs);
  assert.strictEqual(result.verdict, 'close');
  assert.deepStrictEqual([result.best.ref.paramId, result.rival.ref.paramId].sort(), ['LEU', 'NIT']);
  // When the operator picks the runner-up, the report shows the runner-up's difference.
  const scan = { result, chosen: result.rival.ref };
  assert.strictEqual(Report.outcome(scan).ref.paramId, result.rival.ref.paramId);
  assert.strictEqual(Report.outcome(scan).dE, result.rival.dE);
  assert.strictEqual(Report.matchLabel({ result, chosen: null }), 'Close call: unsure');
});

test('measured colours replace placeholders', () => {
  const refs = Ref.buildReferences(['GLU'], { 'GLU:1': { rgb: [0.1, 0.2, 0.3], at: 'today' } });
  assert.strictEqual(refs[1].source, 'measured');
  assert.deepStrictEqual(refs[1].rgb, [0.1, 0.2, 0.3]);
  assert.strictEqual(refs[0].source, 'placeholder');
});

test('averaging five readings and measuring the wobble', () => {
  const { mean, wobble } = Colour.average([
    { c: 100, r: 50, g: 40, b: 30 }, { c: 102, r: 50, g: 40, b: 30 }, { c: 98, r: 50, g: 40, b: 30 },
    { c: 100, r: 50, g: 40, b: 30 }, { c: 100, r: 50, g: 40, b: 30 }]);
  assert.deepStrictEqual(mean, { c: 100, r: 50, g: 40, b: 30 });
  assert.ok(Math.abs(wobble - 0.04) < 1e-9);
});

test('sketch lines are read in the sketch\'s order: clear, red, green, blue', () => {
  assert.deepStrictEqual(Serial.parseCounts('READ,812,301,277,240'), { c: 812, r: 301, g: 277, b: 240 });
});

// A pretend board already running the sensor sketch, speaking text over a fake serial port.
function sketchPort({ firmware = true } = {}) {
  let controller;
  const say = text => setTimeout(() => { try { controller.enqueue(new TextEncoder().encode(text)); } catch (e) { /* closed */ } }, 5);
  return {
    async open() {
      this.readable = new ReadableStream({ start: c => { controller = c; } });
      this.writable = new WritableStream({
        write: chunk => {
          if (!firmware) return;
          const cmd = new TextDecoder().decode(chunk).trim();
          if (cmd === 'R') say('READ,5000,2000,1800,1500\n');
          if (cmd === 'C') say('DARK,90,30,30,25\nWHITE,12000,4300,4100,3600\nCAL,DONE\n');
          if (cmd === 'L1') say('LED,1\n');
          if (cmd === 'L0') say('LED,0\n');
        }
      });
      if (firmware) say('SENSOR,ID,44\nBOOT,READY\nLIVE,5000,2000,1800,1500\n');
    },
    async close() { try { controller.close(); } catch (e) { /* cancelled */ } this.readable = null; }
  };
}

test('connects to the sketch, reads and calibrates', async () => {
  const link = new Serial.ArduinoLink();
  const live = [];
  link.onLive = x => live.push(x);
  await link.open(sketchPort());
  assert.strictEqual(link.sensorId, '44');
  assert.ok(link.sensorOk);
  assert.deepStrictEqual(await link.readOnce(), { c: 5000, r: 2000, g: 1800, b: 1500 });
  const cal = await link.calibrate();
  assert.deepStrictEqual(cal.white, calibration.white);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(await link.setLed(false), false, 'LED off');
  assert.strictEqual(await link.setLed(true), true, 'LED back on');
  await link.close();
});

test('spots a board without the firmware', async () => {
  const link = new Serial.ArduinoLink();
  await assert.rejects(link.open(sketchPort({ firmware: false })), e => e.code === 'NO_FIRMWARE');
});

test('makes a two-page PDF of five scans', () => {
  const refs = Ref.buildReferences(Ref.DEFAULT_ACTIVE, {});
  const picks = ['GLU:2', 'PRO:0', 'URO:3', 'NIT:1', 'LEU:4'];
  const scans = picks.map(key => {
    const ref = refs.find(r => r.key === key);
    const readings = Array.from({ length: 5 }, () => countsFor(ref.rgb));
    const { mean, wobble } = Colour.average(readings);
    const rgb = Colour.normalize(mean, calibration);
    return { readings, mean, wobble, rgb, warnings: [], kind: 'arduino', result: Colour.classify(rgb, refs), chosen: null };
  });
  const pdf = Buffer.from(Report.makePDF({ created: '28/10/2026, 14:00', mode: 'arduino', sensorId: '44', calibratedAt: 'today', scans, references: refs }));
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);
  for (const name of ['Glucose', 'Protein', 'Urobilinogen', 'Nitrite', 'Leukocytes']) assert.ok(text.includes(`(${name})`), name);
  // The xref table must point exactly at each object.
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  const offsets = text.slice(xref).match(/\d{10} 00000 n/g).map(s => Number(s.slice(0, 10)));
  offsets.forEach((offset, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1}`));
});
