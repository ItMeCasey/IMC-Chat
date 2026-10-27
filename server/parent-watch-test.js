'use strict';
const assert = require('node:assert/strict');
const { parentGone, watchParent } = require('./parent-watch.js');

const gone = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
const denied = () => { const e = new Error('not permitted'); e.code = 'EPERM'; throw e; };

assert.equal(parentGone(1234, () => true), false, 'the parent exists');
assert.equal(parentGone(1234, gone), true, 'the parent is gone');
assert.equal(parentGone(1234, denied), false, 'a process we may not signal still exists');
assert.equal(parentGone(0, gone), false, 'no parent given: never stop');
assert.equal(parentGone(NaN, gone), false);

(async () => {
  // gone after the third look: onGone fires once, and no more looks are made afterwards
  let looks = 0, fired = 0;
  const stop = watchParent(99, () => { fired++; }, { everyMs: 10, kill: () => { looks++; if (looks >= 3) gone(); } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, 1, 'fires once');
  assert.equal(looks, 3, 'stops looking after it fires');
  stop();

  // still there: never fires, and can be stopped
  let still = 0;
  const stop2 = watchParent(99, () => { still++; }, { everyMs: 10, kill: () => true });
  await new Promise((r) => setTimeout(r, 60));
  stop2();
  assert.equal(still, 0);

  // a real process: this one exists, a made-up one does not
  assert.equal(parentGone(process.pid, process.kill.bind(process)), false);
  assert.equal(parentGone(2147483000, process.kill.bind(process)), true);

  console.log('parent-watch-test: ok');
})();
