'use strict';
/**
 * Watch a channel in VLC or mpv instead of the embedded player: Streamlink fetches the stream and hands it to the player.
 * "Chromeless" starts the player without its window frame (VLC: borderless, always on top, no interface; mpv: borderless with its hover controls).
 * Needs Streamlink (winget install Streamlink.Streamlink); the buttons in Settings install it, and mpv, with winget.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');

const STYLE_ARGS = {
  vlc: '--no-video-deco --video-on-top --intf dummy --no-video-title-show --no-qt-privacy-ask',
  mpv: '--no-border --ontop --osc=yes --window-dragging=yes --autofit=960x540 --cursor-autohide=1500',
};
const WINGET_IDS = { streamlink: 'Streamlink.Streamlink', mpv: 'shinchiro.mpv' };

module.exports = function createPlayer(ctx) {
  const spawn = ctx.spawn || nodeSpawn, env = ctx.env || process.env;
  const exists = ctx.exists || ((f) => { try { return fs.statSync(f).isFile(); } catch (e) { try { fs.lstatSync(f); return true; } catch (e2) { return false; } } });   // winget is a Windows app alias: stat fails on it, lstat sees it
  const onPath = (name) => (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, name)).find(exists) || '';
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
  const first = (list) => list.find(exists) || '';
  const links = env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')] : [];

  const streamlink = () => onPath('streamlink.exe') || onPath('streamlink') || first(pf.map((d) => path.join(d, 'Streamlink', 'bin', 'streamlink.exe')));
  const vlc = () => first(pf.map((d) => path.join(d, 'VideoLAN', 'VLC', 'vlc.exe')));
  const mpv = () => onPath('mpv.exe') || first(links.map((d) => path.join(d, 'mpv.exe')).concat(pf.map((d) => path.join(d, 'mpv', 'mpv.exe'))));
  const kindOf = (file) => (/vlc/i.test(path.basename(file)) ? 'vlc' : /mpv/i.test(path.basename(file)) ? 'mpv' : '');
  /** the player to use: a program you chose, else the one you prefer (VLC or mpv), else VLC, else mpv */
  function playerFor(chosen, pref) {
    if (chosen && /\.exe$/i.test(chosen) && exists(chosen)) return { path: chosen, name: path.basename(chosen, '.exe'), kind: kindOf(chosen) };
    const v = vlc(), m = mpv(), order = pref === 'mpv' ? [['mpv', m], ['vlc', v]] : [['vlc', v], ['mpv', m]];
    for (const [k, f] of order) if (f) return { path: f, name: k === 'vlc' ? 'VLC' : 'mpv', kind: k };
    return null;
  }

  // installing with Windows' own package manager, when you press the button
  const winget = () => onPath('winget.exe') || (env.LOCALAPPDATA ? first([path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe')]) : '');
  let installing = '', installError = '';
  /** where things are, for the window that plays VLC inside our own window */
  const locate = (chosen, pref) => ({ streamlink: streamlink(), player: playerFor(chosen, pref) });
  const info = (chosen, pref) => { const p = playerFor(chosen, pref); return { streamlink: !!streamlink(), player: p ? p.name : '', kind: p ? p.kind : '', mpv: !!mpv(), vlc: !!vlc(), winget: !!winget(), installing, installError }; };
  function install(what) {
    what = what || 'streamlink'; if (!WINGET_IDS[what]) return Promise.reject(new Error('Unknown program'));
    if ((what === 'streamlink' ? streamlink() : mpv())) return Promise.resolve({ ok: true, already: true }); if (installing) return Promise.resolve({ ok: true, installing: true });
    const w = winget(); if (!w) return Promise.reject(new Error('Windows Package Manager (winget) was not found. Download it from ' + (what === 'mpv' ? 'mpv.io' : 'streamlink.github.io') + ' instead.'));
    installing = what; installError = '';
    const c = spawn(w, ['install', '--id', WINGET_IDS[what], '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; const grab = (d) => { if (out.length < 6000) out += String(d); }; if (c.stdout) c.stdout.on('data', grab); if (c.stderr) c.stderr.on('data', grab);
    const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, ctx.installMs || 600000);
    const end = (code, err) => { clearTimeout(t); installing = ''; if (!(what === 'streamlink' ? streamlink() : mpv())) installError = err || (out.replace(/[\r\u0008\u2588\u2592\u258c-]+/g, ' ').trim().split('\n').filter((l) => l.trim().length > 3).pop() || 'The installer stopped (code ' + code + ')').trim().slice(0, 200); };
    c.on('error', (e) => end(1, 'Could not start winget: ' + e.message)); c.on('exit', (code) => end(code));
    return Promise.resolve({ ok: true, installing: what });
  }

  /** start the stream in the player; resolves as soon as it is running, or with the reason it was not (offline, not installed) */
  function play(channel, chosen, opt) {
    opt = opt || {}; const login = String(channel || '').toLowerCase(), clip = /^[A-Za-z0-9_-]{8,80}$/.test(String(opt.clip || '')) ? opt.clip : ''; if (!clip && !/^[a-z0-9_]{3,25}$/.test(login)) return Promise.reject(new Error('Unknown channel'));
    const sl = streamlink(); if (!sl) return Promise.reject(new Error('Streamlink is not installed. Press Install Streamlink in Settings, or run: winget install Streamlink.Streamlink'));
    const pl = playerFor(chosen, opt.pref); if (!pl) return Promise.reject(new Error('No video player found. Install VLC (videolan.org) or mpv, or choose a player in Settings.'));
    const style = opt.style || 'chromeless', styled = (style === 'chromeless' || (style === 'own' && pl.kind === 'mpv')) && STYLE_ARGS[pl.kind];   // 'own' is the window IMC-Chat draws itself (VLC only); here it means VLC's normal window, or mpv without a frame
    return new Promise((resolve, reject) => {
      let out = '', done = false, c; const finish = (fn, v) => { if (!done) { done = true; clearTimeout(t); fn(v); } };
      const args = ['--player', pl.path].concat(styled ? ['--player-args=' + STYLE_ARGS[pl.kind]] : [],   // one argument with an equals sign: a value starting with dashes is not mistaken for an option
         ['--title', '{author} - {title}', (clip ? 'https://clips.twitch.tv/' + clip : 'https://www.twitch.tv/' + login), 'best']);
      try { c = spawn(sl, args, { windowsHide: true, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(new Error('Could not start Streamlink: ' + e.message)); }
      const grab = (d) => { if (out.length < 4000) out += String(d); }; if (c.stdout) c.stdout.on('data', grab); if (c.stderr) c.stderr.on('data', grab);
      c.on('error', (e) => finish(reject, new Error('Could not start Streamlink: ' + e.message)));
      c.on('exit', (code) => { if (code === 0) return; const why = /offline|no playable streams|not found/i.test(out) ? 'The stream is offline' : (out.trim().split('\n').pop() || 'Streamlink stopped (code ' + code + ')').replace(/^\[cli\]\[error\]\s*/, ''); finish(reject, new Error(why.slice(0, 200))); });
      const t = setTimeout(() => { try { if (c.unref) c.unref(); } catch (e) { /* gone */ } finish(resolve, { ok: true, player: pl.name, chromeless: !!styled }); }, ctx.waitMs || 6000);
    });
  }
  return { play, info, install, locate, styleArgs: STYLE_ARGS };
};
