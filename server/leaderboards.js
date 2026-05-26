// Persistent supporter leaderboards (issue #4 cluster C).
//
// Two rolling windows beyond the current-stream leaderboard that already
// lives in state.leaderboard:
//   - Weekly:   rolling 7 days, computed from a pruned event log.
//   - All-time: lifetime cumulative totals, maintained directly so we don't
//               need the full event history for it.
//
// Persisted to its own file (leaderboards.json) — deliberately separate
// from state.json so the dashboard's "Reset Session" only wipes
// state.leaderboard (current stream) and never touches the longer windows.
// Two explicit reset endpoints handle the rare "wipe my weekly" / "wipe
// my all-time" cases.

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { ROOT }         from './settings-loader.js';
import { join }         from 'node:path';
import log              from './logger.js';

const FILE     = join(ROOT, 'leaderboards.json');
const FILE_TMP = FILE + '.tmp';
const FILE_BAK = FILE + '.bak';

const WEEK_MS = 7 * 24 * 60 * 60_000;

// Categories mirror state.leaderboard's structure: bits | subs | gifts.
// Adding a new one here lights it up across the persistent windows without
// touching the consumers (template scope, widgets, etc.) as long as they
// iterate `categories`.
const CATEGORIES = ['bits', 'subs', 'gifts'];

const DEFAULTS = {
  // [{ ts: epoch_ms, type: 'bits'|'subs'|'gifts', user: string, amount: number }]
  // Pruned to events newer than (now - 7 days) on every recordSupport().
  events:  [],
  // All-time totals per category — { bits: { user: total }, subs: {...}, gifts: {...} }
  allTime: { bits: {}, subs: {}, gifts: {} },
};

const FLUSH_DEBOUNCE_MS = 1000;

class Leaderboards extends EventEmitter {
  #data;
  #flushTimer = null;

  constructor() {
    super();
    this.#data = this.#load();
    // Refresh the backup from the current good file on boot so recovery
    // worst-case is "state at boot" instead of "from some prior run".
    if (existsSync(FILE)) {
      try { copyFileSync(FILE, FILE_BAK); } catch {}
    }
    // Belt-and-braces periodic flush for the rare case where a write sits
    // in the buffer longer than expected.
    setInterval(() => this.flush(), 300_000).unref();
  }

  #load() {
    for (const path of [FILE, FILE_BAK]) {
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path, 'utf8');
        if (!raw.trim()) continue;
        const parsed = JSON.parse(raw);
        return {
          events:  Array.isArray(parsed.events) ? parsed.events : [],
          allTime: {
            bits:  parsed.allTime?.bits  ?? {},
            subs:  parsed.allTime?.subs  ?? {},
            gifts: parsed.allTime?.gifts ?? {},
          },
        };
      } catch (err) {
        log.warn(`[leaderboards] failed to load ${path}: ${err.message} — trying next candidate`);
      }
    }
    return structuredClone(DEFAULTS);
  }

  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.#flushTimer.unref?.();
  }

  flush() {
    try {
      writeFileSync(FILE_TMP, JSON.stringify(this.#data));
      renameSync(FILE_TMP, FILE);
    } catch (err) {
      log.warn(`[leaderboards] flush failed: ${err.message}`);
    }
  }

  // Prune events older than the rolling-week cutoff. Called on each
  // recordSupport so we don't accumulate forever.
  #prune(now) {
    const cutoff = now - WEEK_MS;
    let cut = 0;
    while (cut < this.#data.events.length && this.#data.events[cut].ts < cutoff) cut++;
    if (cut > 0) this.#data.events.splice(0, cut);
  }

  recordSupport(type, user, amount) {
    if (!CATEGORIES.includes(type)) return;
    if (!user || typeof user !== 'string') return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    const now = Date.now();
    this.#data.events.push({ ts: now, type, user, amount: n });
    this.#prune(now);
    const cat = this.#data.allTime[type];
    cat[user] = (cat[user] ?? 0) + n;
    this.emit('change');
    this.#scheduleFlush();
  }

  // Compute weekly totals by summing the event log. Returns the same
  // { bits: { user: total }, subs: {...}, gifts: {...} } shape as
  // state.leaderboard so consumers can read either interchangeably.
  weekly() {
    const out = { bits: {}, subs: {}, gifts: {} };
    const cutoff = Date.now() - WEEK_MS;
    for (const ev of this.#data.events) {
      if (ev.ts < cutoff) continue;
      const bucket = out[ev.type];
      if (!bucket) continue;
      bucket[ev.user] = (bucket[ev.user] ?? 0) + ev.amount;
    }
    return out;
  }

  allTime() {
    return structuredClone(this.#data.allTime);
  }

  resetWeekly() {
    this.#data.events = [];
    this.emit('change');
    this.flush();
    log.info('[leaderboards] weekly leaderboard reset');
  }

  resetAllTime() {
    this.#data.allTime = { bits: {}, subs: {}, gifts: {} };
    // Also drop event log — keeping events without all-time totals would let
    // them re-accumulate into all-time on the next recordSupport, which is
    // not what the user expects when they hit "reset all-time."
    this.#data.events = [];
    this.emit('change');
    this.flush();
    log.info('[leaderboards] all-time leaderboard reset');
  }
}

const leaderboards = new Leaderboards();
export const categories = CATEGORIES;
export default leaderboards;
