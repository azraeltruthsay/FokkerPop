// Per-type minimum gap between VISUAL effects reaching the overlay.
// Only applies to high-frequency low-value events to prevent flooding.
// The event itself still passes through so state/stats/goals keep counting —
// we only clear event.effects to suppress the alert-banner/balloon visuals.
const THROTTLE_MS = {
  follow: 1500,   // follows can burst; merge visually by throttling
};

const lastFired = new Map();

export function throttler(ctx) {
  let limit = THROTTLE_MS[ctx.event.type];

  // Extra throttling for micro-cheers to prevent spam floods
  if (ctx.event.type === 'cheer' && (ctx.event.payload?.bits ?? 0) < 10) {
    limit = 2000;
  }

  if (!limit) return;

  const now  = Date.now();
  const last = lastFired.get(ctx.event.type) ?? 0;
  if (now - last < limit) {
    // Too soon — drop the visual payload but let the event continue so that
    // session counters, goal progress, and leaderboards still tick.
    ctx.event.effects = [];
    return;
  }
  lastFired.set(ctx.event.type, now);
}
