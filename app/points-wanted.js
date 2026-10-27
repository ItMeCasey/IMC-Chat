'use strict';
/**
 * Channel points need a hidden Twitch page per channel, and each of those costs 150-250 MB. So the app only keeps one for a
 * channel you actually have open: the tab you are looking at, a popout chat, a video window or a player window.
 */
const LOGIN = /^[a-z0-9_]{3,25}$/;
// first path segments on twitch.tv that are pages, not channels
const NOT_CHANNELS = new Set(['popout', 'directory', 'videos', 'settings', 'subscriptions', 'wallet', 'inventory', 'drops', 'login', 'signup', 'downloads', 'turbo', 'jobs', 'p', 'embed', 'moderator', 'dashboard', 'friends', 'search']);

/** The channel a window shows, from its address: our popout chat (/?popout=name) or a Twitch video page (twitch.tv/name). '' for anything else. */
function channelFromUrl(address) {
  let u;
  try { u = new URL(String(address)); } catch (e) { return ''; }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
    const p = (u.searchParams.get('popout') || '').toLowerCase();
    return LOGIN.test(p) ? p : '';
  }
  if (u.hostname === 'twitch.tv' || u.hostname === 'www.twitch.tv') {
    const seg = (u.pathname.split('/')[1] || '').toLowerCase();
    return LOGIN.test(seg) && !NOT_CHANNELS.has(seg) ? seg : '';
  }
  return '';
}

/** Live channels that are also open, in the order given, at most `max`. */
function wantedPointsChannels(live, open, max) {
  const out = [];
  for (const c of live) if (open.has(c) && !out.includes(c)) { out.push(c); if (out.length >= max) break; }
  return out;
}

module.exports = { channelFromUrl, wantedPointsChannels, LOGIN };
