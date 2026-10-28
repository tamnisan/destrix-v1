'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../js/stk500.js');
const { FakeUno } = require('./fake-uno.cjs');

const hexText = fs.readFileSync(path.join(__dirname, '..', 'firmware', 'sensor_reader.ino.hex'), 'utf8');

test('reads the firmware file', () => {
  const image = F.parseHex(hexText);
  // arduino-cli reports "Sketch uses 5716 bytes" for firmware/sensor_reader/sensor_reader.ino.
  assert.strictEqual(image.length, 5716);
  // Every AVR program starts with a jump instruction (0x0C 0x94).
  assert.deepStrictEqual([image[0], image[1]], [0x0c, 0x94]);
});

test('rejects a damaged firmware file', () => {
  const broken = hexText.replace(':100000000C9478000C94A0000C94A0000C94A00018', ':100000000C9478000C94A0000C94A0000C94A00019');
  assert.throws(() => F.parseHex(broken), /damaged/);
});

test('uploads and verifies the sketch on a Uno', async () => {
  const board = new FakeUno();
  const stages = [];
  const result = await F.flash(board, hexText, p => stages.push(p.stage));
  const image = F.parseHex(hexText);
  assert.deepStrictEqual(Array.from(board.flash.slice(0, image.length)), Array.from(image));
  assert.strictEqual(result.chip, 'ATmega328P');
  assert.strictEqual(result.baudRate, 115200);
  assert.ok(board.started, 'the new sketch was started');
  assert.ok(stages.includes('write') && stages.includes('verify') && stages.at(-1) === 'done');
  assert.strictEqual(board.readable, null, 'port is closed afterwards');
});

test('falls back to 57600 baud for older bootloaders', async () => {
  const board = new FakeUno({ baud: 57600 });
  const result = await F.flash(board, hexText);
  assert.strictEqual(result.baudRate, 57600);
  assert.ok(board.started);
});

test('refuses a board that is not a Uno', async () => {
  const board = new FakeUno({ signature: [0x1e, 0x98, 0x01] }); // Arduino Mega chip
  await assert.rejects(F.flash(board, hexText), /not an Arduino Uno chip/);
  assert.strictEqual(board.readable, null);
});

test('gives a clear message when nothing answers', async () => {
  const board = new FakeUno({ silent: true });
  await assert.rejects(F.flash(board, hexText), /did not answer/);
});
