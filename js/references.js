// The parameter library and its reference colours.
//
// A "reference" is the colour one pad shows at one level, for example
// "Glucose, 250 mg/dL". Every scan is compared against every reference of the
// parameters you switched on, and the closest one wins. That single match tells
// the app both WHICH parameter it is looking at and WHAT level the pad shows.
(function (root) {
  'use strict';

  // Every pad on a typical 10-parameter urine strip, with the levels printed on
  // its colour chart. `chart` is a rough on-screen copy of a typical chart.
  // These colours are PLACEHOLDERS so the app works out of the box: your sensor
  // sees colour differently from your eyes, so replace them in the Teach tab.
  const LIBRARY = [
    { id: 'GLU', name: 'Glucose', levels: [
      { label: 'Negative', status: 'Normal', chart: '#8ccac4' },
      { label: '100 mg/dL', status: 'High', chart: '#94c49b' },
      { label: '250 mg/dL', status: 'High', chart: '#8fae6c' },
      { label: '500 mg/dL', status: 'High', chart: '#8c8a4e' },
      { label: '1000+ mg/dL', status: 'High', chart: '#79603f' }] },
    { id: 'BIL', name: 'Bilirubin', levels: [
      { label: 'Negative', status: 'Normal', chart: '#f0e5c3' },
      { label: 'Small (1 mg/dL)', status: 'High', chart: '#e0cdac' },
      { label: 'Moderate (2 mg/dL)', status: 'High', chart: '#d2b69b' },
      { label: 'Large (4 mg/dL)', status: 'High', chart: '#c19c8b' }] },
    { id: 'KET', name: 'Ketone', levels: [
      { label: 'Negative', status: 'Normal', chart: '#edd3bd' },
      { label: 'Trace (5 mg/dL)', status: 'Trace', chart: '#e8b6b3' },
      { label: 'Small (15 mg/dL)', status: 'High', chart: '#d98ba0' },
      { label: 'Moderate (40 mg/dL)', status: 'High', chart: '#b35578' },
      { label: 'Large (80+ mg/dL)', status: 'High', chart: '#7e2f5a' }] },
    { id: 'SG', name: 'Specific gravity', levels: [
      { label: '1.000', status: 'Low', chart: '#2f6b6b' },
      { label: '1.005', status: 'Normal', chart: '#4d7d63' },
      { label: '1.010', status: 'Normal', chart: '#6d8b56' },
      { label: '1.015', status: 'Normal', chart: '#889451' },
      { label: '1.020', status: 'Normal', chart: '#9e9b49' },
      { label: '1.025', status: 'Normal', chart: '#b2a246' },
      { label: '1.030', status: 'Normal', chart: '#c3a93e' }] },
    { id: 'BLD', name: 'Blood', levels: [
      { label: 'Negative', status: 'Normal', chart: '#e9b74f' },
      { label: 'Trace (10 Ery/uL)', status: 'Trace', chart: '#c9ba56' },
      { label: 'Small (25 Ery/uL)', status: 'High', chart: '#99ab5a' },
      { label: 'Moderate (80 Ery/uL)', status: 'High', chart: '#5e8f5a' },
      { label: 'Large (200 Ery/uL)', status: 'High', chart: '#2f6b53' }] },
    { id: 'PH', name: 'pH', levels: [
      { label: '5.0', status: 'Normal', chart: '#ec8b44' },
      { label: '6.0', status: 'Normal', chart: '#e4b44a' },
      { label: '6.5', status: 'Normal', chart: '#c7be4c' },
      { label: '7.0', status: 'Normal', chart: '#94ae55' },
      { label: '7.5', status: 'Normal', chart: '#6c9e65' },
      { label: '8.0', status: 'Normal', chart: '#408b7f' },
      { label: '8.5', status: 'High', chart: '#30708f' }] },
    { id: 'PRO', name: 'Protein', levels: [
      { label: 'Negative', status: 'Normal', chart: '#e7e161' },
      { label: 'Trace', status: 'Trace', chart: '#ccd76b' },
      { label: '30 mg/dL', status: 'High', chart: '#aaca77' },
      { label: '100 mg/dL', status: 'High', chart: '#80b784' },
      { label: '300+ mg/dL', status: 'High', chart: '#5aa38c' }] },
    { id: 'URO', name: 'Urobilinogen', levels: [
      { label: '0.2 mg/dL', status: 'Normal', chart: '#f5cfb1' },
      { label: '1 mg/dL', status: 'Normal', chart: '#f0bba6' },
      { label: '2 mg/dL', status: 'High', chart: '#eaa49b' },
      { label: '4 mg/dL', status: 'High', chart: '#e08e90' },
      { label: '8 mg/dL', status: 'High', chart: '#d27484' }] },
    { id: 'NIT', name: 'Nitrite', levels: [
      { label: 'Negative', status: 'Normal', chart: '#f6f1e4' },
      { label: 'Positive', status: 'Positive', chart: '#ecb8c6' }] },
    { id: 'LEU', name: 'Leukocytes', levels: [
      { label: 'Negative', status: 'Normal', chart: '#ede3c7' },
      { label: 'Trace (15 Leu/uL)', status: 'Trace', chart: '#dacccc' },
      { label: 'Small (70 Leu/uL)', status: 'High', chart: '#c0aac6' },
      { label: 'Moderate (125 Leu/uL)', status: 'High', chart: '#9b80b4' },
      { label: 'Large (500 Leu/uL)', status: 'High', chart: '#70549b' }] }
  ];

  // The five parameters switched on the first time the app opens. Picked by
  // scoring all 252 five-pad combinations for look-alike colours: bilirubin and
  // ketone were left out because their creams and pinks overlap other pads.
  const DEFAULT_ACTIVE = ['GLU', 'PRO', 'URO', 'NIT', 'LEU'];

  // "#8ccac4" -> [0.26, 0.59, 0.55]. Screen colours are stored "gamma encoded"
  // (squashed so dark shades get more of the 0-255 range). The sensor measures
  // plain light amounts, so we undo that squashing to get comparable numbers.
  function hexToLinear(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255].map(v => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
  }

  const byId = id => LIBRARY.find(p => p.id === id);
  const keyOf = (paramId, level) => paramId + ':' + level;

  // Turn the library plus your measured colours into one flat list to compare against.
  // `measured` looks like { 'GLU:2': { rgb: [r, g, b], at: '2026-10-28T12:00' }, ... }.
  function buildReferences(activeIds, measured) {
    const list = [];
    for (const id of activeIds) {
      const param = byId(id);
      if (!param) continue;
      param.levels.forEach((level, index) => {
        const own = measured && measured[keyOf(id, index)];
        list.push({
          key: keyOf(id, index), paramId: id, paramName: param.name, level: index,
          label: level.label, status: level.status,
          rgb: own ? own.rgb : hexToLinear(level.chart),
          source: own ? 'measured' : 'placeholder', at: own ? own.at : null
        });
      });
    }
    return list;
  }

  const api = { LIBRARY, DEFAULT_ACTIVE, hexToLinear, byId, keyOf, buildReferences };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StripReferences = api;
})(typeof window === 'undefined' ? globalThis : window);
