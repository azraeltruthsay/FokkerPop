import { createServer }                                  from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize, resolve }             from 'node:path';
import { exec }                                from 'node:child_process';
import { WebSocketServer, WebSocket }          from 'ws';

import bus                   from './bus.js';
import state                 from './state.js';
import { applyPipeline }     from './pipeline/index.js';
import { TwitchEventSub }    from './twitch/eventsub.js';
import settings, { ROOT }    from './settings-loader.js';
import log                   from './logger.js';

// ── Config ────────────────────────────────────────────────────────────────────
const PORT   = settings.server?.port ?? 4747;
const BIND   = '127.0.0.1';   // local only — never expose to LAN

const goals   = loadAndEnsureJson('goals.json',   []);
const redeems = loadAndEnsureJson('redeems.json', {});
state.set('goals', goals);

function loadAndEnsureJson(name, defaultData) {
  const p  = join(ROOT, name);
  const ep = join(ROOT, name.replace('.json', '.example.json'));

  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      log.error(`Failed to parse ${name}:`, err.message);
      return defaultData;
    }
  }

  // Fallback to example
  const data = existsSync(ep) ? JSON.parse(readFileSync(ep, 'utf8')) : defaultData;
  try {
    writeFileSync(p, JSON.stringify(data, null, 2));
    log.info(`Created default ${name} from example.`);
  } catch (err) {
    log.error(`Failed to create ${name}:`, err.message);
  }
  return data;
}

// ── Client registry ───────────────────────────────────────────────────────────
const overlays   = new Set();
const dashboards = new Set();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(clients, obj) {
  for (const ws of clients) send(ws, obj);
}
function broadcastEffect(effect, payload = {}) {
  broadcast(overlays, { type: 'effect', effect, payload });
}
function broadcastState(path, value) {
  const msg = { type: 'state', path, value };
  broadcast(overlays,   msg);
  broadcast(dashboards, msg);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
bus.use(applyPipeline);
bus.on('error', (err) => log.error('Bus error:', err?.message ?? err));

// ── Crowd energy ──────────────────────────────────────────────────────────────
let lastEventTs         = Date.now();
let lastEnergyBroadcast = 0;

// Passive drain — the only setInterval in the entire server
setInterval(() => {
  const energy = state.get('crowd.energy') ?? 0;
  if (energy <= 0) return;
  if (Date.now() - lastEventTs < 2000) return;  // no drain while events are flowing

  const drained = Math.max(0, energy - (settings.crowd?.drainPerSec ?? 1));
  state.set('crowd.energy', drained);

  const now = Date.now();
  if (now - lastEnergyBroadcast > 500) {         // max 2 broadcasts/sec
    broadcastState('crowd.energy', drained);
    lastEnergyBroadcast = now;
  }
}, 1000);

// ── Event → state + effects ───────────────────────────────────────────────────
bus.on('*', async (event) => {
  lastEventTs = Date.now();
  log.info(`event type=${event.type} source=${event.source ?? 'unknown'}`);

  try {
    applyBoost(event);
    updateSessionStats(event);
    checkGoals();
  } catch (err) {
    log.error('Event handler error:', err.message, err.stack);
  }

  // Dispatch routed effects
  for (const { effect, payload } of event.effects ?? []) {
    broadcastEffect(effect, payload);
  }

  // Redeem mapping
  if (event.type === 'redeem') {
    const def = redeems[event.payload?.rewardTitle];
    if (def) {
      const { effect, ...payload } = def;
      broadcastEffect(effect, payload);
    }
  }

  broadcast(dashboards, { type: 'event-log', event });
});

function applyBoost(event) {
  const c = settings.crowd ?? {};
  const boostMap = {
    follow:       () => c.followBoost ?? 1,
    sub:          () => c.subBoost ?? 10,
    'sub.gifted': () => (c.subBoost ?? 10) * (event.payload?.count ?? 1),
    cheer:        () => Math.floor((event.payload?.bits ?? 0) / 50) * (c.bitsBoostPer50 ?? 1),
    raid:         () => (c.raidBoost ?? 20) + Math.floor((event.payload?.viewers ?? 0) / 10) * (c.raidViewerBoostPer10 ?? 1),
  };
  const fn = boostMap[event.type];
  if (!fn) return;

  const boost = fn();
  if (boost <= 0) return;

  const next = Math.min(100, (state.get('crowd.energy') ?? 0) + boost);
  state.set('crowd.energy', next);
  broadcastState('crowd.energy', next);
  if (next >= 100) broadcastEffect('crowd-explosion', {});
}

function updateSessionStats(event) {
  const user = event.payload?.user;
  if (event.type === 'sub') {
    state.increment('session.subCount');
    if (user) incrementLeaderboard('subs', user, 1);
  }
  if (event.type === 'sub.gifted') {
    const n = event.payload?.count ?? 1;
    state.increment('session.subCount', n);
    if (user) incrementLeaderboard('gifts', user, n);
  }
  if (event.type === 'cheer') {
    const bits = event.payload?.bits ?? 0;
    state.increment('session.bitsTotal', bits);
    if (user) incrementLeaderboard('bits', user, bits);
    broadcastState('leaderboard', state.get('leaderboard'));
  }
  if (event.type === 'follow')  state.increment('session.followCount');
  if (event.type === 'raid')    state.increment('session.raidCount');
}

function incrementLeaderboard(category, user, amount) {
  const lb = state.get(`leaderboard.${category}`) ?? {};
  lb[user] = (lb[user] ?? 0) + amount;
  state.set(`leaderboard.${category}`, lb);
  broadcastState('leaderboard', state.get('leaderboard'));
}

function checkGoals() {
  const goals = state.get('goals') ?? [];
  let dirty = false;
  for (const g of goals) {
    if (!g.active || g.completed) continue;
    if ((state.get(g.metric) ?? 0) >= g.target) {
      g.completed = true;
      dirty = true;
      if (g.reward?.type === 'effect') broadcastEffect(g.reward.effect, {});
      broadcastEffect('alert-banner', { tier: 'S', icon: '🎯', text: `Goal Reached: ${g.label}!` });
    }
  }
  if (dirty) {
    state.set('goals', goals);
    broadcastState('goals', goals);
  }
}

// ── HTTP server (no express) ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.ico':  'image/x-icon',
};

