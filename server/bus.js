import { EventEmitter } from 'node:events';
import { randomUUID }   from 'node:crypto';

class EventBus extends EventEmitter {
  #middleware = [];

  use(fn) {
    this.#middleware.push(fn);
    return this;
  }

  async publish(raw) {
    const event = { id: randomUUID(), ts: Date.now(), ...raw };
    const ctx   = { event, cancelled: false };

    for (const fn of this.#middleware) {
      await fn(ctx);
      if (ctx.cancelled) return null;
    }

    this.emit(ctx.event.type, ctx.event);
    this.emit('*', ctx.event);
    return ctx.event;
  }
}

export const bus = new EventBus();
export default bus;

// One-shot await for a bus event matching a predicate. Used by the
// awaitResult flow node and (in Phase 7+) by scene branch clips that
// pause-and-wait for a dice roll / chat command / redeem before
// branching. Rejects if no matching event arrives within timeoutMs.
//
// Predicate signature: (event) => boolean. Pass null to match the first
// event on the named type regardless of payload.
export function awaitBusEvent(eventType, predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const onAny = (event) => {
      if (event.type !== eventType) return;
      if (predicate && !predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`awaitBusEvent("${eventType}") timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    function cleanup() {
      bus.off(eventType, onAny);
      clearTimeout(timer);
    }
    bus.on(eventType, onAny);
  });
}
