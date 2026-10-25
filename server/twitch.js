'use strict';
/**
 * IMC-Chat's Twitch side: login (device code, like IMC-Stream), the channels you joined (remembered between sessions), and one EventSub connection that
 * carries the chat of all of them: messages, GIFs, announcements, subs, gifts, raids and cheers. For channels where you are a moderator it also does the mod actions.
 */
const fs = require('node:fs');
const path = require('node:path');

const CHAT_SCOPES = ['user:read:chat', 'user:write:chat'];
const MOD_SCOPES = ['user:read:moderated_channels', 'moderator:manage:banned_users', 'moderator:manage:chat_messages', 'moderator:manage:chat_settings', 'moderator:read:chat_settings'];
const EMOTE_SCOPE = 'user:read:emotes';
const FOLLOW_SCOPE = 'user:read:follows', MAX_CHANNELS = 100, SUB_BUDGET = 300, EXTRA_SUBS = 14;   // Twitch allows 300 subscriptions on one connection: every channel needs 2 (messages, notices), the moderation events go to as many as fit
const EVENT_GROUPS = ['subs', 'gifts', 'forward', 'raids', 'announce', 'bitsbadge', 'charity', 'sharedsubs', 'redeem', 'hype', 'poll', 'prediction', 'ads'];   // the kinds of chat event that can be hidden (the page maps each to its notice types)
const OWN_SCOPES = ['channel:read:redemptions', 'channel:read:hype_train', 'channel:read:polls', 'channel:read:predictions', 'channel:read:ads'];   // only the broadcaster can read these, so they only work in your own channel
const CLIP_SCOPE = 'clips:edit';
const SUB_SCOPE = 'user:read:subscriptions';   // to tell whether you are subscribed to a channel
const WHISPER_SCOPES = ['user:read:whispers', 'user:manage:whispers'];   // to receive whispers and to answer them
const SCOPES = CHAT_SCOPES.concat(MOD_SCOPES, [EMOTE_SCOPE, FOLLOW_SCOPE], OWN_SCOPES, [CLIP_SCOPE, SUB_SCOPE], WHISPER_SCOPES);
const NOTICE_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'];
const DEFAULT_SETTINGS = { font: 'IMC Sans', size: 16, weight: 400, theme: 'forge', layout: 'horizontal', active: '', showTime: true, altRows: false, compact: true, mentionSound: true, mentionVolume: 60, mentionFlash: true, highlightWords: [], mutedUsers: [], mutedWords: [], mutedAlerts: [], recentHistory: false, favEmotes: [], emoteUse: {}, playerPath: '', playerPref: '', playerStyle: 'own', railWidth: 0, ads: 'skip', videoSource: 'vlc', followedOnlyLive: true, autoLive: false, liveSound: true };
const FONTS = ['IMC Sans', 'IMC Serif', 'IMC Dyslexia', 'system'], THEMES = ['forge', 'midnight', 'ember', 'dusk', 'slate', 'moss', 'cream', 'paper', 'sky'];

