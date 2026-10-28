// Turning raw sensor counts into a colour, and matching colours.
(function (root) {
  'use strict';

  // How strict the matching is. All three numbers are "colour difference" scores
  // (Delta E). Roughly: under 2 you can't see a difference, 5-10 you can see it
  // side by side, 20+ is clearly a different colour.
  const LIMITS = {
    noMatch: 22,   // further than this from every reference -> "no match"
    closeCall: 6,  // runner-up (a DIFFERENT parameter) within this of the winner -> "close call"
    clash: 12      // two references of different parameters closer than this -> warn in Teach tab
  };

  // Sensor counts -> colour between 0 (black) and 1 (white card), per channel.
  // dark  = what the sensor sees with its LED off (stray light + noise)
  // white = what it sees looking at the white calibration card
  // Removing "dark" and dividing by "white" cancels out LED brightness and sensor gain,
  // so the same pad gives the same numbers on different days and different builds.
  function normalize(raw, calibration) {
    return ['r', 'g', 'b'].map(k => {
      const span = Math.max(1, calibration.white[k] - calibration.dark[k]);
      return Math.max(0, Math.min(1.5, (raw[k] - calibration.dark[k]) / span));
    });
  }

  // Average a list of readings like { c, r, g, b }, and measure how much they wobbled.
  function average(readings) {
    const mean = {};
    let wobble = 0;
    for (const k of ['c', 'r', 'g', 'b']) {
      const values = readings.map(x => x[k]);
      mean[k] = values.reduce((a, b) => a + b, 0) / values.length;
      // Spread = (biggest - smallest) / average. 0.05 means the readings moved by 5%.
      wobble = Math.max(wobble, (Math.max(...values) - Math.min(...values)) / Math.max(1, mean[k]));
    }
    return { mean, wobble };
  }

  // Colour -> "Lab", a colour space designed so that equal distances look equally
  // different to people. Plain RGB is bad at this: two dark colours can be far apart
  // in numbers yet look identical. Uses the standard sRGB/D65 formulas.
  function toLab(rgb) {
    const [r, g, b] = rgb;
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 1.0;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  }

  // The colour difference score (CIE76 Delta E): straight-line distance in Lab.
  function deltaE(rgbA, rgbB) {
    const a = toLab(rgbA), b = toLab(rgbB);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  // Linear colour -> screen colour (0-1 per channel), the reverse of hexToLinear.
  function encode(rgb) {
    return rgb.map(v => {
      const s = Math.max(0, Math.min(1, v));
      return s <= 0.0031308 ? 12.92 * s : 1.055 * Math.pow(s, 1 / 2.4) - 0.055;
    });
  }

  // Linear colour -> something a web page can paint, e.g. "rgb(140, 202, 196)".
  function toCss(rgb) {
    return `rgb(${encode(rgb).map(v => Math.round(v * 255)).join(', ')})`;
  }

  // The heart of the app: which reference is this colour closest to?
  // `best`  = the closest reference of all
  // `rival` = the closest reference from a DIFFERENT parameter (the likeliest mix-up)
  function classify(rgb, references) {
    const ranked = references
      .map(ref => ({ ref, dE: deltaE(rgb, ref.rgb) }))
      .sort((a, b) => a.dE - b.dE);
    if (!ranked.length) return { verdict: 'nomatch', best: null, rival: null };
    const best = ranked[0];
    const rival = ranked.find(x => x.ref.paramId !== best.ref.paramId) || null;
    let verdict = 'match';
    if (best.dE > LIMITS.noMatch) verdict = 'nomatch';
    else if (rival && rival.dE - best.dE < LIMITS.closeCall) verdict = 'close';
    return { verdict, best, rival };
  }

  // Pairs of references from different parameters that look too alike.
  // These are the spots where the app could confuse one parameter for another.
  function clashes(references, limit = LIMITS.clash) {
    const out = [];
    for (let i = 0; i < references.length; i++) {
      for (let j = i + 1; j < references.length; j++) {
        const a = references[i], b = references[j];
        if (a.paramId === b.paramId) continue;
        const dE = deltaE(a.rgb, b.rgb);
        if (dE < limit) out.push({ a, b, dE });
      }
    }
    return out.sort((x, y) => x.dE - y.dE);
  }

  const api = { LIMITS, normalize, average, toLab, deltaE, encode, toCss, classify, clashes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StripColour = api;
})(typeof window === 'undefined' ? globalThis : window);
