'use strict';
/** IMC-Chat: the desktop app. Runs the local chat server in the background, shows the chat window, lives in the tray. */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const createSupervisor = require('./supervisor.js');
const createVlcWindows = require('./vlcwindow.js');
const { channelFromUrl, wantedPointsChannels, LOGIN } = require('./points-wanted.js');

const _openExternal = shell.openExternal.bind(shell);
shell.openExternal = (u, o) => { try { const x = new URL(u); log('opened in the browser:', x.hostname + x.pathname.slice(0, 60)); } catch (e) { log('opened in the browser: ?'); } return _openExternal(u, o); };
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
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', IMC_VERSION: app.getVersion(), IMC_DATA: DATA, IMC_PORT: String(PORT), IMC_PARENT_PID: String(process.pid) }),
    onOutput: (t) => { try { fs.appendFileSync(path.join(DATA, 'server.log'), t); } catch (e) { /* ignore */ } },
    onHealth: (h) => { light = h ? h.light : 'red'; refreshTray(); }, onState: () => refreshTray() });
  sup.start();
}
const SPLASH = 'data:text/html;charset=utf-8,' + encodeURIComponent('<body style="background:#222A2A;color:#E2DAC2;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;letter-spacing:6px">IMC-CHAT</body>');
async function waitForServer() { for (let i = 0; i < 120; i++) { try { const r = await fetch(url() + 'api/health'); if (r.ok) return; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); } }
function openWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); return win.focus(); }
  const b = settings.window || {};
  const where = Number.isFinite(b.x) && Number.isFinite(b.y) && onScreen({ x: b.x, y: b.y, width: b.width || 1100, height: b.height || 760 }) ? { x: b.x, y: b.y } : {};   // where it was, unless that screen is gone
  win = new BrowserWindow({ ...where, width: b.width || 1100, height: b.height || 760, minWidth: 380, minHeight: 360, backgroundColor: '#222A2A', show: false, icon: icon('icon.png'), autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#1A2020', symbolColor: '#E2DAC2', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  win.once('ready-to-show', () => win.show());
  let moveT = null; const saveWin = () => { if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return; settings.window = win.getNormalBounds(); saveSettings(); };
  for (const ev of ['move', 'resize']) win.on(ev, () => { clearTimeout(moveT); moveT = setTimeout(saveWin, 600); });   // saved as it moves, not only when it closes (a killed app never closes)
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
// the memory IMC-Chat uses in all: every window and helper process of the app, plus the chat server running beside it
ipcMain.handle('app:memory', async () => {
  const mb = (kb) => Math.round(kb / 1024), parts = { windows: 0, graphics: 0, other: 0, server: 0 };
  for (const m of app.getAppMetrics()) { const kb = (m.memory && (m.memory.privateBytes || m.memory.workingSetSize)) || 0; if (m.type === 'Tab' || m.type === 'Browser') parts.windows += kb; else if (m.type === 'GPU') parts.graphics += kb; else parts.other += kb; }
  for (const k of ['windows', 'graphics', 'other']) parts[k] = mb(parts[k]);
  try { const h = await (await fetch(url() + 'api/health')).json(); parts.server = Math.round((h.rss || 0) / 1048576); } catch (e) { /* the server is not answering */ }
  return { total: parts.windows + parts.graphics + parts.other + parts.server, parts };
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
// Twitch's login page asks for a passkey / security key on its own the moment it opens. In this app that is a Windows dialog on top of the page that blocks it.
// Only that automatic request ("conditional") is switched off; pressing a security-key button on the page still works.
const NO_AUTO_PASSKEY = `(() => { try {
  if (window.PublicKeyCredential) PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  const c = navigator.credentials, get = c.get.bind(c);
  c.get = (o) => (o && o.mediation === 'conditional' ? Promise.reject(new DOMException('Not allowed', 'NotAllowedError')) : get(o));
} catch (e) {} })();`;
app.on('web-contents-created', (e, wc) => {
  try { if (wc.session === twitchSession()) { wc.debugger.attach('1.3'); wc.debugger.sendCommand('Page.enable').then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: NO_AUTO_PASSKEY })).catch(() => {}); } } catch (err) { /* the page still works, only with the prompt */ }
  if (wc.getType() !== 'window') return;   // the Twitch player frame is not a window of its own
  wc.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(url() + '?popout=')) { const watch = /[?&]watch=1/.test(u), key = watch ? 'chatWatch' : 'chat'; pendingKey = key; return { action: 'allow', overrideBrowserWindowOptions: Object.assign({ width: watch ? 1180 : 480, height: 760 }, savedBounds(key), { minWidth: 360, minHeight: 360, autoHideMenuBar: true, backgroundColor: '#222A2A', icon: icon('icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } }) }; }
    if (u.startsWith(url() + '?settings=1') || u.startsWith(url() + '/?settings=1')) { if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return { action: 'deny' }; } pendingKey = 'settings'; pendingSet = true; return { action: 'allow', overrideBrowserWindowOptions: Object.assign({ width: 760, height: 840 }, savedBounds('settings'), { minWidth: 420, minHeight: 320, title: 'Settings - IMC-Chat', frame: false, autoHideMenuBar: true, backgroundColor: '#222A2A', icon: icon('icon.png') , webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } }) }; }
    if (/^https?:\/\//.test(u)) shell.openExternal(u); return { action: 'deny' };
  });
  wc.on('will-navigate', (ev, u) => { if (!u.startsWith(url()) && !u.startsWith('data:')) { ev.preventDefault(); if (/^https?:\/\//.test(u)) shell.openExternal(u); } });
});
// the player window: VLC drawn inside our own resizable window, with our own controls
let vlcWindows = null;
function chatPopout(login) { const w = new BrowserWindow(Object.assign({ width: 480, height: 760 }, savedBounds('chat'), { minWidth: 360, minHeight: 360, autoHideMenuBar: true, backgroundColor: '#222A2A', icon: icon('icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } })); keepBounds(w, 'chat'); w.loadURL(url() + '?popout=' + encodeURIComponent(login)); }
// Twitch's own player in a window of ours. It has a browser profile of its own (kept between runs), so you log in to Twitch once, in that window:
// Turbo or a subscription then means no ads. The app never sees the login: it only shows Twitch's pages and can tell whether the login cookie is there.
const TWITCH_PARTITION = 'persist:imc-twitch', twitchHost = (u) => { try { const h = new URL(u).hostname; return h === 'twitch.tv' || h.endsWith('.twitch.tv') || h.endsWith('.ttvnw.net') || h.endsWith('.jtvnw.net'); } catch (e) { return false; } };
// "Continue with Google / Amazon / Apple" must stay inside this window: if it opened in your browser, the login would end up there and never reach the app
const SIGNIN_HOSTS = /(^|\.)(google\.com|gstatic\.com|googleusercontent\.com|googleapis\.com|recaptcha\.net|hcaptcha\.com|amazon\.com|ssl-images-amazon\.com|media-amazon\.com|apple\.com|cdn-apple\.com|icloud\.com)$/i;
const signinHost = (u) => { try { return SIGNIN_HOSTS.test(new URL(u).hostname); } catch (e) { return false; } };
function twitchWindow(opts, first, quiet) {
  const w = new BrowserWindow(Object.assign({ autoHideMenuBar: true, backgroundColor: '#000000', icon: icon('icon.png'), webPreferences: { partition: TWITCH_PARTITION, contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } }, opts));
  w.webContents.setWindowOpenHandler(({ url: u }) => { if (quiet) { log('viewer ignored a pop-up'); return { action: 'deny' }; } if (twitchHost(u) || signinHost(u)) return { action: 'allow' }; if (/^https?:\/\//.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (ev, u) => { if (quiet && !twitchHost(u)) return ev.preventDefault(); if (!twitchHost(u) && !signinHost(u)) { ev.preventDefault(); if (/^https?:\/\//.test(u)) shell.openExternal(u); } });
  const where = (u) => { try { const x = new URL(u); return x.hostname + x.pathname.slice(0, 40); } catch (e) { return '?'; } };   // what the window does is written to app.log (addresses without their query, never cookie values), to see where a login stops
  w.webContents.on('did-navigate', (e, u) => log('twitch window ->', where(u))); w.webContents.on('did-fail-load', (e, code, desc, u, main) => { if (main) log('twitch window failed:', code, desc, where(u)); });
  w.webContents.on('console-message', (e) => { if (e.level === 'error' && /login|auth|passport|passkey|webauthn|captcha/i.test(e.message || '')) log('twitch window error:', String(e.message).slice(0, 140)); });
  w.loadURL(first); return w;
}
// The video window is Twitch's real channel page (only the real viewer earns channel points, drops and watch time), with everything but the video hidden, like a browser extension would.
const VIEWER_CSS = `
  [data-a-target="raid-banner"], [data-test-selector="raid-banner"], .raid-banner, [data-a-target="top-nav-container"], .top-nav__menu, nav, #side-nav, .side-nav, [data-test-selector="side-nav"], .channel-root__right-column, [data-test-selector="chat-room-component-layout"], .chat-shell,
  #live-channel-stream-information, .channel-root__info, .channel-root__upper-watch-live, button[data-a-target="right-column__toggle-collapse-btn"], button[aria-label^="Theatre Mode"], button[aria-label^="Expand Chat"], button[aria-label^="Collapse Chat"], .consent-banner, [data-a-target="consent-banner"], .community-highlight-stack__backlog-card, .tw-tooltip-wrapper--hidden { display: none !important; }
  html, body { overflow: hidden !important; background: #000 !important; }
  body { position: fixed !important; inset: 40px 0 0 0 !important; height: calc(100vh - 40px) !important; width: 100vw !important; transform: translateZ(0) !important; }   /* below our bar; a transformed body is what the fixed player below fills */
  .channel-root__player-container, .channel-root__player, .persistent-player, .video-player, .video-player__container { position: fixed !important; inset: 0 !important; width: 100% !important; height: 100% !important; max-height: none !important; z-index: 2147483000 !important; }
`;
// The title bar of the video window is drawn like the chat window's: the same colours (read from the chat window, so they follow its theme), the app icon, the stripe under it.
// Twitch's page gets a bar of our own at the top (it drags the window); the Windows buttons are the overlay on its right.
const BAR = 40;
let barLogo = '', barFont = '';
const assetB64 = (rel) => { try { return fs.readFileSync(path.join(SERVER_DIR, 'public', rel)).toString('base64'); } catch (e) { return ''; } };
async function chatTheme() {
  const d = { '--panel': '#1A2020', '--text': '#E2DAC2', '--accent': '#4FB3BF', '--accent2': '#E8A33D', '--danger': '#D9482B', '--flare': 'block' };
  try { const v = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify(Object.fromEntries(['--panel','--text','--accent','--accent2','--danger','--flare'].map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])))`)); for (const k of Object.keys(d)) if (/^#[0-9a-fA-F]{6}$/.test(v[k] || '')) d[k] = v[k]; if (v['--flare'] === 'none') d['--flare'] = 'none'; } catch (e) { /* the defaults */ }
  return d;
}
async function styleViewerBar(w, channel) {
  if (w.isDestroyed()) return; const t = await chatTheme(); barLogo = barLogo || assetB64('icon.png'); barFont = barFont || assetB64('fonts/imc-sans-400.ttf');
  try { w.setTitleBarOverlay({ color: t['--panel'], symbolColor: t['--text'], height: BAR }); } catch (e) { /* not supported */ }
  const css = `@font-face { font-family: "IMC Sans"; font-weight: 400; src: url(data:font/ttf;base64,${barFont}) format("truetype"); }
    #imc-bar { position: fixed; top: 0; left: 0; right: 0; height: ${BAR}px; z-index: 2147483647; display: flex; align-items: center; gap: 12px; padding: 0 150px 0 18px; box-sizing: border-box; background: ${t['--panel']}; color: ${t['--text']}; -webkit-app-region: drag; user-select: none; font: 400 15px "IMC Sans", "Segoe UI", sans-serif; letter-spacing: 3px; white-space: nowrap; overflow: hidden; }
    #imc-bar img { width: 24px; height: 24px; flex: none; pointer-events: none; } #imc-bar b { font-weight: 400; color: ${t['--accent']}; }
    #imc-bar span { flex: none; } #imc-game, #imc-title, #imc-viewers, #imc-up { font-size: 13px; letter-spacing: 1px; } #imc-game { color: ${t['--accent2']}; } #imc-game:not(:empty)::before { content: '\\2022'; color: ${t['--text']}; opacity: .5; margin-right: 12px; } #imc-title { flex: 1 1 auto !important; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: .75; } #imc-title:not(:empty)::before { content: '\\2022'; opacity: .5; margin-right: 12px; } #imc-viewers { color: ${t['--danger']}; } #imc-up { opacity: .75; } #imc-up:not(:empty)::before { content: '\\2022'; opacity: .5; margin-right: 12px; }
    #imc-bar::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; display: ${t['--flare']}; background: linear-gradient(90deg, ${t['--accent']} 0 30%, ${t['--accent2']} 30% 55%, ${t['--danger']} 55% 75%, ${t['--accent2']} 75% 90%, ${t['--text']} 90%); }`;
  if (w.__barCss) w.webContents.removeInsertedCSS(w.__barCss).catch(() => {}); w.__barCss = await w.webContents.insertCSS(css).catch(() => null);
  w.webContents.executeJavaScript(`(() => { window.__imcUp = window.__imcUp || (() => { const e = document.getElementById('imc-up'); if (!e) return; const s = e.dataset.since; if (!s) { e.textContent = ''; return; } const t = Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 1000)); e.textContent = 'live ' + Math.floor(t / 3600) + ':' + String(Math.floor(t % 3600 / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); }); if (!window.__imcUpT) window.__imcUpT = setInterval(() => { if (!document.hidden) window.__imcUp(); }, 1000); if (document.getElementById('imc-bar')) return; const b = document.createElement('div'); b.id = 'imc-bar'; b.innerHTML = '<img src="data:image/png;base64,${barLogo}" alt=""><span>' + ${JSON.stringify('#')} + '<b>' + ${JSON.stringify(channel)} + '</b></span><span id="imc-game"></span><span id="imc-title"></span><span id="imc-viewers"></span><span id="imc-up"></span>'; document.documentElement.appendChild(b); })()`).catch(() => {});
  viewerInfo(w, channel);
}
// the game, the stream title and the viewer count in the bar, from what the chat app already knows about the channel (refreshed every half minute)
async function viewerInfo(w, channel) {
  if (w.isDestroyed()) return; let live = null;
  try { const st = await (await fetch(url() + 'api/status')).json(); const c = (st.channels || []).find((x) => x.login === channel); live = c && c.live; } catch (e) { /* keep what is shown */ }
  const text = live ? { game: live.game || '', title: live.title || '', viewers: Number(live.viewers || 0).toLocaleString() + ' viewers', since: live.since || '' } : { game: '', title: 'offline', viewers: '', since: '' };
  w.webContents.executeJavaScript(`(() => { const t = ${JSON.stringify(text)}; for (const k of ['game', 'title', 'viewers']) { const el = document.getElementById('imc-' + k); if (el) el.textContent = t[k]; } const u = document.getElementById('imc-up'); if (u) { u.dataset.since = t.since; if (window.__imcUp) window.__imcUp(); } })()`).catch(() => {});
}
// like the VLC window: once the stream's picture size is known the window is fitted to it, and dragging an edge keeps its proportions
function fitToVideo(w) {
  const o0 = w.getSize(), c0 = w.getContentSize(), pad = { w: o0[0] - c0[0], h: o0[1] - c0[1] + BAR };   // the frame and our bar are not part of the picture
  let ratio = 0, last = '';
  w.on('will-resize', (e, nb, d) => {
    if (!ratio || w.isMaximized() || w.isFullScreen()) return;
    const edge = String((d && d.edge) || ''), byHeight = /^(top|bottom)$/.test(edge); let W = nb.width, H = nb.height;
    if (byHeight) W = Math.round((H - pad.h) * ratio) + pad.w; else H = Math.round((W - pad.w) / ratio) + pad.h;
    const x = /left/.test(edge) ? nb.x + nb.width - W : nb.x, y = /top/.test(edge) ? nb.y + nb.height - H : nb.y;   // pulling a left or top edge keeps the opposite edge where it is
    e.preventDefault(); w.setBounds({ x, y, width: W, height: H });
  });
  const t = setInterval(async () => {
    if (w.isDestroyed()) return clearInterval(t);
    const d = await w.webContents.executeJavaScript(`(() => { const v = document.querySelector('video'); return v && v.videoWidth ? [v.videoWidth, v.videoHeight] : null; })()`).catch(() => null);
    if (!d || w.isMaximized() || w.isFullScreen() || w.isMinimized()) return; const key = d.join('x'); if (key === last) return; last = key;
    ratio = d[0] / d[1]; const wa = screen.getDisplayMatching(w.getBounds()).workArea, cw = w.getContentSize()[0], width = Math.min(cw, Math.round(wa.width * 0.9)), height = Math.min(Math.round(width / ratio), Math.round(wa.height * 0.9));
    w.setContentSize(Math.round(height * ratio), height + BAR);
  }, 2000);
  w.on('closed', () => clearInterval(t));
}
const twitchSession = () => session.fromPartition(TWITCH_PARTITION);
let pointsTimer = null;
// Twitch's login must outlive the app: cookies without an expiry would be dropped when the app closes, so they are given one, and the store is written out soon after each change
let flushT = null;
function keepTwitchLogin() {
  const ses = twitchSession();
  ses.setUserAgent(ses.getUserAgent().replace(/\s*Electron\/\S+/, '').replace(/\s*imc-chat\/\S+/i, ''));   // a plain Chrome name: Google and Twitch's bot checks refuse a sign-in from "Electron"
  ses.cookies.on('changed', (e, c, cause, removed) => {
    if (removed && /^(auth-token|login|twilight-user)$/.test(c.name)) log('twitch login cookie removed:', c.name, cause);
    if (removed || !twitchHost('https://' + String(c.domain).replace(/^\./, ''))) return;
    if (c.session) ses.cookies.set({ url: 'https://' + String(c.domain).replace(/^\./, '') + (c.path || '/'), name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: Date.now() / 1000 + 365 * 86400 }).catch(() => {});
    if (/^(auth-token|login|twilight-user|persistent)$/.test(c.name)) { log('twitch login cookie', c.name, c.session ? '(session)' : '(persistent)'); ses.cookies.flushStore().catch(() => {}); }
    clearTimeout(flushT); flushT = setTimeout(() => ses.cookies.flushStore().catch(() => {}), 3000);
  });
  app.on('before-quit', () => { ses.cookies.flushStore().catch(() => {}); });
}
// the video viewer: a new window, or (when asked to reuse) the one that is already open pointed at the new channel
let viewerWin = null;
function showViewer(c, reuse) {
  if (reuse && viewerWin && !viewerWin.isDestroyed()) {
    if (viewerWin.__channel !== c) { viewerWin.__channel = c; viewerWin.setTitle('#' + c + ' - Twitch'); viewerWin.loadURL('https://www.twitch.tv/' + c); }   // the bar and the hiding are put back when the page has loaded
    return;
  }
  const vw = twitchWindow(Object.assign({ width: 1280, height: 720 + BAR }, savedBounds('viewer'), { minWidth: 420, minHeight: 260 + BAR, title: '#' + c + ' - Twitch', titleBarStyle: 'hidden', titleBarOverlay: { color: '#1A2020', symbolColor: '#E2DAC2', height: BAR } }), 'https://www.twitch.tv/' + c, true);
  if (!vw || vw.isDestroyed()) return; vw.__channel = c; viewerWin = vw; keepBounds(vw, 'viewer'); vw.on('closed', () => { if (viewerWin === vw) viewerWin = null; });
  const reapply = () => { vw.webContents.insertCSS(VIEWER_CSS).catch(() => {}); styleViewerBar(vw, vw.__channel); };
  // Raids: Twitch's page moves viewers to the channel being raided. The viewer stays on the channel it was opened on (and the raid prompt is hidden).
  const stay = (u, e) => { try { const p = new URL(u); if (!twitchHost(u)) return; const seg = (p.pathname.split('/')[1] || '').toLowerCase(); if (seg && seg !== String(vw.__channel).toLowerCase()) { if (e && e.preventDefault) e.preventDefault(); log('viewer stayed on', vw.__channel, 'instead of moving to', seg); vw.loadURL('https://www.twitch.tv/' + vw.__channel); } } catch (err) { /* not an address */ } };
  vw.webContents.on('will-navigate', (e, u) => { if (!/[?&]imc=1/.test(u)) stay(u, e); }); vw.webContents.on('did-navigate-in-page', (e, u) => stay(u));
  vw.webContents.on('did-finish-load', reapply); vw.webContents.on('did-navigate-in-page', reapply); fitToVideo(vw);
  const info = setInterval(() => (vw.isDestroyed() ? clearInterval(info) : viewerInfo(vw, vw.__channel)), 30000);
}
ipcMain.handle('twitch:player', (e, login, opt) => {
  const clip = opt && /^[A-Za-z0-9_-]{8,80}$/.test(String(opt.clip || '')) ? opt.clip : '';
  if (clip) { twitchWindow({ width: 1100, height: 640, minWidth: 420, minHeight: 260, title: String(opt.title || 'Clip').slice(0, 80) + ' - Twitch' }, 'https://clips.twitch.tv/embed?clip=' + encodeURIComponent(clip) + '&parent=twitch.tv&autoplay=true&muted=false'); return { ok: true }; }
  const c = String(login || '').toLowerCase(); if (!/^[a-z0-9_]{3,25}$/.test(c)) return { error: 'Unknown channel' };
  showViewer(c, !!(opt && opt.reuse)); return { ok: true };
});
// Channel points: for every live channel (when the setting is on) a hidden window shows Twitch's own chat-only page in the app's logged-in Twitch session.
// points-preload.js on that page reads the balance and presses "Claim Bonus"; the result goes to the local server, which shows it on the tab.
const pointsWins = new Map();
// Each hidden page costs 150-250 MB, so only channels that are open get one: the tab being looked at, a popout chat, a video window, a player window.
async function openChannels() {
  const open = new Set(), hidden = new Set(pointsWins.values());
  for (const w of BrowserWindow.getAllWindows()) { if (w.isDestroyed() || hidden.has(w)) continue; const c = channelFromUrl(w.webContents.getURL()); if (c) open.add(c); }
  if (vlcWindows) for (const login of vlcWindows.wins.keys()) if (LOGIN.test(login)) open.add(login);
  if (win && !win.isDestroyed() && (win.isVisible() || win.isMinimized())) {   // a main window hidden in the tray is not being looked at
    try { const c = String(await win.webContents.executeJavaScript('typeof cur === "string" ? cur : ""')).toLowerCase(); if (LOGIN.test(c)) open.add(c); } catch (e) { /* page still loading */ }
  }
  return open;
}
let pointsBusy = false;
function pointsTick() {
  if (pointsBusy) return; pointsBusy = true;
  fetch(url() + 'api/status').then((r) => r.json()).then(async (s) => {
    const on = !!(s.settings && s.settings.channelPoints && s.auth && s.auth.status === 'ok'), open = on ? await openChannels() : new Set();
    const want = new Set(on ? wantedPointsChannels(s.channels.filter((c) => c.live).map((c) => c.login), open, 10) : []);
    for (const [login, w] of Array.from(pointsWins)) if (!want.has(login) || w.isDestroyed()) { if (!w.isDestroyed()) w.destroy(); pointsWins.delete(login); }
    for (const login of want) if (!pointsWins.has(login)) openPointsWindow(login);
  }).catch(() => {}).finally(() => { pointsBusy = false; });
}
// Moving to another tab starts (and stops) the right hidden pages within a couple of seconds instead of at the next 20 second round.
let lastOpenKey = '';
async function watchOpenChannels() { try { const key = Array.from(await openChannels()).sort().join(','); if (key !== lastOpenKey) { lastOpenKey = key; pointsTick(); } } catch (e) { /* ignore */ } }
function openPointsWindow(login) {
  if (!/^[a-z0-9_]{3,25}$/.test(login)) return;
  const w = new BrowserWindow({ show: false, width: 420, height: 700, webPreferences: { partition: TWITCH_PARTITION, preload: path.join(__dirname, 'points-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, additionalArguments: ['--imc-channel=' + login] } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); w.webContents.on('will-navigate', (ev, u) => { if (!twitchHost(u)) ev.preventDefault(); });
  const home = 'https://www.twitch.tv/popout/' + login + '/chat', stay = (u, e) => { try { if (twitchHost(u) && !new URL(u).pathname.toLowerCase().startsWith('/popout/' + login + '/chat')) { if (e && e.preventDefault) e.preventDefault(); log('points reader stayed on', login, 'after a raid'); w.loadURL(home); } } catch (err) { /* not an address */ } };   // a raid must not carry this page to another channel
  w.webContents.on('will-navigate', (e, u) => stay(u, e)); w.webContents.on('did-navigate-in-page', (e, u) => stay(u));
  w.webContents.setAudioMuted(true); w.on('closed', () => { if (pointsWins.get(login) === w) pointsWins.delete(login); });
  pointsWins.set(login, w); w.loadURL('https://www.twitch.tv/popout/' + login + '/chat');
}
// IMC-Chat's own rewards list: commands go to the hidden Twitch page of that channel (the reader in points-preload.js), and its answer comes back
const pointsPending = new Map(); let pointsCmdId = 0;
ipcMain.on('points:reply', (e, id, r) => { const done = pointsPending.get(id); if (done) { pointsPending.delete(id); done(r); } });
const askPointsPage = (w, cmd, arg) => { const id = ++pointsCmdId; return new Promise((resolve) => { pointsPending.set(id, resolve); w.webContents.send('points:cmd', id, String(cmd), arg); setTimeout(() => { if (pointsPending.delete(id)) resolve({ error: 'Twitch did not answer' }); }, 15000); }); };
ipcMain.handle('points:cmd', async (e, login, cmd, arg) => {
  const w = pointsWins.get(String(login || '').toLowerCase()); if (!w || w.isDestroyed()) return { error: 'The points reader is not running for this channel yet' };
  const r = await askPointsPage(w, cmd, arg);
  return r;
});
ipcMain.on('points:update', (e, d) => {
  if (!d || !/^[a-z0-9_]{3,25}$/.test(String(d.channel))) return;
  fetch(url() + 'api/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: d.channel, balance: String(d.balance || ''), bits: String(d.bits || ''), claimed: !!d.claimed }) }).catch(() => {});
});
// with an address (the page that approves IMC-Chat's login code) it opens that page here, in the same Twitch window the video uses, so connecting the chat and logging in for the video are one login
ipcMain.handle('twitch:login', (e, target) => { const first = typeof target === 'string' && /^https:\/\//.test(target) && twitchHost(target) ? target : 'https://www.twitch.tv/login'; twitchWindow({ width: 560, height: 800, title: 'Log in to Twitch' }, first); return { ok: true }; });
ipcMain.handle('twitch:status', async () => { try { return { loggedIn: (await twitchSession().cookies.get({ name: 'auth-token' })).length > 0 }; } catch (err) { return { loggedIn: false }; } });
ipcMain.handle('twitch:logout', async () => { try { await twitchSession().clearStorageData(); return { ok: true }; } catch (err) { return { error: err.message }; } });
ipcMain.handle('player:watch', async (e, login, opt) => {
  vlcWindows = vlcWindows || createVlcWindows({ url, icon: icon('icon.png'), preload: path.join(__dirname, 'player-preload.js'), log, openChat: chatPopout, bounds: () => savedBounds('player'), keep: (w) => keepBounds(w, 'player'), locate: require(path.join(SERVER_DIR, 'player.js'))({}).locate });
  if (opt && opt.reuse) { const want = String(login || '').toLowerCase(); for (const r of Array.from(vlcWindows.wins.values())) if (r.login !== want && !r.host.isDestroyed()) r.host.close(); }
  try { return await vlcWindows.watch(login, opt && { playerPath: String(opt.playerPath || ''), quality: 'best', ads: opt.ads === 'show' ? 'show' : 'skip', clip: String(opt.clip || ''), title: String(opt.title || ''), chat: String(opt.chat || '') }); } catch (err) { return { error: err.message }; }
});
ipcMain.on('flash', () => { if (win && !win.isFocused()) win.flashFrame(true); });   // a mention while the window is in the background: the taskbar button flashes
app.on('second-instance', openWindow);
app.whenReady().then(() => {
  app.setAppUserModelId('com.itmecasey.imcchat'); tray = new Tray(icon('tray-grey.png').resize({ width: 24, height: 24 })); tray.on('click', openWindow); refreshTray(); startServer(); keepTwitchLogin(); pointsTimer = setInterval(pointsTick, 20000); setInterval(watchOpenChannels, 2000);
  if (!process.argv.includes('--hidden')) openWindow();
});
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; if (vlcWindows) vlcWindows.closeAll(); if (sup) sup.stop(); });
