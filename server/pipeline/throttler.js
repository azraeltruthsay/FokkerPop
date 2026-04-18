// Per-type minimum gap between events reaching the overlay.
// Only applies to high-frequency low-value events to prevent flooding.
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
    ctx.cancelled = true;
    return;
  }
  lastFired.set(ctx.event.type, now);
}
