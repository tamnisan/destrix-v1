// Simulated results: 10 built-in pretend samples ("cases"), used instead of what the
// sensor reads when "Simulated results" is switched on in the Settings tab.
(function (root) {
  'use strict';
  const Colour = root.StripColour || (typeof require !== 'undefined' ? require('./colour.js') : null);

  // Each case gives the level every pad shows: 0 is the first level listed for that
  // parameter in references.js, 1 the second, and so on.
  const CASES = [
    { GLU: 0, BIL: 0, KET: 0, SG: 3, BLD: 0, PH: 2, PRO: 0, URO: 0, NIT: 0, LEU: 0 },
    { GLU: 2, BIL: 0, KET: 1, SG: 4, BLD: 0, PH: 1, PRO: 0, URO: 1, NIT: 0, LEU: 0 },
    { GLU: 4, BIL: 0, KET: 3, SG: 5, BLD: 0, PH: 0, PRO: 1, URO: 0, NIT: 0, LEU: 0 },
    { GLU: 0, BIL: 0, KET: 0, SG: 3, BLD: 1, PH: 5, PRO: 2, URO: 0, NIT: 1, LEU: 3 },
    { GLU: 0, BIL: 1, KET: 0, SG: 4, BLD: 0, PH: 2, PRO: 0, URO: 2, NIT: 0, LEU: 1 },
    { GLU: 1, BIL: 0, KET: 0, SG: 5, BLD: 2, PH: 2, PRO: 3, URO: 1, NIT: 0, LEU: 0 },
    { GLU: 0, BIL: 2, KET: 0, SG: 6, BLD: 3, PH: 3, PRO: 4, URO: 3, NIT: 0, LEU: 2 },
    { GLU: 3, BIL: 0, KET: 2, SG: 4, BLD: 2, PH: 4, PRO: 2, URO: 0, NIT: 1, LEU: 4 },
    { GLU: 0, BIL: 3, KET: 0, SG: 2, BLD: 0, PH: 3, PRO: 1, URO: 4, NIT: 0, LEU: 1 },
    { GLU: 1, BIL: 0, KET: 0, SG: 1, BLD: 1, PH: 6, PRO: 0, URO: 0, NIT: 1, LEU: 2 }
  ];

  // Choose the case for a new test. `mode` is 'same' or 'different'; `last` is the
  // previous test's case number, or null if there hasn't been one.
  function pickCase(mode, last, random = Math.random) {
    if (mode === 'same' && last !== null) return last;
    const others = CASES.map((_, i) => i).filter(i => i !== last);
    return others[Math.floor(random() * others.length)];
  }

  // Which pad does this scan "see"? The enabled parameters are read in order.
  function padFor(caseIndex, slot, references) {
    const ids = [...new Set(references.map(r => r.paramId))];
    const id = ids[slot % ids.length];
    return references.find(r => r.key === `${id}:${CASES[caseIndex][id]}`);
  }

  // One reading: the sensor counts this pad would give with this calibration. `tint` is a
  // small colour error for the whole scan, and each channel also gets a little flicker,
  // so the numbers vary like a real sensor's do.
  function reading(pad, calibration, tint = [1, 1, 1], random = Math.random) {
    const { dark, white } = calibration;
    const flicker = () => 1 + (random() - 0.5) * 0.01;
    const channel = (k, v) => Math.round(dark[k] + v * (white[k] - dark[k]) * flicker());
    const [r, g, b] = pad.rgb.map((v, i) => v * tint[i]);
    return { c: channel('c', (r + g + b) / 3), r: channel('r', r), g: channel('g', g), b: channel('b', b) };
  }

  // The 5 readings for one scan. The colour noise could push a pad into a close call with a
  // look-alike, which would break "same as last time", so noisy tries that don't match the
  // pad cleanly are thrown away. The last resort is the pad's exact colour with no noise.
  function scanReadings(pad, calibration, references, random = Math.random) {
    const five = (tint, rnd) => Array.from({ length: 5 }, () => reading(pad, calibration, tint, rnd));
    for (let attempt = 0; attempt < 20; attempt++) {
      const tint = [0, 1, 2].map(() => 1 + (random() - 0.5) * 0.03);
      const readings = five(tint, random);
      const rgb = Colour.normalize(Colour.average(readings).mean, calibration);
      const { verdict, best } = Colour.classify(rgb, references);
      if (verdict === 'match' && best.ref.key === pad.key) return readings;
    }
    return five([1, 1, 1], () => 0.5);
  }

  // Stands in for the Arduino when "Work without the Arduino" is on. It has the same
  // buttons as the real connection in serial.js (open, readOnce, calibrate, setLed, close),
  // so the rest of the app doesn't need to know the difference.
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const BOARD = {
    white: { c: 17000, r: 6200, g: 7100, b: 6400 },
    dark: { c: 120, r: 40, g: 45, b: 38 }
  };

  class PretendBoard {
    constructor() {
      this.pretend = true;
      this.port = null;
      this.sensorId = '44';
      this.sensorOk = true;
      this.led = true;
      this.onLive = null;
      this.onLost = null;
    }
    async open() {
      await sleep(1800); // a real Uno takes about this long to restart
      this.timer = setInterval(() => { if (this.onLive) this.onLive(this.counts()); }, 250);
    }
    // What the sensor "sees" between scans: an empty grey box, or nearly nothing with the LED off.
    counts() {
      return reading({ rgb: this.led ? [0.5, 0.48, 0.46] : [0.003, 0.003, 0.003] }, BOARD);
    }
    async readOnce() { await sleep(55); return this.counts(); }
    async calibrate() {
      await sleep(300);
      return { dark: { ...BOARD.dark }, white: reading({ rgb: [1, 1, 1] }, BOARD) };
    }
    async setLed(on) { await sleep(20); this.led = on; return on; }
    async close() { clearInterval(this.timer); }
  }

  const api = { CASES, pickCase, padFor, reading, scanReadings, PretendBoard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StripSimulation = api;
})(typeof window === 'undefined' ? globalThis : window);
