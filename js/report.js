// The PDF report.
//
// A PDF is mostly plain text: "objects" (pages, fonts, drawings) plus a table of
// contents saying at which byte each object starts. Writing it by hand, like the
// simulator repo does, means the app needs no internet and no PDF library.
(function (root) {
  'use strict';
  const Colour = root.StripColour || (typeof require !== 'undefined' ? require('./colour.js') : null);

  // What a scan finally counts as, after any close call has been settled.
  //   how: 'auto' (colour match), 'user' (operator picked after a close call),
  //        'uncertain' (close call nobody settled), 'none' (no match)
  // `dE` is the colour difference between the scan and the reference it ended up as.
  function outcome(scan) {
    const { verdict, best, rival } = scan.result;
    if (scan.chosen) {
      const picked = scan.chosen.key === best.ref.key ? best : rival;
      return { ref: scan.chosen, how: 'user', dE: picked.dE };
    }
    if (verdict === 'nomatch') return { ref: null, how: 'none', dE: best ? best.dE : null };
    return { ref: best.ref, how: verdict === 'close' ? 'uncertain' : 'auto', dE: best.dE };
  }

  function matchLabel(scan) {
    const o = outcome(scan);
    if (o.how === 'none') return 'No match';
    if (o.how === 'user') return 'Close call: chosen';
    if (o.how === 'uncertain') return 'Close call: unsure';
    return o.dE < 8 ? 'Strong' : 'Fair';
  }

  // The PDF's built-in fonts only know plain English letters, so swap anything fancy.
  const ascii = s => String(s ?? '').replace(/µ|μ/g, 'u').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, ' ');
  const escape = s => ascii(s).replace(/([\\()])/g, '\\$1');
  const fixed = (v, n = 0) => Number(v).toFixed(n);

  function makePDF(report) {
    const { scans, references } = report;
    const pages = [];
    let commands = [];
    const rgb = c => c.map(v => Math.max(0, Math.min(1, v)).toFixed(3)).join(' ');
    // PDF measures from the bottom of the page; these helpers let us measure from the top.
    function text(s, x, y, size = 10, bold = false, colour = [0.14, 0.19, 0.24]) {
      commands.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(colour)} rg 1 0 0 1 ${x} ${842 - y} Tm (${escape(s)}) Tj ET`);
    }
    function box(x, y, w, h, colour) { commands.push(`${rgb(colour)} rg ${x} ${842 - y - h} ${w} ${h} re f`); }
    function header(title, page) {
      box(0, 0, 595, 92, [0.09, 0.19, 0.24]);
      text('URINE TEST STRIP', 36, 37, 22, true, [1, 1, 1]);
      text(title, 36, 61, 12, false, [1, 1, 1]);
      text('EDUCATIONAL PROTOTYPE - NOT A MEDICAL DIAGNOSIS', 36, 80, 9, true, [0.75, 0.9, 0.85]);
      text(`${page} / 2`, 527, 43, 9, false, [1, 1, 1]);
    }
    function footer() {
      text('Colour-matched results from a home-built sensor. Confirm any result with a laboratory test.', 36, 807, 8);
      text('Arduino Uno + TCS34725 colour sensor', 36, 824, 8);
    }
    const statusColour = s => (s === 'High' || s === 'Positive') ? [0.68, 0.2, 0.16]
      : s === 'Low' ? [0.2, 0.36, 0.7] : s === 'Trace' ? [0.62, 0.45, 0.05] : [0.14, 0.43, 0.29];

    const measured = references.filter(r => r.source === 'measured').length;
    const placeholders = references.length - measured;
    const paramNames = [...new Set(references.map(r => r.paramName))];

    // ---- Page 1: the results ----
    header('Scan results', 1);
    text(`${report.created} | ${scans.length} scans | 5 readings averaged per scan`, 36, 116, 10, true);
    text(`Sensor: Arduino Uno + TCS34725 (ID 0x${report.sensorId || '?'}) | White card calibration: ${report.calibratedAt || 'unknown'}`, 36, 134, 9);
    if (placeholders) {
      text(`Reference colours: ${measured} measured, ${placeholders} placeholders copied from a typical chart - teach the app before trusting results.`, 36, 150, 8, true, [0.68, 0.2, 0.16]);
    } else {
      text(`Reference colours: all ${measured} measured with this sensor setup.`, 36, 150, 9);
    }
    box(36, 166, 523, 24, [0.9, 0.94, 0.94]);
    ['SCAN', 'COLOUR', 'DETECTED PARAMETER', 'RESULT', 'STATUS', 'MATCH'].forEach((s, i) => text(s, [44, 84, 134, 264, 384, 452][i], 182, 8, true));
    scans.forEach((scan, i) => {
      const y = 190 + i * 46, o = outcome(scan), rival = scan.result.rival;
      if (i % 2 === 0) box(36, y, 523, 46, [0.96, 0.97, 0.98]);
      text(String(i + 1), 50, y + 27, 12, true);
      box(84, y + 11, 30, 24, Colour.encode(scan.rgb));
      if (o.ref) {
        text(o.ref.paramName, 134, y + 21, 10, true);
        const note = o.how === 'user' ? 'chosen by operator'
          : o.how === 'uncertain' ? `or ${rival.ref.paramName}?` : 'found from colour alone';
        text(note, 134, y + 35, 7.5);
        text(o.ref.label, 264, y + 27, 10);
        text(o.ref.status, 384, y + 27, 10, true, statusColour(o.ref.status));
      } else {
        text('Not recognised', 134, y + 21, 10, true);
        text('far from every reference colour', 134, y + 35, 7.5);
        text('-', 264, y + 27, 10);
        text('-', 384, y + 27, 10);
      }
      text(matchLabel(scan), 452, y + 21, 9, true);
      if (o.dE !== null) text(`difference ${fixed(o.dE, 1)}`, 452, y + 35, 7.5);
    });
    let y = 450;
    text('HOW TO READ THIS', 36, y, 10, true);
    [
      'Each scan averages five sensor readings taken one second apart. The app compares that colour',
      'with every reference colour of the enabled parameters and picks the closest one. That match',
      'names the parameter AND its level - nobody tells the app which pad it is reading.',
      '',
      'Match: Strong = very close to a reference. Fair = close enough to accept. Close call = two',
      'different parameters looked alike ("chosen" = the operator said which pad it was).',
      'No match = far from every reference colour.',
      '"Difference" is a colour difference score (CIE76 Delta E): under 5 looks almost identical,',
      'over 20 is clearly a different colour.',
      '',
      `Parameters the app was looking for: ${paramNames.join(', ')}.`,
      'Normal / Trace / High / Low are the usual expected-value groups printed on strip charts.'
    ].forEach((line, i) => text(line, 36, y + 18 + i * 15, 9));
    footer();
    pages.push(commands.join('\n'));
    commands = [];

    // ---- Page 2: the raw numbers behind each result ----
    header('Measurement details', 2);
    scans.forEach((scan, i) => {
      const top = 116 + i * 80, o = outcome(scan), best = scan.result.best, rival = scan.result.rival;
      text(`SCAN ${i + 1}: ${o.ref ? `${o.ref.paramName} - ${o.ref.label}` : 'not recognised'}`, 36, top, 10, true);
      text('Raw readings C/R/G/B:  ' + scan.readings.map(x => `${x.c}/${x.r}/${x.g}/${x.b}`).join('  '), 36, top + 15, 7.5);
      const m = scan.mean;
      text(`Average: C ${fixed(m.c)}  R ${fixed(m.r)}  G ${fixed(m.g)}  B ${fixed(m.b)}   |   Spread between readings: ${fixed(scan.wobble * 100, 1)}%${scan.wobble > 0.08 ? ' (unsteady)' : ''}`, 36, top + 29, 8);
      text(`Colour compared with the white card: R ${fixed(scan.rgb[0], 3)}  G ${fixed(scan.rgb[1], 3)}  B ${fixed(scan.rgb[2], 3)}`, 36, top + 43, 8);
      if (best) {
        text(`Closest: ${best.ref.paramName} ${best.ref.label} (difference ${fixed(best.dE, 1)})` +
          (rival ? `   Next other parameter: ${rival.ref.paramName} ${rival.ref.label} (${fixed(rival.dE, 1)})` : ''), 36, top + 57, 8);
      }
    });
    y = 530;
    text('REFERENCE COLOURS USED', 36, y, 10, true);
    paramNames.forEach((name, i) => {
      const own = references.filter(r => r.paramName === name);
      const count = own.filter(r => r.source === 'measured').length;
      text(`${name}: ${own.length} levels - ${count} measured, ${own.length - count} placeholder`, 36, y + 18 + i * 14, 8);
    });
    text('Measured = taught by holding a known pad in front of this kind of sensor. Placeholder = a rough copy', 36, 740, 8);
    text('of a printed strip chart, only good enough to try the app out.', 36, 753, 8);
    footer();
    pages.push(commands.join('\n'));

    // Assemble the file. Every character is plain ASCII, so character count = byte count,
    // which keeps the byte positions in the "xref" table exact.
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
    ];
    pages.forEach((stream, i) => {
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(pdf);
  }

  const api = { outcome, matchLabel, makePDF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StripReport = api;
})(typeof window === 'undefined' ? globalThis : window);
