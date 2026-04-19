import { createServer }                                  from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, createWriteStream } from 'node:fs';
import { extname, join, normalize, resolve, sep, relative, isAbsolute, basename } from 'node:path';
import { exec }                                from 'node:child_process';
import { WebSocketServer, WebSocket }          from 'ws';

import bus                        from './bus.js';
import state                      from './state.js';
import { applyPipeline }          from './pipeline/index.js';
import { TwitchEventSub }         from './twitch/eventsub.js';
import flowEngine            from './pipeline/flow-engine.js';
import obs                   from './obs.js';
import * as helix            from './twitch/helix.js';
import settings, { ROOT }    from './settings-loader.js';

import log                        from './logger.js';
import { makeCtx, resolveDeep }   from './template.js';
import { scheduleChecks, applyUpdate, getAvailable as getAvailableUpdate } from './update-checker.js';

process.title = 'FokkerPop';

// ── Config ────────────────────────────────────────────────────────────────────
const PORT    = settings.server?.port ?? 4747;
const BIND    = '127.0.0.1';   // local only — never expose to LAN
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const goals    = loadAndEnsureJson('goals.json',   []);
const redeems  = loadAndEnsureJson('redeems.json', {});
const commands = loadAndEnsureJson('commands.json', {});
const flows    = loadAndEnsureJson('flows.json',   []);
state.set('goals', goals);
flowEngine.setFlows(flows);

const commandCooldowns = new Map();

function fireCommand(text, event) {
  if (!text.startsWith('!')) return;
  const cmd = commands[text.toLowerCase().trim()];
  if (!cmd) return;

  const now = Date.now();
  const last = commandCooldowns.get(text) ?? 0;
  if (now - last < (cmd.cooldown || 5) * 1000) return;

  commandCooldowns.set(text, now);
  broadcastEffect(cmd.effect, { ...cmd }, event.isTest);
}

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
let layoutMode = false;
let isShuttingDown = false;

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(clients, obj) {
  for (const ws of clients) send(ws, obj);
}
function broadcastEffect(effect, payload = {}, isTest = false) {
  broadcast(overlays, { type: 'effect', effect, payload, isTest });
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
  if (isShuttingDown) return;
  lastEventTs = Date.now();
  log.info(`event type=${event.type} source=${event.source ?? 'unknown'}`);

  // Track chatters from any event that carries a user (skip test events — they're not real viewers)
  if (event.payload?.user && !event.isTest) {
    state.addChatter(event.payload.user);
    broadcastState('chatters', state.get('chatters'));
  }

  try {
    // Test events fire visuals but don't mutate persistent session state / leaderboard / crowd energy / goals
    if (!event.isTest) {
      applyBoost(event);
      updateSessionStats(event);
      checkGoals();
    }
    flowEngine.processEvent(event, broadcastEffect);
    if (event.type === 'chat') {
      fireCommand(event.payload.message, event);
    }
  } catch (err) {
    log.error('Event handler error:', err.message, err.stack);
  }

  // Dispatch routed effects
  for (const { effect, payload } of event.effects ?? []) {
    broadcastEffect(effect, payload, event.isTest);
  }

  // Visual flow tracking for Studio
  if (event.type === 'flow.node-fired') {
    broadcast(dashboards, { type: 'flow.node-fired', nodeId: event.nodeId });
  }

  // Redeem mapping — supports expressions, effects arrays, and chaining
  if (event.type === 'redeem') {
    fireRedeem(redeems[event.payload?.rewardTitle], event);
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
      if (g.reward?.type === 'effect') {
        const { type, effect, ...rest } = g.reward;
        broadcastEffect(effect, rest);
      }
      broadcastEffect('alert-banner', { tier: 'S', icon: '🎯', text: `Goal Reached: ${g.label}!` });
    }
  }
  if (dirty) {
    state.set('goals', goals);
    broadcastState('goals', goals);
  }
}

