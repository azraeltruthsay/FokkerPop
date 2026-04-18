import { createWriteStream, mkdirSync } from 'node:fs';
import { join }                         from 'node:path';
import { ROOT }                         from './settings-loader.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

// Rolling log file — one per process start, capped by OS rotation if needed.
let fileStream = null;
try {
  const logDir = join(ROOT, 'logs');
  mkdirSync(logDir, { recursive: true });
  const name = `fokkerpop-${new Date().toISOString().slice(0,10)}.log`;
  fileStream = createWriteStream(join(logDir, name), { flags: 'a', highWaterMark: 1 });
  fileStream.on('error', (err) => console.error('[LOGGER ERROR] File stream error:', err.message));
} catch (err) {
  console.error('[LOGGER ERROR] Failed to open log file:', err.message);
}

function write(level, ...args) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const ts  = new Date().toISOString();
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === 'object' && a !== null) return JSON.stringify(a);
    return String(a);
  }).join(' ');
  const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${msg}`;

  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }

  fileStream?.write(line + '\n');
}

export const log = {
  debug: (...a) => write('debug', ...a),
  info:  (...a) => write('info',  ...a),
  warn:  (...a) => write('warn',  ...a),
  error: (...a) => write('error', ...a),
};

export default log;
