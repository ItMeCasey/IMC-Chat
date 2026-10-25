'use strict';
/**
 * IMC-Chat's own player window: a normal resizable window with VLC drawing the video inside it and our own controls floating over the video.
 *  - the window (frame, title, resize) is sized to the video once VLC knows its dimensions;
 *  - a borderless window over it takes VLC's picture (--drawable-hwnd), and a transparent window above that holds the controls (a native
 *    video window can not be drawn over by a web page, so the controls are a window of their own);
 *  - Streamlink feeds VLC; VLC's own web interface (localhost, random port and password) is how the controls drive it.
 * The controls show while the mouse moves over the window and hide after a few idle seconds.
 */
const { BrowserWindow, screen, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const { parseAds, adLeft } = require('./hls-ads.js');

const BAR = 76, HEAD = 40, EDGE = 8, IDLE_MS = 3000, QUALITIES = ['best', '2160p60', '2160p', '1440p60', '1440p', '1080p60', '1080p', '720p60', '720p', '480p', '360p', '160p', 'audio_only'];

module.exports = function createVlcWindows(o) {
  const wins = new Map();   // channel -> record

  const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  /** one call to VLC's web interface: returns its status, or null */
  const vlcReq = (port, pw, query) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/requests/status.json' + (query ? '?' + query : ''), headers: { Authorization: 'Basic ' + Buffer.from(':' + pw).toString('base64') }, timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); r.end();
  });
  /** the picture size VLC reports for the stream it is playing, or null until it knows */
  const videoSize = (st) => {
    const cats = (st && st.information && st.information.category) || {};
    for (const k of Object.keys(cats)) { const m = /^(\d{2,5})x(\d{2,5})$/.exec(String((cats[k] || {}).Video_resolution || '')); if (m) return { w: Number(m[1]), h: Number(m[2]) }; }
    return null;
  };
  /** one command to VLC's remote-control socket (it lists and switches subtitle tracks); resolves what VLC answered */
  const rcCall = (port, cmd) => new Promise((resolve) => {
    let out = ''; const c = net.connect(port, '127.0.0.1'), done = () => { clearTimeout(t); c.destroy(); resolve(out); }, t = setTimeout(done, 1500);
    c.on('connect', () => c.write(cmd + '\n')); c.on('data', (d) => { out += d; if (/returned -?\d+/.test(out)) setTimeout(done, 40); }); c.on('error', () => { clearTimeout(t); resolve(''); });
  });
  /** how many closed-caption tracks VLC found inside the stream (it only sees them once the video is decoding) */
  const captionTracks = (st) => { const cats = (st && st.information && st.information.category) || {}; return Object.keys(cats).filter((k) => /^subtitle$/i.test(String((cats[k] || {}).Type || ''))).length; };
  /** the qualities Streamlink can offer for a channel (it asks Twitch once) */
  const listQualities = (sl, target) => new Promise((resolve) => {
    let out = ''; let c; try { c = spawn(sl, ['--json', target], { windowsHide: true, shell: false }); } catch (e) { return resolve([]); }
    const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } resolve([]); }, 15000);
    c.stdout.on('data', (d) => { out += d; }); c.on('error', () => { clearTimeout(t); resolve([]); });
    c.on('exit', () => { clearTimeout(t); try { const names = Object.keys(JSON.parse(out).streams || {}); resolve(QUALITIES.filter((q) => names.includes(q))); } catch (e) { resolve([]); } });
  });
  const killTree = (pid) => { if (pid) { try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* gone */ } } };

  async function watch(channel, opt) {
    const clipId = opt && /^[A-Za-z0-9_-]{8,80}$/.test(String(opt.clip || '')) ? opt.clip : '';   // a clip plays in the same window as a stream, under a made-up name of its own
    const login = clipId ? 'clip_' + crypto.createHash('md5').update(clipId).digest('hex').slice(0, 12) : String(channel || '').toLowerCase(); if (!clipId && !/^[a-z0-9_]{3,25}$/.test(login)) throw new Error('Unknown channel');
    const target = clipId ? 'https://clips.twitch.tv/' + clipId : 'https://www.twitch.tv/' + login;
    const have = wins.get(login); if (have && !have.host.isDestroyed()) { if (have.host.isMinimized()) have.host.restore(); have.host.show(); have.host.focus(); return { ok: true, player: 'VLC', again: true }; }
    const found = o.locate(opt && opt.playerPath, 'vlc'); if (!found.streamlink) throw new Error('Streamlink is not installed. Press Install Streamlink in Settings.');
    if (!found.player || found.player.kind !== 'vlc') throw new Error('VLC was not found. Install VLC (videolan.org), or choose another window style in Settings.');
    const port = await freePort(), rcPort = await freePort(), pw = crypto.randomBytes(9).toString('hex'), web = { preload: o.preload, contextIsolation: true, sandbox: true };
    const host = new BrowserWindow({ width: 960, height: 540, useContentSize: true, minWidth: 320, minHeight: 200, backgroundColor: '#000000', title: (clipId ? String((opt && opt.title) || 'Clip').slice(0, 80) : '#' + login) + ' - IMC-Chat', icon: o.icon, autoHideMenuBar: true, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#1A2020', symbolColor: '#E2DAC2', height: HEAD }, webPreferences: web });   // the title strip is the page's own, themed like the chat
    const video = new BrowserWindow({ parent: host, frame: false, show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, hasShadow: false, backgroundColor: '#000000' });
    // VLC's own window swallows the mouse, so an almost invisible window sits over the picture to catch clicks: a click gives the player window the keyboard,
    // a double click maximises or restores it (it never takes focus itself, so it stays under the controls)
    const hit = new BrowserWindow({ parent: video, frame: false, transparent: true, backgroundColor: '#03000000', show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, hasShadow: false, webPreferences: web });
    const ctl = new BrowserWindow({ parent: video, frame: false, transparent: true, backgroundColor: '#00000000', show: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, hasShadow: false, webPreferences: web });
    const rec = { login, chat: clipId ? String((opt && opt.chat) || '') : login, host, video, hit, ctl, head: HEAD, cc: 0, rc: rcPort, ads: !clipId && (opt && opt.ads) === 'show' ? 'show' : 'skip', adMuted: false, hls: '', lagMs: 6000, adSeen: 0, port, pw, bar: true, menu: 0, shown: false, quality: (opt && opt.quality) || 'best', qualities: [], proc: null, ended: '', closing: false, vol: opt && Number.isFinite(opt.volume) ? opt.volume : 100, last: { x: -1, y: -1 }, moved: Date.now() };
    wins.set(login, rec);
    const gone = () => host.isDestroyed() || video.isDestroyed() || hit.isDestroyed() || ctl.isDestroyed();
    const showVideo = () => { if (!video.isDestroyed()) video.showInactive(); if (!hit.isDestroyed()) hit.showInactive(); };
    const hideVideo = () => { if (!hit.isDestroyed()) hit.hide(); if (!video.isDestroyed()) video.hide(); };
    const place = () => {   // the video covers the whole content area; the controls float along its bottom edge
      if (gone()) return; const cb = host.getContentBounds(), head = host.isFullScreen() ? 0 : HEAD, vh = Math.max(40, cb.height - head);
      const edge = host.isFullScreen() || host.isMaximized() ? 0 : EDGE, vw = Math.max(40, cb.width - 2 * edge), vv = Math.max(40, vh - edge);   // a thin black margin keeps the window's edges free, so they can be grabbed to resize
      video.setBounds({ x: cb.x + edge, y: cb.y + head, width: vw, height: vv }); hit.setBounds({ x: cb.x + edge, y: cb.y + head, width: vw, height: Math.max(40, vv - BAR - rec.menu) });   // the catcher stops above the control strip (and above an open quality menu), so it never covers the buttons
      const ch = Math.min(BAR + rec.menu, vv); ctl.setBounds({ x: cb.x + edge, y: cb.y + head + vv - ch, width: vw, height: ch });   // an open quality menu grows the controls window upward
    };
    const showControls = (on) => { if (gone()) return; if (on && rec.shown && !rec.ended && !host.isMinimized()) ctl.showInactive(); else ctl.hide(); };
    const send = (d) => { for (const w of [host, ctl]) if (!w.isDestroyed()) w.webContents.send('player:event', d); };
    const start = () => {
      killTree(rec.proc && rec.proc.pid); rec.ended = '';
      const hwnd = video.getNativeWindowHandle().readBigUInt64LE(0).toString();
      const vlcArgs = ['--drawable-hwnd=' + hwnd, '--no-video-title-show', '--intf', 'rc', '--rc-host=127.0.0.1:' + rcPort, '--rc-quiet', '--extraintf=http', '--http-host=127.0.0.1', '--http-port=' + port, '--http-password=' + pw, '--volume=' + Math.round(rec.vol * 2.56), '--no-qt-privacy-ask'];
      rec.ad = null; rec.adMuted = false; rec.hls = ''; rec.cc = 0;
      if (rec.ads === 'show') return startRaw(vlcArgs);   // the stream as Twitch sends it, ads included; we mute VLC while an ad plays
      const pa = vlcArgs.join(' ');
      let out = ''; const c = spawn(found.streamlink, ['--player', found.player.path, '--player-args=' + pa, '--title', '{author} - {title}', target, rec.quality], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      rec.proc = c;
      const grab = (d) => {
        const t = String(d); if (out.length < 4000) out += t;
        // Twitch's ad breaks: Streamlink skips them and pauses the picture until they are over, and says so in its log
        const m = /advertisement break of (\d+) seconds/i.exec(t); if (m) rec.ad = { until: Date.now() + Number(m[1]) * 1000 + 4000, seconds: Number(m[1]) };
        if (/resuming stream output/i.test(t)) rec.ad = null;
      };
      c.stdout.on('data', grab); c.stderr.on('data', grab);
      c.on('exit', (code) => {
        if (rec.proc !== c || rec.closing) return; rec.ended = /offline|no playable streams|not found/i.test(out) ? 'The stream is offline' : code === 0 ? 'The stream ended' : (out.trim().split('\n').pop() || 'The player stopped').replace(/^\[cli\]\[error\]\s*/, '').slice(0, 160);
        if (!gone()) { hideVideo(); showControls(false); if (!rec.shown) reveal(); } send({ type: 'state', ended: rec.ended });
      });
      if (rec.shown && !video.isDestroyed()) showVideo();
    };
    /** "show ads, muted": Streamlink only finds the stream's address; VLC plays it itself, ad breaks and all */
    const startRaw = (vlcArgs) => {
      let urlOut = '', errOut = ''; const f = spawn(found.streamlink, ['--stream-url', target, rec.quality], { windowsHide: true, shell: false });
      rec.proc = f; f.stdout.on('data', (d) => { urlOut += d; }); f.stderr.on('data', (d) => { if (errOut.length < 2000) errOut += d; });
      const fail = (why) => { if (rec.proc !== f || rec.closing) return; rec.ended = why; if (!gone()) { hideVideo(); showControls(false); if (!rec.shown) reveal(); } send({ type: 'state', ended: rec.ended }); };
      f.on('error', (e) => fail('Could not start Streamlink: ' + e.message));
      f.on('exit', (code) => {
        if (rec.proc !== f || rec.closing) return; const url = urlOut.trim().split(/\r?\n/).pop();
        if (code !== 0 || !/^https:\/\//.test(url)) return fail(/offline|no playable streams|not found/i.test(errOut) ? 'The stream is offline' : (errOut.trim().split('\n').pop() || 'No stream address').replace(/^\[cli\]\[error\]\s*/, '').slice(0, 160));
        rec.hls = url; const v = spawn(found.player.path, [url].concat(vlcArgs), { windowsHide: false, shell: false, stdio: 'ignore' }); rec.proc = v;
        v.on('exit', () => { if (rec.proc !== v || rec.closing) return; rec.ended = 'The stream ended'; if (!gone()) { hideVideo(); showControls(false); if (!rec.shown) reveal(); } send({ type: 'state', ended: rec.ended }); });
        if (rec.shown && !video.isDestroyed()) showVideo(); place();
      });
    };
    /** look at the stream's playlist for an ad break; mute VLC while it plays, restore the volume after */
    const watchAds = async () => {
      if (rec.ads !== 'show' || !rec.hls || rec.ended) return;
      let text = ''; try { const r = await fetch(rec.hls, { signal: AbortSignal.timeout(4000) }); text = r.ok ? await r.text() : ''; } catch (e) { return; }
      const left = adLeft(parseAds(text), rec.lagMs); rec.ad = left ? { until: Date.now() + left * 1000, seconds: left } : null;
      if (left && !rec.adMuted) { rec.adMuted = true; vlcReq(port, pw, 'command=volume&val=0'); }
      else if (!left && rec.adMuted) { rec.adMuted = false; vlcReq(port, pw, 'command=volume&val=' + Math.round(rec.vol * 2.56)); }
    };
    /** the window appears once VLC knows the picture size, sized to it (or after a while, 16:9, or at once with a message if there is no stream) */
    const reveal = (size) => {
      if (rec.shown || gone()) return; rec.shown = true;
      if (size) {   // as wide as 960 css px, or the screen allows, with the picture's own proportions
        const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, w = Math.round(Math.min(960, wa.width * 0.8, (wa.height * 0.8) * (size.w / size.h))), h = Math.round(w * size.h / size.w);
        const sb = o.bounds && o.bounds(), cw = sb ? Math.min(Math.max(320, sb.width - 2 * EDGE), wa.width) : Math.max(320, w);   // the width it had last time, if it was moved or resized
        host.setContentSize(cw + 2 * EDGE, Math.round(cw * size.h / size.w) + HEAD + EDGE);
      }
      rec.ratio = size ? size.w / size.h : 16 / 9;   // resizing keeps the picture's proportions
      const at = o.bounds && o.bounds(); if (at) host.setPosition(at.x, at.y); else host.center();   // where it was last time, else the middle of the screen
      if (o.keep) o.keep(host); host.show(); place(); if (!rec.ended) { showVideo(); showControls(true); }
    };
    ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((e) => host.on(e, place));
    // you can resize the window freely, but the picture keeps its own proportions (the title strip and the thin margins are not part of it)
    host.on('will-resize', (e, nb, d) => {
      if (!rec.ratio || host.isFullScreen() || host.isMaximized()) return;
      const edge = String((d && d.edge) || ''), byHeight = /^(top|bottom)$/.test(edge), padW = 2 * EDGE, padH = HEAD + EDGE;
      let w = nb.width, h = nb.height; if (byHeight) w = Math.round((h - padH) * rec.ratio) + padW; else h = Math.round((w - padW) / rec.ratio) + padH;
      const x = /left/.test(edge) ? nb.x + nb.width - w : nb.x, y = /top/.test(edge) ? nb.y + nb.height - h : nb.y;   // pulling a left or top edge keeps the opposite edge where it is
      e.preventDefault(); host.setBounds({ x, y, width: w, height: h });
    });
    host.on('minimize', () => { if (!gone()) { hideVideo(); ctl.hide(); } });
    host.on('restore', () => { if (!gone()) { if (!rec.ended) showVideo(); place(); showControls(rec.bar); } });
    host.on('page-title-updated', (e) => e.preventDefault());   // the window keeps its channel title
    let sized = false, adTick = 0; const t0 = Date.now();
    const timer = setInterval(async () => {   // the controls follow the mouse; VLC's state goes to the controls; the first picture size sizes the window
      if (gone()) return; const pt = screen.getCursorScreenPoint(), b = host.getContentBounds(), inside = rec.shown && host.isVisible() && !host.isMinimized() && pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
      if (pt.x !== rec.last.x || pt.y !== rec.last.y) { rec.last = pt; rec.moved = Date.now(); }
      const overBar = rec.bar && inside && pt.y >= b.y + b.height - BAR, want = inside && (Date.now() - rec.moved < IDLE_MS || overBar || rec.menu > 0);
      if (want !== rec.bar) { rec.bar = want; showControls(want); send({ type: 'bar', show: want }); }
      if (rec.ads === 'show' && ++adTick % 3 === 0) watchAds();
      const st = rec.ended ? null : await vlcReq(port, pw, ''); if (gone()) return;
      if (!sized && st) { const size = videoSize(st); if (size) { sized = true; reveal(size); } }
      if (!rec.shown && !sized && Date.now() - t0 > 15000) reveal(null);
      send({ type: 'state', state: st ? st.state : rec.ended ? 'ended' : 'starting', volume: st ? Math.round(st.volume / 2.56) : rec.vol, top: host.isAlwaysOnTop(), full: host.isFullScreen(), quality: rec.quality, qualities: rec.qualities, ended: rec.ended, ad: rec.ad && rec.ad.until > Date.now() ? Math.ceil((rec.ad.until - Date.now()) / 1000) : 0, adMuted: rec.adMuted, cc: st ? captionTracks(st) : 0, ccOn: rec.cc > 0 ? rec.cc : 0 });
    }, 600);
    host.on('closed', () => { rec.closing = true; clearInterval(timer); killTree(rec.proc && rec.proc.pid); for (const w of [ctl, hit, video]) if (!w.isDestroyed()) w.destroy(); wins.delete(login); });
    host.webContents.once('did-finish-load', () => { send({ type: 'init', channel: login }); }); ctl.webContents.once('did-finish-load', () => { send({ type: 'init', channel: login }); });
    hit.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:rgba(0,0,0,0.012);height:100vh;cursor:default"></body><script>document.addEventListener("mousedown",()=>window.imcPlayer&&imcPlayer.cmd({a:"focus"}));document.addEventListener("dblclick",()=>window.imcPlayer&&imcPlayer.cmd({a:"max"}));</script>'));
    await video.loadURL('data:text/html;charset=utf-8,<body style="background:%23000;margin:0"></body>');
    host.loadURL(o.url() + 'player.html?channel=' + encodeURIComponent(login)); ctl.loadURL(o.url() + 'player-controls.html?channel=' + encodeURIComponent(login));
    start(); listQualities(found.streamlink, target).then((q) => { rec.qualities = q; });
    rec.restart = (q) => { rec.quality = q; start(); }; rec.place = place;
    return { ok: true, player: 'VLC' };
  }

  /** what the controls ask for */
  async function command(wc, c) {
    const rec = Array.from(wins.values()).find((r) => !r.host.isDestroyed() && (r.host.webContents.id === wc.id || (!r.ctl.isDestroyed() && r.ctl.webContents.id === wc.id) || (!r.hit.isDestroyed() && r.hit.webContents.id === wc.id))); return run(rec, c);
  }
  async function run(rec, c) {
    if (!rec || !c) return null;
    const q = (x) => vlcReq(rec.port, rec.pw, x);
    switch (c.a) {
      case 'pause': return q('command=pl_pause');
      case 'volume': rec.vol = Math.max(0, Math.min(100, Math.round(Number(c.v) || 0))); return rec.adMuted ? null : q('command=volume&val=' + Math.round(rec.vol * 2.56));   // during a muted ad the new volume waits for the ad to end
      case 'top': rec.host.setAlwaysOnTop(!rec.host.isAlwaysOnTop()); return null;
      case 'focus': if (!rec.host.isDestroyed() && !rec.host.isFocused()) rec.host.focus(); return null;   // a click on the picture: the player window gets the keyboard (Space pauses)
      case 'max': if (rec.host.isFullScreen()) rec.host.setFullScreen(false); else if (rec.host.isMaximized()) rec.host.unmaximize(); else rec.host.maximize(); return null;   // a double click
      case 'full': rec.host.setFullScreen(!rec.host.isFullScreen()); return null;
      case 'quality': if (QUALITIES.includes(c.q) && (rec.qualities.includes(c.q) || c.q === 'best')) rec.restart(c.q); return null;
      case 'menu': rec.menu = Math.max(0, Math.min(420, Math.round(Number(c.h) || 0))); rec.place(); return null;   // the quality menu opens upward, so the controls window makes room for it
      case 'cc': {   // closed captions: ask VLC for its subtitle tracks and pick the next one; after the last they switch off again
        const list = await rcCall(rec.rc, 'strack'), ids = Array.from(list.matchAll(/\|\s*(\d+) - /g)).map((m) => Number(m[1])); if (!ids.length) return null;
        const cur = /\|\s*(-?\d+) - [^\n]*\*\s*$/m.exec(list), at = cur && Number(cur[1]) >= 0 ? ids.indexOf(Number(cur[1])) : -1, next = at + 1 < ids.length ? ids[at + 1] : -1;
        await rcCall(rec.rc, 'strack ' + next); rec.cc = next < 0 ? 0 : ids.indexOf(next) + 1; return null;
      }
      case 'chat': if (o.openChat && rec.chat) o.openChat(rec.chat); return null;
      case 'retry': rec.restart(rec.quality); return null;
      case 'close': rec.host.close(); return null;
      default: return null;
    }
  }
  ipcMain.handle('player:cmd', (e, c) => command(e.sender, c));
  ipcMain.on('player:theme', (e, t) => {   // the window buttons take the chat's theme colours
    const hex = /^#[0-9a-fA-F]{6}$/, rec = Array.from(wins.values()).find((r) => !r.host.isDestroyed() && r.host.webContents.id === e.sender.id);
    if (rec && t && hex.test(t.color) && hex.test(t.symbolColor)) { try { rec.host.setTitleBarOverlay({ color: t.color, symbolColor: t.symbolColor, height: HEAD }); } catch (err) { /* not supported */ } }
  });
  const closeAll = () => { for (const r of wins.values()) { r.closing = true; killTree(r.proc && r.proc.pid); } };
  return { watch, closeAll, wins, videoSize, control: (login, c) => run(wins.get(String(login).toLowerCase()), c) };
};
