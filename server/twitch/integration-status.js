// Per-feature health registry for the Twitch integration. Each Helix poller
// (and the chat-dynamics aggregator) reports into this so the dashboard
// "Twitch Integration Health" panel can render a single coherent view:
// who's healthy, who needs a reconnect, who's silently broken.
//
// Surfaces as state.twitch.health for the dashboard to read. Pollers call
// reportOk / reportError; the registry handles state transitions and the
// rate-limited logging (using log.once under the hood).

import log from '../logger.js';

// Catalog of every Twitch-derived feature. Adding here makes it show up in
// the health panel automatically — pollers just need to call reportOk /
// reportError with the matching key.
//
// requiresScopes: scopes the feature needs (subset of OAuth grant). When
// settings.twitch.scopes is missing one, the feature is shown as
// 'missing-scope' with a reconnect prompt before its poller even runs.
//
// pollHint: human description of cadence, shown in the panel.
//
// fokkerNote: optional Fokker-facing description of what the feature gives
// him — shown beneath the row in the dashboard so he knows whether he
// cares about the feature being healthy.
const CATALOG = [
  { key: 'live',            label: 'Live stream stats',   requiresScopes: [],                              pollHint: '60 s when connected',
    fokkerNote: 'Viewer count, current category, stream title, uptime. Powers the Twitch Live widget.' },
  { key: 'totals',          label: 'Channel totals',      requiresScopes: ['moderator:read:followers','channel:read:subscriptions'], pollHint: '120 s when connected',
    fokkerNote: 'Total follower count, total subscriber count, sub points.' },
  { key: 'chat-dynamics',   label: 'Chat dynamics',       requiresScopes: [],                              pollHint: 'every chat event',
    fokkerNote: 'Active chatters, msgs/min, top chatter, chat heat. Resets on Session Reset.' },
  { key: 'schedule',        label: 'Stream schedule',     requiresScopes: [],                              pollHint: '1 h when connected',
    fokkerNote: 'Next scheduled stream (title + start time). Pulled from the schedule you set in the Twitch dashboard.' },
  { key: 'ads',             label: 'Ad break schedule',   requiresScopes: ['channel:read:ads'],            pollHint: '60 s when live',
    fokkerNote: 'Time until next ad break, snooze count. Affiliate/Partner only.' },
  { key: 'recent-followers',label: 'Recent followers',    requiresScopes: ['moderator:read:followers'],    pollHint: '60 s when connected',
    fokkerNote: 'List of users who followed in the last 24 h.' },
];

const status = new Map();
for (const f of CATALOG) {
  status.set(f.key, {
    ...f,
    state:        'unconfigured',  // overall: ok | missing-scope | unavailable | unconfigured | stale
    lastFetchAt:  0,
    lastOkAt:     0,
    lastError:    null,            // { kind, status, message } or null
    summary:      '',              // short human-readable current value
  });
}

let onChangeCallback = null;
export function onChange(cb) { onChangeCallback = cb; }

function emit() {
  if (onChangeCallback) {
    try { onChangeCallback(snapshot()); } catch (err) { log.error('integration-status onChange threw:', err.message); }
  }
}

export function reportOk(key, { summary = '', recovered = false } = {}) {
  const row = status.get(key);
  if (!row) return;
  const wasError = !!row.lastError;
  row.lastFetchAt = Date.now();
  row.lastOkAt    = row.lastFetchAt;
  row.lastError   = null;
  row.state       = 'ok';
  row.summary     = summary;
  if (wasError || recovered) {
    log.info(`[twitch:${key}] recovered — ${summary || 'ok'}`);
    log.clearOnce(`twitch:${key}:err`);
  }
  emit();
}

export function reportError(key, err, { summary } = {}) {
  const row = status.get(key);
  if (!row) return;
  row.lastFetchAt = Date.now();
  const kind = err?.kind || 'data';
  row.lastError = {
    kind,
    status:  err?.status || 0,
    message: err?.message || String(err),
  };
  row.state = (
    kind === 'unconfigured' ? 'unconfigured' :
    kind === 'scope'        ? 'missing-scope' :
    kind === 'not-monetized'? 'unavailable' :
    /* auth/rate-limit/network/data */ 'unavailable'
  );
  if (summary !== undefined) row.summary = summary;
  // Rate-limited: same kind+status under the same key only logs once per
  // state-or-10-min — see logger.js `repeating`.
  const level = (kind === 'scope' || kind === 'auth') ? 'warn' : 'debug';
  log.once(`twitch:${key}:err`, `${kind}:${row.lastError.status}`, level,
    `[twitch:${key}] ${kind}${row.lastError.status ? ` (${row.lastError.status})` : ''}: ${row.lastError.message}`);
  emit();
}

// Used by the Health panel before pollers run, to show "needs reconnect"
// without waiting for the first poll to fail.
export function markScopeStatus(key, hasScopes) {
  const row = status.get(key);
  if (!row) return;
  if (row.requiresScopes.length === 0) return;
  if (!hasScopes) {
    row.state     = 'missing-scope';
    row.lastError = { kind: 'scope', status: 0, message: `Missing scopes: ${row.requiresScopes.join(', ')}` };
    emit();
  }
}

export function snapshot() {
  return Array.from(status.values()).map(row => ({ ...row }));
}

export const catalog = CATALOG;

export default { reportOk, reportError, markScopeStatus, snapshot, onChange, catalog };
