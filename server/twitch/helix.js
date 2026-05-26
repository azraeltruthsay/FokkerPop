import settings from '../settings-loader.js';

const BASE = 'https://api.twitch.tv/helix';

// Categorized error so pollers can branch on cause without parsing strings.
// kind values:
//   'unconfigured' — clientId or accessToken missing locally (not a Twitch error)
//   'scope'        — 401 with "missing scope" body (user needs to reconnect)
//   'auth'         — 401 not specifically about scope (token expired / revoked)
//   'rate-limit'   — 429
//   'not-monetized'— 400 from the ads endpoint when channel isn't an Affiliate/Partner
//   'data'         — 4xx with a well-formed error response from Twitch
//   'network'      — fetch threw before we got a response (DNS / timeout / etc.)
export class HelixError extends Error {
  constructor(kind, status, message, { path, scope } = {}) {
    super(message);
    this.kind   = kind;
    this.status = status;
    this.path   = path || '';
    this.scope  = scope || '';
  }
}

function categorize(path, res, body) {
  const status = res.status;
  const msg    = body?.message || res.statusText || `HTTP ${status}`;
  if (status === 401) {
    const scopeMatch = /scope/i.test(msg) || /missing/i.test(msg);
    return new HelixError(scopeMatch ? 'scope' : 'auth', status, msg, { path });
  }
  if (status === 429) return new HelixError('rate-limit', status, msg, { path });
  if (status === 400 && /not.*affiliate|not.*partner|not.*monetized/i.test(msg)) {
    return new HelixError('not-monetized', status, msg, { path });
  }
  return new HelixError('data', status, msg, { path });
}

async function helixGet(path, accessToken) {
  const { clientId } = settings.twitch ?? {};
  if (!clientId || !accessToken) {
    throw new HelixError('unconfigured', 0, 'Twitch is not connected — clientId or accessToken missing', { path });
  }
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id':     clientId,
      },
    });
  } catch (err) {
    throw new HelixError('network', 0, err.message || 'fetch failed', { path });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw categorize(path, res, body);
  }
  return res.json();
}

export async function getUser(login, accessToken) {
  const data = await helixGet(`/users?login=${encodeURIComponent(login)}`, accessToken);
  return data.data?.[0] ?? null;
}

// /users with no login param returns the authenticated user — the account
// whose access token is on the request. Used right after OAuth completes
// to resolve the user's broadcaster id (which EventSub.isConfigured needs
// before it'll dial out) without making the user paste their channel name
// into a separate Setup step.
export async function getAuthenticatedUser(accessToken) {
  const data = await helixGet('/users', accessToken);
  return data.data?.[0] ?? null;
}

// Live-stream info for the broadcaster. Empty array → offline. When live,
// returns one entry with viewer_count, title, game_name, started_at, etc.
// Used by the stream-stats poller to keep state.twitch.live in sync.
export async function getStreamInfo(broadcasterId, accessToken) {
  const data = await helixGet(`/streams?user_id=${encodeURIComponent(broadcasterId)}`, accessToken);
  return data.data?.[0] ?? null;
}

// Total follower count. Returns the response's `total` field — we don't
// need the actual follower list, so first=1 keeps the payload minimal.
// Scope: moderator:read:followers (the broadcaster reading their own channel
// counts as being a moderator of it). Already requested in the OAuth flow.
export async function getFollowerTotal(broadcasterId, accessToken) {
  const data = await helixGet(`/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`, accessToken);
  return Number.isFinite(data.total) ? data.total : 0;
}

// Total subscriber count + sub points. `points` weighs tier-2/3/gift subs
// (per Twitch's "X subs unlocks emote tier" math) so a Goals widget bound
// to sub points reflects what Twitch actually displays for sub goals.
// Scope: channel:read:subscriptions.
export async function getSubscriberTotal(broadcasterId, accessToken) {
  const data = await helixGet(`/subscriptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`, accessToken);
  return {
    total:  Number.isFinite(data.total) ? data.total : 0,
    points: Number.isFinite(data.points) ? data.points : 0,
  };
}

