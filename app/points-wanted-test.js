'use strict';
const assert = require('node:assert/strict');
const { channelFromUrl, wantedPointsChannels } = require('./points-wanted.js');

// the channel a window shows
assert.equal(channelFromUrl('http://localhost:8430/?popout=Bearki'), 'bearki');
assert.equal(channelFromUrl('http://localhost:8430/?popout=bearki&watch=1'), 'bearki');
assert.equal(channelFromUrl('http://localhost:8430/'), '', 'the main window has no channel in its address');
assert.equal(channelFromUrl('http://localhost:8430/?popout=a b'), '', 'not a channel name');
assert.equal(channelFromUrl('https://www.twitch.tv/bearki'), 'bearki');
assert.equal(channelFromUrl('https://twitch.tv/Bearki?imc=1'), 'bearki');
assert.equal(channelFromUrl('https://www.twitch.tv/popout/bearki/chat'), '', 'the hidden points pages must not count as open');
assert.equal(channelFromUrl('https://www.twitch.tv/directory/following'), '');
assert.equal(channelFromUrl('https://www.twitch.tv/login'), '');
assert.equal(channelFromUrl('https://evil.example/bearki'), '');
assert.equal(channelFromUrl('https://www.twitch.tv.evil.example/bearki'), '');
assert.equal(channelFromUrl('not an address'), '');
assert.equal(channelFromUrl(''), '');

// which live channels get a hidden points page
const live = ['a_live', 'b_live', 'c_live', 'd_live'];
assert.deepEqual(wantedPointsChannels(live, new Set(['b_live']), 10), ['b_live'], 'only open channels');
assert.deepEqual(wantedPointsChannels(live, new Set(), 10), [], 'nothing open means no hidden pages');
assert.deepEqual(wantedPointsChannels(live, new Set(['x_off', 'c_live']), 10), ['c_live'], 'an open channel that is not live gets none');
assert.deepEqual(wantedPointsChannels(live, new Set(live), 2), ['a_live', 'b_live'], 'the cap still applies');
assert.deepEqual(wantedPointsChannels(['a_live', 'a_live'], new Set(['a_live']), 10), ['a_live'], 'no duplicates');

console.log('points-wanted-test: ok');
