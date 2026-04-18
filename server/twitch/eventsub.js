import { WebSocket } from 'ws';
import bus            from '../bus.js';
import settings       from '../settings-loader.js';

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
};

export class TwitchEventSub {
  #ws            = null;
  #sessionId     = null;
  #retryDelay    = 2000;
  #keepaliveTimer = null;

  get isConfigured() {
    const t = settings.twitch ?? {};
    return !!(t.clientId && t.accessToken && t.userId);
  }

  connect() {
    if (!this.isConfigured) {
      console.log('[eventsub] Twitch credentials not configured — skipping connection.');
      console.log('[eventsub] Fill in settings.json to enable live events.');
      return;
    }
    this.#dial(EVENTSUB_URL);
  }

  #dial(url) {
    this.#ws = new WebSocket(url);
    this.#ws.on('open',    ()    => console.log('[eventsub] connected'));
    this.#ws.on('message', (raw) => this.#handle(JSON.parse(raw)));
    this.#ws.on('close',   ()    => {
      clearTimeout(this.#keepaliveTimer);
      console.log(`[eventsub] disconnected, retrying in ${this.#retryDelay / 1000}s`);
      setTimeout(() => this.#dial(EVENTSUB_URL), this.#retryDelay);
      this.#retryDelay = Math.min(this.#retryDelay * 2, 30_000);
    });
    this.#ws.on('error', (e) => console.error('[eventsub]', e.message));
  }

  #handle(msg) {
    const { metadata, payload } = msg;

    // Reset keepalive watchdog — Twitch sends a keepalive every ~10s
    clearTimeout(this.#keepaliveTimer);
    this.#keepaliveTimer = setTimeout(() => {
      console.warn('[eventsub] keepalive timeout, reconnecting');
      this.#ws?.terminate();
    }, 15_000);

    switch (metadata.message_type) {
      case 'session_welcome':
        this.#sessionId  = payload.session.id;
        this.#retryDelay = 2000;
        this.#subscribe();
        break;

      case 'notification':
        this.#normalize(payload);
        break;

      case 'session_reconnect':
        clearTimeout(this.#keepaliveTimer);
        this.#ws?.removeAllListeners();
        this.#dial(payload.session.reconnect_url);
        break;

      case 'revocation':
        console.warn('[eventsub] subscription revoked:', payload.subscription.type);
        break;
    }
  }

  async #subscribe() {
    const { userId, accessToken, clientId } = settings.twitch;

    for (const [type, version, condition] of SUBS(userId)) {
      try {
        const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: this.#sessionId } }),
        });
        if (!res.ok) console.warn(`[eventsub] sub failed ${type}:`, (await res.json())?.message);
      } catch (e) {
        console.error(`[eventsub] sub error ${type}:`, e.message);
      }
    }
  }

  #normalize(payload) {
    const normalizer = NORMALIZERS[payload.subscription.type];
    if (normalizer) bus.publish({ source: 'twitch', ...normalizer(payload.event) });
  }
}
