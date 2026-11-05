// The screen: buttons, scanning, teaching colours and the report.
(() => {
  'use strict';
  const Ref = window.StripReferences, Colour = window.StripColour, Serial = window.StripSerial;
  const Flasher = window.StripFlasher, Report = window.StripReport, Sim = window.StripSimulation;
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const SCANS_PER_STRIP = 5;   // scans before "Complete" unlocks
  const READINGS_PER_SCAN = 5; // one reading per second, then averaged
  const BUFFER_SECONDS = 5;    // countdown before the readings start, to get the pad in place
  const TOO_BRIGHT = 16000;    // about 75% of the highest count the sketch's sensor settings allow

  // Small things remembered between visits. They live in this browser only.
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('strip.' + key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('strip.' + key, JSON.stringify(value)); } catch (e) { /* private window: just don't remember */ }
    }
  };
  const shared = window.STRIP_SHARED_REFERENCES || {};

  // R + G + B: how much light the sensor sees in total. The Clear channel is left out on
  // purpose: it maxes out before the colour channels do, and colour matching doesn't use it.
  const light = x => x.r + x.g + x.b;
  // A calibration is usable only if the white card reads clearly brighter than the dark
  // reading in every colour channel. Otherwise every colour would come out pure white.
  const usable = c => !!c && ['r', 'g', 'b'].every(k => c.white[k] - c.dark[k] >= Math.max(50, 0.1 * c.white[k]));
  const savedCalibration = key => { const c = store.get(key, null); return usable(c) ? c : null; };

  // Everything the screen shows comes from this one object. Change it, then call render().
  const S = {
    link: null,              // the connected Arduino, or null
    port: null,              // the last Arduino port used, so Install firmware needn't ask again
    calibration: savedCalibration('calibration'), // white-card numbers
    ledOn: true,             // the white LED beside the sensor
    simulate: store.get('simulate', false),         // Settings: use the built-in cases for scans
    simRepeat: store.get('simRepeat', 'different'), // Settings: each new test uses a 'different' or the 'same' case
    simLast: store.get('simLast', null),            // the case number the latest test used
    withoutArduino: store.get('withoutArduino', false), // Settings: act as if an Arduino is connected
    simPad: null,            // the pretend pad being read right now, or null
    active: store.get('active', shared.active || Ref.DEFAULT_ACTIVE),
    measured: store.get('measured', shared.measured || {}),
    scans: [],
    busy: false,
    live: null,
    tab: 'scan',
    confirmReset: false
  };

  // True when running as the installed Windows app rather than in Chrome/Edge.
  const isDesktopApp = /Electron/.test(navigator.userAgent);
  const refs = () => Ref.buildReferences(S.active, S.measured);
  // With no sensor there is nothing real to read, so this needs simulated results on too.
  const noArduino = () => S.simulate && S.withoutArduino;
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function say(text, kind = 'info', where = 'message') {
    $(where).textContent = text;
    $(where).className = 'message ' + kind;
  }

  // Runs one job at a time (scan, calibrate, ...) and shows its error if it fails.
  async function run(job, where = 'message') {
    if (S.busy) return;
    S.busy = true;
    render();
    try { await job(); } catch (e) { say(e.message, 'bad', where); } finally { S.busy = false; render(); }
  }

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- connecting ----------

  function watch(link) {
    // During a simulated scan the live numbers follow the pretend pad, so they match the result.
    link.onLive = counts => { S.live = S.simPad ? Sim.reading(S.simPad, S.calibration) : counts; renderLive(); };
    link.onLost = () => {
      if (S.link !== link) return;
      S.link = null; S.live = null;
      say('The Arduino was unplugged. Plug it back in and it will reconnect.', 'bad');
      render();
    };
  }

  async function disconnect() {
    const link = S.link;
    S.link = null; S.live = null;
    if (link) await link.close();
  }

  async function connect(port) {
    if (S.busy) return;
    S.busy = true;
    await disconnect();
    S.port = port;
    setStatus('busy', 'Connecting...');
    const link = noArduino() ? new Sim.PretendBoard() : new Serial.ArduinoLink();
    try {
      await link.open(port);
      S.link = link;
      // The pretend board has its own calibration, so it can never be used with the real sensor.
      S.calibration = savedCalibration(link.pretend ? 'pretendCalibration' : 'calibration');
      S.ledOn = true; // the sketch switches the LED on when it starts
      watch(link);
      if (!link.sensorOk) say('Arduino connected, but the colour sensor is not answering. Check the 5 wires (Setup tab).', 'bad');
      else say(S.calibration ? 'Arduino connected. Ready to scan.' : 'Arduino connected. Next: calibrate with the white card.', 'ok');
    } catch (e) {
      if (e.code === 'NO_FIRMWARE') {
        S.tab = 'setup';
        say('This Arduino does not have the sensor firmware yet. Click "Install firmware" below.', 'bad');
      } else say(e.message, 'bad');
    } finally {
      S.busy = false;
      render();
    }
  }

  async function pickAndConnect(showAll) {
    if (noArduino()) return connect(null);
    let port;
    try {
      port = await Serial.ArduinoLink.pickPort(showAll);
    } catch (e) {
      // No board was picked: either none is plugged in, or the list was closed.
      say('No Arduino chosen. Plug it in with its USB cable, then click Connect Arduino again.', 'warn');
      return;
    }
    connect(port);
  }

  // ---------- reading the sensor ----------

  // Switch the white LED beside the sensor on or off (the sketch's L1 / L0 commands).
  function toggleLed() {
    run(async () => {
      const before = S.live;
      S.ledOn = await S.link.setLed(!S.ledOn);
      await sleep(700); // let the sensor take a couple of fresh readings
      const after = S.live;
      // The Arduino always answers the command, even if the LED isn't wired to it.
      // So check the light really changed, and say so if it didn't.
      if (before && after && Math.abs(light(after) - light(before)) < 0.1 * Math.max(light(before), light(after), 1)) {
        say('The Arduino switched pin D6, but the light the sensor sees did not change. If the box is closed, '
          + 'the LED is probably not wired to D6: check the wire from the sensor\'s LED pin to Arduino pin D6.', 'warn');
      } else {
        say(S.ledOn ? 'Sensor LED on.' : 'Sensor LED off. Turn it back on before scanning, unless you light the strip some other way.',
          S.ledOn ? 'ok' : 'warn');
      }
    });
  }

  // A countdown that gives time to get the pad in front of the sensor.
  async function getReady(bar) {
    for (let left = BUFFER_SECONDS; left > 0; left--) {
      showProgress(bar, 0, `Starting in ${left}...`);
      await sleep(1000);
    }
    if (!S.link) throw new Error('The Arduino was unplugged. Plug it back in and it will reconnect.');
  }

  // Which pretend pad should this scan use? null means read the real sensor.
  function simulatedPad(slot) {
    if (!S.simulate) return null;
    // The first scan of a strip starts a new test, so that's when the case is chosen.
    if (!S.scans.some(Boolean) || S.simLast === null) {
      S.simLast = Sim.pickCase(S.simRepeat, S.simLast);
      store.set('simLast', S.simLast);
    }
    return Sim.padFor(S.simLast, slot, refs());
  }

  // 5 readings, one per second, then average them. Used by both Scan and Teach.
  // `bar` is the id of the progress bar to animate while it runs.
  // With a `pad`, the results come from that pretend pad instead of the sensor.
  async function captureFive(bar, pad = null) {
    const simulated = pad ? Sim.scanReadings(pad, S.calibration, refs()) : null;
    S.simPad = pad;
    const readings = [], start = performance.now();
    const tick = () => showProgress(bar, Math.min(1, (performance.now() - start) / (READINGS_PER_SCAN * 1000)),
      `Reading ${Math.min(READINGS_PER_SCAN, readings.length + 1)} of ${READINGS_PER_SCAN}`);
    tick();
    const ticker = setInterval(tick, 100);
    try {
      for (let i = 0; i < READINGS_PER_SCAN; i++) {
        // The board is asked even for a simulated scan, so a pulled cable still stops it.
        const real = await S.link.readOnce();
        readings.push(simulated ? simulated[i] : real);
        // Wait until the next whole second, so 5 readings take 5 seconds.
        const wait = start + (i + 1) * 1000 - performance.now();
        if (wait > 0) await sleep(wait);
      }
    } finally {
      S.simPad = null;
      clearInterval(ticker);
      showProgress(bar, null);
    }
    if (readings.every(x => !x.c && !x.r && !x.g && !x.b)) {
      throw new Error('The sensor only sent zeros. Check the 5 wires to the sensor (Setup tab).');
    }
    const { mean, wobble } = Colour.average(readings);
    const warnings = [];
    if (Math.max(...readings.map(x => Math.max(x.r, x.g, x.b))) >= TOO_BRIGHT) {
      warnings.push('Very bright: the sensor is near its limit. Move it a little further from the strip.');
    }
    if (wobble > 0.08) warnings.push('The readings changed during the scan. Hold the strip still and close the box.');
    if (!S.ledOn) warnings.push('The sensor LED was off during this scan.');
    return { readings, mean, wobble, rgb: Colour.normalize(mean, S.calibration), warnings };
  }

  function canMeasure(where = 'message') {
    if (!S.link) { say('Connect the Arduino first.', 'bad', where); return false; }
    if (!S.calibration) { say('Calibrate first: put the white card in front of the sensor and click Calibrate.', 'bad', where); return false; }
    return true;
  }

  function calibrate() {
    run(async () => {
      say('Calibrating... keep the white card still.', 'info');
      const c = await S.link.calibrate();
      c.at = new Date().toLocaleString();
      if (light(c.white) < 300) throw new Error('The sensor sees almost no light. Put the white card right in front of it and check that the LED is lit.');
      // The sketch reads once with the LED off ("dark") and once with it on ("white").
      // If both come out the same, the LED never switched off - usually because its
      // wire to D6 isn't connected, which leaves it on all the time. Calibrate anyway,
      // assuming no stray light gets into the closed box, and say how to fix it.
      const ledStuck = light(c.white) - light(c.dark) < 0.1 * light(c.white);
      if (ledStuck) c.dark = { c: 0, r: 0, g: 0, b: 0 };
      S.calibration = c;
      store.set(S.link.pretend ? 'pretendCalibration' : 'calibration', c);
      const bright = Math.max(c.white.r, c.white.g, c.white.b) >= TOO_BRIGHT;
      if (ledStuck) {
        say('Calibrated, but the LED did not switch off for the "dark" reading, so the app could not measure stray light. '
          + 'Scans still work if the box is closed. To fix it, check the wire from the sensor\'s LED pin to Arduino pin D6.', 'warn');
      } else if (bright) {
        say('Calibrated, but the white card is very bright. Move the sensor a little further away and calibrate again.', 'warn');
      } else {
        say('Calibrated. Put the first pad in front of the sensor and press Scan.', 'ok');
      }
    });
  }

  function scan(slot) {
    if (!canMeasure()) return;
    run(async () => {
      say('Put the pad in front of the sensor.', 'info');
      await getReady('progress');
      say('Scanning... keep the strip still.', 'info');
      const pad = simulatedPad(slot);
      const shot = await captureFive('progress', pad);
      const scanData = { ...shot, simulated: !!pad, result: Colour.classify(shot.rgb, refs()), chosen: null };
      S.scans[slot] = scanData;
      const o = Report.outcome(scanData);
      const allDone = S.scans.filter(Boolean).length === SCANS_PER_STRIP ? ' All 5 done - press Complete.' : '';
      const extra = shot.warnings.length ? ' ' + shot.warnings.join(' ') : '';
      if (o.how === 'none') say('No match: this colour is far from every reference. Check the pad is in front of the sensor, or teach this colour.' + extra, 'warn');
      else if (o.how === 'uncertain') say('Close call: two parameters look alike here. Tell the app which pad it was.' + extra, 'warn');
      else say(`Scan ${slot + 1}: ${o.ref.paramName}, ${o.ref.label}.${allDone}${extra}`, extra ? 'warn' : 'ok');
    });
  }

  function complete() {
    const scans = S.scans.filter(Boolean);
    if (scans.length < SCANS_PER_STRIP) return;
    const now = new Date();
    const bytes = Report.makePDF({
      created: now.toLocaleString(),
      sensorId: S.link && S.link.sensorId,
      calibratedAt: S.calibration && S.calibration.at,
      simulated: scans.some(s => s.simulated),
      scans,
      references: refs()
    });
    // File name with the local date and time, e.g. strip-report-20261028-1909.pdf
    const two = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
    download(`strip-report-${stamp}.pdf`, bytes, 'application/pdf');
    say(isDesktopApp ? 'Choose where to save the report. It opens as soon as it is saved.'
      : 'Report downloaded. Check your Downloads folder.', 'ok');
  }

  // ---------- teaching reference colours ----------

  function record(key) {
    if (S.link && S.link.pretend) {
      say('Teaching needs the real sensor. Turn off "Work without the Arduino" in Settings first.', 'bad', 'teach-message');
      return;
    }
    if (!canMeasure('teach-message')) return;
    const ref = refs().find(r => r.key === key);
    run(async () => {
      say(`Put the ${ref.paramName} pad in front of the sensor.`, 'info', 'teach-message');
      await getReady('teach-progress');
      say(`Recording ${ref.paramName}, ${ref.label}... keep the pad still.`, 'info', 'teach-message');
      const shot = await captureFive('teach-progress');
      S.measured[key] = { rgb: shot.rgb.map(v => +v.toFixed(5)), at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
      store.set('measured', S.measured);
      say(`Saved ${ref.paramName}, ${ref.label}.` + (shot.warnings.length ? ' ' + shot.warnings.join(' ') : ''), shot.warnings.length ? 'warn' : 'ok', 'teach-message');
    }, 'teach-message');
  }

  function importReferences(text) {
    const data = JSON.parse(text);
    const okRgb = v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && isFinite(n));
    if (!data || typeof data.measured !== 'object') throw new Error('That file is not a backup from this app.');
    const measured = {};
    for (const [key, value] of Object.entries(data.measured)) {
      if (/^[A-Z]+:\d+$/.test(key) && value && okRgb(value.rgb)) measured[key] = { rgb: value.rgb, at: String(value.at || '') };
    }
    S.measured = measured;
    if (Array.isArray(data.active)) S.active = data.active.filter(id => Ref.byId(id));
    store.set('measured', S.measured);
    store.set('active', S.active);
  }

  // ---------- firmware ----------

  async function installFirmware(showAll) {
    if (S.busy) return;
    let port = S.link ? S.link.port : S.port;
    if (!port || showAll) {
      try { port = await Serial.ArduinoLink.pickPort(showAll); } catch (e) { return; }
    }
    const log = $('install-log');
    log.hidden = false;
    log.textContent = '';
    const write = line => { log.textContent += line + '\n'; log.scrollTop = log.scrollHeight; };
    S.busy = true;
    render();
    setStatus('busy', 'Installing firmware...');
    try {
      await disconnect();
      write('Restarting the Arduino into its bootloader...');
      const result = await Flasher.flash(port, window.STRIP_FIRMWARE_HEX, p => {
        if (p.stage === 'connect') write(`Talking to the board at ${p.baudRate} baud...`);
        if (p.stage === 'write') showProgress('install-progress', p.done / p.total, `Writing ${Math.round(100 * p.done / p.total)}%`);
        if (p.stage === 'verify') showProgress('install-progress', p.done / p.total, `Checking ${Math.round(100 * p.done / p.total)}%`);
      });
      write(`Done: ${result.bytes} bytes written to the ${result.chip} and checked.`);
      showProgress('install-progress', null);
      S.busy = false;
      await sleep(500);
      await connect(port);
      if (S.link) { write('Connected to the new firmware.'); S.tab = 'scan'; render(); }
    } catch (e) {
      write('Problem: ' + e.message);
      showProgress('install-progress', null);
      say(e.message, 'bad');
    } finally {
      S.busy = false;
      render();
    }
  }

  // ---------- drawing the screen ----------

  function showProgress(id, fraction, label = '') {
    const box = $(id);
    box.hidden = fraction === null;
    if (fraction === null) return;
    box.querySelector('i').style.width = (fraction * 100).toFixed(1) + '%';
    box.querySelector('span').textContent = label;
  }

  function setStatus(kind, text) {
    $('status').className = 'status ' + kind;
    $('status-text').textContent = text;
  }

  function renderStatus() {
    if (S.busy && !S.link) return; // connect()/install keep their own "busy" text
    if (!S.link) setStatus('', 'Not connected');
    else if (!S.link.sensorOk) setStatus('bad', 'Arduino connected - sensor not found');
    else setStatus('ok', 'Arduino connected');
    $('connect').hidden = !!S.link;
    $('disconnect').hidden = !S.link;
    $('connect').disabled = S.busy || (!noArduino() && !Serial.ArduinoLink.supported());
  }

  function renderLive() {
    const v = S.live;
    for (const k of ['r', 'g', 'b', 'c']) $('live-' + k).textContent = v ? v[k].toLocaleString() : '-';
    $('live-swatch').style.background = v && S.calibration ? Colour.toCss(Colour.normalize(v, S.calibration)) : '#333';
    const on = !!S.link && S.ledOn;
    $('led').disabled = S.busy || !S.link;
    $('led').setAttribute('aria-pressed', String(on));
    $('led-text').textContent = on ? 'On' : 'Off';
  }

  function resultCard(scan, i) {
    if (!scan) return `<li class="result empty"><span class="num">${i + 1}</span>Waiting for scan ${i + 1}</li>`;
    const o = Report.outcome(scan), r = scan.result;
    let what = o.ref
      ? `<b>${esc(o.ref.paramName)}</b><span class="level">${esc(o.ref.label)}</span><span class="status-tag ${o.ref.status.toLowerCase()}">${esc(o.ref.status)}</span>`
      : '<b>Not recognised</b><span class="level">far from every reference colour</span>';
    what += `<div class="how">${Report.matchLabel(scan)}${o.dE !== null ? ' - difference ' + o.dE.toFixed(1) : ''}</div>`;
    const earlier = o.ref && S.scans.slice(0, i).some(s => s && Report.outcome(s).ref && Report.outcome(s).ref.paramId === o.ref.paramId);
    if (earlier) what += `<div class="note">${esc(o.ref.paramName)} was already found in an earlier scan.</div>`;
    for (const w of scan.warnings) what += `<div class="note">${esc(w)}</div>`;
    if (r.verdict === 'close') {
      const a = r.best.ref, b = r.rival.ref, picked = scan.chosen && scan.chosen.paramId;
      what += `<div class="choose">This colour fits both <b>${esc(a.paramName)}</b> and <b>${esc(b.paramName)}</b>. Which pad was it?<br>
        <button data-choose="${i}:best" class="${picked === a.paramId ? 'picked' : ''}">${esc(a.paramName)} (${esc(a.label)})</button>
        <button data-choose="${i}:rival" class="${picked === b.paramId ? 'picked' : ''}">${esc(b.paramName)} (${esc(b.label)})</button></div>`;
    }
    return `<li class="result"><span class="num">${i + 1}</span><span class="swatch" style="background:${Colour.toCss(scan.rgb)}"></span>
      <div class="what">${what}</div><button class="redo" data-redo="${i}" ${S.busy ? 'disabled' : ''}>Redo</button></li>`;
  }

  function renderScan() {
    const done = S.scans.filter(Boolean).length;
    $('scan-count').textContent = `${done} of ${SCANS_PER_STRIP} scans`;
    $('scan').disabled = S.busy || !S.link || done >= SCANS_PER_STRIP;
    $('scan').textContent = done >= SCANS_PER_STRIP ? 'All 5 scanned' : done ? `Scan pad ${done + 1}` : 'Scan';
    $('complete').disabled = S.busy || done < SCANS_PER_STRIP;
    $('new-session').disabled = S.busy || !done;
    $('calibrate').disabled = S.busy || !S.link;
    const c = S.calibration;
    $('cal-text').textContent = c ? `Calibrated ${c.at}.` : 'Not calibrated yet.';
    $('results').innerHTML = Array.from({ length: SCANS_PER_STRIP }, (_, i) => resultCard(S.scans[i], i)).join('');
  }

  function renderTeach() {
    $('param-list').innerHTML = Ref.LIBRARY.map(p => {
      const on = S.active.includes(p.id);
      return `<label class="chip ${on ? 'on' : ''}"><input type="checkbox" value="${p.id}" ${on ? 'checked' : ''}> ${esc(p.name)}</label>`;
    }).join('');

    const list = refs(), clashes = Colour.clashes(list);
    $('clash-list').innerHTML = clashes.length
      ? clashes.map(c => `<li><span class="swatch sm" style="background:${Colour.toCss(c.a.rgb)}"></span> ${esc(c.a.paramName)} ${esc(c.a.label)}
          <span class="vs">looks like</span><span class="swatch sm" style="background:${Colour.toCss(c.b.rgb)}"></span> ${esc(c.b.paramName)} ${esc(c.b.label)}
          <em>difference ${c.dE.toFixed(1)}</em></li>`).join('')
      : '<li class="good">No look-alikes between the parameters you picked.</li>';

    const canRecord = !!S.link && !!S.calibration && !S.busy;
    $('ref-table').innerHTML = S.active.map(id => {
      const p = Ref.byId(id);
      const rows = list.filter(r => r.paramId === id).map(r => `<div class="ref-row">
        <span class="swatch" style="background:${Colour.toCss(r.rgb)}"></span>
        <span>${esc(r.label)} <span class="status-tag ${r.status.toLowerCase()}">${esc(r.status)}</span></span>
        <span class="src ${r.source}">${r.source === 'measured' ? 'measured ' + esc(r.at) : 'placeholder'}</span>
        <button data-record="${r.key}" ${canRecord ? '' : 'disabled'}>Record</button>
        <button data-forget="${r.key}" ${r.source === 'measured' && !S.busy ? '' : 'disabled'} title="Go back to the placeholder">Forget</button>
      </div>`).join('');
      return `<div class="ref-param"><h3>${esc(p.name)}</h3>${rows}</div>`;
    }).join('');
    $('reset-refs').textContent = S.confirmReset ? 'Click again to reset everything' : 'Reset to placeholders';
  }

  function renderSetup() {
    const supported = Serial.ArduinoLink.supported();
    $('install').disabled = S.busy || !supported;
    $('install-any').disabled = S.busy || !supported;
  }

  function renderSettings() {
    $('sim-toggle').setAttribute('aria-pressed', String(S.simulate));
    $('sim-text').textContent = S.simulate ? 'On' : 'Off';
    $('sim-repeat').value = S.simRepeat;
    $('sim-repeat').disabled = !S.simulate;
    $('sim-toggle').disabled = S.busy;
    $('no-arduino').disabled = S.busy || !S.simulate;
    $('no-arduino').setAttribute('aria-pressed', String(noArduino()));
    $('no-arduino-text').textContent = noArduino() ? 'On' : 'Off';
    $('sim-last').textContent = S.simLast === null ? 'No simulated test yet.' : `The latest test used case ${S.simLast + 1} of ${Sim.CASES.length}.`;
  }

  function render() {
    for (const tab of ['scan', 'teach', 'setup', 'settings']) {
      $('tab-' + tab).hidden = S.tab !== tab;
      document.querySelector(`[data-tab="${tab}"]`).classList.toggle('active', S.tab === tab);
    }
    renderStatus();
    renderLive();
    renderScan();
    renderTeach();
    renderSetup();
    renderSettings();
  }

  // ---------- buttons ----------

  document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { S.tab = b.dataset.tab; render(); }; });
  $('connect').onclick = () => pickAndConnect(false);
  $('disconnect').onclick = async () => { await disconnect(); say('Disconnected.', 'info'); render(); };
  $('led').onclick = toggleLed;
  $('calibrate').onclick = calibrate;
  $('scan').onclick = () => scan(S.scans.filter(Boolean).length);
  $('complete').onclick = complete;
  $('new-session').onclick = () => { S.scans = []; say('New strip. Scan the first pad.', 'info'); render(); };
  $('results').onclick = e => {
    const redo = e.target.closest('[data-redo]'), choose = e.target.closest('[data-choose]');
    if (redo) scan(Number(redo.dataset.redo));
    if (choose) {
      const [i, which] = choose.dataset.choose.split(':');
      const s = S.scans[Number(i)];
      s.chosen = s.result[which].ref;
      say(`Scan ${Number(i) + 1} set to ${s.chosen.paramName}.`, 'ok');
      render();
    }
  };

  $('param-list').onchange = e => {
    const id = e.target.value;
    S.active = e.target.checked ? Ref.LIBRARY.map(p => p.id).filter(x => x === id || S.active.includes(x)) : S.active.filter(x => x !== id);
    store.set('active', S.active);
    render();
  };
  $('ref-table').onclick = e => {
    const rec = e.target.closest('[data-record]'), forget = e.target.closest('[data-forget]');
    if (rec) record(rec.dataset.record);
    if (forget) { delete S.measured[forget.dataset.forget]; store.set('measured', S.measured); render(); }
  };
  $('export-json').onclick = () => download('strip-references.json', JSON.stringify({ active: S.active, measured: S.measured }, null, 2), 'application/json');
  $('import-json').onclick = () => $('import-file').click();
  $('import-file').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { importReferences(await file.text()); say('Backup loaded.', 'ok', 'teach-message'); } catch (err) { say(err.message.startsWith('That') ? err.message : 'Could not read that file.', 'bad', 'teach-message'); }
    render();
  };
  $('export-default').onclick = () => {
    const body = JSON.stringify({ active: S.active, measured: S.measured }, null, 2);
    download('reference-data.js', `// Reference colours shared with everyone who downloads the app.\n// Exported from the Teach tab on ${new Date().toLocaleString()}.\nwindow.STRIP_SHARED_REFERENCES = ${body};\n`, 'text/javascript');
    say('Downloaded reference-data.js. Replace js/reference-data.js in the project with it and upload to GitHub.', 'ok', 'teach-message');
  };
  $('reset-refs').onclick = () => {
    if (!S.confirmReset) { S.confirmReset = true; render(); setTimeout(() => { S.confirmReset = false; render(); }, 4000); return; }
    S.confirmReset = false;
    S.measured = {};
    store.set('measured', S.measured);
    say('All reference colours are back to placeholders.', 'info', 'teach-message');
    render();
  };
  $('install').onclick = () => installFirmware(false);
  $('install-any').onclick = () => installFirmware(true);
  // These two settings can change what is connected: start or stop the pretend board to match.
  async function applyBoardSetting() {
    const pretending = !!S.link && !!S.link.pretend;
    if (noArduino() && !pretending) {
      connect(null);
    } else if (!noArduino() && pretending) {
      await disconnect();
      say('Plug in the Arduino and click Connect Arduino.', 'info');
    }
    render();
  }
  $('sim-toggle').onclick = () => { S.simulate = !S.simulate; store.set('simulate', S.simulate); applyBoardSetting(); };
  $('no-arduino').onclick = () => { S.withoutArduino = !S.withoutArduino; store.set('withoutArduino', S.withoutArduino); applyBoardSetting(); };
  $('sim-repeat').onchange = e => { S.simRepeat = e.target.value; store.set('simRepeat', S.simRepeat); };

  // ---------- start-up ----------

  if (!Serial.ArduinoLink.supported()) {
    $('unsupported').hidden = false;
  } else {
    // An Arduino this app was allowed to use before connects without asking,
    // both at start-up and whenever one is plugged in.
    navigator.serial.getPorts().then(ports => {
      const arduino = ports.find(Serial.ArduinoLink.looksLikeArduino);
      if (arduino && !S.link && !noArduino()) connect(arduino);
    });
    navigator.serial.addEventListener('connect', e => {
      if (!S.link && !S.busy && !noArduino() && Serial.ArduinoLink.looksLikeArduino(e.target)) connect(e.target);
    });
  }
  say('Plug in the Arduino and click Connect Arduino.', 'info');
  render();
  if (noArduino()) connect(null);
})();
