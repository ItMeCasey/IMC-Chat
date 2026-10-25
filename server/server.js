'use strict';
/** IMC-Chat: a local server that joins Twitch chats for you. The window (or any browser) at http://localhost:8430 is the chat client. No dependencies. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const createTwitch = require('./twitch.js');
const player = require('./player.js')({});
const thirdParty = require('./emotes.js')({ log: (...a) => console.log(...a) }).forChannel;

const DATA = process.env.IMC_DATA || path.join(__dirname, 'data'), PORT = Number(process.env.IMC_PORT) || 8430, STARTED = Date.now();
fs.mkdirSync(DATA, { recursive: true });
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch (e) { return {}; } })();
const clientId = process.env.IMC_CLIENT_ID || cfg.clientId || JSON.parse(fs.readFileSync(path.join(__dirname, 'default-client.json'), 'utf8')).clientId;
const VERSION = process.env.IMC_VERSION || (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'package.json'), 'utf8')).version; } catch (e) { return ''; } })();
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.join(' '); console.log(line); };

const clients = new Set();
function broadcast(event, data) { const s = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; for (const r of clients) { try { r.write(s); } catch (e) { clients.delete(r); } } }
const twitch = createTwitch({ dir: DATA, clientId, log, emit: broadcast, thirdParty, customClient: !!(process.env.IMC_CLIENT_ID || cfg.clientId) });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
const json = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(v)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } }); });

const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '');   // only this PC may talk to the server (a web page elsewhere cannot make you send chat)
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { res.writeHead(403); return res.end('local only'); }
  const p = new URL(req.url, 'http://localhost').pathname;
  try {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write('retry: 2000\n\n');
      clients.add(res); req.on('close', () => clients.delete(res)); return res.write('event: status\ndata: ' + JSON.stringify(twitch.status()) + '\n\n');
    }
    if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION, light: twitch.status().connected ? 'green' : 'amber', uptime: Math.round((Date.now() - STARTED) / 1000) });
    if (p === '/api/status') return json(res, 200, twitch.status());
    if (p === '/api/badges') return json(res, 200, await twitch.badges(new URL(req.url, 'http://localhost').searchParams.get('channel')));
    if (p === '/api/followed') return json(res, 200, await twitch.followed().then((list) => ({ list }), (e) => ({ error: e.message })));
    if (p === '/api/export') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="imc-chat-backup.json"', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(twitch.exportData(), null, 2)); }
    if (p === '/api/emotes') return json(res, 200, await twitch.emotes(new URL(req.url, 'http://localhost').searchParams.get('channel')).catch((e) => ({ error: e.message })));
    if (p === '/api/user') return json(res, 200, await twitch.userInfo(new URL(req.url, 'http://localhost').searchParams.get('id')).catch((e) => ({ error: e.message })));
    if (p === '/api/history') return json(res, 200, twitch.history(new URL(req.url, 'http://localhost').searchParams.get('channel')));
    if (req.method === 'POST' && p.startsWith('/api/')) {
      if ((req.headers['content-type'] || '').indexOf('application/json') < 0) return json(res, 415, { error: 'JSON only' });
      const b = await readBody(req);
      try {
        if (p === '/api/login') return json(res, 200, await twitch.startLogin());
        if (p === '/api/logout') { twitch.logout(); return json(res, 200, twitch.status()); }
        if (p === '/api/join') return json(res, 200, await twitch.join(b.channel));
        if (p === '/api/leave') return json(res, 200, await twitch.leave(b.channel));
        if (p === '/api/addchannels') { const r = await twitch.addLogins(Array.isArray(b.logins) ? b.logins.slice(0, 200) : []); return json(res, 200, Object.assign({ status: twitch.status() }, r)); }
        if (p === '/api/import') return json(res, 200, await twitch.importData(b));
        if (p === '/api/play') return json(res, 200, await player.play(b.channel, twitch.status().settings.playerPath, { pref: twitch.status().settings.playerPref, style: twitch.status().settings.playerStyle }));
        if (p === '/api/streamlink') return json(res, 200, await player.install(b.what));
        if (p === '/api/playerinfo') return json(res, 200, player.info(twitch.status().settings.playerPath, twitch.status().settings.playerPref));
        if (p === '/api/settings') return json(res, 200, twitch.configure(b));
        if (p === '/api/move') return json(res, 200, twitch.move(b.channel, b.to));
        if (p === '/api/mod') return json(res, 200, await twitch.mod(b.channel, b.action, b));
        if (p === '/api/send') return json(res, 200, await twitch.send(b.channel, b.text, b.replyTo));
        if (p === '/api/restart') { json(res, 200, { ok: true }); return setTimeout(() => process.exit(75), 200); }
      } catch (e) { return json(res, 200, { error: e.message }); }
      return json(res, 404, { error: 'unknown' });
    }
    const file = p === '/' ? 'index.html' : p.slice(1), full = path.join(__dirname, 'public', file);
    if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': p.startsWith('/fonts/') && p.endsWith('.ttf') ? 'public, max-age=86400' : 'no-store' }); fs.createReadStream(full).pipe(res);
  } catch (e) { log('request failed:', e.message); if (!res.headersSent) json(res, 500, { error: e.message }); }
});
server.listen(PORT, '127.0.0.1', () => { log('IMC-Chat on http://localhost:' + PORT); twitch.connect(); });
process.on('uncaughtException', (e) => log('error:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('error:', e && e.stack || e));
