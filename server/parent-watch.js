'use strict';
/**
 * The chat server is started by the desktop app as a child process. Windows does not stop a child when its parent is killed
 * (a crash, a hang that gets "closed", End task on the main process), so without this the server would keep running, keep
 * port 8430 and block the next start of the app. The server calls this now and then, and exits when the app is gone.
 */

/** True when the process `pid` no longer exists. `kill` is process.kill, passed in so it can be tested. */
function parentGone(pid, kill) {
  if (!pid || pid <= 0) return false;
  try { kill(pid, 0); return false; }   // signal 0 only asks "does it exist?"
  catch (e) { return !!e && e.code === 'ESRCH'; }   // EPERM means it exists but is not ours: still there
}

/** Calls `onGone` once, soon after the parent process disappears. Returns a function that stops watching. */
function watchParent(pid, onGone, opt) {
  const kill = (opt && opt.kill) || process.kill.bind(process), every = (opt && opt.everyMs) || 2000;
  if (!pid) return () => {};
  const t = setInterval(() => { if (parentGone(pid, kill)) { clearInterval(t); onGone(); } }, every);
  return () => clearInterval(t);
}

module.exports = { parentGone, watchParent };
