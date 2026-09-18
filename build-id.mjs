// Build stamp for the in-page agent. A tab keeps running whatever inject.js it
// loaded until it navigates, so an edited file is invisible to it (the root
// index.html even pins the script with a ?v= query). inject.js carries
// AGENT_BUILD and sends it on connect; the relay compares it with the hash of
// the file on disk and warns when they differ.
//
// The hash covers the whole file with the stamp itself blanked, so it can live
// inside the file it describes. After editing inject.js run:
//   node tools/web-scout/build-id.mjs --stamp
// (build-id.test.mjs fails until you do, and scaffold-command.mjs does it for you.)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INJECT_PATH = path.join(__dirname, 'inject.js');
const STAMP_RE = /const AGENT_BUILD = '[^']*';/;

export function injectBuildId(source) {
  const normalized = source.replace(/\r\n/g, '\n').replace(STAMP_RE, "const AGENT_BUILD = '';");
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function stampedBuildId(source) {
  return source.match(/const AGENT_BUILD = '([^']*)';/)?.[1] ?? null;
}

// Restamps inject.js in place; returns { changed, build }.
export function stampInject(file = INJECT_PATH) {
  const source = fs.readFileSync(file, 'utf8');
  if (!STAMP_RE.test(source)) throw new Error(`${file} has no "const AGENT_BUILD = '...';" line to stamp`);
  const build = injectBuildId(source);
  const next = source.replace(STAMP_RE, `const AGENT_BUILD = '${build}';`);
  if (next === source) return { changed: false, build };
  fs.writeFileSync(file, next, 'utf8');
  return { changed: true, build };
}

// The hash of inject.js as it is on disk right now, cached by mtime so the
// relay can ask on every reply without re-hashing 90KB.
let cache = { mtimeMs: -1, build: null };
export function currentInjectBuild(file = INJECT_PATH) {
  try {
    const { mtimeMs } = fs.statSync(file);
    if (mtimeMs !== cache.mtimeMs) cache = { mtimeMs, build: injectBuildId(fs.readFileSync(file, 'utf8')) };
    return cache.build;
  } catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--stamp')) {
    const { changed, build } = stampInject();
    console.log(changed ? `inject.js stamped: ${build}` : `inject.js already stamped: ${build}`);
  } else {
    const source = fs.readFileSync(INJECT_PATH, 'utf8');
    const want = injectBuildId(source);
    const have = stampedBuildId(source);
    console.log(have === want ? `inject.js build ${have} (current)` : `inject.js stamp ${have} is out of date (file hashes to ${want}) - run: node tools/web-scout/build-id.mjs --stamp`);
    process.exitCode = have === want ? 0 : 1;
  }
}
