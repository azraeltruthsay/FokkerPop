import { EventEmitter }             from 'node:events';
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';

const STATE_FILE     = new URL('../state.json', import.meta.url).pathname;
const STATE_FILE_TMP = STATE_FILE + '.tmp';
const STATE_FILE_BAK = STATE_FILE + '.bak';

const DEFAULTS = {
  session:     { subCount: 0, bitsTotal: 0, followCount: 0, raidCount: 0 },
  crowd:       { energy: 0, combo: null },
  goals:       [],
  leaderboard: { bits: {}, subs: {}, gifts: {} },
  recent:      [],
  chatters:    [],
};

// Debounced-flush window. Short enough that a user drag is persisted long
// before any realistic kill signal arrives (NSIS updater does taskkill /F
// ~1500 ms after detecting FokkerPop.exe), slow enough to batch the
// once-per-second crowd-energy drain into a single disk write.
const FLUSH_DEBOUNCE_MS = 300;

class StateStore extends EventEmitter {
  #data;
  #flushTimer = null;

  constructor() {
    super();
    this.#data = this.#loadInitial();

    // Belt-and-braces periodic flush. Debounced writes in set() cover the
    // normal case; this catches the edge case where something sits in the
    // buffer longer than expected.
    setInterval(() => this.flush(), 300_000).unref();
  }

  // Try state.json first; if missing/empty/corrupt, try state.json.bak
  // (the previous flush's snapshot). If neither works, start clean.
  #loadInitial() {
    for (const path of [STATE_FILE, STATE_FILE_BAK]) {
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path, 'utf8');
        if (!raw.trim()) continue;
        return { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
      } catch {
        // fall through to next candidate
      }
    }
    return structuredClone(DEFAULTS);
  }

  get(path) {
    return path.split('.').reduce((o, k) => o?.[k], this.#data);
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const node = keys.reduce((o, k) => {
      if (!o[k] || typeof o[k] !== 'object') o[k] = {};
      return o[k];
    }, this.#data);
    node[last] = value;
    this.emit('change',        { path, value });
    this.emit(`change:${path}`, value);
    this.#scheduleFlush();
  }

  increment(path, by = 1) {
    this.set(path, (this.get(path) ?? 0) + by);
  }

  // Collapse bursty set() calls into a single write. Called from set() and
  // addChatter(); flush() itself clears any pending timer so an explicit
  // shutdown-time flush isn't double-fired.
  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.#flushTimer.unref?.();
  }

  snapshot() {
    return structuredClone(this.#data);
  }

  flush() {
    if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
    try {
      const json = JSON.stringify(this.#data, null, 2);
      // Snapshot the current good file as .bak before overwriting. If the
      // process is killed mid-write or the new file is somehow corrupt,
      // #loadInitial() falls back to .bak on the next boot.
      if (existsSync(STATE_FILE)) {
        try { copyFileSync(STATE_FILE, STATE_FILE_BAK); } catch {}
      }
      // Atomic write: tmp + rename. Even if the process dies between the
      // write and the rename, state.json itself is never partial.
      writeFileSync(STATE_FILE_TMP, json);
      renameSync(STATE_FILE_TMP, STATE_FILE);
    } catch { /* non-fatal */ }
  }

  addChatter(user) {
    if (!user || typeof user !== 'string') return;
    const list = this.#data.chatters;
    const idx  = list.indexOf(user);
    if (idx !== -1) list.splice(idx, 1);  // move to front if already present
    list.unshift(user);
    if (list.length > 300) list.length = 300;
    this.emit('change', { path: 'chatters', value: list });
    this.emit('change:chatters', list);
    this.#scheduleFlush();
  }

  resetSession() {
    // Session reset clears live-stream counters (subCount, bits, leaderboard,
    // crowd energy, chatters) but preserves user configuration: goals stay
    // defined (their completed flags clear so they can fire again next stream)
    // AND the entire overlay.* tree is preserved — widget positions, sizes,
    // hidden-element list, registered widgets. Resetting layout is destructive
    // and was never the intent of "Reset Session Stats" (the button label).
    const preservedGoals   = (this.#data.goals ?? []).map(g => ({ ...g, completed: false }));
    const preservedOverlay = this.#data.overlay ?? {};
    this.#data = structuredClone(DEFAULTS);
    this.#data.goals   = preservedGoals;
    this.#data.overlay = preservedOverlay;
    this.#scheduleFlush();
  }
}

export const state = new StateStore();
export default state;
