import fs from 'node:fs';
import path from 'node:path';

// Expand a list of file patterns relative to root. A `*` is allowed in the last path segment only
// ("routes-*.mjs", "src/api/*.js"); anything else is a literal path. No dependency on a glob library.
export function expandFiles(root, patterns) {
  const out = [];
  const missing = [];
  for (const pattern of patterns) {
    const normal = pattern.replace(/\\/g, '/');
    const slash = normal.lastIndexOf('/');
    const dir = slash === -1 ? '' : normal.slice(0, slash);
    const base = slash === -1 ? normal : normal.slice(slash + 1);
    if (!base.includes('*')) {
      if (fs.existsSync(path.join(root, normal))) out.push(normal);
      else missing.push(normal);
      continue;
    }
    const re = new RegExp(`^${base.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const abs = path.join(root, dir);
    const names = fs.existsSync(abs) ? fs.readdirSync(abs).filter((n) => re.test(n)).sort() : [];
    if (!names.length) missing.push(normal);
    for (const n of names) out.push(dir ? `${dir}/${n}` : n);
  }
  return { files: [...new Set(out)], missing };
}

export const readText = (root, file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
