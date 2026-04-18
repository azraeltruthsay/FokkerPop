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