function serveFile(res, filePath) {
  // Path traversal guard: resolved path must stay within ROOT
  const safe = resolve(filePath);
  if (!safe.startsWith(ROOT + '/') && safe !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!existsSync(safe)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, {
    'Content-Type':           MIME[extname(safe)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control':          'no-cache',
  });
  res.end(readFileSync(safe));
}

const httpServer = createServer((req, res) => {
  let url, path;
  try {
    url  = new URL(req.url, `http://${req.headers.host}`);
    path = url.pathname;
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }

  // Overlay browser source
  if (path === '/' || path === '/overlay') {
    return serveFile(res, join(ROOT, 'overlay.html'));
  }

  // Dashboard static files
  if (path === '/dashboard' || path === '/dashboard/') {
    return serveFile(res, join(ROOT, 'dashboard/index.html'));
  }
  if (path.startsWith('/dashboard/')) {
    return serveFile(res, join(ROOT, path.slice(1)));
  }

  // Assets (stickers, sounds, character sprites)
  if (path.startsWith('/assets/') || path.startsWith('/characters/')) {
    return serveFile(res, join(ROOT, path.slice(1)));
  }

  // Plugins (future-proofing)
  if (path.startsWith('/plugins/')) {
    return serveFile(res, join(ROOT, path.slice(1)));
  }

  // REST API
  if (path === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state.snapshot()));
  }

  if (path === '/api/goals' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state.get('goals') ?? []));
  }

  if (path === '/api/goals' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const goals = JSON.parse(body);
        state.set('goals', goals);
        broadcastState('goals', goals);
        writeFileSync(join(ROOT, 'goals.json'), JSON.stringify(goals, null, 2));
        res.writeHead(200); res.end('{"ok":true}');
      } catch (err) { res.writeHead(400); res.end(err.message); }
    });
    return;
  }

  if (path === '/api/redeems' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(redeems));
  }

  if (path === '/api/redeems' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        // Full replacement — Config editor saves the complete current set
        Object.keys(redeems).forEach(k => delete redeems[k]);
        Object.assign(redeems, patch);
        writeFileSync(join(ROOT, 'redeems.json'), JSON.stringify(redeems, null, 2));
        res.writeHead(200); res.end('{"ok":true}');
      } catch (err) { res.writeHead(400); res.end(err.message); }
    });
    return;
  }

  if (path === '/api/assets' && req.method === 'GET') {
    const assets = { sounds: [], stickers: [] };
    try {
      const sDir = join(ROOT, 'assets/sounds');
      if (existsSync(sDir)) assets.sounds = readdirSync(sDir).filter(f => !f.startsWith('.'));
      const tDir = join(ROOT, 'assets/stickers');
      if (existsSync(tDir)) assets.stickers = readdirSync(tDir).filter(f => !f.startsWith('.'));
    } catch (err) { log.error('Asset scan error:', err.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(assets));
  }

  if (path === '/api/settings' && req.method === 'GET') {
    const s = { ...settings };
    if (s.twitch) s.twitch = { ...s.twitch, accessToken: '***', refreshToken: '***', clientSecret: '***' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(s));
  }

  if (path === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        settings.twitch ??= {};
        if (patch.twitch?.clientId)     settings.twitch.clientId     = patch.twitch.clientId;
        if (patch.twitch?.clientSecret) settings.twitch.clientSecret = patch.twitch.clientSecret;
        writeFileSync(join(ROOT, 'settings.json'), JSON.stringify(settings, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (err) {
        log.error('Settings POST error:', err.message);
        res.writeHead(400); res.end('Bad request');
      }
    });
    return;
  }

  // OAuth callback
  if (path === '/auth/callback') {
    return handleOAuthCallback(url.searchParams, res);
  }

  res.writeHead(404); res.end('Not found');
});

