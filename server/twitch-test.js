'use strict';
// The Twitch side against a fake Twitch: nothing leaves this PC. Run: node twitch-test.js
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), createTwitch = require('./twitch');

const IRC = '@badge-info=subscriber/12;badges=moderator/1,subscriber/12;color=#FF0000;display-name=Old\\sUser;emotes=25:0-4;id=h1aaaaaaaa;tmi-sent-ts=1700000000000;user-id=77 :olduser!olduser@olduser.tmi.twitch.tv PRIVMSG #alice :Kappa hello', hits = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-')), events = [], subsMade = [], deleted = [], sent = [], calls = []; let polls = 0, wsLast = null;
const ALL = ['user:read:chat', 'user:write:chat', 'user:read:moderated_channels', 'moderator:manage:banned_users', 'moderator:manage:chat_messages', 'moderator:manage:chat_settings', 'moderator:read:chat_settings', 'user:read:emotes', 'user:read:follows'];
let liveIds = ['11'], followedLive = []; const live1 = (id, login, name, v) => ({ user_id: id, user_login: login, user_name: name, viewer_count: v, game_name: 'Tetris', title: 'Late night' });
const users = { cara: { id: '33', login: 'cara', display_name: 'Cara' }, dave: { id: '44', login: 'dave', display_name: 'Dave' }, alice: { id: '11', login: 'alice', display_name: 'Alice', profile_image_url: 'https://x/a.png' }, mememe: { id: '99', login: 'mememe', display_name: 'Me' }, bobby: { id: '22', login: 'bobby', display_name: 'Bobby' } };
const fake = async (url, opt) => {
  opt = opt || {}; if (url.startsWith('https://recent-messages.robotty.de/')) { hits.push(url); return { ok: true, status: 200, json: async () => ({ messages: [IRC, 'PING :tmi.twitch.tv', IRC.replace('id=h1', 'id=h2').replace('Kappa hello', '\u0001ACTION waves\u0001').replace('emotes=25:0-4', 'emotes=')] }) }; }
  const j = (v, st) => ({ ok: !st || st < 400, status: st || 200, json: async () => v }), u = url.replace('https://api.twitch.tv/helix', '').replace('https://id.twitch.tv/oauth2', '');
  if (u === '/device') return j({ device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://twitch.tv/activate', expires_in: 600, interval: 1 });
  if (u === '/token') { if (opt.body.includes('device_code')) return ++polls < 2 ? j({ message: 'authorization_pending' }, 400) : j({ access_token: 'at', refresh_token: 'rt', expires_in: 14400 }); return j({ access_token: 'at2', refresh_token: 'rt2', expires_in: 14400 }); }
  if (u === '/validate') return j({ user_id: '99', login: 'mememe', scopes: ALL });
  if (u.startsWith('/users?login=')) { const want = new URLSearchParams(u.split('?')[1]).getAll('login'); return j({ data: want.map((l) => users[l] || (/^u\d+$/.test(l) ? { id: 'x' + l, login: l, display_name: l } : null)).filter(Boolean) }); }
  if (u.startsWith('/channels/followed?')) return j({ data: [['11', 'alice', 'Alice'], ['22', 'bobby', 'Bobby'], ['33', 'cara', 'Cara'], ['44', 'dave', 'Dave']].map(([id, l, n]) => ({ broadcaster_id: id, broadcaster_login: l, broadcaster_name: n })), pagination: {} });
  if (u.startsWith('/streams/followed?')) return j({ data: followedLive, pagination: {} });
  if (u.startsWith('/streams?')) { const ids = new URLSearchParams(u.split('?')[1]).getAll('user_id'), names = { 11: ['alice', 'Alice'], 22: ['bobby', 'Bobby'] }; return j({ data: ids.filter((i) => liveIds.includes(i)).map((i) => live1(i, names[i][0], names[i][1], i === '11' ? 1234 : 50)) }); }
  if (u.startsWith('/users?id=')) return j({ data: [{ id: '22', login: 'bobby', display_name: 'Bobby', profile_image_url: 'https://x/b.png', description: 'hi', created_at: '2020-01-01T00:00:00Z', broadcaster_type: 'affiliate' }] });
  if (u === '/chat/badges/global') return j({ data: [{ set_id: 'moderator', versions: [{ id: '1', image_url_2x: 'https://x/mod.png', title: 'Moderator' }] }] });
  if (u.startsWith('/chat/badges?broadcaster_id=')) return j({ data: [{ set_id: 'subscriber', versions: [{ id: '0', image_url_2x: 'https://x/sub.png', title: 'Subscriber' }] }] });
  if (u.startsWith('/moderation/channels?')) return j({ data: [{ broadcaster_id: '11' }] });
  if (u === '/eventsub/subscriptions' && opt.method === 'POST') { const b = JSON.parse(opt.body); subsMade.push(b); return j({ data: [{ id: 's' + subsMade.length }] }); }
  if (u.startsWith('/eventsub/subscriptions?id=')) { deleted.push(u.split('=')[1]); return j({}); }
  if (u === '/chat/messages') { const b = JSON.parse(opt.body); sent.push(b); return j({ data: [b.message === 'blocked' ? { is_sent: false, drop_reason: { message: 'AutoMod held it' } } : { is_sent: true }] }); }
  if (u.startsWith('/moderation/') || u.startsWith('/chat/settings')) { calls.push([opt.method, u, opt.body ? JSON.parse(opt.body) : null]); return j(u.startsWith('/chat/settings') && opt.method === 'GET' ? { data: [{ slow_mode: true, slow_mode_wait_time: 30, follower_mode: false, subscriber_mode: false, emote_mode: true, unique_chat_mode: false }] } : { data: [] }); }
  return j({ message: 'unknown ' + u }, 404);
};
class FakeWS { constructor(url) { this.url = url; FakeWS.all.push(this); wsLast = this; } close() { this.closed = true; } } FakeWS.all = [];
const T = createTwitch({ dir, clientId: 'cid', fetch: fake, WebSocket: FakeWS, sleep: async () => {}, emit: (e, d) => events.push([e, d]), retryMs: 1 });
const msg = (type, e) => ({ metadata: { message_type: 'notification', subscription_type: type }, payload: { event: e } });
const base = { broadcaster_user_login: 'alice', chatter_user_id: '22', chatter_user_login: 'bobby', chatter_user_name: 'Bobby', color: '#fff', badges: [{ set_id: 'moderator', id: '1' }], message_id: 'm1' };
const chat = (o) => msg('channel.chat.message', Object.assign({}, base, { message_type: 'text', message: { text: 'hi Mememe!', fragments: [{ type: 'text', text: 'hi Mememe!' }] } }, o));
const ev = (name) => events.filter((e) => e[0] === name);

(async () => {
  assert.equal(T.status().auth.status, 'none'); await assert.rejects(T.join('alice'), /Not logged in/);
  const s = await T.startLogin(); assert.equal(s.device.code, 'ABCD'); assert.equal((await T.startLogin()).device.code, 'ABCD', 'one code at a time'); await new Promise((r) => setTimeout(r, 50));
  assert.equal(T.status().auth.status, 'ok'); assert.equal(T.status().login, 'mememe'); assert.equal(T.status().clientId, 'cid'); assert.equal(T.status().customClient, false); assert.equal(T.status().needsModScopes, false); assert.ok(FakeWS.all.length >= 1, 'connects after login');
  await assert.rejects(T.join('!!'), /not a channel name/); await assert.rejects(T.join('nobody1'), /No channel called/);
  const ws = wsLast; ws.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess1' } } }) }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(subsMade.length, 0, 'nothing to subscribe to until a channel is joined');
  await T.join('https://www.twitch.tv/Alice'); await T.join('mememe');
  assert.deepEqual(subsMade.slice(0, 5).map((b) => b.type), ['channel.chat.message', 'channel.chat.notification', 'channel.chat.message_delete', 'channel.chat.clear_user_messages', 'channel.chat.clear']);
  assert.deepEqual(subsMade[0].condition, { broadcaster_user_id: '11', user_id: '99' }); assert.equal(subsMade[0].transport.session_id, 'sess1'); assert.equal(subsMade.length, 10);
  // chat, badges with names, mentions
  ws.onmessage({ data: JSON.stringify(chat()) }); const m = ev('chat')[0][1]; assert.equal(m.channel, 'alice'); assert.equal(m.mention, true); assert.deepEqual(m.badges, ['moderator/1']);
  const bd = await T.badges('alice'); assert.deepEqual(bd['moderator/1'], { u: 'https://x/mod.png', t: 'Moderator' }); assert.equal(bd['subscriber/0'].t, 'Subscriber');
  // GIFs and cheers
  ws.onmessage({ data: JSON.stringify(chat({ message_id: 'm2', cheer: { bits: 100 }, message: { text: 'wow', fragments: [{ type: 'text', text: 'wow ' }, { type: 'gif', text: '', gif: { url: 'https://media.tenor.com/x.gif' } }, { type: 'gif', text: '', gif: { url: 'http://bad' } }] } })) }); const g = ev('chat')[1][1];
  assert.equal(g.bits, 100); assert.equal(g.frags[1].gif.url, 'https://media.tenor.com/x.gif'); assert.equal(g.frags[2].gif, undefined, 'only https GIFs');
  // events and announcements
  ws.onmessage({ data: JSON.stringify(msg('channel.chat.notification', Object.assign({}, base, { message_id: 'n1', notice_type: 'sub_gift', system_message: 'Bobby gifted a Tier 1 sub to Cara!', message: { text: '', fragments: [] } }))) });
  ws.onmessage({ data: JSON.stringify(msg('channel.chat.notification', Object.assign({}, base, { message_id: 'n2', notice_type: 'announcement', announcement: { color: 'GREEN' }, system_message: '', message: { text: 'Drops are live', fragments: [{ type: 'text', text: 'Drops are live' }] } }))) });
  ws.onmessage({ data: JSON.stringify(msg('channel.chat.notification', Object.assign({}, base, { message_id: 'n3', notice_type: 'announcement', announcement: { color: 'green' }, message: { text: 'ok', fragments: [] } }))) });
  ws.onmessage({ data: JSON.stringify(msg('channel.chat.notification', Object.assign({}, base, { message_id: 'n4', notice_type: 'raid', system_message: '40 raiders from Zed have joined!', raid: { user_name: 'Zed', viewer_count: 40 }, message: { text: '', fragments: [] } }))) });
  const [sg, an, an2, rd] = ev('chat').slice(2).map((x) => x[1]); assert.equal(sg.event, 'sub_gift'); assert.match(sg.system, /gifted a Tier 1/); assert.equal(an.event, 'announcement'); assert.equal(an.color, 'primary', 'an unknown colour falls back'); assert.equal(an2.color, 'green'); assert.equal(rd.raid.viewers, 40);
  ws.onmessage({ data: JSON.stringify(chat({ message_id: 'm7', chatter_user_id: '99', chatter_user_login: 'mememe', message: { text: 'I am Mememe', fragments: [] } })) }); assert.equal(ev('chat').slice(-1)[0][1].mention, false, 'your own messages do not alert you');
  ws.onmessage({ data: JSON.stringify(chat({ message_id: 'm8', message: { text: 'sure thing', fragments: [] }, reply: { parent_user_login: 'mememe', parent_user_name: 'Me', parent_message_body: 'hello' } })) }); assert.equal(ev('chat').slice(-1)[0][1].mention, true, 'a reply to you counts');
  // deletes
  ws.onmessage({ data: JSON.stringify(msg('channel.chat.message_delete', { broadcaster_user_login: 'alice', message_id: 'm1' })) }); assert.ok(!T.history('alice').some((x) => x.id === 'm1'), 'deleted messages leave the history');
  // the hover card
  const u = await T.userInfo('22'); assert.equal(u.name, 'Bobby'); assert.equal(u.created, '2020-01-01T00:00:00Z'); await assert.rejects(T.userInfo('x'), /Unknown user/);
  // sending
  await T.send('alice', 'hello', 'm9'); assert.deepEqual(sent[0], { broadcaster_id: '11', sender_id: '99', message: 'hello', reply_parent_message_id: 'm9' });
  await assert.rejects(T.send('alice', 'blocked'), /AutoMod held it/); await assert.rejects(T.send('alice', '   '), /Nothing to send/); await assert.rejects(T.send('zed', 'x'), /Join that channel first/);
  // moderator: from the list Twitch gives, plus your own channel
  await T.loadMods(true); const st = T.status(); assert.equal(st.channels.find((c) => c.login === 'alice').mod, true); assert.equal(st.channels.find((c) => c.login === 'mememe').mod, true, 'your own channel');
  await T.mod('alice', 'delete', { messageId: 'abcdefgh1' }); assert.deepEqual(calls[0].slice(0, 2), ['DELETE', '/moderation/chat?broadcaster_id=11&moderator_id=99&message_id=abcdefgh1']);
  await T.mod('alice', 'timeout', { userId: '22', seconds: 600, reason: 'spam' }); assert.deepEqual(calls[1][2], { data: { user_id: '22', duration: 600, reason: 'spam' } });
  await T.mod('alice', 'ban', { userId: '22' }); assert.equal(calls[2][2].data.duration, undefined); await T.mod('alice', 'unban', { userId: '22' }); assert.equal(calls[3][0], 'DELETE'); await T.mod('alice', 'clear');
  await T.mod('alice', 'slow', { on: true, value: 10 }); assert.deepEqual(calls[5][2], { slow_mode: true, slow_mode_wait_time: 10 }); await T.mod('alice', 'emotes', { on: false }); assert.deepEqual(calls[6][2], { emote_mode: false });
  assert.deepEqual(await T.mod('alice', 'settings'), { slow: 30, followers: -1, subs: false, emotes: true, unique: false });
  await assert.rejects(T.mod('alice', 'ban', { userId: 'x' }), /Unknown user/); await assert.rejects(T.mod('alice', 'nuke'), /Unknown action/);
  // settings and the order of tabs are remembered
  T.configure({ font: 'IMC Dyslexia', size: 99, weight: 650, theme: 'moss', layout: 'vertical', active: 'alice' }); assert.deepEqual(T.status().settings, { font: 'IMC Dyslexia', size: 32, weight: 400, theme: 'moss', layout: 'vertical', active: 'alice', showTime: true, altRows: false, compact: true, mentionSound: true, mentionVolume: 60, mentionFlash: true, highlightWords: [], mutedUsers: [], mutedWords: [], mutedAlerts: [], recentHistory: false, favEmotes: [], emoteUse: {}, playerPath: '', playerPref: '', playerStyle: 'own', railWidth: 0, ads: 'skip', videoSource: 'vlc', followedOnlyLive: true, autoLive: false, liveSound: true }, 'bad values are refused or clamped');
  T.configure({ showTime: false, altRows: true, font: 'x"};alert(1)', theme: 'nope' }); assert.equal(T.status().settings.showTime, false); assert.equal(T.status().settings.altRows, true); T.configure({ highlightWords: [' gg ', 'gg', '', 'ez win'], mutedUsers: ['@NightBot', 'bad name!', 'x'], mutedWords: 'nope', mutedAlerts: ['Alice'] }); assert.deepEqual(T.status().settings.highlightWords, ['gg', 'ez win'], 'trimmed and de-duplicated'); assert.deepEqual(T.status().settings.mutedUsers, ['nightbot', 'badname', 'x']); assert.deepEqual(T.status().settings.mutedWords, [], 'a list must be a list'); assert.deepEqual(T.status().settings.mutedAlerts, ['alice']); T.configure({ highlightWords: [], mutedUsers: [], mutedAlerts: [] });
  T.configure({ mentionVolume: 500, mentionSound: false }); assert.equal(T.status().settings.mentionVolume, 100); assert.equal(T.status().settings.mentionSound, false); T.configure({ mentionSound: true, mentionVolume: 60, showTime: 'no' }); assert.equal(T.status().settings.showTime, false, 'only true or false'); assert.equal(T.status().settings.font, 'IMC Dyslexia'); T.configure({ font: 'Comic Sans' }); assert.equal(T.status().settings.font, 'Comic Sans', 'any installed font is allowed'); T.configure({ font: 'IMC Dyslexia' }); T.move('mememe', 0); assert.deepEqual(T.status().channels.map((c) => c.login), ['mememe', 'alice']);
  // moving to a new Twitch address keeps the subscriptions
  const before = subsMade.length; ws.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://new' } } }) }); const ws2 = wsLast; assert.equal(ws2.url, 'wss://new');
  ws2.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess2' } } }) }); await new Promise((r) => setTimeout(r, 20)); assert.equal(subsMade.length, before, 'not subscribed twice'); assert.ok(ws.closed);
  await T.leave('alice'); assert.equal(deleted.length, 5); assert.deepEqual(T.status().channels.map((c) => c.login), ['mememe']);
  // a login from before the mod tools existed is asked to reconnect, and mod actions are refused
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-old-')); fs.writeFileSync(path.join(old, 'tokens.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 1e7, user_id: '99', login: 'mememe', scopes: ['user:read:chat', 'user:write:chat'] })); fs.writeFileSync(path.join(old, 'channels.json'), JSON.stringify([{ login: 'mememe', id: '99', name: 'Me' }]));
  const T3 = createTwitch({ dir: old, clientId: 'cid', fetch: fake, WebSocket: FakeWS }); assert.equal(T3.status().needsModScopes, true); assert.equal(T3.status().needsFollows, true); await assert.rejects(T3.followed(), /Reconnect Twitch/); await assert.rejects(T3.mod('mememe', 'clear'), /Reconnect Twitch/);
  // the optional recent history: off until you switch it on, then older messages come first
  const before2 = hits.length; await T.join('bobby'); await new Promise((r) => setTimeout(r, 30)); assert.equal(hits.length, before2, 'nothing is sent anywhere while it is off');
  T.configure({ recentHistory: true }); await new Promise((r) => setTimeout(r, 60)); assert.ok(hits.some((u) => u.includes('/recent-messages/bobby?')), 'switching it on fetches every joined channel');
  const hist = T.history('bobby'); assert.equal(hist.length, 2); assert.equal(hist[0].name, 'Old User'); assert.deepEqual(hist[0].badges, ['moderator/1', 'subscriber/12']); assert.deepEqual(hist[0].frags.map((f) => f.type + ':' + f.text), ['emote:Kappa', 'text: hello']); assert.equal(hist[0].frags[0].id, '25'); assert.equal(hist[1].text, 'waves', '/me lines lose their wrapper'); assert.equal(hist[0].mention, false); assert.equal(hist[0].old, true);
  T.configure({ recentHistory: false });
  // who is live
  await T.fillLive(); assert.deepEqual(T.status().channels.find((c) => c.login === 'bobby').live, null); await T.join('alice'); await T.fillLive(); assert.deepEqual(T.status().channels.find((c) => c.login === 'alice').live, { viewers: 1234, game: 'Tetris', title: 'Late night' });
  // favourites and what you use most
  T.configure({ favEmotes: ['Kappa', 'Kappa', ''], emoteUse: { Kappa: 5, PogChamp: 12, bad: 0, ['x'.repeat(50)]: 3 } }); assert.deepEqual(T.status().settings.favEmotes, ['Kappa']); assert.deepEqual(Object.keys(T.status().settings.emoteUse), ['PogChamp', 'Kappa'], 'sorted by use, junk dropped');
  T.configure({ playerPath: 'C:\\Tools\\mpv.exe' }); assert.equal(T.status().settings.playerPath, 'C:\\Tools\\mpv.exe'); T.configure({ playerPath: 'notes.txt' }); assert.equal(T.status().settings.playerPath, 'C:\\Tools\\mpv.exe', 'only programs'); T.configure({ playerPath: '' }); assert.equal(T.status().settings.playerPath, ''); assert.equal(T.status().settings.styleChosen, undefined); T.configure({ playerPref: 'mpv', playerStyle: 'normal' }); assert.equal(T.status().settings.playerPref, 'mpv'); assert.equal(T.status().settings.playerStyle, 'normal'); T.configure({ playerPref: 'evil', playerStyle: 'x' }); assert.equal(T.status().settings.playerPref, 'mpv', 'only the known choices'); T.configure({ playerPref: '', playerStyle: 'own' }); T.configure({ videoSource: 'twitch' }); assert.equal(T.status().settings.videoSource, 'twitch'); T.configure({ videoSource: 'flash' }); assert.equal(T.status().settings.videoSource, 'twitch', 'only the known choices'); T.configure({ videoSource: 'vlc' });
  T.configure({ ads: 'show' }); assert.equal(T.status().settings.ads, 'show'); T.configure({ ads: 'nope' }); assert.equal(T.status().settings.ads, 'show', 'only the known choices'); T.configure({ ads: 'skip' }); T.configure({ railWidth: 9999 }); assert.equal(T.status().settings.railWidth, 520); T.configure({ railWidth: 50 }); assert.equal(T.status().settings.railWidth, 120); T.configure({ railWidth: 300 }); assert.equal(T.status().settings.railWidth, 300); T.configure({ railWidth: 0 }); assert.equal(T.status().settings.railWidth, 0);
  // the channels you follow: live ones first, what is already added is marked
  const fl = await T.followed(); assert.deepEqual(fl.map((f) => f.login), ['alice', 'bobby', 'cara', 'dave']); followedLive = [live1('33', 'cara', 'Cara', 300), live1('11', 'alice', 'Alice', 1234)];
  const fl2 = await T.followed(); assert.deepEqual(fl2.map((f) => f.login), ['alice', 'cara', 'bobby', 'dave'], 'live first, busiest first'); assert.equal(fl2[1].live.viewers, 300); assert.equal(fl2[0].added, true); assert.equal(fl2[1].added, false);
  // a channel going live: joined ones are announced (a chime), followed ones are added too once that is switched on
  followedLive = []; liveIds = ['11']; await T.fillLive(); const wl = () => events.filter((e) => e[0] === 'wentlive').map((e) => e[1]); const wl0 = wl().length;
  liveIds = ['11', '22']; await T.fillLive(); assert.equal(wl().length, wl0 + 1, 'a joined channel went live'); assert.equal(wl()[wl0].login, 'bobby'); assert.equal(wl()[wl0].added, false);
  await T.fillLive(); assert.equal(wl().length, wl0 + 1, 'still live is not announced again');
  followedLive = [live1('33', 'cara', 'Cara', 300)]; await T.fillLive(); assert.equal(wl().length, wl0 + 1, 'a followed channel that is not joined is left alone while auto-add is off'); assert.ok(!T.status().channels.some((c) => c.login === 'cara'));
  followedLive = []; await T.fillLive(); T.configure({ autoLive: true }); followedLive = [live1('33', 'cara', 'Cara', 300)]; await T.fillLive();
  assert.equal(wl().length, wl0 + 2); assert.deepEqual([wl()[wl0 + 1].login, wl()[wl0 + 1].added], ['cara', true]); assert.ok(T.status().channels.some((c) => c.login === 'cara'), 'it was added'); assert.ok(subsMade.some((b) => b.condition.broadcaster_user_id === '33' && b.type === 'channel.chat.message'), 'and its chat is followed');
  await T.leave('cara'); T.configure({ autoLive: false }); followedLive = []; liveIds = ['11']; await T.fillLive();
  assert.equal(T.status().needsFollows, false);
  // a backup or a list never goes past the limit
  const fresh5 = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-cap-')); fs.writeFileSync(path.join(fresh5, 'tokens.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 1e7, user_id: '99', login: 'mememe', scopes: ALL }));
  const T5 = createTwitch({ dir: fresh5, clientId: 'cid', fetch: fake, WebSocket: FakeWS }); const cap = await T5.addLogins(Array.from({ length: 70 }, (_, i) => 'u' + (i + 1))); assert.equal(cap.added, 60); assert.equal(cap.full, true); assert.equal(T5.status().channels.length, 60); assert.equal(T5.status().maxChannels, 60);
  // backup and restore
  const bk = T.exportData(); assert.equal(bk.app, 'IMC-Chat'); assert.ok(!JSON.stringify(bk).includes('access_token'), 'never the login'); assert.deepEqual(bk.channels.sort(), ['alice', 'bobby', 'mememe']);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-new-')); fs.writeFileSync(path.join(fresh, 'tokens.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 1e7, user_id: '99', login: 'mememe', scopes: ALL }));
  const T4 = createTwitch({ dir: fresh, clientId: 'cid', fetch: fake, WebSocket: FakeWS }); await assert.rejects(T4.importData({ app: 'other' }), /not an IMC-Chat backup/); const st4 = await T4.importData(Object.assign({}, bk, { channels: bk.channels.concat(['nobody1', '!!']) }));
  assert.deepEqual(st4.channels.map((c) => c.login).sort(), ['alice', 'bobby', 'mememe']); assert.equal(st4.settings.theme, 'moss', 'settings come back too'); assert.deepEqual(st4.settings.favEmotes, ['Kappa']);
  // everything survives a restart
  const T2 = createTwitch({ dir, clientId: 'cid', fetch: fake, WebSocket: FakeWS }); assert.deepEqual(T2.status().channels.map((c) => c.login).sort(), ['alice', 'bobby', 'mememe']); assert.equal(T2.status().settings.theme, 'moss'); assert.equal(T2.status().auth.status, 'ok');
  T.stop(); console.log('twitch test passed'); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
