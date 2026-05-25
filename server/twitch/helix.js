import settings from '../settings-loader.js';

const BASE = 'https://api.twitch.tv/helix';

async function helixGet(path, accessToken) {
  const { clientId } = settings.twitch ?? {};
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id':     clientId,
    },
  });
  if (!res.ok) throw new Error(`Helix ${path} → ${res.status}`);
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
