// Talking to the sensor sketch running on the Arduino.
//
// The browser reaches the Arduino through "Web Serial": a Chrome/Edge feature that
// lets a web page use a USB serial port, but only after you pick the device yourself.
// The sketch understands short text commands, each ending with a new line:
//   R  -> one reading,        replies "READ,clear,red,green,blue"
//   C  -> white-card calibration, replies "DARK,..." then "WHITE,..." then "CAL,DONE"
//   L1 -> LED on,             replies "LED,1"
//   L0 -> LED off,            replies "LED,0"
// On its own it also prints "LIVE,..." four times a second, which drives the live view.
(function (root) {
  'use strict';

  const BAUD = 115200;
  // USB chip makers used by genuine Arduinos and the common clones (CH340, FTDI, CP210x).
  // Filtering by them means the "pick a device" list only shows likely Arduinos.
  const USB_FILTERS = [0x2341, 0x2a03, 0x1a86, 0x0403, 0x10c4].map(id => ({ usbVendorId: id }));

  // "READ,812,301,277,240" -> { c: 812, r: 301, g: 277, b: 240 }
  // Note the order: the sketch prints Clear first, then Red, Green, Blue.
  function parseCounts(line) {
    const [, c, r, g, b] = line.split(',').map(Number);
    return { c, r, g, b };
  }

  class ArduinoLink {
    static supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
    // Ports this site was allowed to use before. Lets the app reconnect without asking.
    static async rememberedPorts() { return navigator.serial.getPorts(); }
    // Opens the "pick a device" list. Must be called from a button click.
    static async pickPort(showAll = false) {
      return navigator.serial.requestPort(showAll ? {} : { filters: USB_FILTERS });
    }
    // True if the port's USB chip is one Arduinos use. Bluetooth COM ports have no USB
    // chip at all, so this keeps the app from trying to connect to them.
    static looksLikeArduino(port) {
      const { usbVendorId } = port.getInfo();
      return USB_FILTERS.some(f => f.usbVendorId === usbVendorId);
    }

    constructor() {
      this.port = null;
      this.sensorId = null;
      this.waiters = [];       // commands waiting for a particular reply
      this.onLive = null;      // called with each LIVE reading
      this.onLost = null;      // called if the cable is pulled out
    }

    async open(port) {
      this.port = port;
      try {
        await port.open({ baudRate: BAUD });
      } catch (e) {
        throw new Error('Could not open the Arduino. Close Arduino IDE\'s Serial Monitor (and any other tab using it), then try again.');
      }
      this.closing = false;
      this.finished = this.pump();
      // Opening the port restarts the Uno; about 2 s later the sketch prints BOOT,READY.
      const booted = await this.waitFor('BOOT,READY', 4000);
      if (!booted) {
        // Some clones don't restart when the port opens. Ask the sketch something instead.
        const reply = await this.request('L1', 'LED,', 1500);
        if (!reply) {
          await this.close();
          const err = new Error('This Arduino is not running the sensor sketch yet.');
          err.code = 'NO_FIRMWARE';
          throw err;
        }
      }
      // The sketch prints the sensor's ID at start-up: 44 or 4D for a TCS3472x.
      // 0 means the Arduino couldn't reach the sensor - usually a wiring problem.
      this.sensorOk = this.sensorId === null ? true : ['44', '4D'].includes(this.sensorId);
    }

    // Runs for as long as the port is open: splits incoming text into lines.
    async pump() {
      const decoder = new TextDecoder();
      let text = '';
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          let end;
          while ((end = text.indexOf('\n')) >= 0) {
            const line = text.slice(0, end).trim();
            text = text.slice(end + 1);
            if (line) this.handle(line);
          }
        }
      } catch (e) {
        // Reading fails when the cable is pulled out.
      } finally {
        this.reader.releaseLock();
        if (!this.closing) {
          try { await this.port.close(); } catch (e) { /* already gone */ }
          if (this.onLost) this.onLost();
        }
      }
    }

    handle(line) {
      if (line.startsWith('SENSOR,ID,')) this.sensorId = line.slice(10).toUpperCase();
      if (line.startsWith('LIVE,') && this.onLive) this.onLive(parseCounts(line));
      const i = this.waiters.findIndex(w => line.startsWith(w.prefix));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(line);
    }

    // Wait for a line starting with `prefix`. Resolves with the line, or null on timeout.
    waitFor(prefix, ms) {
      return new Promise(resolve => {
        const waiter = { prefix, resolve: line => { clearTimeout(timer); resolve(line); } };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter(w => w !== waiter);
          resolve(null);
        }, ms);
        this.waiters.push(waiter);
      });
    }

    async send(text) {
      const writer = this.port.writable.getWriter();
      try { await writer.write(new TextEncoder().encode(text + '\n')); } finally { writer.releaseLock(); }
    }

    async request(text, prefix, ms) {
      const reply = this.waitFor(prefix, ms); // start listening before sending
      await this.send(text);
      return reply;
    }

    async readOnce() {
      const line = await this.request('R', 'READ,', 2000);
      if (!line) throw new Error('The Arduino stopped answering. Check the USB cable.');
      return parseCounts(line);
    }

    async calibrate() {
      const dark = this.waitFor('DARK,', 3000), white = this.waitFor('WHITE,', 3000);
      await this.send('C');
      const [d, w] = await Promise.all([dark, white]);
      if (!d || !w) throw new Error('Calibration did not finish. Check the USB cable.');
      return { dark: parseCounts(d), white: parseCounts(w) };
    }

    // Turn the sensor's white LED on or off. Resolves with the state the sketch reports.
    async setLed(on) {
      const reply = await this.request(on ? 'L1' : 'L0', 'LED,', 1500);
      if (!reply) throw new Error('The Arduino did not answer. Check the USB cable.');
      return reply === 'LED,1';
    }

    async close() {
      this.closing = true;
      try { await this.reader.cancel(); } catch (e) { /* not reading */ }
      await this.finished;
      try { await this.port.close(); } catch (e) { /* already closed */ }
    }
  }

  const api = { BAUD, USB_FILTERS, parseCounts, ArduinoLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StripSerial = api;
})(typeof window === 'undefined' ? globalThis : window);
