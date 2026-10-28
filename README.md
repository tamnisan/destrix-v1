# Urine strip reader

A small app that reads urine test strip pads with an **Arduino Uno + TCS34725 colour sensor**, works out **which parameter** each pad is and **what level** it shows from the colour alone, and gives you a **PDF report**.

It's a **Windows app** you download and install, like Arduino IDE. You don't need Arduino IDE or Python: the firmware installer is built in.

> Educational prototype, not a medical device. Confirm any result with a laboratory test.

## How it works

1. You place one strip pad in front of the sensor and click **Scan**.
2. The app takes **5 readings over 5 seconds** and averages them.
3. It compares that colour with a list of **reference colours** (every level of every parameter you switched on) and picks the closest one. That one match tells it the parameter *and* the level. You never tell it which pad it's looking at.
4. After **5 scans**, click **Complete & get PDF**.

If two different parameters look almost the same (a "close call"), the app doesn't guess. It shows both and asks you which pad it was.

## Installing it

1. On the GitHub page, open **Releases** (right-hand side) and download the newest `Urine-strip-reader-Setup-….exe` (about 110 MB).
2. Double-click it. Windows may show **"Windows protected your PC"**, because the app isn't signed (a signing certificate costs money). Click **More info → Run anyway**.
3. Follow the installer. It adds a desktop shortcut and a Start menu entry. You can remove it later from **Settings → Apps**, like any other program.

**Updating:** close the app, then run the newer installer. It replaces the old version in place, so there's no need to uninstall first. Your calibration and taught colours are kept.

It also still works as a plain web page: download the ZIP, unzip it and open `index.html` in Chrome or Edge.

## First-time setup

1. **Wire the sensor** (Waveshare TCS34725 → Arduino Uno):

   | Sensor | VCC | GND | SDA | SCL | LED |
   |---|---|---|---|---|---|
   | Arduino | 5V | GND | A4 | A5 | D6 |

2. **Install the firmware.** Plug the Arduino in by USB, close Arduino IDE if it's open, go to the **Setup & firmware** tab and click **Install firmware**. Pick your board from the list. It takes a few seconds and checks itself afterwards. You only do this once per board. ("Firmware" is the small program on the Arduino that reads the sensor. This one is `firmware/sensor_reader/sensor_reader.ino`.)
3. **Calibrate.** On the **Scan** tab, put a white card in front of the sensor, close the box and click **Calibrate**. Do this each time you start.

The **Sensor LED** switch on the Scan tab turns the white LED beside the sensor on or off. It switches on by itself when the Arduino connects. Keep it on while scanning: with it off, the sensor only sees whatever light gets into the box, and the app warns you about that on the scan.

**If the LED switch makes no difference** (the app tells you), the LED pin isn't reaching the Arduino. On these sensor boards an unconnected LED pin leaves the LED on all the time. Check the wire from the sensor's **LED** pin to Arduino **digital pin 6** (on the top row of pins, not A0-A5). The app still calibrates and scans with the LED stuck on, as long as the box is closed.

After the first time, the app connects to the Arduino by itself as soon as you open it and plug the board in.

## Teach it your colours (important)

The app ships with **placeholder** colours: rough copies of a typical strip chart, so it works straight away. Your sensor sees colour differently from your eyes, so for real results:

1. Open the **Teach colours** tab.
2. Dip a strip in a sample whose level you know and wait for the reading time printed on the bottle.
3. Put that pad in front of the sensor and click **Record** on the matching row.

Repeat for each level you can make. Use **Save backup file** to keep your colours safe. To give everyone who downloads the app your colours, click **Export as built-in default** and replace `js/reference-data.js` with the downloaded file.

## Which parameters to use

On a 10-parameter strip, many pads share colours. Most "negative" pads are off-white or cream, and several pads go through the same greens or pinks. The **look-alike check** in the Teach tab lists every pair that could be confused.

Default set: **Glucose, Protein, Urobilinogen, Nitrite, Leukocytes.** Using the placeholder colours, this set has 3 look-alike pairs, against 7 for glucose/ketone/protein/bilirubin/nitrite:

- Glucose 100 mg/dL ↔ Protein 100 mg/dL (both green)
- Glucose 250 mg/dL ↔ Protein 100 mg/dL
- Nitrite negative ↔ Leukocytes negative (both off-white)

Once you've taught your real colours, check the look-alike list again. Your own sensor has the final word.

## Publishing on GitHub

1. Create a new repository on GitHub and upload this folder (GitHub Desktop works well for this). The `.gitignore` file keeps out the big `node_modules` and `dist` folders.
2. On the repository page, click **Releases → Create a new release**. Type a tag such as `v1.0.0`, give it a title, and drag `dist/Urine-strip-reader-Setup-<version>.exe` into the box. Click **Publish release**.
3. Anyone can now download the installer from your Releases page.

The installer must go in a Release, not in the code itself: GitHub won't accept files over 100 MB in the code.

## Building the installer yourself

You need [Node.js](https://nodejs.org) (version 22 or newer). In this folder, run:

```sh
npm install            # downloads the build tools into node_modules
npx install-electron   # downloads the Electron runtime the app runs on
npm start              # opens the app without installing it, for trying changes
npm run dist           # builds the installer in the dist folder
```

Electron is the same tool Arduino IDE 2 is built with. It bundles the Chrome engine, which is why the installer is around 110 MB.

## For developers

- `npm test` runs 16 checks, including a full firmware upload to a simulated Uno bootloader, recognising every reference colour, and building a PDF.
- The app icon is drawn by `python tools/make-icon.py` (needs Pillow).
- To change the firmware: edit `firmware/sensor_reader/sensor_reader.ino`, compile it with Arduino IDE or `arduino-cli compile --fqbn arduino:avr:uno --output-dir firmware/build firmware/sensor_reader`, copy `firmware/build/sensor_reader.ino.hex` to `firmware/sensor_reader.ino.hex`, then run `node tools/embed-firmware.cjs`.
- The firmware is the same sketch as in the [simulation repo](https://github.com/tamnisan/destrix_simulation). Its commands are `R` (reading), `C` (calibrate), `L0`/`L1` (LED) and `S,steps,gain` (sensor settings).

| File | What it does |
|---|---|
| `desktop/main.js` | The Windows app: its window, USB port picking, saving the PDF |
| `index.html`, `style.css` | The app's screen |
| `js/app.js` | Buttons, scanning, teaching, report download |
| `js/references.js` | All 10 parameters, their levels and placeholder colours |
| `js/colour.js` | Calibration maths, colour difference, matching, look-alike check |
| `js/serial.js` | Talking to the sketch over USB (readings, calibration, LED) |
| `js/stk500.js` | The firmware installer (speaks the Uno bootloader's STK500 protocol) |
| `js/report.js` | The PDF report, written by hand so it works offline |
| `js/firmware-hex.js` | The compiled firmware, generated by `tools/embed-firmware.cjs` |
| `js/reference-data.js` | Shared reference colours (empty until you export yours) |
