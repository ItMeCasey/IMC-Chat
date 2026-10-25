'use strict';
/** IMC-Chat: the desktop app. Runs the local chat server in the background, shows the chat window, lives in the tray. */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const createSupervisor = require('./supervisor.js');
const createVlcWindows = require('./vlcwindow.js');

const PACKED = app.isPackaged, RES = PACKED ? process.resourcesPath : path.join(__dirname, '..'), SERVER_DIR = path.join(RES, 'server'), BUILD = path.join(__dirname, 'build');
const PORT = 8430, userData = app.getPath('userData'), DATA = path.join(userData, 'data'), SETTINGS_FILE = path.join(userData, 'settings.json');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, tray = null, sup = null, quitting = false, light = 'grey', settings = { closeToTray: true, startWithWindows: false };
try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (e) { /* first run */ }
const saveSettings = () => { try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { /* read-only */ } };
const log = (...a) => { try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(path.join(DATA, 'app.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch (e) { /* ignore */ } };
const url = () => 'http://localhost:' + PORT + '/', icon = (n) => nativeImage.createFromPath(path.join(BUILD, n));

function startServer() {
  fs.mkdirSync(DATA, { recursive: true });
  sup = createSupervisor({ command: process.execPath, args: [path.join(SERVER_DIR, 'server.js')], cwd: SERVER_DIR, port: PORT, log,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', IMC_VERSION: app.getVersion(), IMC_DATA: DATA, IMC_PORT: String(PORT) }),
    onOutput: (t) => { try { fs.appendFileSync(path.join(DATA, 'server.log'), t); } catch (e) { /* ignore */ } },
    onHealth: (h) => { light = h ? h.light : 'red'; refreshTray(); }, onState: () => refreshTray() });
  sup.start();
}
const SPLASH = 'data:text/html;charset=utf-8,' + encodeURIComponent('<body style="background:#222A2A;color:#E2DAC2;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;letter-spacing:6px">IMC-CHAT</body>');
async function waitForServer() { for (let i = 0; i < 120; i++) { try { const r = await fetch(url() + 'api/health'); if (r.ok) return; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); } }
function openWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); return win.focus(); }
  const b = settings.window || {};
  win = new BrowserWindow({ width: b.width || 1100, height: b.height || 760, minWidth: 700, minHeight: 480, backgroundColor: '#222A2A', show: false, icon: icon('icon.png'), autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#1A2020', symbolColor: '#E2DAC2', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => { if (!win.isMinimized() && !win.isMaximized()) settings.window = win.getNormalBounds(); saveSettings(); if (!quitting && settings.closeToTray) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; }); win.on('focus', () => win.flashFrame(false));
  win.loadURL(SPLASH).then(() => waitForServer().then(() => win && win.loadURL(url()))).catch(() => {});
}
const TEXT = { green: 'Connected', amber: 'Not connected to Twitch yet', red: 'Server problem', grey: 'Starting...' };
function refreshTray() {
  if (!tray) return;
  tray.setImage(icon('tray-' + light + '.png').resize({ width: 24, height: 24 })); tray.setToolTip('IMC-Chat: ' + TEXT[light]);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Status: ' + TEXT[light], enabled: false }, { type: 'separator' }, { label: 'Open IMC-Chat', click: openWindow },
    { label: 'Start with Windows', type: 'checkbox', checked: !!settings.startWithWindows, click: (m) => { settings.startWithWindows = m.checked; saveSettings(); try { app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }); } catch (e) { /* unsupported */ } } },
    { label: 'Keep running in the tray when closed', type: 'checkbox', checked: !!settings.closeToTray, click: (m) => { settings.closeToTray = m.checked; saveSettings(); } },
    { label: 'Open my data folder', click: () => shell.openPath(DATA) }, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
}
// the page tells the window which colours the Windows buttons should have (they follow the chosen theme)
ipcMain.on('overlay', (e, o) => {
  const hex = /^#[0-9a-fA-F]{6}$/; if (!win || !o || !hex.test(o.color) || !hex.test(o.symbolColor)) return;
  try { win.setTitleBarOverlay({ color: o.color, symbolColor: o.symbolColor, height: 40 }); } catch (err) { /* not supported */ }
});
// where the player and the chat popouts were last put: restored next time, unless that spot is no longer on a screen
const onScreen = (b) => !!b && screen.getAllDisplays().some((d) => { const a = d.workArea; return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + b.height > a.y + 50; });
const savedBounds = (key) => { const b = settings.bounds && settings.bounds[key]; return b && onScreen(b) ? b : null; };
function keepBounds(w, key) {
  let t = null; const save = () => { if (w.isDestroyed() || w.isMinimized() || w.isMaximized() || w.isFullScreen()) return; settings.bounds = Object.assign(settings.bounds || {}, { [key]: w.getNormalBounds() }); saveSettings(); };
  const later = () => { clearTimeout(t); t = setTimeout(save, 600); }; w.on('move', later); w.on('resize', later); w.on('close', save);
}
let pendingKey = null, pendingSet = false, settingsWin = null; app.on('browser-window-created', (e, w) => { if (pendingKey) { const k = pendingKey; pendingKey = null; keepBounds(w, k); if (pendingSet) { pendingSet = false; settingsWin = w; w.on('closed', () => { settingsWin = null; }); } } });
// links open in the browser; a popout (this app's own page with ?popout=) opens as its own window, with the stream beside the chat if you asked to watch
app.on('web-contents-created', (e, wc) => {
  if (wc.getType() !== 'window') return;   // the Twitch player frame is not a window of its own
  wc.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(url() + '?popout=')) { const watch = /[?&]watch=1/.test(u), key = watch ? 'chatWatch' : 'chat'; pendingKey = key; return { action: 'allow', overrideBrowserWindowOptions: Object.assign({ width: watch ? 1180 : 480, height: 760 }, savedBounds(key), { minWidth: 360, minHeight: 360, autoHideMenuBar: true, backgroundColor: '#222A2A', icon: icon('icon.png') }) }; }
    if (u.startsWith(url() + '?settings=1') || u.startsWith(url() + '/?settings=1')) { if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return { action: 'deny' }; } pendingKey = 'settings'; pendingSet = true; return { action: 'allow', overrideBrowserWindowOptions: Object.assign({ width: 760, height: 840 }, savedBounds('settings'), { minWidth: 420, minHeight: 320, title: 'Settings - IMC-Chat', frame: false, autoHideMenuBar: true, backgroundColor: '#222A2A', icon: icon('icon.png') }) }; }
    if (/^https?:\/\//.test(u)) shell.openExternal(u); return { action: 'deny' };
  });
  wc.on('will-navigate', (ev, u) => { if (!u.startsWith(url()) && !u.startsWith('data:')) { ev.preventDefault(); if (/^https?:\/\//.test(u)) shell.openExternal(u); } });
});
// the player window: VLC drawn inside our own resizable window, with our own controls
let vlcWindows = null;
function chatPopout(login) { const w = new BrowserWindow(Object.assign({ width: 480, height: 760 }, savedBounds('chat'), { minWidth: 360, minHeight: 360, autoHideMenuBar: true, backgroundColor: '#222A2A', icon: icon('icon.png') })); keepBounds(w, 'chat'); w.loadURL(url() + '?popout=' + encodeURIComponent(login)); }
// Twitch's own player in a window of ours. It has a browser profile of its own (kept between runs), so you log in to Twitch once, in that window:
// Turbo or a subscription then means no ads. The app never sees the login: it only shows Twitch's pages and can tell whether the login cookie is there.
const TWITCH_PARTITION = 'persist:imc-twitch', twitchHost = (u) => { try { const h = new URL(u).hostname; return h === 'twitch.tv' || h.endsWith('.twitch.tv') || h.endsWith('.ttvnw.net') || h.endsWith('.jtvnw.net'); } catch (e) { return false; } };
function twitchWindow(opts, first) {
  const w = new BrowserWindow(Object.assign({ autoHideMenuBar: true, backgroundColor: '#000000', icon: icon('icon.png'), webPreferences: { partition: TWITCH_PARTITION, contextIsolation: true, sandbox: true } }, opts));
  w.webContents.setWindowOpenHandler(({ url: u }) => { if (twitchHost(u)) return { action: 'allow' }; if (/^https?:\/\//.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (ev, u) => { if (!twitchHost(u)) { ev.preventDefault(); if (/^https?:\/\//.test(u)) shell.openExternal(u); } });
  w.loadURL(first); return w;
}
const twitchSession = () => session.fromPartition(TWITCH_PARTITION);
ipcMain.handle('twitch:player', (e, login, opt) => {
  const clip = opt && /^[A-Za-z0-9_-]{8,80}$/.test(String(opt.clip || '')) ? opt.clip : '';
  if (clip) { twitchWindow({ width: 1100, height: 640, minWidth: 420, minHeight: 260, title: String(opt.title || 'Clip').slice(0, 80) + ' - Twitch' }, 'https://clips.twitch.tv/embed?clip=' + encodeURIComponent(clip) + '&parent=twitch.tv&autoplay=true&muted=false'); return { ok: true }; }
  const c = String(login || '').toLowerCase(); if (!/^[a-z0-9_]{3,25}$/.test(c)) return { error: 'Unknown channel' };
  twitchWindow({ width: 1100, height: 640, minWidth: 420, minHeight: 260, title: '#' + c + ' - Twitch' }, 'https://player.twitch.tv/?channel=' + c + '&parent=twitch.tv&muted=false'); return { ok: true };
});
ipcMain.handle('twitch:login', () => { twitchWindow({ width: 560, height: 800, title: 'Log in to Twitch' }, 'https://www.twitch.tv/login'); return { ok: true }; });   // only for Twitch's own player: the chat login uses your normal browser
ipcMain.handle('twitch:status', async () => { try { return { loggedIn: (await twitchSession().cookies.get({ name: 'auth-token' })).length > 0 }; } catch (err) { return { loggedIn: false }; } });
ipcMain.handle('twitch:logout', async () => { try { await twitchSession().clearStorageData(); return { ok: true }; } catch (err) { return { error: err.message }; } });
ipcMain.handle('player:watch', async (e, login, opt) => {
  vlcWindows = vlcWindows || createVlcWindows({ url, icon: icon('icon.png'), preload: path.join(__dirname, 'player-preload.js'), log, openChat: chatPopout, bounds: () => savedBounds('player'), keep: (w) => keepBounds(w, 'player'), locate: require(path.join(SERVER_DIR, 'player.js'))({}).locate });
  try { return await vlcWindows.watch(login, opt && { playerPath: String(opt.playerPath || ''), quality: 'best', ads: opt.ads === 'show' ? 'show' : 'skip', clip: String(opt.clip || ''), title: String(opt.title || ''), chat: String(opt.chat || '') }); } catch (err) { return { error: err.message }; }
});
ipcMain.on('flash', () => { if (win && !win.isFocused()) win.flashFrame(true); });   // a mention while the window is in the background: the taskbar button flashes
app.on('second-instance', openWindow);
app.whenReady().then(() => {
  app.setAppUserModelId('com.itmecasey.imcchat'); tray = new Tray(icon('tray-grey.png').resize({ width: 24, height: 24 })); tray.on('click', openWindow); refreshTray(); startServer();
  if (!process.argv.includes('--hidden')) openWindow();
});
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; if (vlcWindows) vlcWindows.closeAll(); if (sup) sup.stop(); });