function fireRedeem(def, event, depth = 0) {
  if (!def || depth > 5) return;  // guard against circular chains
  const ctx = makeCtx(event);

  // Support both legacy single-effect and new effects array
  const effectList = def.effects
    ?? (def.effect ? [{ effect: def.effect, ...def }] : []);

  for (const entry of effectList) {
    const { effect, ...rawPayload } = entry;
    if (!effect) continue;
    const payload = resolveDeep(rawPayload, ctx);
    broadcastEffect(effect, payload);
  }

  // Chain: trigger another named redeem after this one
  if (def.chain) {
    const chainDef = Array.isArray(def.chain)
      ? def.chain.map(n => redeems[n]).filter(Boolean)
      : [redeems[def.chain]].filter(Boolean);
    for (const next of chainDef) fireRedeem(next, event, depth + 1);
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
  const safe = normalize(resolve(filePath));
  const root = normalize(resolve(ROOT));
  
  // Guard: path must be within ROOT.
  // We use lowercase comparison for startsWith to handle Windows casing quirks.
  if (!safe.toLowerCase().startsWith(root.toLowerCase())) {
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

  // Redirect /dashboard -> /dashboard/ (ensures relative assets like app.js work)
  if (path === '/dashboard') {
    res.writeHead(301, { 'Location': '/dashboard/' });
    return res.end();
  }

  // Overlay browser source
  if (path === '/' || path === '/overlay') {
    return serveFile(res, join(ROOT, 'overlay.html'));
  }

  // Dashboard static files
  if (path === '/dashboard/') {
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

  // ... (REST API unchanged)

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

  if (path === '/api/commands' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(commands));
  }

  if (path === '/api/commands' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        Object.keys(commands).forEach(k => delete commands[k]);
        Object.assign(commands, patch);
        writeFileSync(join(ROOT, 'commands.json'), JSON.stringify(commands, null, 2));
        res.writeHead(200); res.end('{"ok":true}');
      } catch (err) { res.writeHead(400); res.end(err.message); }
    });
    return;
  }

  if (path === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);
        if (!message) throw new Error('Missing message');
        await helix.sendChatMessage(settings.twitch.userId, message);
        res.writeHead(200); res.end('{"ok":true}');
      } catch (err) {
        log.error('Chat send error:', err.message);
        res.writeHead(400); res.end(err.message);
      }
    });
    return;
  }

  if (path === '/api/upload' && req.method === 'POST') {
    const rawName = req.headers['x-filename'];
    const type    = req.headers['x-type']; // 'sound', 'sticker', 'character'

    if (!rawName || !type) { res.writeHead(400); res.end('Missing metadata'); return; }

    const folders = {
      sound:     'assets/sounds',
      sticker:   'assets/stickers',
      character: 'characters/lilfokkermascot'
    };

    const targetDir = folders[type];
    if (!targetDir) { res.writeHead(400); res.end('Invalid type'); return; }

    // Reject any filename that carries path separators — legitimate uploads never do.
    const nameStr = String(rawName);
    if (/[/\\]/.test(nameStr) || nameStr === '.' || nameStr === '..' || nameStr.startsWith('.')) {
      res.writeHead(400); res.end('Invalid filename'); return;
    }
    const name = basename(nameStr); // defense in depth

    const targetRoot = resolve(ROOT, targetDir);
    const savePath   = resolve(targetRoot, name);
    if (!savePath.startsWith(targetRoot + sep)) {
      res.writeHead(400); res.end('Invalid filename'); return;
    }

    const stream = createWriteStream(savePath);
    req.pipe(stream);
    stream.on('finish', () => {
      log.info(`Uploaded file: ${name} to ${targetDir}`);
      res.writeHead(200); res.end('{"ok":true}');
    });
    stream.on('error', (err) => {
      log.error('Upload error:', err.message);
      res.writeHead(500); res.end(err.message);
    });
    return;
  }

  if (path === '/api/flows' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(flows));
  }

  if (path === '/api/flows/example' && req.method === 'GET') {
    const p = join(ROOT, 'flows.example.json');
    const data = existsSync(p) ? readFileSync(p, 'utf8') : '[]';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(data);
  }

  if (path === '/api/flows' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const newFlows = JSON.parse(body);
        flows.length = 0;
        flows.push(...newFlows);
        flowEngine.setFlows(flows);
        writeFileSync(join(ROOT, 'flows.json'), JSON.stringify(flows, null, 2));
        res.writeHead(200); res.end('{"ok":true}');
      } catch (err) { res.writeHead(400); res.end(err.message); }
    });
    return;
  }

  if (path === '/api/assets' && req.method === 'GET') {
    const assets = { sounds: [], stickers: [], characters: [] };
    try {
      const sDir = join(ROOT, 'assets/sounds');
      if (existsSync(sDir)) assets.sounds = readdirSync(sDir).filter(f => !f.startsWith('.'));
      const tDir = join(ROOT, 'assets/stickers');
      if (existsSync(tDir)) assets.stickers = readdirSync(tDir).filter(f => !f.startsWith('.'));
      const cDir = join(ROOT, 'characters/lilfokkermascot');
      if (existsSync(cDir)) assets.characters = readdirSync(cDir).filter(f => !f.startsWith('.'));
    } catch (err) { log.error('Asset scan error:', err.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(assets));
  }

  if (path === '/api/logs' && req.method === 'GET') {
    const logName = `fokkerpop-${new Date().toISOString().slice(0,10)}.log`;
    const logPath = join(ROOT, 'logs', logName);
    let content = 'No logs found for today.';
    try {
      if (existsSync(logPath)) {
        const raw = readFileSync(logPath, 'utf8');
        content = raw.split('\n').slice(-100).join('\n');
      }
    } catch (err) { content = 'Error reading logs: ' + err.message; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(content);
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
        let obsChanged = false;

        if (patch.twitch) {
          settings.twitch ??= {};
          if (patch.twitch.clientId)     settings.twitch.clientId     = patch.twitch.clientId;
          if (patch.twitch.clientSecret) settings.twitch.clientSecret = patch.twitch.clientSecret;
        }

        if (patch.obs) {
          settings.obs ??= {};
          if (patch.obs.address !== undefined && patch.obs.address !== settings.obs.address) {
            settings.obs.address = patch.obs.address;
            obsChanged = true;
          }
          if (patch.obs.password !== undefined && patch.obs.password !== settings.obs.password) {
            settings.obs.password = patch.obs.password;
            obsChanged = true;
          }
        }

        if (patch.crowd) {
          settings.crowd ??= {};
          Object.assign(settings.crowd, patch.crowd);
        }

        writeFileSync(join(ROOT, 'settings.json'), JSON.stringify(settings, null, 2));
        
        if (obsChanged) {
          log.info('OBS settings updated — reconnecting...');
          obs.reconnect();
        }

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
      body:    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `http://localhost:${activePort}/auth/callback`, client_id: clientId, client_secret: clientSecret }),
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
        const snapshot = {
          ...state.snapshot(),
          version: VERSION,
          'overlay.layoutMode': layoutMode
        };
        send(ws, { type: 'state-snapshot', state: snapshot });
        send(ws, { type: 'state', path: 'version',      value: VERSION });
        send(ws, { type: 'state', path: 'twitch.status', value: twitchEventSub.status });
        send(ws, { type: 'state', path: 'obs.status',    value: obs.status });
        send(ws, { type: 'state', path: 'obs.streaming', value: obs.streaming });
        send(ws, { type: 'state', path: 'update.available', value: getAvailableUpdate() });
      } else {
        // Overlay: send current state
        send(ws, { type: 'state', path: 'crowd.energy', value: state.get('crowd.energy') });
        send(ws, { type: 'state', path: 'goals',        value: state.get('goals')         });
        send(ws, { type: 'state', path: 'leaderboard',  value: state.get('leaderboard')   });
        send(ws, { type: 'state', path: 'session',      value: state.get('session')        });
        send(ws, { type: 'state', path: 'overlay.positions',  value: state.get('overlay.positions') });
        send(ws, { type: 'state', path: 'overlay.layoutMode', value: layoutMode });
      }
      return;
    }

    if (!dashboards.has(ws)) return;  // only dashboard can send commands

    switch (msg.type) {
      case '_dashboard.test-event':
        bus.publish({ source: 'dashboard', isTest: true, ...(msg.event ?? {}) });
        break;
      case '_dashboard.effect':
        broadcastEffect(msg.effect, msg.payload ?? {}, true);
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
      case '_dashboard.layout-mode':
        layoutMode = msg.active;
        broadcast(overlays, { type: 'state', path: 'overlay.layoutMode', value: msg.active });
        broadcast(dashboards, { type: 'state', path: 'overlay.layoutMode', value: msg.active });
        break;
      case '_dashboard.save-position': {
        const positions = state.get('overlay.positions') ?? {};
        positions[msg.id] = { x: msg.x, y: msg.y };
        state.set('overlay.positions', positions);
        broadcastState('overlay.positions', positions);
        break;
      }
      case '_dashboard.reset-layout':
        state.set('overlay.positions', {});
        broadcastState('overlay.positions', {});
        break;
      case '_dashboard.session-reset':
        state.resetSession();
        broadcastState('session',     state.get('session'));
        broadcastState('leaderboard', state.get('leaderboard'));
        broadcastState('crowd.energy', 0);
        broadcastState('goals', state.get('goals'));
        break;
      case '_dashboard.update-apply':
        try {
          applyUpdate({
            root: ROOT,
            onBeforeExit: () => broadcast(overlays, { type: '_system.shutdown' }),
          });
        } catch (err) {
          log.error('Update apply failed:', err.message);
          broadcast(dashboards, { type: 'update.apply-error', message: err.message });
        }
        break;
    }
  });

  ws.on('close', () => { overlays.delete(ws); dashboards.delete(ws); });
  ws.on('error', () => { overlays.delete(ws); dashboards.delete(ws); });

  send(ws, { type: 'ping' });
});

