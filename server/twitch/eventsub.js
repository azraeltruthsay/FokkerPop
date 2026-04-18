import { EventEmitter } from 'node:events';
import { WebSocket }    from 'ws';
import { join }         from 'node:path';
import { writeFileSync } from 'node:fs';
import bus             from '../bus.js';
import settings, { ROOT } from '../settings-loader.js';
import { refreshAccessToken } from './helix.js';
import log             from '../logger.js';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

// Subscriptions we want, in [type, version, condition-builder] tuples.
const SUBS = (uid) => [
  ['channel.follow',                                    '2', { broadcaster_user_id: uid, moderator_user_id: uid }],
  ['channel.subscribe',                                 '1', { broadcaster_user_id: uid }],
  ['channel.subscription.gift',                         '1', { broadcaster_user_id: uid }],
  ['channel.cheer',                                     '1', { broadcaster_user_id: uid }],
  ['channel.raid',                                      '1', { to_broadcaster_user_id: uid }],
  ['channel.channel_points_custom_reward_redemption.add','1', { broadcaster_user_id: uid }],
  ['channel.hype_train.begin',                          '1', { broadcaster_user_id: uid }],
  ['channel.hype_train.progress',                       '1', { broadcaster_user_id: uid }],
  ['channel.hype_train.end',                            '1', { broadcaster_user_id: uid }],
  ['channel.chat.message',                              '1', { broadcaster_user_id: uid, user_id: uid }],
];

// Maps Twitch subscription types → normalized FokkerPop events.
const NORMALIZERS = {
  'channel.follow':
    (ev) => ({ type: 'follow',          payload: { user: ev.user_name, userId: ev.user_id } }),
  'channel.subscribe':
    (ev) => ({ type: 'sub',             payload: { user: ev.user_name, tier: ev.tier, message: ev.message?.text } }),
  'channel.subscription.gift':
    (ev) => ({ type: 'sub.gifted',      payload: { user: ev.user_name, count: ev.total, tier: ev.tier, recipient: ev.recipient_user_name } }),
  'channel.cheer':
    (ev) => ({ type: 'cheer',           payload: { user: ev.user_name, bits: ev.bits, message: ev.message } }),
  'channel.raid':
    (ev) => ({ type: 'raid',            payload: { user: ev.from_broadcaster_user_name, viewers: ev.viewers } }),
  'channel.channel_points_custom_reward_redemption.add':
    (ev) => ({ type: 'redeem',          payload: { user: ev.user_name, rewardTitle: ev.reward.title, rewardId: ev.reward.id, input: ev.user_input } }),
  'channel.hype_train.begin':
    (ev) => ({ type: 'hype-train.start',    payload: { level: ev.level, total: ev.total } }),
  'channel.hype_train.progress':
    (ev) => ({ type: 'hype-train.progress', payload: { level: ev.level, total: ev.total, progress: ev.progress, goal: ev.goal } }),
  'channel.hype_train.end':
    (ev) => ({ type: 'hype-train.end',      payload: { level: ev.level, total: ev.total } }),
  'channel.chat.message':
    (ev) => ({ type: 'chat',                payload: { user: ev.chatter_user_name, message: ev.message.text, color: ev.color, badges: ev.badges } }),
};

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
      log.info('Offline mode active (Twitch credentials not configured). You can still use the Simulator in the dashboard.');
      this.#setStatus('disconnected');
      return;
    }
    this.#setStatus('connecting');
    this.#dial(EVENTSUB_URL);
  }

  disconnect() {
    clearTimeout(this.#keepaliveTimer);
    if (this.#ws) {
      this.#ws.removeAllListeners();
      this.#ws.terminate();
      this.#ws = null;
    }
    this.#setStatus('disconnected');
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
        
        if (res.status === 401) {
          log.warn('Twitch token expired — attempting auto-refresh...');
          const newTokens = await refreshAccessToken();
          if (newTokens?.access_token) {
            settings.twitch.accessToken = newTokens.access_token;
            if (newTokens.refresh_token) settings.twitch.refreshToken = newTokens.refresh_token;
            writeFileSync(join(ROOT, 'settings.json'), JSON.stringify(settings, null, 2));
            log.info('Token refreshed successfully — retrying subscription.');
            return this.#subscribe(); // Retry entire loop once
          } else {
            log.error('Auto-refresh failed — please re-connect Twitch in the dashboard.');
            this.#setStatus('error');
            return;
          }
        }

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
