import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { fileURLToPath }           from 'node:url';
import { dirname, join }           from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SETTINGS_FILE = join(ROOT, 'settings.json');
const SETTINGS_BAK  = SETTINGS_FILE + '.bak';
const SETTINGS_TMP  = SETTINGS_FILE + '.tmp';

function load(name) {
  const p = join(ROOT, name);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Try settings.json first; if missing/empty/corrupt (e.g. truncated by an
// NSIS taskkill /F mid-write during update), fall back to settings.json.bak —
// the previous good snapshot. Without the .bak step, an update-time write race
// would leave Twitch creds resolving from settings.example.json (empty), so
// the dashboard came back showing "Twitch Offline" after an update.
let loadedFrom = null;
let settings = load('settings.json');
if (settings) loadedFrom = 'settings.json';
else if ((settings = load('settings.json.bak'))) loadedFrom = 'settings.json.bak';
else if ((settings = load('settings.example.json'))) loadedFrom = 'settings.example.json';
else { settings = {}; loadedFrom = 'defaults'; }

// Refresh .bak from the current good settings.json on boot. Bounds recovery
// worst-case to "settings at boot" instead of "settings from whenever the
// last write happened to a previous run". Mirrors server/state.js.
if (loadedFrom === 'settings.json') {
  try { copyFileSync(SETTINGS_FILE, SETTINGS_BAK); } catch {}
}

// Atomic save. Snapshot the current good file to .bak first, then write to
// .tmp + rename so even a hard kill mid-write can't leave settings.json
// truncated. Mirrors server/state.js's flush() pattern. Always call this
// instead of writeFileSync('settings.json', …) — the three call sites
// (OAuth callback, settings POST, eventsub token-refresh) all run during
// windows where the NSIS updater might taskkill /F the process.
export function saveSettings() {
  const json = JSON.stringify(settings, null, 2);
  if (existsSync(SETTINGS_FILE)) {
    try { copyFileSync(SETTINGS_FILE, SETTINGS_BAK); } catch {}
  }
  writeFileSync(SETTINGS_TMP, json);
  renameSync(SETTINGS_TMP, SETTINGS_FILE);
}

export default settings;
export { ROOT, loadedFrom };
