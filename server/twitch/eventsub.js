import { EventEmitter } from 'node:events';
import { WebSocket }    from 'ws';
import bus             from '../bus.js';
import settings        from '../settings-loader.js';
import log             from '../logger.js';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

// ... (SUBS and NORMALIZERS unchanged)

export class TwitchEventSub extends EventEmitter {
  #ws             = null;
  #sessionId      = null;
  #retryDelay     = 2000;
  #keepaliveTimer = null;
  #status         = 'disconnected';

  get status() { return this.#status; }

  #setStatus(s) {
    if (this.#status === s) return;
    this.#status = s;
    this.emit('status', s);
  }

  get isConfigured() {
    const t = settings.twitch ?? {};
    return !!(t.clientId && t.accessToken && t.userId);
  }

  connect() {
    if (!this.isConfigured) {
      log.warn('Twitch credentials not configured — skipping connection. Fill in settings.json to enable live events.');
      this.#setStatus('disconnected');
      return;
    }
    this.#setStatus('connecting');
    this.#dial(EVENTSUB_URL);
  }

  #dial(url) {
    if (this.#ws) {
      this.#ws.removeAllListeners();
      this.#ws.terminate();
    }
    this.#ws = new WebSocket(url);

    this.#ws.on('open', () => {
      log.info('EventSub WebSocket connected');
      // Status stays 'connecting' until session_welcome
    });

    this.#ws.on('message', (raw) => {
      try {
        this.#handle(JSON.parse(raw));
      } catch (err) {
        log.error('EventSub message parse error:', err.message);
      }
    });

    this.#ws.on('close', (code, reason) => {
      clearTimeout(this.#keepaliveTimer);
      log.warn(`EventSub disconnected (code=${code}), retrying in ${this.#retryDelay / 1000}s`);
      this.#setStatus('disconnected');
      setTimeout(() => this.#dial(EVENTSUB_URL), this.#retryDelay);
      this.#retryDelay = Math.min(this.#retryDelay * 2, 30_000);
    });

    this.#ws.on('error', (err) => {
      log.error('EventSub WebSocket error:', err.message);
      this.#setStatus('error');
    });
  }

  #handle(msg) {
    const { metadata, payload } = msg;

    // Reset keepalive watchdog — Twitch sends a keepalive every ~10s
    clearTimeout(this.#keepaliveTimer);
    this.#keepaliveTimer = setTimeout(() => {
      log.warn('EventSub keepalive timeout — reconnecting');
      this.#ws?.terminate();
    }, 15_000);

    switch (metadata.message_type) {
      case 'session_welcome':
        this.#sessionId  = payload.session.id;
        this.#retryDelay = 2000;
        log.info('EventSub session established, subscribing to events');
        this.#setStatus('connected');
        this.#subscribe();
        break;

      case 'notification':
        this.#normalize(payload);
        break;

      case 'session_reconnect':
        log.info('EventSub requesting reconnect to new URL');
        this.#setStatus('connecting');
        clearTimeout(this.#keepaliveTimer);
        this.#ws?.removeAllListeners();
        this.#dial(payload.session.reconnect_url);
        break;

      case 'revocation':
        log.warn('EventSub subscription revoked:', payload.subscription.type, '— reason:', payload.subscription.status);
        break;

      case 'session_keepalive':
        break;  // handled by keepalive timer reset above

      default:
        log.debug('EventSub unknown message type:', metadata.message_type);
    }
  }

  async #subscribe() {
    const { userId, accessToken, clientId } = settings.twitch;
    let ok = 0, fail = 0;

    for (const [type, version, condition] of SUBS(userId)) {
      try {
        const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: this.#sessionId } }),
        });
        if (res.ok) {
          ok++;
        } else {
          const body = await res.json().catch(() => ({}));
          log.warn(`EventSub subscription failed [${type}]:`, body?.message ?? res.status);
          fail++;
        }
      } catch (err) {
        log.error(`EventSub subscription error [${type}]:`, err.message);
        fail++;
      }
    }

    log.info(`EventSub subscriptions: ${ok} ok, ${fail} failed`);
    if (fail > 0 && ok === 0) this.#setStatus('error');
  }

  #normalize(payload) {
    const normalizer = NORMALIZERS[payload.subscription.type];
    if (normalizer) {
      try {
        bus.publish({ source: 'twitch', ...normalizer(payload.event) });
      } catch (err) {
        log.error('EventSub normalize error:', err.message);
      }
    } else {
      log.debug('EventSub unhandled event type:', payload.subscription.type);
    }
  }
}