// Broadcaster's scheduled-stream segments. Returns the next non-canceled
// upcoming segment, or null if nothing is scheduled in the next ~week.
// No special scope required — schedule data is public.
export async function getNextScheduleSegment(broadcasterId, accessToken) {
  const data = await helixGet(`/schedule?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=10`, accessToken);
  const segs = data.data?.segments ?? [];
  const now  = Date.now();
  for (const s of segs) {
    const startMs = s.start_time ? Date.parse(s.start_time) : NaN;
    if (!Number.isFinite(startMs) || startMs <= now) continue;
    if (s.canceled_until) continue; // canceled segment — skip to next
    return {
      startAt:  startMs,
      endAt:    s.end_time ? Date.parse(s.end_time) : 0,
      title:    s.title || '',
      category: s.category?.name || '',
    };
  }
  return null;
}

// Next channel-ad-break info. Requires channel:read:ads scope (added to the
// OAuth scope list in v0.4.15 — existing connects will 401 here until they
// reconnect, and that's fine: caller catches and shows '—'). Affiliates/
// Partners only; Twitch returns 400 for non-monetized channels.
export async function getAdSchedule(broadcasterId, accessToken) {
  const data = await helixGet(`/channels/ads?broadcaster_id=${encodeURIComponent(broadcasterId)}`, accessToken);
  const row  = data.data?.[0];
  if (!row) return null;
  return {
    nextAdAt:        row.next_ad_at        ? Number(row.next_ad_at)        * 1000 : 0,
    lastAdAt:        row.last_ad_at        ? Number(row.last_ad_at)        * 1000 : 0,
    durationSec:     Number(row.duration)     || 0,
    snoozeCount:     Number(row.snooze_count) || 0,
    snoozeRefreshAt: row.snooze_refresh_at ? Number(row.snooze_refresh_at) * 1000 : 0,
    prerollFreeSec:  Number(row.preroll_free_time) || 0,
  };
}

// Recent followers list (up to 100). Used for "last 24 h follower" counts
// and a most-recent-follower display. Same scope as getFollowerTotal.
export async function getRecentFollowers(broadcasterId, accessToken, first = 100) {
  const data = await helixGet(`/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=${Math.min(100, Math.max(1, first))}`, accessToken);
  const list = (data.data ?? []).map(r => ({
    user:        r.user_name || r.user_login || '',
    userId:      r.user_id || '',
    followedAt:  r.followed_at ? Date.parse(r.followed_at) : 0,
  }));
  return { total: Number.isFinite(data.total) ? data.total : 0, list };
}

// List the broadcaster's Channel Point custom rewards. Used by the Studio
// "Refresh from Twitch" button on the Redeem trigger's reward dropdown so
// new rewards created in the Twitch dashboard show up without manual
// redeems.json edits. Requires the channel:read:redemptions scope which the
// app already requests for EventSub redemption subscriptions.
export async function getCustomRewards(broadcasterId, accessToken) {
  const data = await helixGet(`/channel_points/custom_rewards?broadcaster_id=${encodeURIComponent(broadcasterId)}`, accessToken);
  return data.data ?? [];
}

async function helixPost(path, body, accessToken) {
  const { clientId } = settings.twitch ?? {};
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.message || res.statusText);
  }
  return res.json();
}

export async function sendChatMessage(broadcasterId, message) {
  const { accessToken } = settings.twitch ?? {};
  if (!accessToken) {
    throw new Error('Twitch OAuth is not complete. Click "Connect Twitch" in Settings.');
  }

  return helixPost('/chat/messages', {
    broadcaster_id: broadcasterId,
    sender_id:      broadcasterId,
    message:        message
  }, accessToken);
}

export async function refreshAccessToken() {
  const { clientId, clientSecret, refreshToken } = settings.twitch ?? {};
  if (!clientId || !clientSecret || !refreshToken) return null;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) return null;
  return res.json();   // { access_token, refresh_token, expires_in }
}
