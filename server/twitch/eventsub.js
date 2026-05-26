import { EventEmitter } from 'node:events';
import { WebSocket }    from 'ws';
import bus             from '../bus.js';
import settings, { saveSettings } from '../settings-loader.js';
import { refreshAccessToken } from './helix.js';
import log             from '../logger.js';
import integrationStatus from './integration-status.js';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

// Subscriptions we want — [type, version, condition, integrationKey].
// integrationKey is optional: when set, scope/auth subscription failures
// for that type are reported to integration-status under that feature key
// so the Health panel can show "needs reconnect" without waiting for a
// run-time event to fail.
const SUBS = (uid) => [
  ['channel.follow',                                       '2', { broadcaster_user_id: uid, moderator_user_id: uid }],
  ['channel.subscribe',                                    '1', { broadcaster_user_id: uid }],
  ['channel.subscription.gift',                            '1', { broadcaster_user_id: uid }],
  ['channel.cheer',                                        '1', { broadcaster_user_id: uid }],
  ['channel.raid',                                         '1', { to_broadcaster_user_id: uid }],
  ['channel.channel_points_custom_reward_redemption.add',  '1', { broadcaster_user_id: uid }],
  // Cluster E — hype train (was partial, now full coverage).
  ['channel.hype_train.begin',                             '1', { broadcaster_user_id: uid }, 'hype-train'],
  ['channel.hype_train.progress',                          '1', { broadcaster_user_id: uid }, 'hype-train'],
  ['channel.hype_train.end',                               '1', { broadcaster_user_id: uid }, 'hype-train'],
  // Cluster E — predictions (channel:read:predictions).
  ['channel.prediction.begin',                             '1', { broadcaster_user_id: uid }, 'prediction'],
  ['channel.prediction.progress',                          '1', { broadcaster_user_id: uid }, 'prediction'],
  ['channel.prediction.lock',                              '1', { broadcaster_user_id: uid }, 'prediction'],
  ['channel.prediction.end',                               '1', { broadcaster_user_id: uid }, 'prediction'],
  // Cluster E — polls (channel:read:polls).
  ['channel.poll.begin',                                   '1', { broadcaster_user_id: uid }, 'poll'],
  ['channel.poll.progress',                                '1', { broadcaster_user_id: uid }, 'poll'],
  ['channel.poll.end',                                     '1', { broadcaster_user_id: uid }, 'poll'],
  // Cluster E — charity (channel:read:charity).
  ['channel.charity_campaign.start',                       '1', { broadcaster_user_id: uid }, 'charity'],
  ['channel.charity_campaign.progress',                    '1', { broadcaster_user_id: uid }, 'charity'],
  ['channel.charity_campaign.stop',                        '1', { broadcaster_user_id: uid }, 'charity'],
  ['channel.charity_campaign.donate',                      '1', { broadcaster_user_id: uid }, 'charity'],
  ['channel.chat.message',                                 '1', { broadcaster_user_id: uid, user_id: uid }],
];

