import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath }           from 'node:url';
import { dirname, join }           from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function load(name) {
  const p = join(ROOT, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

const settings = load('settings.json') ?? load('settings.example.json') ?? {};
export default settings;
export { ROOT };
