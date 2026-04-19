import { enricher }   from './enricher.js';
import { combinator } from './combinator.js';
import { throttler }  from './throttler.js';
import { router }     from './router.js';

// Router must run BEFORE throttler so that throttler can strip visual effects
// on floods while still letting the event through for state/stat updates.
const PIPELINE = [enricher, combinator, router, throttler];

export async function applyPipeline(ctx) {
  for (const fn of PIPELINE) {
    await fn(ctx);
    if (ctx.cancelled) return;
  }
}
