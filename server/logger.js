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

// Rate-limited logger: dedupes "same error every 60 s" spam from pollers.
// Behavior per key:
//   - First occurrence:      log at requested level
//   - Same value within TTL: silently swallow
//   - Different value:       log the state transition
//   - After TTL:             log again as a "still happening" reminder
// Used by Twitch pollers so a missing-scope or offline-server error logs
// once per state change, not 60 times per hour.
const REPEAT_TTL_MS = 10 * 60_000;
const repeatState = new Map(); // key → { value, loggedAt }

function repeating(level, key, value, ...args) {
  const prev = repeatState.get(key);
  const now  = Date.now();
  const valStr = typeof value === 'string' ? value : JSON.stringify(value);
  if (prev && prev.value === valStr && (now - prev.loggedAt) < REPEAT_TTL_MS) return;
  repeatState.set(key, { value: valStr, loggedAt: now });
  write(level, ...args);
}

// Clears the dedupe state for a key — call this when a feature recovers so
// the next failure logs immediately instead of being deduped against a
// stale prior occurrence.
function clearRepeating(key) {
  repeatState.delete(key);
}

export const log = {
  debug: (...a) => write('debug', ...a),
  info:  (...a) => write('info',  ...a),
  warn:  (...a) => write('warn',  ...a),
  error: (...a) => write('error', ...a),
  // log.once('key', value, level, ...args) — see repeating() above.
  once:  (key, value, level, ...args) => repeating(level, key, value, ...args),
  clearOnce: (key) => clearRepeating(key),
};

export default log;