/** one chat line as the recent-messages service keeps it (IRC), turned into the same message the live chat makes */
function parseIrc(line) {
  let tags = {}, rest = String(line);
  if (rest[0] === '@') { const i = rest.indexOf(' '); for (const kv of rest.slice(1, i).split(';')) { const j = kv.indexOf('='); tags[kv.slice(0, j)] = kv.slice(j + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\'); } rest = rest.slice(i + 1); }
  const m = /^:([^!\s]+)![^\s]* PRIVMSG #(\S+) :([\s\S]*)$/.exec(rest); return m ? { tags, login: m[1], channel: m[2], text: m[3] } : null;
}
function fromIrc(p, myId, now) {
  const t = p.tags; if (!t.id || !/^[\w-]{8,64}$/.test(t.id)) return null;
  let text = p.text; const act = /^\u0001ACTION ([\s\S]*)\u0001$/.exec(text); if (act) text = act[1];
  const chars = Array.from(text), spans = [];
  for (const part of String(t.emotes || '').split('/')) { const [id, ranges] = part.split(':'); if (!id || !ranges) continue; for (const r of ranges.split(',')) { const [a, b] = r.split('-').map(Number); if (a >= 0 && b >= a) spans.push({ a, b, id }); } }
  spans.sort((x, y) => x.a - y.a); const frags = []; let at = 0;
  for (const s of spans) { if (s.a < at) continue; if (s.a > at) frags.push({ type: 'text', text: chars.slice(at, s.a).join('') }); frags.push({ type: 'emote', text: chars.slice(s.a, s.b + 1).join(''), id: s.id }); at = s.b + 1; }
  if (at < chars.length) frags.push({ type: 'text', text: chars.slice(at).join('') });
  return { id: t.id, channel: p.channel, uid: t['user-id'] || '', login: p.login, name: t['display-name'] || p.login, color: t.color || '', badges: t.badges ? t.badges.split(',').filter(Boolean) : [], frags, text, kind: 'text', ts: Number(t['tmi-sent-ts']) || now,
    mine: !!myId && t['user-id'] === myId, mention: false, bits: Number(t.bits) || 0, reply: t['reply-parent-display-name'] ? { name: t['reply-parent-display-name'], text: String(t['reply-parent-msg-body'] || '').slice(0, 100) } : null, old: true };
}

module.exports = function createTwitch(ctx) {
  const log = ctx.log || (() => {}), doFetch = ctx.fetch || ((...a) => fetch(...a)), WS = ctx.WebSocket || globalThis.WebSocket, now = ctx.now || Date.now, emit = ctx.emit || (() => {});
  const ID = ctx.idUrl || 'https://id.twitch.tv/oauth2', HELIX = ctx.helixUrl || 'https://api.twitch.tv/helix', WSURL = ctx.eventsubUrl || 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
  const TOK = path.join(ctx.dir, 'tokens.json'), CH = path.join(ctx.dir, 'channels.json'), SET = path.join(ctx.dir, 'settings.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const write = (f, v) => { try { fs.mkdirSync(ctx.dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) { log('could not save', path.basename(f), e.message); } };
  let tokens = read(TOK, null), channels = read(CH, []), settings = Object.assign({}, DEFAULT_SETTINGS, read(SET, {})), device = null, auth = { status: tokens ? 'ok' : 'none', message: tokens ? 'Logged in as ' + tokens.login : 'Not connected' };
  if (!settings.styleChosen && settings.playerStyle === 'chromeless') settings.playerStyle = 'own';   // a window style that was only ever the old default moves to the new default
  let ws = null, session = '', subs = new Map(), ready = false, ka = null, closed = false, mods = new Set(), modsAt = 0;   // subs: "type|channelId" -> subscription id
  const liveMap = new Map(), backfilled = new Set(), emoteCache = new Map(), history = new Map(), badgeCache = new Map(), userCache = new Map();   // badgeCache: 'global' or a channel id -> { 'set/version': { u: image, t: title } }

  const form = (o) => new URLSearchParams(o).toString();
  async function idPost(ep, body) { const r = await doFetch(ID + ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) }); return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) }; }
  const granted = () => (tokens && tokens.scopes) || [];
  const isMod = (c) => !!tokens && (c.id === tokens.user_id || mods.has(c.id));
  const status = () => ({ auth, login: tokens ? tokens.login : '', userId: tokens ? tokens.user_id : '', device: device && { code: device.user_code, url: device.verification_uri }, connected: ready,
    channels: channels.map((c) => Object.assign({}, c, { mod: isMod(c), live: liveMap.get(c.id) || null, sub: subState.has(c.id) ? subState.get(c.id) : null })), needsSubs: !!tokens && !granted().includes(SUB_SCOPE), needsWhispers: !!tokens && WHISPER_SCOPES.some((s) => !granted().includes(s)), whisperUnread: whisperUnread(), settings, clientId: ctx.clientId, customClient: !!ctx.customClient, needsModScopes: !!tokens && MOD_SCOPES.concat([EMOTE_SCOPE]).some((s) => !granted().includes(s)), needsFollows: !!tokens && !granted().includes(FOLLOW_SCOPE), maxChannels: MAX_CHANNELS });
  const changed = () => emit('status', status());

  // ---------------------------------------------------------------- settings
  /** a list typed by the person: trimmed, de-duplicated, limited */
  const list = (v, max, len, fix) => (Array.isArray(v) ? Array.from(new Set(v.map((x) => fix(String(x).trim().slice(0, len))).filter(Boolean))).slice(0, max) : null);
  const login = (x) => x.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
  function configure(b) {
    b = b || {};
    for (const [k, max, len, fix] of [['highlightWords', 40, 40, (x) => x], ['mutedWords', 100, 40, (x) => x], ['mutedUsers', 300, 25, login], ['mutedAlerts', 100, 25, login], ['hiddenEvents', 20, 20, (x) => (EVENT_GROUPS.includes(x) ? x : '')]]) { const l = list(b[k], max, len, fix); if (l) settings[k] = l; }
    if (FONTS.includes(b.font) || (typeof b.font === 'string' && /^[^ -"'`\;{}<>]{1,80}$/.test(b.font))) settings.font = b.font;   // ours, or any font installed on the PC (no characters that could break out of the CSS)
    if (Number.isFinite(Number(b.size))) settings.size = Math.min(32, Math.max(11, Math.round(Number(b.size))));
    if ([100, 200, 300, 400, 500, 600, 700, 800, 900].includes(Number(b.weight))) settings.weight = Number(b.weight);
    if (THEMES.includes(b.theme)) settings.theme = b.theme;
    if (b.layout === 'vertical' || b.layout === 'horizontal') settings.layout = b.layout;
    if (typeof b.showTime === 'boolean') settings.showTime = b.showTime;
    if (typeof b.altRows === 'boolean') settings.altRows = b.altRows;
    if (typeof b.compact === 'boolean') settings.compact = b.compact;
    if (typeof b.playerPath === 'string') { const pp = b.playerPath.trim().slice(0, 260); if (pp === '' || /\.exe$/i.test(pp)) settings.playerPath = pp; }   // a program, or empty for automatic
    if (['', 'vlc', 'mpv'].includes(b.playerPref)) settings.playerPref = b.playerPref;
    if (['own', 'chromeless', 'normal'].includes(b.playerStyle)) { settings.playerStyle = b.playerStyle; settings.styleChosen = true; }
    if (b.setRail !== undefined && Number.isFinite(Number(b.setRail))) settings.setRail = Math.min(320, Math.max(110, Math.round(Number(b.setRail))));   // the width of the category list in Settings
    if (b.railWidth !== undefined && Number.isFinite(Number(b.railWidth))) { const w = Math.round(Number(b.railWidth)); settings.railWidth = w <= 0 ? 0 : Math.min(520, Math.max(120, w)); }   // the width of the channel list on the left; 0 = automatic
    if (['skip', 'show'].includes(b.ads)) settings.ads = b.ads;
    if (['vlc', 'twitch'].includes(b.videoSource)) settings.videoSource = b.videoSource;
    for (const k of ['followedOnlyLive', 'autoLive', 'liveSound', 'liveOnly', 'railMin', 'showActivity', 'channelPoints', 'openViewer']) if (typeof b[k] === 'boolean') settings[k] = b[k];
    const turnedOn = typeof b.recentHistory === 'boolean' && b.recentHistory && !settings.recentHistory;
    if (typeof b.recentHistory === 'boolean') settings.recentHistory = b.recentHistory;
    const fav = list(b.favEmotes, 60, 40, (x) => x); if (fav) settings.favEmotes = fav;
    if (b.emoteUse && typeof b.emoteUse === 'object' && !Array.isArray(b.emoteUse)) settings.emoteUse = Object.fromEntries(Object.entries(b.emoteUse).filter(([k, v]) => k.length <= 40 && Number(v) >= 1).map(([k, v]) => [k, Math.min(99999, Math.round(Number(v)))]).sort((x, y) => y[1] - x[1]).slice(0, 150));
    if (turnedOn) channels.forEach((c) => backfill(c.login));
    if (typeof b.mentionSound === 'boolean') settings.mentionSound = b.mentionSound;
    if (typeof b.mentionFlash === 'boolean') settings.mentionFlash = b.mentionFlash;
    if (Number.isFinite(Number(b.mentionVolume))) settings.mentionVolume = Math.min(100, Math.max(0, Math.round(Number(b.mentionVolume))));
    if (typeof b.active === 'string') settings.active = b.active.slice(0, 30);
    write(SET, settings); changed(); return settings;
  }

  // ---------------------------------------------------------------- login
  async function startLogin() {
    if (!ctx.clientId) throw new Error('No Twitch Client ID');
    if (device && now() < device.expires) return status();   // a code is already waiting: do not make a new one
    const r = await idPost('/device', { client_id: ctx.clientId, scopes: SCOPES.join(' ') });
    if (!r.ok) throw new Error('Twitch refused the request: ' + (r.json.message || r.status));
    device = { user_code: r.json.user_code, verification_uri: r.json.verification_uri, expires: now() + r.json.expires_in * 1000 };
    auth = { status: 'pending', message: 'Open the link and enter the code' }; poll(r.json.device_code, (r.json.interval || 5) * 1000); changed(); return status();
  }
  async function poll(code, every) {
    while (device && now() < device.expires) {
      await (ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(every);
      const r = await idPost('/token', { client_id: ctx.clientId, scopes: SCOPES.join(' '), device_code: code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (r.ok) {
        const v = await doFetch(ID + '/validate', { headers: { Authorization: 'OAuth ' + r.json.access_token } }).then((x) => x.json()).catch(() => ({}));
        tokens = { access_token: r.json.access_token, refresh_token: r.json.refresh_token, expires_at: now() + (r.json.expires_in || 14400) * 1000, user_id: v.user_id, login: v.login, scopes: v.scopes || r.json.scope || [] };
        write(TOK, tokens); device = null; auth = { status: 'ok', message: 'Logged in as ' + tokens.login }; log('login ok:', tokens.login); modsAt = 0; changed(); connect(); return;
      }
      if (!/authorization_pending|slow_down/i.test(r.json.message || '')) { auth = { status: 'error', message: 'Login failed: ' + (r.json.message || r.status) }; device = null; return changed(); }
    }
    if (device) { device = null; auth = { status: 'error', message: 'Login code expired: press Connect again' }; changed(); }
  }
  let refreshing = null;
  const refresh = () => refreshing || (refreshing = (async () => {
    const r = await idPost('/token', { client_id: ctx.clientId, grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    if (!r.ok) { auth = { status: 'error', message: 'Session expired: press Connect again' }; changed(); throw new Error('refresh failed'); }
    tokens = Object.assign({}, tokens, { access_token: r.json.access_token, refresh_token: r.json.refresh_token || tokens.refresh_token, expires_at: now() + (r.json.expires_in || 14400) * 1000, scopes: r.json.scope || tokens.scopes }); write(TOK, tokens);
  })().finally(() => { refreshing = null; }));
  async function helix(method, p, body, retry = true) {
    if (!tokens) throw new Error('Not logged in');
    if (tokens.expires_at - now() < 300000) await refresh();
    const r = await doFetch(HELIX + p, { method, headers: { 'Client-Id': ctx.clientId, Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && retry) { await refresh(); return helix(method, p, body, false); }
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
  }
  function logout() { closeWs(); tokens = null; mods = new Set(); subs.clear(); try { fs.unlinkSync(TOK); } catch (e) { /* none */ } auth = { status: 'none', message: 'Not connected' }; changed(); }

  // ---------------------------------------------------------------- badges and people
  async function loadBadges(id) {
    if (badgeCache.has(id)) return;
    const r = await helix('GET', '/chat/badges' + (id === 'global' ? '/global' : '?broadcaster_id=' + id)).catch(() => null), map = {};
    for (const set of (r && r.json.data) || []) for (const v of set.versions || []) map[set.set_id + '/' + v.id] = { u: v.image_url_2x || v.image_url_1x, t: v.title || set.set_id };
    if (r && r.ok) badgeCache.set(id, map);
  }
  /** the badge pictures and names for one channel: its own (subscriber, bits) over the global ones */
  async function badges(channel) {
    const c = channels.find((x) => x.login === clean(channel)); await loadBadges('global'); if (c) await loadBadges(c.id);
    return Object.assign({}, badgeCache.get('global'), c && badgeCache.get(c.id));
  }
  // ---------------------------------------------------------------- whispers: one conversation per person, kept between runs
  const WH = path.join(ctx.dir, 'whispers.json'); let whispers = read(WH, {}); let whisperSave = null;
  const saveWhispers = () => { clearTimeout(whisperSave); whisperSave = setTimeout(() => write(WH, whispers), 1500); if (whisperSave.unref) whisperSave.unref(); };
  function whisperUnread() { return Object.values(whispers).reduce((n, w) => n + (w.unread || 0), 0); }
  function addWhisper(login, name, id, mine, text, wid) {
    login = clean(login); if (!login) return; const w = whispers[login] = whispers[login] || { id: String(id || ''), name: name || login, unread: 0, msgs: [] };
    if (id) w.id = String(id); if (name) w.name = name; if (wid && w.msgs.some((m) => m.id === wid)) return;
    const m = { id: wid || 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), mine: !!mine, text: String(text || '').slice(0, 500), ts: now() }; w.msgs.push(m); if (w.msgs.length > 200) w.msgs.shift(); if (!mine) w.unread = (w.unread || 0) + 1;
    saveWhispers(); emit('whisper', { login, name: w.name, msg: m, unread: whisperUnread() }); changed();
  }
  const whisperList = () => Object.entries(whispers).map(([login, w]) => ({ login, name: w.name, unread: w.unread || 0, last: (w.msgs[w.msgs.length - 1] || {}).ts || 0, msgs: w.msgs })).sort((a, b) => b.last - a.last);
  function readWhispers(login) { const w = whispers[clean(login)]; if (w && w.unread) { w.unread = 0; saveWhispers(); changed(); } return { ok: true }; }
  async function sendWhisper(to, text) {
    if (!tokens) throw new Error('Not logged in'); if (WHISPER_SCOPES.some((s) => !granted().includes(s))) throw new Error('Reconnect Twitch to allow whispers');
    const login = clean(to); text = String(text || '').trim().slice(0, 500); if (!login || !text) throw new Error('Nothing to send');
    let id = whispers[login] && whispers[login].id, name = whispers[login] && whispers[login].name;
    if (!id) { const r = await helix('GET', '/users?login=' + encodeURIComponent(login)); const u = r.json.data && r.json.data[0]; if (!u) throw new Error('No user called ' + login); id = u.id; name = u.display_name; }
    const r = await helix('POST', '/whispers?from_user_id=' + tokens.user_id + '&to_user_id=' + id, { message: text });
    if (!r.ok) throw new Error((r.json && r.json.message) || 'Twitch refused the whisper');
    addWhisper(login, name, id, true, text); return { ok: true };
  }
  async function subWhisper() { if (tokens && granted().includes('user:read:whispers')) await sub('user.whisper.message', '1', { user_id: tokens.user_id }); }
  /** are you subscribed to each joined channel (true / false; null when it is not known yet)? Asked again every ten minutes. */
  const subState = new Map(); let subTimer = null;
  async function refreshSubs() {
    if (!tokens || !granted().includes(SUB_SCOPE)) return;
    for (const c of channels.slice()) {
      if (c.id === tokens.user_id) { subState.set(c.id, true); continue; }   // your own channel
      const r = await helix('GET', '/subscriptions/user?broadcaster_id=' + c.id + '&user_id=' + tokens.user_id).catch(() => null);
      if (r && r.ok) subState.set(c.id, true); else if (r && r.status === 404) subState.set(c.id, false);
    }
    changed();
  }
  function startSubs() { clearInterval(subTimer); refreshSubs(); subTimer = setInterval(refreshSubs, 600000); if (subTimer.unref) subTimer.unref(); }
  /** the channel's cheermotes (Cheer100 and the like) with their pictures, so chat can show them */
  const cheerCache = new Map();
  async function cheermotes(channel) {
    const c = channels.find((x) => x.login === clean(channel)); const key = c ? c.id : 'global', hit = cheerCache.get(key); if (hit && now() - hit.at < 3600000) return hit.v;
    const r = await helix('GET', '/bits/cheermotes' + (c ? '?broadcaster_id=' + c.id : '')), out = {};
    for (const m of r.json.data || []) out[String(m.prefix).toLowerCase()] = (m.tiers || []).map((t) => { const d = (t.images && t.images.dark) || {}, pick = (o) => (o && (o['3'] || o['2'] || o['1'])) || ''; return { min: t.min_bits, color: /^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : '', url: /^https:\/\//.test(pick(d.animated)) ? pick(d.animated) : /^https:\/\//.test(pick(d.static)) ? pick(d.static) : '' }; }).sort((a, b) => a.min - b.min);
    if (r.ok) cheerCache.set(key, { at: now(), v: out }); return out;
  }
  /** what the hover card shows about a person: picture, name, account age, bio */
  async function userInfo(id) {
    id = String(id || ''); if (!/^\d{1,20}$/.test(id)) throw new Error('Unknown user');
    const hit = userCache.get(id); if (hit && now() - hit.at < 600000) return hit.v;
    const r = await helix('GET', '/users?id=' + id), u = r.json.data && r.json.data[0]; if (!u) throw new Error('No such user');
    const v = { id: u.id, login: u.login, name: u.display_name, image: u.profile_image_url, bio: String(u.description || '').slice(0, 300), created: u.created_at, kind: u.broadcaster_type || '' };
    userCache.set(id, { at: now(), v }); return v;
  }

  // ---------------------------------------------------------------- the emote picker
  async function pages(p) {   // follows Twitch's cursor
    const out = []; let cursor = '';
    for (let i = 0; i < 40; i++) { const r = await helix('GET', p + (cursor ? '&after=' + cursor : '')).catch(() => null); if (!r || !r.ok) break; out.push(...(r.json.data || [])); cursor = r.json.pagination && r.json.pagination.cursor; if (!cursor) break; }
    return out;
  }
  const img = (e) => String((e.images && (e.images.url_2x || e.images.url_1x)) || '').replace('/static/light/', '/default/dark/');   // the dark-background, animated version
  /** every emote you can type in a channel: its own, the ones you own from anywhere, Twitch's, and 7TV / BetterTTV / FrankerFaceZ. g: c channel, m yours, g Twitch, 7 b f the others */
  async function emotes(channel) {
    const c = channels.find((x) => x.login === clean(channel)); if (!c) throw new Error('Join that channel first');
    const hit = emoteCache.get(c.id); if (hit && now() - hit.at < 600000) return hit.v;
    const [chan, glob, mine, third] = await Promise.all([pages('/chat/emotes?broadcaster_id=' + c.id).catch(() => []), pages('/chat/emotes/global?x=1'), granted().includes(EMOTE_SCOPE) ? pages('/chat/emotes/user?user_id=' + tokens.user_id + '&broadcaster_id=' + c.id) : Promise.resolve([]),
      ctx.thirdParty ? ctx.thirdParty(c.id).catch(() => []) : Promise.resolve([])]);
    const out = [], seen = new Set(), add = (list, g, only) => { for (const e of list) if (e.name && img(e) && !seen.has(e.name) && (!only || only(e))) { seen.add(e.name); out.push({ n: e.name, u: img(e), g }); } };
    if (mine.length) add(mine, 'c', (e) => e.owner_id === c.id); else add(chan, 'c');   // with the emote permission only the ones you can use are listed
    add(glob, 'g'); add(mine, 'm'); for (const e of third) if (!seen.has(e.n)) { seen.add(e.n); out.push(e); }
    emoteCache.set(c.id, { at: now(), v: out }); return out;
  }

  // ---------------------------------------------------------------- recent history (optional: asks a community service, so the channel name leaves this PC)
  async function backfill(login) {
    if (!settings.recentHistory || !/^[a-z0-9_]{3,25}$/.test(login)) return;
    const r = await doFetch('https://recent-messages.robotty.de/api/v2/recent-messages/' + login + '?limit=100&hide_moderation_messages=true&hide_moderated_messages=true', { headers: { 'User-Agent': 'IMC-Chat' } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null; if (!j || !Array.isArray(j.messages)) return;
    const old = j.messages.map(parseIrc).filter(Boolean).map((p) => fromIrc(p, tokens && tokens.user_id, now())).filter(Boolean), have = history.get(login) || [], seen = new Set(have.map((m) => m.id));
    history.set(login, old.filter((m) => !seen.has(m.id)).concat(have).sort((a, b) => a.ts - b.ts).slice(-300)); emit('backfill', { channel: login });
  }
  // ---------------------------------------------------------------- who is live (public stream data, every two minutes)
  let prevLive = null; const justJoined = new Set();   // logins that were live at the last check; channels just joined (not announced as "went live")
  async function fillLive() {
    if (!tokens) return; const next = new Map(), liveNow = new Map();
    for (let i = 0; i < channels.length; i += 100) {
      const part = channels.slice(i, i + 100), r = await helix('GET', '/streams?first=100&' + part.map((c) => 'user_id=' + c.id).join('&')).catch(() => null); if (!r || !r.ok) return;
      for (const s of r.json.data || []) { const info = { viewers: s.viewer_count, game: s.game_name || '', title: String(s.title || '').slice(0, 140) }; next.set(s.user_id, info); liveNow.set(s.user_login, Object.assign({ id: s.user_id, name: s.user_name }, info)); }
    }
    if (granted().includes(FOLLOW_SCOPE)) {   // the channels you follow that are live right now, joined or not
      let cursor = '';
      for (let i = 0; i < 10; i++) {
        const r = await helix('GET', '/streams/followed?user_id=' + tokens.user_id + '&first=100' + (cursor ? '&after=' + cursor : '')).catch(() => null); if (!r || !r.ok) break;
        for (const s of r.json.data || []) { const info = { viewers: s.viewer_count, game: s.game_name || '', title: String(s.title || '').slice(0, 140) }; liveNow.set(s.user_login, Object.assign({ id: s.user_id, name: s.user_name }, info)); if (channels.some((c) => c.id === s.user_id)) next.set(s.user_id, info); }
        cursor = r.json.pagination && r.json.pagination.cursor; if (!cursor) break;
      }
    }
    if (prevLive) {   // someone new is live: tell the app (a chime), and add followed channels if that is switched on
      for (const [login, info] of liveNow) {
        if (prevLive.has(login)) continue; if (justJoined.delete(login)) continue;
        const joined = channels.some((c) => c.login === login); if (!joined && !settings.autoLive) continue;
        let added = false; if (!joined) { const r = await addLogins([login]).catch(() => null); added = !!(r && r.added); }
        emit('wentlive', { login, name: info.name || login, viewers: info.viewers, game: info.game, added });
      }
    }
    else if (settings.autoLive) {   // the first look after the app starts: followed channels that are already live are added too
      const want = Array.from(liveNow.keys()).filter((l) => !channels.some((c) => c.login === l)); if (want.length) await addLogins(want).catch(() => null);
    }
    prevLive = new Set(liveNow.keys()); justJoined.clear();
    if (!channels.length && !prevLive.size) return;
    const same = next.size === liveMap.size && Array.from(next).every(([k, v]) => JSON.stringify(liveMap.get(k)) === JSON.stringify(v)); liveMap.clear(); next.forEach((v, k) => liveMap.set(k, v)); if (!same) changed();
  }
  let liveTimer = null; const startLive = () => { fillLive(); clearInterval(liveTimer); liveTimer = setInterval(fillLive, ctx.liveMs || 120000); if (liveTimer.unref) liveTimer.unref(); };
  // ---------------------------------------------------------------- backup: your channels and settings in one file (never the login)
  const exportData = () => ({ app: 'IMC-Chat', version: 1, channels: channels.map((c) => c.login), settings: Object.assign({}, settings, { active: '' }) });
  /** add channels by name (at most MAX_CHANNELS in all); returns how many were added */
  async function addLogins(logins) {
    const have = new Set(channels.map((c) => c.login)), want = Array.from(new Set(logins.map((x) => String(x).toLowerCase()).filter((x) => /^[a-z0-9_]{3,25}$/.test(x) && !have.has(x)))), room = Math.max(0, MAX_CHANNELS - channels.length), take = want.slice(0, room), added = [];
    for (let i = 0; i < take.length; i += 100) {
      const part = take.slice(i, i + 100), r = await helix('GET', '/users?' + part.map((x) => 'login=' + x).join('&')); if (!r.ok) throw new Error(r.json.message || 'Twitch refused the channel list');
      for (const u of r.json.data || []) { const c = { login: u.login, id: u.id, name: u.display_name, image: u.profile_image_url }; channels.push(c); added.push(c); justJoined.add(c.login); }
    }
    if (added.length) { write(CH, channels); if (ready) for (const c of added) await subscribeChannel(c); added.forEach((c) => backfill(c.login)); fillLive(); changed(); }
    return { added: added.length, skipped: want.length - added.length, full: channels.length >= MAX_CHANNELS && want.length > added.length };
  }
  /** the channels you follow, live ones first, for the "add followed channels" list */
  async function followed() {
    if (!tokens) throw new Error('Not logged in'); if (!granted().includes(FOLLOW_SCOPE)) throw new Error('Reconnect Twitch to allow reading the channels you follow');
    const all = []; let cursor = '';
    for (let i = 0; i < 20; i++) {
      const r = await helix('GET', '/channels/followed?user_id=' + tokens.user_id + '&first=100' + (cursor ? '&after=' + cursor : '')); if (!r.ok) throw new Error(r.json.message || 'Twitch refused the list');
      for (const f of r.json.data || []) all.push({ id: f.broadcaster_id, login: f.broadcaster_login, name: f.broadcaster_name }); cursor = r.json.pagination && r.json.pagination.cursor; if (!cursor) break;
    }
    const live = new Map(); cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = await helix('GET', '/streams/followed?user_id=' + tokens.user_id + '&first=100' + (cursor ? '&after=' + cursor : '')).catch(() => null); if (!r || !r.ok) break;
      for (const s of r.json.data || []) live.set(s.user_login, { viewers: s.viewer_count, game: s.game_name || '', title: String(s.title || '').slice(0, 140) }); cursor = r.json.pagination && r.json.pagination.cursor; if (!cursor) break;
    }
    const have = new Set(channels.map((c) => c.login));
    return all.map((f) => Object.assign({}, f, { live: live.get(f.login) || null, added: have.has(f.login) })).sort((a, b) => (b.live ? b.live.viewers + 1 : 0) - (a.live ? a.live.viewers + 1 : 0) || a.name.localeCompare(b.name));
  }
  async function importData(d) {
    if (!d || d.app !== 'IMC-Chat' || !Array.isArray(d.channels)) throw new Error('That is not an IMC-Chat backup file');
    await addLogins(d.channels);
    if (d.settings && typeof d.settings === 'object') configure(Object.assign({}, d.settings, { active: undefined })); changed(); return status();
  }

  // ---------------------------------------------------------------- channels
  const clean = (x) => String(x || '').trim().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?\s]/)[0].toLowerCase();
  async function loadMods(force) {
    if (!tokens || !granted().includes('user:read:moderated_channels') || (!force && now() - modsAt < 600000)) return;
    const found = new Set(); let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = await helix('GET', '/moderation/channels?user_id=' + tokens.user_id + '&first=100' + (cursor ? '&after=' + cursor : '')).catch(() => null);
      if (!r || !r.ok) return; for (const c of r.json.data || []) found.add(c.broadcaster_id);
      cursor = r.json.pagination && r.json.pagination.cursor; if (!cursor) break;
    }
    mods = found; modsAt = now(); changed();
  }
  /** channels joined before pictures were kept get theirs now */
  async function fillImages() {
    const need = channels.filter((c) => !c.image).slice(0, 100); if (!tokens || !need.length) return;
    const r = await helix('GET', '/users?' + need.map((c) => 'id=' + c.id).join('&')).catch(() => null); if (!r || !r.ok) return;
    let any = false; for (const u of r.json.data || []) { const c = channels.find((x) => x.id === u.id); if (c && u.profile_image_url) { c.image = u.profile_image_url; any = true; } }
    if (any) { write(CH, channels); changed(); }
  }
  async function join(name) {
    const login = clean(name); if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new Error('That is not a channel name');
    if (channels.some((c) => c.login === login)) return status();
    const r = await helix('GET', '/users?login=' + login); const u = r.json.data && r.json.data[0]; if (!u) throw new Error('No channel called ' + login);
    channels.push({ login: u.login, id: u.id, name: u.display_name, image: u.profile_image_url }); write(CH, channels); if (ready) await subscribeChannel(channels[channels.length - 1]); justJoined.add(u.login); backfill(u.login); fillLive(); refreshSubs(); changed(); return status();
  }
  async function leave(name) {
    const login = clean(name), c = channels.find((x) => x.login === login); if (!c) return status();
    channels = channels.filter((x) => x !== c); write(CH, channels); history.delete(login);
    for (const [k, id] of Array.from(subs)) if (k.endsWith('|' + c.id)) { subs.delete(k); helix('DELETE', '/eventsub/subscriptions?id=' + id).catch(() => {}); }
    changed(); return status();
  }
  /** move a tab: the order is remembered */
  function move(name, to) {
    const i = channels.findIndex((c) => c.login === clean(name)); if (i < 0) return status();
    const [c] = channels.splice(i, 1); channels.splice(Math.max(0, Math.min(channels.length, Number(to) || 0)), 0, c); write(CH, channels); changed(); return status();
  }
  async function sub(type, version, condition) {
    const k = type + '|' + condition.broadcaster_user_id; if (subs.has(k)) return;
    let r; for (let i = 0; i < 4; i++) {   // Twitch answers 429 when subscriptions are made too fast: wait a moment and ask again
      r = await helix('POST', '/eventsub/subscriptions', { type, version, condition, transport: { method: 'websocket', session_id: session } });
      if (r.status !== 429) break; await new Promise((x) => setTimeout(x, 1500 * (i + 1)));
    }
    if (r.ok && r.json.data && r.json.data[0]) subs.set(k, r.json.data[0].id); else log('subscription', type, 'refused:', (r.json && r.json.message) || r.status);
  }
  /** make room for n more subscriptions on the connection by dropping the moderation events of the channels at the end of the list (their messages and notices stay) */
  async function freeSubs(n) {
    const mod = Array.from(subs.keys()).filter((k) => /^channel\.chat\.(message_delete|clear_user_messages|clear)\|/.test(k)).reverse();
    for (const k of mod) { if (SUB_BUDGET - 2 - subs.size >= n) break; const id = subs.get(k); subs.delete(k); await helix('DELETE', '/eventsub/subscriptions?id=' + id).catch(() => {}); }
  }
  async function subscribeChannel(c) {
    await freeSubs(5);
    const cond = { broadcaster_user_id: c.id, user_id: tokens.user_id };
    // Twitch allows 300 subscriptions on one connection: your own channel's extras and whispers are kept room for, every channel gets its messages and notices,
    // and the moderation events (deletes, clears) go to as many channels as are left
    const full = Math.max(0, Math.floor((SUB_BUDGET - EXTRA_SUBS - 2 * channels.length) / 3)), types = ['channel.chat.message', 'channel.chat.notification'].concat(channels.indexOf(c) < full ? ['channel.chat.message_delete', 'channel.chat.clear_user_messages', 'channel.chat.clear'] : []);
    for (const t of types) await sub(t, '1', cond);
    if (c.id === tokens.user_id) {   // your own channel: rewards, hype trains, polls, predictions and ad breaks (each needs its own permission)
      const own = { broadcaster_user_id: c.id }, has = (sc) => granted().includes(sc);
      const want = [['channel:read:redemptions', [['channel.channel_points_custom_reward_redemption.add', '1']]], ['channel:read:hype_train', [['channel.hype_train.begin', '2'], ['channel.hype_train.progress', '2'], ['channel.hype_train.end', '2']]],
        ['channel:read:polls', [['channel.poll.begin', '1'], ['channel.poll.end', '1']]], ['channel:read:predictions', [['channel.prediction.begin', '1'], ['channel.prediction.lock', '1'], ['channel.prediction.end', '1']]], ['channel:read:ads', [['channel.ad_break.begin', '1']]]];
      for (const [scope, types] of want) if (has(scope)) for (const [t, v] of types) await sub(t, v, own);
    }
  }

  // ---------------------------------------------------------------- EventSub
  function closeWs() { closed = true; ready = false; clearTimeout(ka); if (ws) { try { ws.close(); } catch (e) { /* gone */ } } ws = null; }
  function connect(url) {
    if (!tokens || !WS) return;
    if (!url) { closeWs(); subs.clear(); }
    closed = false; const w = new WS(url || WSURL), old = ws; if (!url) ws = w;
    const watchdog = () => { clearTimeout(ka); ka = setTimeout(() => { log('chat connection went quiet; reconnecting'); if (!closed) { ready = false; changed(); try { w.close(); } catch (e) { /* gone */ } } }, 40000); if (ka.unref) ka.unref(); };
    w.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; } watchdog();
      const t = m.metadata && m.metadata.message_type;
      if (t === 'session_welcome') {
        session = m.payload.session.id;
        if (url) { ws = w; try { old && old.close(); } catch (e) { /* gone */ } ready = true; changed(); }   // moved to a new address: the subscriptions came along
        else Promise.all(channels.map((c) => subscribeChannel(c))).then(() => { ready = true; changed(); loadMods(true); fillImages(); startLive(); startSubs(); subWhisper(); channels.forEach((c) => { if (!backfilled.has(c.login)) { backfilled.add(c.login); backfill(c.login); } }); }).catch((e) => log('subscribe failed:', e.message));
      } else if (t === 'session_reconnect') connect(m.payload.session.reconnect_url);
      else if (t === 'notification') onEvent(m.metadata.subscription_type, m.payload.event);
    };
    w.onclose = () => { if (ws !== w || closed) return; ready = false; subs.clear(); changed(); setTimeout(() => { if (!closed && tokens) connect(); }, ctx.retryMs || 5000); };
    w.onerror = () => {};
  }

  // ---------------------------------------------------------------- events
  const fragsOf = (e) => ((e.message && e.message.fragments) || [{ type: 'text', text: (e.message && e.message.text) || '' }]).map((f) => ({
    type: f.type, text: f.text, id: f.emote ? f.emote.id : undefined, bits: f.cheermote ? f.cheermote.bits : undefined, prefix: f.cheermote ? f.cheermote.prefix : undefined, tier: f.cheermote ? f.cheermote.tier : undefined,
    gif: f.gif && /^https:\/\//.test(String(f.gif.url || '')) ? { url: f.gif.url } : undefined }));   // Twitch's inline GIFs
  const person = (e) => ({ uid: e.chatter_user_id, login: e.chatter_user_login, name: e.chatter_user_name || e.chatter_user_login, color: e.color || '', badges: (e.badges || []).map((b) => b.set_id + '/' + b.id) });
  const hype = new Map();   // channel -> the hype train level last shown
  /** a line in the chat that is not from a chatter: a reward, hype train, poll, prediction or ad break */
  function note(ch, event, system, extra) {
    const m = Object.assign({ id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), channel: ch, uid: '', login: '', name: '', color: '', badges: [], frags: [], text: '', ts: now(), event, system }, extra);
    m.text = String(m.text || '').slice(0, 500); m.frags = m.text ? [{ type: 'text', text: m.text }] : []; keep(ch, m);
  }
  function keep(ch, m) { const list = history.get(ch) || []; list.push(m); if (list.length > 300) list.shift(); history.set(ch, list); emit('chat', m); }
  function onEvent(type, e) {
    const ch = e.broadcaster_user_login, me = tokens && tokens.login;
    if (type === 'channel.chat.message') {
      const text = (e.message && e.message.text) || '';
      // a mention is your name in the text, or a reply to you (never your own messages)
      keep(ch, Object.assign(person(e), { id: e.message_id, channel: ch, frags: fragsOf(e), text, kind: e.message_type || 'text', ts: now(), mine: !!tokens && e.chatter_user_id === tokens.user_id,
        mention: !!me && e.chatter_user_id !== tokens.user_id && (new RegExp('(^|\\W)@?' + me + '(\\W|$)', 'i').test(text) || !!(e.reply && e.reply.parent_user_login === me)), bits: e.cheer ? e.cheer.bits : 0, reward: !!e.channel_points_custom_reward_id, src: e.source_broadcaster_user_id && e.source_broadcaster_user_id !== e.broadcaster_user_id ? (e.source_broadcaster_user_name || e.source_broadcaster_user_login || '') : '', reply: e.reply ? { name: e.reply.parent_user_name, text: String(e.reply.parent_message_body || '').slice(0, 100) } : null }));
    } else if (type === 'channel.chat.notification') {
      const kind = e.notice_type, raid = e.raid;
      keep(ch, Object.assign(person(e), { id: e.message_id, channel: ch, frags: fragsOf(e), text: (e.message && e.message.text) || '', ts: now(), event: kind, system: String(e.system_message || '').slice(0, 300),
        color: kind === 'announcement' ? (NOTICE_COLORS.includes(e.announcement && e.announcement.color) ? e.announcement.color : 'primary') : '', raid: raid ? { name: raid.user_name, viewers: raid.viewer_count } : null }));
    } else if (type === 'user.whisper.message') {
      addWhisper(e.from_user_login, e.from_user_name, e.from_user_id, false, e.whisper && e.whisper.text, e.whisper_id);
    } else if (type === 'channel.channel_points_custom_reward_redemption.add') {
      const rw = e.reward || {}; note(ch, 'redeem', e.user_name + ' redeemed ' + String(rw.title || 'a reward').slice(0, 80) + (rw.cost ? ' (' + Number(rw.cost).toLocaleString() + ')' : ''), { name: e.user_name, text: e.user_input });
    } else if (type === 'channel.hype_train.begin') {
      hype.set(ch, e.level || 1); note(ch, 'hype_train', 'A hype train started: level ' + (e.level || 1) + ', ' + Number(e.progress || 0).toLocaleString() + ' of ' + Number(e.goal || 0).toLocaleString());
    } else if (type === 'channel.hype_train.progress') {
      if (e.level && e.level !== hype.get(ch)) { hype.set(ch, e.level); note(ch, 'hype_train', 'Hype train level ' + e.level + ' (' + Number(e.total || 0).toLocaleString() + ' total)'); }
    } else if (type === 'channel.hype_train.end') {
      hype.delete(ch); note(ch, 'hype_train', 'The hype train ended at level ' + (e.level || 1) + ' with ' + Number(e.total || 0).toLocaleString() + ' total');
    } else if (type === 'channel.poll.begin') {
      note(ch, 'poll', 'Poll: ' + String(e.title || '').slice(0, 120) + ' - ' + (e.choices || []).map((c) => String(c.title || '').slice(0, 40)).join(' / '));
    } else if (type === 'channel.poll.end') {
      const top = (e.choices || []).slice().sort((a, b) => (b.votes || 0) - (a.votes || 0)); note(ch, 'poll', 'Poll ' + (e.status === 'completed' ? 'ended' : e.status || 'ended') + ': ' + String(e.title || '').slice(0, 120) + ' - ' + top.map((c) => String(c.title || '').slice(0, 40) + ' ' + (c.votes || 0)).join(', '));
    } else if (type === 'channel.prediction.begin') {
      note(ch, 'prediction', 'Prediction: ' + String(e.title || '').slice(0, 120) + ' - ' + (e.outcomes || []).map((o) => String(o.title || '').slice(0, 40)).join(' / '));
    } else if (type === 'channel.prediction.lock') {
      note(ch, 'prediction', 'Predictions are closed: ' + String(e.title || '').slice(0, 120));
    } else if (type === 'channel.prediction.end') {
      const win = (e.outcomes || []).find((o) => o.id === e.winning_outcome_id); note(ch, 'prediction', e.status === 'resolved' && win ? 'Prediction result: ' + String(win.title || '').slice(0, 40) : 'Prediction ' + (e.status || 'ended') + ': ' + String(e.title || '').slice(0, 120));
    } else if (type === 'channel.ad_break.begin') {
      note(ch, 'ad_break', 'An ad break started (' + (e.duration_seconds || '?') + ' seconds)' + (e.is_automatic ? '' : ', run by the streamer'));
    } else if (type === 'channel.chat.message_delete') {
      for (const m of history.get(ch) || []) if (m.id === e.message_id) m.gone = true; emit('chatmod', { channel: ch, type: 'delete', id: e.message_id });
    } else if (type === 'channel.chat.clear_user_messages') {
      for (const m of history.get(ch) || []) if (m.uid === e.target_user_id) m.gone = true; emit('chatmod', { channel: ch, type: 'clearUser', uid: e.target_user_id });
    } else if (type === 'channel.chat.clear') {
      history.delete(ch); emit('chatmod', { channel: ch, type: 'clear' });
    }
  }
  async function send(channel, text, replyTo) {
    const c = channels.find((x) => x.login === clean(channel)); if (!c) throw new Error('Join that channel first');
    text = String(text || '').trim().slice(0, 500); if (!text) throw new Error('Nothing to send');
    const r = await helix('POST', '/chat/messages', Object.assign({ broadcaster_id: c.id, sender_id: tokens.user_id, message: text }, replyTo ? { reply_parent_message_id: String(replyTo) } : {}));
    const d = r.json.data && r.json.data[0];
    if (!r.ok) throw new Error(r.json.message || 'Twitch refused the message');
    if (d && d.is_sent === false) throw new Error((d.drop_reason && d.drop_reason.message) || 'The message was not sent'); return { ok: true };
  }

  // ---------------------------------------------------------------- moderator tools
  const MODES = { slow: (v, n) => ({ slow_mode: !!v, slow_mode_wait_time: v ? n || 30 : undefined }), followers: (v, n) => ({ follower_mode: !!v, follower_mode_duration: v ? n || 0 : undefined }),
    subs: (v) => ({ subscriber_mode: !!v }), emotes: (v) => ({ emote_mode: !!v }), unique: (v) => ({ unique_chat_mode: !!v }) };
  async function mod(channel, action, o) {
    o = o || {}; const c = channels.find((x) => x.login === clean(channel)); if (!c) throw new Error('Join that channel first');
    if (!isMod(c)) throw new Error('You are not a moderator in ' + c.name);
    if (MOD_SCOPES.some((s) => !granted().includes(s))) throw new Error('Reconnect Twitch to allow the moderator tools');
    const q = 'broadcaster_id=' + c.id + '&moderator_id=' + tokens.user_id, uid = String(o.userId || ''), need = () => { if (!/^\d{1,20}$/.test(uid)) throw new Error('Unknown user'); };
    let r;
    if (action === 'delete') { if (!/^[\w-]{8,64}$/.test(String(o.messageId || ''))) throw new Error('Unknown message'); r = await helix('DELETE', '/moderation/chat?' + q + '&message_id=' + o.messageId); }
    else if (action === 'clear') r = await helix('DELETE', '/moderation/chat?' + q);
    else if (action === 'timeout') { need(); r = await helix('POST', '/moderation/bans?' + q, { data: { user_id: uid, duration: Math.min(1209600, Math.max(1, Number(o.seconds) || 600)), reason: String(o.reason || '').slice(0, 500) } }); }
    else if (action === 'ban') { need(); r = await helix('POST', '/moderation/bans?' + q, { data: { user_id: uid, reason: String(o.reason || '').slice(0, 500) } }); }
    else if (action === 'unban') { need(); r = await helix('DELETE', '/moderation/bans?' + q + '&user_id=' + uid); }
    else if (action === 'settings') { r = await helix('GET', '/chat/settings?' + q); const d = r.json.data && r.json.data[0]; if (!r.ok || !d) throw new Error(r.json.message || 'Could not read the chat modes'); return { slow: d.slow_mode ? d.slow_mode_wait_time : 0, followers: d.follower_mode ? d.follower_mode_duration || 0 : -1, subs: d.subscriber_mode, emotes: d.emote_mode, unique: d.unique_chat_mode }; }
    else if (MODES[action]) { const b = MODES[action](o.on, Number(o.value)); for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k]; r = await helix('PATCH', '/chat/settings?' + q, b); }
    else throw new Error('Unknown action');
    if (!r.ok) throw new Error(r.json.message || 'Twitch refused that'); return { ok: true };
  }
  /** what a clip is (title, picture, who, how long), for the card shown under a clip link in chat */
  const clipCache = new Map();
  async function clipInfo(id) {
    id = String(id || ''); if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('That is not a clip');
    if (clipCache.has(id)) return clipCache.get(id);
    if (!tokens) throw new Error('Not logged in');
    const r = await helix('GET', '/clips?id=' + encodeURIComponent(id)); const d = r.json.data && r.json.data[0]; if (!r.ok || !d) throw new Error('Clip not found');
    let game = ''; if (d.game_id) { const g = await helix('GET', '/games?id=' + encodeURIComponent(d.game_id)).catch(() => null); game = (g && g.json.data && g.json.data[0] && g.json.data[0].name) || ''; }
    const known = channels.find((c) => c.id === d.broadcaster_id);
    const out = { id: d.id, title: String(d.title || '').slice(0, 140), thumb: /^https:\/\//.test(d.thumbnail_url || '') ? d.thumbnail_url : '', creator: d.creator_name || '', channel: d.broadcaster_name || '', login: known ? known.login : String(d.broadcaster_name || '').toLowerCase().replace(/[^a-z0-9_]/g, ''),
      game: String(game).slice(0, 80), views: d.view_count || 0, seconds: Math.round(d.duration || 0), created: d.created_at || '' };
    clipCache.set(id, out); if (clipCache.size > 300) clipCache.delete(clipCache.keys().next().value); return out;
  }
  /** save the last 30 seconds of the stream as a clip; the link opens Twitch's clip editor */
  async function clip(channel) {
    const c = channels.find((x) => x.login === clean(channel)); if (!c) throw new Error('Join that channel first');
    if (!granted().includes(CLIP_SCOPE)) throw new Error('Reconnect Twitch to allow making clips');
    const r = await helix('POST', '/clips?broadcaster_id=' + c.id); const d = r.json.data && r.json.data[0];
    if (!r.ok || !d) throw new Error(r.status === 404 ? c.name + ' is not live' : (r.json && r.json.message) || 'Twitch could not make the clip');
    return { ok: true, url: 'https://clips.twitch.tv/' + encodeURIComponent(d.id), edit: d.edit_url };
  }
  return { startLogin, logout, join, leave, move, send, mod, clip, clipInfo, connect: () => connect(), status, configure, badges, emotes, userInfo, loadMods, fillImages, cheermotes, whisperList, readWhispers, sendWhisper, exportData, importData, fillLive, backfill, addLogins, followed, history: (ch) => (history.get(clean(ch)) || []).filter((m) => !m.gone), onEvent, stop: () => { clearInterval(liveTimer); closeWs(); } };
};
