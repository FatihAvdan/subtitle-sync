'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const files = ['js/app.js', 'js/sync.js'];
let bad = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const re = /\$\('([^#][^']*)'\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    bad.push(f + ' -> $(\'' + m[1] + '\')');
  }
}
assert.strictEqual(bad.length, 0,
  'Bare-ID $() calls (missing # prefix — querySelector treats them as tag selectors):\n  ' + bad.join('\n  '));
console.log('selector check passed');
