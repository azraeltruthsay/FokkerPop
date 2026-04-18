import state   from '../state.js';
import bus     from '../bus.js';
import settings from '../settings-loader.js';

export function combinator(ctx) {
  const { event } = ctx;
  const comboDefs = settings.combo?.[event.type];
  if (!comboDefs?.length) return;

  const recent = state.get('recent') ?? [];
  const now    = Date.now();

  for (const def of comboDefs) {                        // defs are ordered highest→lowest
    const windowStart = now - def.seconds * 1000;
    const count = recent.filter(e => e.type === event.type && e.ts > windowStart).length + 1;

    if (count >= def.count) {
      state.set('crowd.combo', {
        multiplier: def.level,
        label:      def.label,
        expiresAt:  now + def.seconds * 1000,
      });
      // Fire synthetic combo event without blocking the current one
      setImmediate(() => bus.publish({
        type:    `${event.type}.combo`,
        source:  'combinator',
        payload: { level: def.level, label: def.label, count },
      }));
      break;
    }
  }
}
