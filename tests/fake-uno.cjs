// A pretend Arduino Uno for the tests. It looks like a Web Serial port to the code
// under test, and inside it behaves like the Uno's bootloader (Optiboot):
// after a DTR reset it answers STK500 commands and stores pages in fake flash memory.
'use strict';

class FakeUno {
  constructor({ baud = 115200, signature = [0x1e, 0x95, 0x0f], silent = false } = {}) {
    this.baud = baud;
    this.signature = signature;
    this.silent = silent;
    this.flash = new Uint8Array(32768).fill(0xff);
    this.inBootloader = false;
    this.started = false;      // set when LEAVE_PROGMODE starts the new sketch
    this.lastDtr = true;
    this.address = 0;
    this.rx = [];
    this.readable = null;
    this.writable = null;
  }

  async open({ baudRate }) {
    if (this.readable) throw new Error('already open');
    this.baudRate = baudRate;
    this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
    this.writable = new WritableStream({ write: chunk => this.receive(chunk) });
    // The sketch that is already on the board keeps printing until the reset.
    this.send(Buffer.from('LIVE,812,301,277,240\nLIVE,814,300,279,241\n'));
  }

  async close() {
    if (!this.readable) throw new Error('not open');
    try { this.controller.close(); } catch (e) { /* reader already cancelled */ }
    this.readable = null;
    this.writable = null;
  }

  async setSignals({ dataTerminalReady }) {
    // A DTR off -> on edge restarts the board into its bootloader.
    if (this.lastDtr === false && dataTerminalReady === true) {
      this.inBootloader = true;
      this.rx = [];
    }
    this.lastDtr = dataTerminalReady;
  }

  send(bytes) {
    if (!this.readable) return;
    setTimeout(() => { try { this.controller.enqueue(Uint8Array.from(bytes)); } catch (e) { /* closed */ } }, 1);
  }

  receive(chunk) {
    if (!this.inBootloader || this.silent) return;
    if (this.baudRate !== this.baud) {   // wrong speed: the board only hears noise
      this.send([0x00, 0xf8]);
      return;
    }
    this.rx.push(...chunk);
    this.process();
  }

  // Pull whole commands out of the received bytes and answer each one.
  process() {
    for (;;) {
      const cmd = this.rx[0];
      if (cmd === undefined) return;
      const length = { 0x30: 2, 0x75: 2, 0x50: 2, 0x51: 2, 0x55: 4, 0x74: 5 }[cmd] ??
        (cmd === 0x64 && this.rx.length >= 3 ? 5 + ((this.rx[1] << 8) | this.rx[2]) : null);
      if (length === null) {
        if (cmd === 0x64) return;      // PROG_PAGE header not complete yet
        this.rx.shift();               // unknown byte: drop it
        this.send([0x15]);             // NOSYNC
        continue;
      }
      if (this.rx.length < length) return;
      const c = this.rx.splice(0, length);
      if (c[c.length - 1] !== 0x20) { this.send([0x15]); continue; }
      if (cmd === 0x75) this.send([0x14, ...this.signature, 0x10]);
      else if (cmd === 0x55) { this.address = ((c[2] << 8) | c[1]) * 2; this.send([0x14, 0x10]); }
      else if (cmd === 0x64) {
        const size = (c[1] << 8) | c[2];
        this.flash.set(c.slice(4, 4 + size), this.address);
        this.send([0x14, 0x10]);
      } else if (cmd === 0x74) {
        const size = (c[1] << 8) | c[2];
        this.send([0x14, ...this.flash.slice(this.address, this.address + size), 0x10]);
      } else if (cmd === 0x51) { this.inBootloader = false; this.started = true; this.send([0x14, 0x10]); }
      else this.send([0x14, 0x10]);
    }
  }
}

module.exports = { FakeUno };
