// Encoding accidents that only ever surfaced through manual byte checks: CRLF
// re-introduced by a Windows text-mode write, control characters left where a
// `\p` or `\f` escape was collapsed by a shell, and U+FFFD from a lossy
// re-encode. All are invisible in an editor and break greps, diffs and help text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = [];
(function walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(mjs|js|json|html|md|txt|yml|yaml|css)$/.test(entry.name)) files.push(full);
  }
})(dir);

function problems(text) {
  const found = [];
  if (text.includes('\r')) found.push('carriage return (CRLF or stray CR) - .gitattributes wants LF; a Windows text-mode write does this, use newline=\'\n\'');
  const control = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  if (control) found.push(`control character U+${control[0].charCodeAt(0).toString(16).padStart(4, '0')} (a collapsed backslash escape like \f or \0?)`);
  if (text.includes('\ufffd')) found.push('U+FFFD replacement character (a lossy re-encode)');
  return found;
}

test('no CR, control characters or U+FFFD in any source, doc or help file', () => {
  assert.ok(files.length > 20, 'expected to scan the whole tool directory');
  const bad = [];
  for (const f of files) for (const p of problems(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(dir, f)}: ${p}`);
  assert.deepEqual(bad, []);
});

test('the checker itself catches each problem', () => {
  assert.equal(problems('a\r\nb').length, 1);
  assert.equal(problems('a\fb').length, 1);
  assert.equal(problems('a\u0000b').length, 1);
  assert.equal(problems('a\ufffdb').length, 1);
  assert.deepEqual(problems('tab\there\nand a newline\n'), []);
});
