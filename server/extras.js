'use strict';
/** A chatter's 7TV name colour and paint, for names in chat. A service that is down just adds nothing. */
module.exports = function createExtras(ctx) {
  ctx = ctx || {};
  const doFetch = ctx.fetch || ((...a) => fetch(...a)), now = ctx.now || Date.now, log = ctx.log || (() => {}), fx = new Map(), paints = new Map();
  const json = async (url, init) => { try { const r = await doFetch(url, Object.assign({ headers: { 'User-Agent': 'IMC-Chat' } }, init)); return r.ok ? await r.json() : null; } catch (e) { log('extras:', url, e.message); return null; } };
  const rgba = (n) => { n = Number(n) >>> 0; return 'rgba(' + ((n >>> 24) & 255) + ',' + ((n >>> 16) & 255) + ',' + ((n >>> 8) & 255) + ',' + ((n & 255) / 255).toFixed(3) + ')'; };
  const hex = (n) => (Number.isFinite(Number(n)) && Number(n) !== 0 ? '#' + (Number(n) >>> 8).toString(16).padStart(6, '0') : '');   // a 7TV colour is a signed RGBA number

  /** a 7TV paint as CSS: a background for the name, and a drop-shadow filter */
  function css(p) {
    const stops = (p.stops || []).map((s) => rgba(s.color) + ' ' + (Math.round(Number(s.at) * 10000) / 100) + '%').join(', '); let bg = '';
    if (p.function === 'LINEAR_GRADIENT' && stops) bg = (p.repeat ? 'repeating-linear-gradient(' : 'linear-gradient(') + Number(p.angle || 0) + 'deg, ' + stops + ')';
    else if (p.function === 'RADIAL_GRADIENT' && stops) bg = (p.repeat ? 'repeating-radial-gradient(' : 'radial-gradient(') + (p.shape === 'ellipse' ? 'ellipse' : 'circle') + ', ' + stops + ')';
    else if (p.function === 'URL' && /^https:\/\/cdn\.7tv\.app\//.test(p.image_url || '')) bg = 'url("' + p.image_url + '")';
    if (!bg) return null;
    const shadow = (p.shadows || []).slice(0, 4).map((s) => 'drop-shadow(' + Number(s.x_offset || 0) + 'px ' + Number(s.y_offset || 0) + 'px ' + Number(s.radius || 0) + 'px ' + rgba(s.color) + ')').join(' ');
    return { bg, shadow };
  }
  async function paint(id) {
    if (!/^[0-9A-Za-z]{10,40}$/.test(id)) return null; const hit = paints.get(id); if (hit && now() - hit.at < 3600000) return hit.v;
    const d = await json('https://7tv.io/v3/gql', { method: 'POST', headers: { 'User-Agent': 'IMC-Chat', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ cosmetics(list: ["' + id + '"]) { paints { id color function angle shape image_url repeat stops { at color } shadows { x_offset y_offset radius color } } } }' }) });
    const p = d && d.data && d.data.cosmetics && (d.data.cosmetics.paints || []).find((x) => x.id === id), v = p ? css(p) : null; paints.set(id, { at: now(), v }); return v;
  }
  /** { color, paint }: the colour and the paint 7TV gives this Twitch user, if any */
  async function nameFx(twitchId) {
    twitchId = String(twitchId || ''); if (!/^\d{1,20}$/.test(twitchId)) return { color: '', paint: null };
    const hit = fx.get(twitchId); if (hit && now() - hit.at < 3600000) return hit.v;
    const u = await json('https://7tv.io/v3/users/twitch/' + twitchId), st = u && u.user && u.user.style || {}, v = { color: hex(st.color), paint: st.paint_id ? await paint(String(st.paint_id)) : null };
    fx.set(twitchId, { at: now(), v }); if (fx.size > 3000) fx.delete(fx.keys().next().value); return v;
  }
  return { nameFx };
};
