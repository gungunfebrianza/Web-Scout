import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const defineConfig = (config) => config;
export const CONFIG_NAMES = ['surfacemap.config.mjs', 'surfacemap.config.js'];

export function findConfig(cwd) {
  for (const name of CONFIG_NAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Load a config file and fill in defaults. `root` is where adapters resolve their files; it defaults to the
// config file's own folder.
export async function loadConfig(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`config not found: ${abs}`);
  const mod = await import(pathToFileURL(abs).href);
  const raw = mod.default ?? mod.config;
  if (!raw || typeof raw !== 'object') throw new Error(`${abs} must export a config object as its default export`);
  if (!Array.isArray(raw.adapters) || !raw.adapters.length) throw new Error('config.adapters must list at least one adapter');
  const dir = path.dirname(abs);
  return {
    project: raw.project ?? path.basename(dir),
    purpose: raw.purpose ?? '',
    kinds: raw.kinds ?? {},
    adapters: raw.adapters,
    live: raw.live ?? null,
    failOn: raw.failOn ?? ['error'],
    root: path.resolve(dir, raw.root ?? '.'),
    out: path.resolve(dir, raw.out ?? 'docs/surfacemap'),
  };
}
