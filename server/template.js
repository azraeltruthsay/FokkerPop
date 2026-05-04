'use strict';

import state from './state.js';

/**
 * Expression resolver for dynamic fields.
 * Syntax: {{ expression }} — full JS expressions evaluated in a safe sandbox.
 *
 * Available context:
 *   payload     — event.payload (user, bits, count, viewers, message, …)
 *   event       — full event object (type, source, payload)
 *   state       — full state snapshot (read-only plain object)
 *   session     — state.session shorthand
 *   crowd       — state.crowd shorthand
 *   leaderboard — state.leaderboard shorthand
 *   chatters    — string[] of recent chatters (most recent first)
 *   twitch      — state.twitch shorthand (twitch.live.viewers, .title, .game, .uptimeSec, .isLive)
 *   pick(arr)   — random element from array
 *   clamp(v,min,max)
 *   plural(n, word) — e.g. plural(3, 'sub') → '3 subs'
 *   Math
 *
 * Examples:
 *   "{{ payload.user }} just subbed!"
 *   "{{ payload.bits > 1000 ? '🔥 MEGA' : '💜' }} cheer!"
 *   "{{ pick(chatters) }} gets targeted!"
 *   "{{ plural(payload.count, 'gift') }}"
 */

export function makeCtx(event = {}) {
  const snap = state.snapshot();
  return {
    payload:     event?.payload ?? {},
    event,
    state:       snap,
    session:     snap.session     ?? {},
    crowd:       snap.crowd       ?? {},
    leaderboard: snap.leaderboard ?? {},
    chatters:    snap.chatters    ?? [],
    twitch:      snap.twitch      ?? {},
    Math,
    pick:   (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '',
    clamp:  (v, min, max) => Math.min(Math.max(v, min), max),
    plural: (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`,
  };
}

/**
 * Resolve a template string against an expression context.
 * A string that is entirely one {{ expr }} returns the raw typed value.
 * Mixed strings are interpolated and returned as a string.
 */
export function resolve(template, ctx) {
  if (typeof template !== 'string') return template;

  // Entire string is one expression → return raw typed value (number, bool, etc.)
  const pure = template.match(/^\{\{([\s\S]+?)\}\}$/);
  if (pure) {
    try { return evalExpr(pure[1].trim(), ctx); }
    catch (e) { return `[ERR: ${e.message}]`; }
  }

  if (!template.includes('{{')) return template;

  // Mixed content → interpolate and return string
  return template.replace(/\{\{([\s\S]+?)\}\}/g, (_, expr) => {
    try {
      const v = evalExpr(expr.trim(), ctx);
      return v ?? '';
    } catch (e) {
      return `[ERR: ${e.message}]`;
    }
  });
}

/**
 * Recursively resolve all string values in an object/array.
 */
export function resolveDeep(obj, ctx) {
  if (typeof obj === 'string')        return resolve(obj, ctx);
  if (Array.isArray(obj))             return obj.map(v => resolveDeep(v, ctx));
  if (obj && typeof obj === 'object') return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, resolveDeep(v, ctx)])
  );
  return obj;
}

function evalExpr(expr, ctx) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(ctx), `"use strict"; return (${expr});`);
  return fn(...Object.values(ctx));
}