// Pull role/tier info out of Twitch chat badges (issue #4 cluster D).
// Chat events carry an array of {set_id, id, info} badge objects — for
// subscriber, `id` happens to encode the months-subscribed badge tier
// (1/3/6/12/24/...), which is what Twitch displays. Mod/VIP just have to
// exist. For non-chat events badges aren't included by EventSub, so this
// derivation runs on chat only and other events get the fields as
// undefined; per-user Helix lookups for cheer/redeem can come in a later
// iteration if rate-limit budget allows.
function deriveUserMeta(badges) {
  const list = Array.isArray(badges) ? badges : [];
  const sub  = list.find(b => b?.set_id === 'subscriber');
  return {
    userIsMod:        list.some(b => b?.set_id === 'moderator'),
    userIsVip:        list.some(b => b?.set_id === 'vip'),
    userIsSub:        !!sub,
    userMonthsSubbed: sub?.id ? Number(sub.id) || 0 : 0,
  };
}

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
    (ev) => ({ type: 'hype-train.start',    payload: { level: ev.level, total: ev.total, goal: ev.goal, expiresAt: ev.expires_at } }),
  'channel.hype_train.progress':
    (ev) => ({ type: 'hype-train.progress', payload: { level: ev.level, total: ev.total, progress: ev.progress, goal: ev.goal, expiresAt: ev.expires_at } }),
  'channel.hype_train.end':
    (ev) => ({ type: 'hype-train.end',      payload: { level: ev.level, total: ev.total, cooldownEndsAt: ev.cooldown_ends_at } }),

  // Cluster E — Predictions. Twitch sends outcomes as an array; we keep the
  // per-outcome channel-points wagered and user counts so flows can branch
  // on "which side is winning" mid-prediction, not just at end.
  'channel.prediction.begin':
    (ev) => ({ type: 'prediction.start',    payload: { id: ev.id, title: ev.title, outcomes: normalizePredictionOutcomes(ev.outcomes), locksAt: ev.locks_at } }),
  'channel.prediction.progress':
    (ev) => ({ type: 'prediction.progress', payload: { id: ev.id, title: ev.title, outcomes: normalizePredictionOutcomes(ev.outcomes), locksAt: ev.locks_at } }),
  'channel.prediction.lock':
    (ev) => ({ type: 'prediction.lock',     payload: { id: ev.id, title: ev.title, outcomes: normalizePredictionOutcomes(ev.outcomes), lockedAt: ev.locked_at } }),
  'channel.prediction.end':
    (ev) => {
      const outcomes = normalizePredictionOutcomes(ev.outcomes);
      const winning  = outcomes.find(o => o.id === ev.winning_outcome_id) || null;
      return { type: 'prediction.end',      payload: {
        id: ev.id, title: ev.title, outcomes,
        winningOutcomeId: ev.winning_outcome_id ?? '',
        winningOutcome:   winning ? winning.title : '',
        status:           ev.status, // 'resolved' | 'canceled'
        endedAt:          ev.ended_at,
      } };
    },

  // Cluster E — Polls. Choices carry channel-points / bits / standard votes
  // separately because Twitch lets viewers pay channel points or bits to
  // amplify their vote.
  'channel.poll.begin':
    (ev) => ({ type: 'poll.start',    payload: { id: ev.id, title: ev.title, choices: normalizePollChoices(ev.choices), endsAt: ev.ends_at } }),
  'channel.poll.progress':
    (ev) => ({ type: 'poll.progress', payload: { id: ev.id, title: ev.title, choices: normalizePollChoices(ev.choices), endsAt: ev.ends_at } }),
  'channel.poll.end':
    (ev) => {
      const choices = normalizePollChoices(ev.choices);
      const winning = choices.length ? choices.reduce((a, b) => (b.totalVotes > a.totalVotes ? b : a)) : null;
      return { type: 'poll.end',      payload: {
        id: ev.id, title: ev.title, choices,
        winningChoice:   winning ? winning.title : '',
        winningChoiceId: winning ? winning.id    : '',
        status:          ev.status, // 'completed' | 'archived' | 'terminated'
        endedAt:         ev.ended_at,
      } };
    },

  // Cluster E — Charity. donate events carry per-donation user + amount
  // so flows can show "User X donated $5 to charity" callouts.
  'channel.charity_campaign.start':
    (ev) => ({ type: 'charity.start',    payload: { id: ev.id, campaignName: ev.charity_name, website: ev.charity_website, target: amountFrom(ev.target_amount), current: amountFrom(ev.current_amount), startedAt: ev.started_at } }),
  'channel.charity_campaign.progress':
    (ev) => ({ type: 'charity.progress', payload: { id: ev.id, campaignName: ev.charity_name, current: amountFrom(ev.current_amount), target: amountFrom(ev.target_amount) } }),
  'channel.charity_campaign.stop':
    (ev) => ({ type: 'charity.stop',     payload: { id: ev.id, campaignName: ev.charity_name, stoppedAt: ev.stopped_at, finalAmount: amountFrom(ev.current_amount) } }),
  'channel.charity_campaign.donate':
    (ev) => ({ type: 'charity.donate',   payload: { id: ev.id, user: ev.user_name, userId: ev.user_id, amount: amountFrom(ev.amount), campaignName: ev.charity_name } }),

  'channel.chat.message':
    (ev) => ({ type: 'chat',                payload: { user: ev.chatter_user_name, message: ev.message.text, color: ev.color, badges: ev.badges, ...deriveUserMeta(ev.badges) } }),
};

