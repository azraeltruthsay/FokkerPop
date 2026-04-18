import { EventEmitter }             from 'node:events';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STATE_FILE = new URL('../state.json', import.meta.url).pathname;

const DEFAULTS = {
  session:     { subCount: 0, bitsTotal: 0, followCount: 0, raidCount: 0 },
  crowd:       { energy: 0, combo: null },
  goals:       [],
  leaderboard: { bits: {}, subs: {}, gifts: {} },
  recent:      [],
  chatters:    [],
};

class StateStore extends EventEmitter {
  #data;

  constructor() {
    super();
    this.#data = existsSync(STATE_FILE)
      ? { ...structuredClone(DEFAULTS), ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
      : structuredClone(DEFAULTS);

    // Periodic flush every 5 minutes
    setInterval(() => this.flush(), 300_000).unref();
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
  }

  increment(path, by = 1) {
    this.set(path, (this.get(path) ?? 0) + by);
  }

  snapshot() {
    return structuredClone(this.#data);
  }

  flush() {
    try { writeFileSync(STATE_FILE, JSON.stringify(this.#data, null, 2)); }
    catch { /* non-fatal */ }
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
  }

  resetSession() {
    this.#data = structuredClone(DEFAULTS);
  }
}

export const state = new StateStore();
export default state;
