'use strict';
/** The third-party emotes of a channel: 7TV, BetterTTV and FrankerFaceZ, global and the channel's own. Cached for an hour; a site that is down just adds nothing. */
module.exports = function createEmotes(ctx) {
  const doFetch = ctx.fetch || ((...a) => fetch(...a)), now = ctx.now || Date.now, log = ctx.log || (() => {}), cache = new Map();
  const get = async (url) => { try { const r = await doFetch(url, { headers: { 'User-Agent': 'IMC-Chat' } }); return r.ok ? await r.json() : null; } catch (e) { log('emotes:', url, e.message); return null; } };
  const https = (u) => (String(u || '').startsWith('//') ? 'https:' + u : String(u || ''));
  const ok = (n) => /^[\w:()-]{1,40}$/.test(n);

  function seventv(set, group) {
    return ((set && set.emotes) || []).filter((e) => e && ok(e.name) && e.data && e.data.host && !(e.data.flags & 256)).map((e) => ({ n: e.name, u: https(e.data.host.url) + '/2x.webp', g: group }));   // 256 = zero-width: left out
  }
  const bttv = (list) => (list || []).filter((e) => e && ok(e.code)).map((e) => ({ n: e.code, u: 'https://cdn.betterttv.net/emote/' + encodeURIComponent(e.id) + '/2x', g: 'b' }));
  function ffz(sets) {
    const out = []; for (const s of Object.values(sets || {})) for (const e of s.emoticons || []) if (ok(e.name)) out.push({ n: e.name, u: https((e.urls || {})['2'] || (e.urls || {})['1']), g: 'f' });
    return out;
  }
  async function forChannel(id) {
    id = String(id || ''); const hit = cache.get(id); if (hit && now() - hit.at < 3600000) return hit.v;
    const glob = cache.get('global') && now() - cache.get('global').at < 3600000 ? cache.get('global').v : null;
    const [g7, gb, gf] = glob ? [] : await Promise.all([get('https://7tv.io/v3/emote-sets/global'), get('https://api.betterttv.net/3/cached/emotes/global'), get('https://api.frankerfacez.com/v1/set/global')]);
    const base = glob || [].concat(seventv(g7, '7'), bttv(gb), ffz(gf && gf.sets)).map((e) => Object.assign(e, { gl: 1 }));   // gl: from the global sets, not the channel's own
    if (!glob) cache.set('global', { at: now(), v: base });
    let mine = [];
    if (/^\d{1,20}$/.test(id)) {
      const [c7, cb, cf] = await Promise.all([get('https://7tv.io/v3/users/twitch/' + id), get('https://api.betterttv.net/3/cached/users/twitch/' + id), get('https://api.frankerfacez.com/v1/room/id/' + id)]);
      mine = [].concat(seventv(c7 && c7.emote_set, '7'), bttv(cb && [].concat(cb.channelEmotes || [], cb.sharedEmotes || [])), ffz(cf && cf.sets));
    }
    const seen = new Set(), v = []; for (const e of mine.concat(base)) if (!seen.has(e.n)) { seen.add(e.n); v.push(e); }   // the channel's own win over the global ones
    cache.set(id, { at: now(), v }); return v;
  }
  return { forChannel };
};
