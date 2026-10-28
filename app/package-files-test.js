'use strict';
// Every file the app loads with require('./x.js') must be in the installer's file list, or the installed app fails to start.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')), listed = new Set(pkg.build.files);
const missing = [];
for (const f of pkg.build.files.filter((x) => x.endsWith('.js'))) {
  assert.ok(fs.existsSync(path.join(__dirname, f)), f + ' is in the file list but does not exist');
  for (const m of fs.readFileSync(path.join(__dirname, f), 'utf8').matchAll(/require\('\.\/([\w-]+\.js)'\)/g)) if (!listed.has(m[1])) missing.push(f + ' needs ' + m[1]);
}
assert.deepEqual(missing, [], 'not packaged: ' + missing.join(', '));
console.log('package-files test passed');
