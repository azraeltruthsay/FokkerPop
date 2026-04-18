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