// ── Plugins ──────────────────────────────────────────────────────────────────
const pluginDir = join(ROOT, 'plugins');
if (existsSync(pluginDir)) {
  const files = readdirSync(pluginDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const pluginPath = resolve(join(pluginDir, file));
      const { register } = await import(`file://${pluginPath}`);
      if (typeof register === 'function') {
        register({ bus, state, log, settings, flowEngine, broadcastEffect });
        log.info(`Plugin loaded: ${file}`);
      }
    } catch (err) {
      log.error(`Failed to load plugin ${file}:`, err.message);
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
const twitchEventSub = new TwitchEventSub();

twitchEventSub.on('status', (status) => {
  broadcast(dashboards, { type: 'state', path: 'twitch.status', value: status });
});

obs.on('status', (status) => {
  broadcast(dashboards, { type: 'state', path: 'obs.status', value: status });
});

obs.on('streaming', (live) => {
  broadcast(dashboards, { type: 'state', path: 'obs.streaming', value: live });
});

// ── Port binding with auto-fallback ───────────────────────────────────────────
let activePort = PORT;
const MAX_PORT_TRIES = 5;

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Almost always this means another FokkerPop is already running.
    // Falling back to port 4748 would split the dashboard/overlay between
    // two servers — confusing and the cause of "two instances" reports.
    log.error(`Port ${activePort} is already in use. FokkerPop appears to be already running.`);
    log.error(`Close the existing FokkerPop window (or kill FokkerPop.exe in Task Manager) and try again.`);
    process.exit(1);
  } else if (err.code === 'EACCES' && activePort < PORT + MAX_PORT_TRIES) {
    // Hyper-V / WSL / Docker can reserve ports on Windows — fall back to the next one.
    log.warn(`Port ${activePort} reserved by the OS (${err.code}), trying ${activePort + 1}…`);
    activePort++;
    httpServer.listen(activePort, BIND);
  } else if (err.code === 'EACCES') {
    log.error(`Ports ${PORT}–${activePort} are all reserved by Windows (Hyper-V/WSL/Docker).`);
    log.error(`Run in an admin Command Prompt to release them, then restart:`);
    log.error(`  netsh int ipv4 delete excludedportrange protocol=tcp numberofports=1 startport=${PORT}`);
    process.exit(1);
  } else {
    log.error('HTTP server error:', err.message);
    process.exit(1);
  }
});

