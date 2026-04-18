import state from '../state.js';

const FIVE_MIN = 5 * 60 * 1000;

export function enricher(ctx) {
  const { event } = ctx;
  const recent    = state.get('recent') ?? [];
  const cutoff    = Date.now() - FIVE_MIN;

  event.meta = {
    sessionSubCount:  state.get('session.subCount'),
    sessionBitsTotal: state.get('session.bitsTotal'),
    crowdEnergy:      state.get('crowd.energy'),
    recentSameType:   recent.filter(e => e.type === event.type && e.ts > cutoff).length,
  };

  // Maintain rolling 5-min window (capped at 200 entries to bound memory)
  const updated = [...recent, { type: event.type, ts: event.ts }]
    .filter(e => e.ts > cutoff)
    .slice(-200);
  state.set('recent', updated);
}
