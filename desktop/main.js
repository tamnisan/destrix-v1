// The Windows app. It opens the same page (index.html) in its own window, and does
// the jobs a web browser would normally do for the page: letting it use USB serial
// ports, choosing which port is the Arduino, and saving the PDF report.
// This is the same approach Arduino IDE 2 uses (it is also built with Electron).
'use strict';
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const path = require('node:path');

// USB chip makers used by genuine Arduinos and the common clones (same list as js/serial.js).
const ARDUINO_VENDORS = [0x2341, 0x2a03, 0x1a86, 0x0403, 0x10c4];
// Electron hands us the vendor ID as text. Accept it written in decimal or hex.
const looksLikeArduino = p => !!p.vendorId &&
  (ARDUINO_VENDORS.includes(parseInt(p.vendorId, 10)) || ARDUINO_VENDORS.includes(parseInt(p.vendorId, 16)));

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 860, minWidth: 420, minHeight: 500,
    title: 'Urine strip reader',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0f1316',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      // Normally a window in the background gets its timers slowed to once a second.
      // The firmware installer must answer the Arduino within about a second of
      // restarting it, so keep full speed even when the window is minimised.
      backgroundThrottling: false
    }
  });
  // The page is the whole app: never let it navigate away or open other windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

function setUpSession(ses) {
  // A browser asks "allow this site to use serial ports?". This app only ever loads its
  // own page, so it may always use them. This also lets the page reconnect by itself.
  ses.setPermissionCheckHandler((webContents, permission) => permission === 'serial');
  ses.setDevicePermissionHandler(details => details.deviceType === 'serial');

  // The page asked to pick a board ("Connect Arduino" or "Install firmware").
  // A browser shows its own list here. We pick the Arduino ourselves when there is
  // exactly one, and otherwise ask with a normal Windows dialog.
  ses.on('select-serial-port', async (event, portList, webContents, callback) => {
    event.preventDefault();
    const arduinos = portList.filter(looksLikeArduino);
    const choices = arduinos.length ? arduinos : portList;
    if (choices.length === 0) return callback('');           // nothing plugged in: the page explains
    if (choices.length === 1) return callback(choices[0].portId);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Choose your board',
      message: 'More than one device is plugged in. Which one is your Arduino?',
      buttons: [...choices.map(p => `${p.displayName || 'Serial device'} (${p.portName})`), 'Cancel'],
      cancelId: choices.length,
      noLink: true
    });
    callback(response < choices.length ? choices[response].portId : '');
  });

  // Saving the report: ask where (starting in Downloads), then open the PDF.
  ses.on('will-download', (event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    item.once('done', (e, state) => {
      if (state === 'completed' && item.getSavePath().toLowerCase().endsWith('.pdf')) shell.openPath(item.getSavePath());
    });
  });
}

// Only one copy may run: two copies would fight over the same USB port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // no File/Edit/View bar: the page has all the buttons
    setUpSession(session.defaultSession);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
