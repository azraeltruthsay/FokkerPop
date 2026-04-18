import { enricher }   from './enricher.js';
import { combinator } from './combinator.js';
import { throttler }  from './throttler.js';
import { router }     from './router.js';

const PIPELINE = [enricher, combinator, throttler, router];

export async function applyPipeline(ctx) {
  for (const fn of PIPELINE) {
    await fn(ctx);
    if (ctx.cancelled) return;
  }
}