async function handleOAuthCallback(params, res) {
  const code = params.get('code');
  if (!code) {
    res.writeHead(400); res.end('Missing code'); return;
  }
  const { clientId, clientSecret } = settings.twitch ?? {};
  try {
    const r = await fetch('https://id.twitch.tv/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `http://localhost:${PORT}/auth/callback`, client_id: clientId, client_secret: clientSecret }),
    });
    const token = await r.json();
    if (token.access_token) {
      settings.twitch.accessToken  = token.access_token;
      settings.twitch.refreshToken = token.refresh_token ?? '';
      writeFileSync(join(ROOT, 'settings.json'), JSON.stringify(settings, null, 2));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
        <body style="font:20px system-ui;text-align:center;padding:60px;background:#0d0d14;color:#fff">
          <p>✅ Twitch connected!</p>
          <p style="font-size:16px;color:#aaa">Closing this window in 2 seconds...</p>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body>
        </html>`);
      // Re-connect EventSub with new token
      twitchEventSub.connect();
    } else {
      res.writeHead(400); res.end('Token exchange failed: ' + JSON.stringify(token));
    }
  } catch (e) {
    res.writeHead(500); res.end('OAuth error: ' + e.message);
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Reject anything not from localhost
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    ws.close(1008, 'Local only');
    return;
  }

  overlays.add(ws);   // default client type until register message

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      if (msg.client === 'dashboard') {
        overlays.delete(ws);
        dashboards.add(ws);
        send(ws, { type: 'state-snapshot', state: state.snapshot() });
        send(ws, { type: 'state', path: 'twitch.status', value: twitchEventSub.status });
      } else {
        // Overlay: send current state
        send(ws, { type: 'state', path: 'crowd.energy', value: state.get('crowd.energy') });
        send(ws, { type: 'state', path: 'goals',        value: state.get('goals')         });
        send(ws, { type: 'state', path: 'leaderboard',  value: state.get('leaderboard')   });
        send(ws, { type: 'state', path: 'session',      value: state.get('session')        });
      }
      return;
    }

    if (!dashboards.has(ws)) return;  // only dashboard can send commands

    switch (msg.type) {
      case '_dashboard.test-event':
        bus.publish({ source: 'dashboard', ...(msg.event ?? {}) });
        break;
      case '_dashboard.effect':
        broadcastEffect(msg.effect, msg.payload ?? {});
        break;
      case '_dashboard.crowd-boost': {
        const next = Math.min(100, (state.get('crowd.energy') ?? 0) + (msg.amount ?? 10));
        state.set('crowd.energy', next);
        broadcastState('crowd.energy', next);
        if (next >= 100) broadcastEffect('crowd-explosion', {});
        break;
      }
      case '_dashboard.crowd-reset':
        state.set('crowd.energy', 0);
        broadcastState('crowd.energy', 0);
        break;
      case '_dashboard.goal-toggle': {
        const goals = state.get('goals') ?? [];
        const g = goals.find(g => g.id === msg.id);
        if (g) { g.active = !g.active; state.set('goals', goals); broadcastState('goals', goals); }
        break;
      }
      case '_dashboard.goal-reset': {
        const goals = state.get('goals') ?? [];
        const g = goals.find(g => g.id === msg.id);
        if (g) { g.completed = false; state.set('goals', goals); broadcastState('goals', goals); }
        break;
      }
      case '_dashboard.volume':
        broadcast(overlays, { type: 'state', path: 'overlay.volume', value: msg.value });
        broadcast(dashboards, { type: 'state', path: 'overlay.volume', value: msg.value });
        break;
      case '_dashboard.session-reset':
        state.resetSession();
        broadcastState('session',     state.get('session'));
        broadcastState('leaderboard', state.get('leaderboard'));
        broadcastState('crowd.energy', 0);
        broadcastState('goals', state.get('goals'));
        break;
    }
  });

  ws.on('close', () => { overlays.delete(ws); dashboards.delete(ws); });
  ws.on('error', () => { overlays.delete(ws); dashboards.delete(ws); });

  send(ws, { type: 'ping' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
const twitchEventSub = new TwitchEventSub();

twitchEventSub.on('status', (status) => {
  broadcast(dashboards, { type: 'state', path: 'twitch.status', value: status });
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use. Is FokkerPop already running?`);
  } else {
    log.error('HTTP server error:', err.message);
  }
  process.exit(1);
});

httpServer.listen(PORT, BIND, () => {
  log.info(`FokkerPop listening on ${BIND}:${PORT}`);
  console.log(`
╔══════════════════════════════════════════════════╗
║   FokkerPop  v0.1.9   — live on ${BIND}:${PORT}   ║
╠══════════════════════════════════════════════════╣
║  Overlay   →  http://localhost:${PORT}/          ║
║  Dashboard →  http://localhost:${PORT}/dashboard ║
╚══════════════════════════════════════════════════╝`);

  twitchEventSub.connect();
});

function shutdown(signal) {
  log.info(`Received ${signal}, shutting down…`);
  state.flush();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (err) => { log.error('Uncaught exception:',  err.message, err.stack); });
process.on('unhandledRejection', (err) => { log.error('Unhandled rejection:', err?.message ?? err); });
