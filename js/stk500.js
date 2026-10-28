// Puts the sensor sketch onto an Arduino Uno straight from the browser.
//
// Every Uno has a tiny program called a "bootloader" that runs for about one second
// after the board restarts. During that second it listens on USB for a new sketch.
// Arduino IDE talks to it using a simple language called STK500 (version 1).
// This file speaks the same language, so nobody needs Arduino IDE installed.
(function (root) {
  'use strict';

  // STK500 command and reply bytes (from Atmel's AVR061 document).
  const STK = {
    OK: 0x10, INSYNC: 0x14, CRC_EOP: 0x20, GET_SYNC: 0x30,
    ENTER_PROGMODE: 0x50, LEAVE_PROGMODE: 0x51, LOAD_ADDRESS: 0x55,
    PROG_PAGE: 0x64, READ_PAGE: 0x74, READ_SIGN: 0x75
  };
  const PAGE = 128;            // the Uno's chip writes flash memory in 128-byte pages
  const FLASH_FOR_SKETCH = 32256; // 32 KB chip minus the bootloader's own space
  const MEMORY_F = 0x46;       // 'F' = we are talking about flash memory
  // Each chip reports a 3-byte ID ("signature"). These are the Uno/Nano chips.
  const CHIPS = { '1e950f': 'ATmega328P', '1e9514': 'ATmega328', '1e9516': 'ATmega328PB' };

  class FlashError extends Error {}
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

  // Read an Intel HEX file (what Arduino IDE produces) into the raw bytes of the program.
  // Each line looks like ":10 0000 00 0C9478...18": byte count, address, type, data, checksum.
  function parseHex(text) {
    const image = new Uint8Array(FLASH_FOR_SKETCH).fill(0xff);
    let size = 0, base = 0, lineNo = 0;
    for (const raw of text.split(/\r?\n/)) {
      lineNo++;
      const line = raw.trim();
      if (!line) continue;
      if (line[0] !== ':' || line.length % 2 === 0) throw new FlashError(`Firmware file is damaged (line ${lineNo}).`);
      const b = [];
      for (let i = 1; i < line.length; i += 2) b.push(parseInt(line.substr(i, 2), 16));
      const [count, hi, lo, type] = b;
      // All bytes on a line, checksum included, must add up to a multiple of 256.
      if (b.length !== count + 5 || (b.reduce((a, v) => a + v, 0) & 0xff) !== 0) {
        throw new FlashError(`Firmware file is damaged (line ${lineNo}).`);
      }
      if (type === 0x00) {                       // data
        const address = base + ((hi << 8) | lo);
        if (address + count > image.length) throw new FlashError('Firmware is too big for an Arduino Uno.');
        image.set(b.slice(4, 4 + count), address);
        size = Math.max(size, address + count);
      } else if (type === 0x01) {                // end of file
        break;
      } else if (type === 0x02) {                // extended segment address
        base = ((b[4] << 8) | b[5]) << 4;
      } else if (type === 0x04) {                // extended linear address
        base = ((b[4] << 8) | b[5]) << 16;
      }
    }
    if (!size) throw new FlashError('Firmware file is empty.');
    return image.slice(0, size);
  }

  // Web Serial hands us incoming bytes in random-sized chunks. This collects them in
  // a buffer so we can say "give me exactly 3 bytes, or give up after 500 ms".
  class ByteStream {
    constructor(port) {
      this.port = port;
      this.buffer = [];
      this.wake = null;
      this.reader = port.readable.getReader();
      this.finished = this.pump();
    }
    async pump() {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          for (const byte of value) this.buffer.push(byte);
          if (this.wake) this.wake();
        }
      } catch (e) {
        // The board was unplugged or the port closed; take() will time out.
      } finally {
        this.reader.releaseLock();
      }
    }
    clear() { this.buffer.length = 0; }
    async take(count, ms) {
      const deadline = Date.now() + ms;
      while (this.buffer.length < count) {
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await new Promise(resolve => {
          const timer = setTimeout(resolve, left);
          this.wake = () => { clearTimeout(timer); resolve(); };
        });
        this.wake = null;
      }
      return this.buffer.splice(0, count);
    }
    async write(bytes) {
      const writer = this.port.writable.getWriter();
      try { await writer.write(Uint8Array.from(bytes)); } finally { writer.releaseLock(); }
    }
    async close() {
      try { await this.reader.cancel(); } catch (e) { /* already closed */ }
      await this.finished;
    }
  }

  // Send one command. Every reply is: INSYNC, then `extra` data bytes, then OK.
  async function command(io, bytes, extra = 0, ms = 500) {
    await io.write([...bytes, STK.CRC_EOP]);
    const reply = await io.take(extra + 2, ms);
    if (!reply) throw new FlashError('The board stopped answering in the middle of the upload.');
    if (reply[0] !== STK.INSYNC || reply[reply.length - 1] !== STK.OK) {
      throw new FlashError('The board sent a reply that made no sense. Unplug it, plug it back in and try again.');
    }
    return reply.slice(1, -1);
  }

  // Restart the Uno by flicking the USB "DTR" control line, exactly like Arduino IDE does.
  // The Uno wires DTR to its reset pin through a small capacitor for this purpose.
  async function resetBoard(port) {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(250);
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await sleep(50);
  }

  // Say "hello" until the bootloader answers. Returns false if it never does.
  async function sync(io) {
    for (let attempt = 0; attempt < 10; attempt++) {
      io.clear();
      await io.write([STK.GET_SYNC, STK.CRC_EOP]);
      const reply = await io.take(2, 200);
      if (reply && reply[0] === STK.INSYNC && reply[1] === STK.OK) {
        // A late answer to an earlier "hello" could still be on its way. Wait for it,
        // throw it away, and say hello once more so replies and commands line up.
        await sleep(50);
        io.clear();
        await io.write([STK.GET_SYNC, STK.CRC_EOP]);
        const again = await io.take(2, 300);
        if (again && again[0] === STK.INSYNC && again[1] === STK.OK) return true;
      }
    }
    return false;
  }

  // The whole upload. `onProgress` gets { stage, done, total } updates for the progress bar.
  async function flash(port, hexText, onProgress = () => {}) {
    const image = parseHex(hexText);
    const pages = Math.ceil(image.length / PAGE);
    const pageAt = p => {
      const page = new Uint8Array(PAGE).fill(0xff);
      page.set(image.subarray(p * PAGE, p * PAGE + PAGE));
      return page;
    };

    // Genuine Unos listen at 115200 baud (bits per second). Some older clones and
    // Nanos use 57600, so if nothing answers at the first speed we try the second.
    for (const baudRate of [115200, 57600]) {
      try { await port.close(); } catch (e) { /* it was already closed */ }
      try {
        await port.open({ baudRate });
      } catch (e) {
        throw new FlashError('Could not open the board. Close Arduino IDE (and any other tab using the board), then try again.');
      }
      const io = new ByteStream(port);
      try {
        onProgress({ stage: 'connect', done: 0, total: 1, baudRate });
        await resetBoard(port);
        io.clear(); // throw away anything the old sketch printed before it restarted
        if (!(await sync(io))) continue;

        const signature = await command(io, [STK.READ_SIGN], 3);
        const chip = CHIPS[hex(signature)];
        if (!chip) throw new FlashError(`This board's chip (signature ${hex(signature)}) is not an Arduino Uno chip.`);

        await command(io, [STK.ENTER_PROGMODE]);
        for (let p = 0; p < pages; p++) {
          const word = (p * PAGE) >> 1; // addresses are counted in 2-byte words
          await command(io, [STK.LOAD_ADDRESS, word & 0xff, word >> 8]);
          await command(io, [STK.PROG_PAGE, 0, PAGE, MEMORY_F, ...pageAt(p)], 0, 1000);
          onProgress({ stage: 'write', done: p + 1, total: pages });
        }
        // Read everything back and compare, so a bad cable can't leave a half-written sketch.
        for (let p = 0; p < pages; p++) {
          const word = (p * PAGE) >> 1;
          await command(io, [STK.LOAD_ADDRESS, word & 0xff, word >> 8]);
          const back = await command(io, [STK.READ_PAGE, 0, PAGE, MEMORY_F], PAGE, 1000);
          const expected = pageAt(p);
          if (back.some((byte, i) => byte !== expected[i])) {
            throw new FlashError(`Check failed at byte ${p * PAGE}: the board did not store the sketch correctly. Try another USB cable.`);
          }
          onProgress({ stage: 'verify', done: p + 1, total: pages });
        }
        await command(io, [STK.LEAVE_PROGMODE]); // the bootloader now starts the new sketch
        onProgress({ stage: 'done', done: 1, total: 1 });
        return { chip, baudRate, bytes: image.length };
      } finally {
        await io.close();
        try { await port.close(); } catch (e) { /* already closed */ }
      }
    }
    throw new FlashError('The board did not answer. Check that it is an Arduino Uno, try a different USB cable, and close Arduino IDE.');
  }

  const api = { STK, PAGE, CHIPS, FlashError, parseHex, flash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StripFlasher = api;
})(typeof window === 'undefined' ? globalThis : window);