// Twitch sends outcomes as [{ id, title, color, channel_points, users, top_predictors }]
// — flatten to a smaller shape that's easy to use in templates without burying
// the interesting numbers under raw API field names.
function normalizePredictionOutcomes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(o => ({
    id:            o.id,
    title:         o.title,
    color:         o.color,
    channelPoints: Number(o.channel_points) || 0,
    users:         Number(o.users)          || 0,
  }));
}

// Polls return [{ id, title, votes, channel_points_votes, bits_votes }].
// totalVotes rolls all three sources into a single number — useful for
// "which choice won" and most flow branches.
function normalizePollChoices(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    const base = Number(c.votes) || 0;
    const cp   = Number(c.channel_points_votes) || 0;
    const bit  = Number(c.bits_votes) || 0;
    return {
      id:                c.id,
      title:             c.title,
      votes:             base,
      channelPointsVotes: cp,
      bitsVotes:         bit,
      totalVotes:        base + cp + bit,
    };
  });
}

// Charity amounts arrive as { value, decimal_places, currency } — turn into
// a single float for "$X.YZ" formatting and a separate currency code so
// templates can render `${amount} ${currency}` without doing math.
function amountFrom(raw) {
  if (!raw || typeof raw !== 'object') return { value: 0, currency: 'USD' };
  const decimals = Number.isFinite(raw.decimal_places) ? raw.decimal_places : 2;
  return {
    value:    (Number(raw.value) || 0) / Math.pow(10, decimals),
    currency: raw.currency || 'USD',
  };
}

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
    const okFeatures   = new Set();
    const failFeatures = new Map(); // featureKey → most recent failure detail

    for (const sub of SUBS(userId)) {
      const [type, version, condition, integrationKey] = sub;
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
            saveSettings();
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
          if (integrationKey) okFeatures.add(integrationKey);
        } else {
          const body = await res.json().catch(() => ({}));
          const msg  = body?.message ?? `HTTP ${res.status}`;
          // 403 with "missing scope" wording is the standard "user hasn't
          // authorized this scope" path — record as 'scope' kind so the
          // Health panel can surface a Reconnect Twitch prompt.
          const kind = res.status === 403 && /scope/i.test(msg) ? 'scope' : 'data';
          log.warn(`EventSub subscription failed [${type}]:`, msg);
          fail++;
          if (integrationKey) {
            failFeatures.set(integrationKey, { kind, status: res.status, message: msg });
          }
        }
      } catch (err) {
        log.error(`EventSub subscription error [${type}]:`, err.message);
        fail++;
        if (integrationKey) {
          failFeatures.set(integrationKey, { kind: 'network', status: 0, message: err.message });
        }
      }
    }

    // Roll up per-feature status: report ok if at least one of the feature's
    // subscriptions succeeded (e.g. prediction.begin failed but .end worked
    // would still be partial-ok); otherwise report the most-recent failure.
    for (const feat of okFeatures) {
      integrationStatus.reportOk(feat, { summary: 'subscriptions live' });
    }
    for (const [feat, err] of failFeatures) {
      if (okFeatures.has(feat)) continue;
      integrationStatus.reportError(feat, err);
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
