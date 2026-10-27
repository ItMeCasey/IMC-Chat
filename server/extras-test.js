'use strict';
const assert = require('node:assert/strict');
const createExtras = require('./extras.js');

(async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push(url);
    const ok = (v) => ({ ok: true, json: async () => v });
    if (url === 'https://7tv.io/v3/users/twitch/111') return ok({ user: { style: { color: -1857617921, paint_id: '01JHXJFACX42RV996VE9933TB8' } } });
    if (url === 'https://7tv.io/v3/users/twitch/222') return ok({ user: { style: { color: 0, paint_id: null } } });
    if (url === 'https://7tv.io/v3/gql') return ok({ data: { cosmetics: { paints: [{ id: '01JHXJFACX42RV996VE9933TB8', function: 'LINEAR_GRADIENT', angle: 90, repeat: false, stops: [{ at: 0, color: -16776961 }, { at: 1, color: 255 }], shadows: [{ x_offset: 1, y_offset: 2, radius: 3, color: 255 }] }] } } });
    return { ok: false, json: async () => ({}) };
  };
  const X = createExtras({ fetch: fake });

  const a = await X.nameFx('111');
  assert.equal(a.color, '#' + (((-1857617921) >>> 8).toString(16).padStart(6, '0')));
  assert.equal(a.paint.bg, 'linear-gradient(90deg, rgba(255,0,0,1.000) 0%, rgba(0,0,0,1.000) 100%)');
  assert.equal(a.paint.shadow, 'drop-shadow(1px 2px 3px rgba(0,0,0,1.000))');
  assert.deepEqual(await X.nameFx('222'), { color: '', paint: null }, 'no style: nothing');
  assert.deepEqual(await X.nameFx('nope'), { color: '', paint: null }, 'not an id');
  assert.deepEqual(await X.nameFx('999'), { color: '', paint: null }, 'a failed lookup adds nothing');
  const n = calls.length; await X.nameFx('111'); assert.equal(calls.length, n, 'answers are kept');

  console.log('extras test passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