httpServer.listen(PORT, BIND, () => {
  log.info(`FokkerPop listening on ${BIND}:${activePort}`);
  if (activePort !== PORT) {
    log.warn(`Default port ${PORT} was unavailable — using port ${activePort} instead.`);
    log.warn(`Add "server": { "port": ${activePort} } to settings.json to make this permanent.`);
  }
  console.log(`
╔══════════════════════════════════════════════════╗
║   FokkerPop  v${VERSION}  — live on ${BIND}:${activePort}   ║
╠══════════════════════════════════════════════════╣
║  Overlay   →  http://localhost:${activePort}/          ║
║  Dashboard →  http://localhost:${activePort}/dashboard ║
╚══════════════════════════════════════════════════╝`);

  twitchEventSub.connect();
  obs.connect();

  scheduleChecks({
    currentVersion:          VERSION,
    root:                    ROOT,
    broadcastToDashboards:   (msg) => broadcast(dashboards, msg),
  });

  const url = `http://localhost:${activePort}/dashboard/`;

  let cmd;
  if (process.platform === 'win32') {
    // Try Edge App Mode -> Chrome App Mode -> Default Browser
    cmd = `start msedge --app="${url}" || start chrome --app="${url}" || start ${url}`;
  } else {
    cmd = `xdg-open "${url}" 2>/dev/null || open "${url}"`;
  }

  // Give any existing dashboard window 5s to reconnect and reload itself.
  // If one does, skip opening a duplicate window. 5s is padded for auto-update
  // restarts where the browser may take a moment to retry.
  setTimeout(() => {
    if (dashboards.size > 0 || overlays.size > 0) {
      log.info('Existing client reconnected — skipping new browser window.');
    } else {
      exec(cmd, () => {});
    }
  }, 5000);

  log.info('FokkerPop is ready! Use the dashboard to test your overlay.');
});

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`Received ${signal}, shutting down…`);
  
  // Clear overlays immediately
  broadcast(overlays, { type: '_system.shutdown' });
  
  twitchEventSub.disconnect();
  obs.disconnect();
  state.flush();
  
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (err) => { log.error('Uncaught exception:',  err.message, err.stack); });
process.on('unhandledRejection', (err) => { log.error('Unhandled rejection:', err?.message ?? err); });
