import { createServer }                                  from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, createWriteStream, statSync } from 'node:fs';
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
import { scheduleChecks, applyUpdate, getAvailable as getAvailableUpdate, setAutoInstall, setStreamingProbe, setAutoInstallHandler, onStreamingStateChange } from './update-checker.js';
import { parseChatRollSpec, expandPercentile, canRenderInTray } from '../shared/dice.js';

process.title = 'FokkerPop';

// ── Config ────────────────────────────────────────────────────────────────────
// Env var wins so `PORT=4800 npm start` and smoke tests can pick a free port
// without mutating settings.json.
const PORT    = parseInt(process.env.PORT, 10) || settings.server?.port || 4747;
const BIND    = '127.0.0.1';   // local only — never expose to LAN
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const goals    = loadAndEnsureJson('goals.json',   []);
const redeems  = loadAndEnsureJson('redeems.json', {});
const commands = loadAndEnsureJson('commands.json', {});
const flows    = loadAndEnsureJson('flows.json',   []);
const widgets  = loadAndEnsureJson('widgets.json', []);
state.set('goals', goals);
state.set('overlay.widgets', widgets);
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

  // Mode 1: trigger a redeem flow by name. Publishes the same kind of
  // 'redeem' event a real channel-point redemption would, so anything
  // wired to the redeem (redeems.json effects, Studio flows triggered
  // on type:'redeem' with that rewardTitle) fires identically. Lets
  // LilFokker make a chat command a true alias for a redeem instead
  // of duplicating the effect config.
  if (cmd.redeem) {
    if (!redeems[cmd.redeem]) {
      log.warn(`Chat command "${text.trim()}" references unknown redeem "${cmd.redeem}". Check redeems.json for the exact title (case + punctuation count).`);
      return;
    }
    bus.publish({
      source: 'chat-command',
      type:   'redeem',
      payload: {
        user:        event.payload?.user,
        rewardTitle: cmd.redeem,
      },
      isTest: event.isTest,
    });
    return;
  }

  // Mode 2 (legacy): fire an effect directly. Existing commands keep working.
  if (cmd.effect) {
    broadcastEffect(cmd.effect, { ...cmd }, event.isTest);
  }
}

// Chat dice roller. Responds to `!r`, `!roll`, `/r`, `/roll` followed by a
// standard RPG dice spec (e.g. `2d6`, `1d20+2d6`, `4d12`, `1d100`). If every
// requested die type is renderable by the dice-tray (D4/D6/D8/D10/D12/D20, and
// D100 as percentile 2×D10), the physical roll fires on the overlay and the
// result comes back via the normal dice-tray.rolled bus event. Otherwise the
// server rolls server-side and posts the result back to Twitch chat.
//
// Note: Twitch clients swallow some unknown `/` commands before sending, so
// `!r` / `!roll` are the reliable triggers. `/r` / `/roll` work for chat
// clients that let them through (and for dashboard simulation).
const ROLL_PREFIX_RE = /^[!\/](?:r|roll)\b\s*/i;

export let currentRollId = null;
export function setRollId(id) { currentRollId = id; }

async function fireChatRoll(text, event) {
  if (!ROLL_PREFIX_RE.test(text)) return;
  const rest = text.replace(ROLL_PREFIX_RE, '').trim();
  const spec = parseChatRollSpec(rest);
  if (!spec) return;

  const user = event.payload?.user || 'Chatter';

  if (canRenderInTray(spec)) {
    currentRollId = Math.random().toString(36).slice(2);
    const dice = expandPercentile(spec);
    bus.publish({
      source: 'chat-roll',
      type:   'dice-tray-roll',
      payload: { dice, user, tag: `chat-roll:${user}`, rollId: currentRollId },
      isTest: event.isTest,
    });
    return;
  }

  // Non-standard die sides (e.g. d7, d30) — just roll server-side and reply.
  const rolls = spec.map(g => ({
    sides:   g.sides,
    results: Array.from({ length: g.count }, () => 1 + Math.floor(Math.random() * g.sides)),
  }));
  const total  = rolls.reduce((s, r) => s + r.results.reduce((a, b) => a + b, 0), 0);
  const detail = rolls.map(r => `${r.results.length}d${r.sides}[${r.results.join(',')}]`).join(' + ');
  const reply  = `@${user} 🎲 ${detail} → ${total}`;
  if (!event.isTest && settings.twitch?.userId && settings.twitch?.accessToken && twitchEventSub.status === 'connected') {
    helix.sendChatMessage(settings.twitch.userId, reply).catch(err => log.error('Chat roll reply failed:', err.message));
  } else {
    log.info(`[chat-roll offline] ${reply}`);
  }
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
// Cached set of sound files actually on disk. Rebuilt at startup and after
// any upload / asset-refresh so we can substitute a fallback when a config
// references a file that was never shipped (e.g. legacy explosion.wav).
let availableSounds = new Set();
function rebuildSoundSet() {
  try {
    const dir = join(ROOT, 'assets/sounds');
    availableSounds = new Set(
      existsSync(dir) ? readdirSync(dir).filter(f => !f.startsWith('.')) : []
    );
  } catch { availableSounds = new Set(); }
}
rebuildSoundSet();

const FALLBACK_SOUND = 'alert.wav';

function broadcastEffect(effect, payload = {}, isTest = false) {
  if (payload?.sound && !availableSounds.has(payload.sound)) {
    log.debug(`Sound "${payload.sound}" not found on disk — substituting ${FALLBACK_SOUND}.`);
    payload = { ...payload, sound: availableSounds.has(FALLBACK_SOUND) ? FALLBACK_SOUND : undefined };
  }
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

// ── Resource accounting ──────────────────────────────────────────────────────
// Rolling counters sampled every RESOURCE_SAMPLE_MS and broadcast to dashboards
// on the `resources` state path, so the Resources page shows live server-side
// numbers (RSS, heap, CPU%, events/sec) plus whatever each overlay reports.
const RESOURCE_SAMPLE_MS = 2000;
let eventCounter = 0;
let lastCpuSample = process.cpuUsage();
let lastCpuAt    = Date.now();
// Keyed by WebSocket. Each entry is the latest payload an overlay sent via
// _overlay.resource-report — FPS, heap, widget inventory. Removed on close.
const overlayResourceReports = new Map();

function sampleResources() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage(lastCpuSample);
  const now = Date.now();
  const elapsedMs = Math.max(1, now - lastCpuAt);
  // process.cpuUsage returns microseconds; normalize to % of one CPU core
  // over the elapsed wall-clock window. >100% is possible on a multi-core
  // box under real load.
  const cpuPct = Math.min(999, ((cpu.user + cpu.system) / 1000) / elapsedMs * 100);
  lastCpuSample = process.cpuUsage();
  lastCpuAt = now;

  const eventsPerSec = eventCounter / (RESOURCE_SAMPLE_MS / 1000);
  eventCounter = 0;

  // Convert overlay reports into a plain array so JSON serialization works.
  // Anything that stopped reporting for > 3 sample intervals is stale and
  // dropped so the dashboard doesn't show ghost entries.
  const staleCutoff = now - RESOURCE_SAMPLE_MS * 3;
  const overlayReports = [];
  for (const [ws, report] of overlayResourceReports.entries()) {
    if (report.receivedAt < staleCutoff) { overlayResourceReports.delete(ws); continue; }
    overlayReports.push(report);
  }

  broadcastState('resources', {
    ts: now,
    server: {
      uptimeSec:  Math.round(process.uptime()),
      rss:        mem.rss,
      heapUsed:   mem.heapUsed,
      heapTotal:  mem.heapTotal,
      external:   mem.external,
      cpuPct:     Math.round(cpuPct * 10) / 10,
      eventsPerSec: Math.round(eventsPerSec * 10) / 10,
      pid:        process.pid,
      version:    VERSION,
      nodeVersion: process.version,
      platform:   process.platform,
    },
    connections: {
      overlays:   overlays.size,
      dashboards: dashboards.size,
    },
    overlays: overlayReports,
  });
}
setInterval(sampleResources, RESOURCE_SAMPLE_MS);

// ── Event → state + effects ───────────────────────────────────────────────────
bus.on('*', async (event) => {
  if (isShuttingDown) return;
  eventCounter++;
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
      fireChatRoll(event.payload.message, event);
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
  // Overlays need the event too so event-badge widgets can flash on matching types.
  broadcast(overlays,   { type: 'event-log', event });
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
  // URL pathnames aren't auto-decoded by `new URL()` — so an incoming request
  // like /assets/sounds/has%20space.wav arrives with the literal %20 still in
  // it. Decode before resolving to the on-disk path so files with spaces or
  // other URL-unsafe chars in their names actually serve.
  let decoded;
  try { decoded = decodeURIComponent(filePath); } catch { decoded = filePath; }
  const safe = normalize(resolve(decoded));
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
  if (path === '/overlay-widgets.js') {
    return serveFile(res, join(ROOT, 'overlay-widgets.js'));
  }

  // Dashboard static files
  if (path === '/dashboard/') {
    return serveFile(res, join(ROOT, 'dashboard/index.html'));
  }
  if (path.startsWith('/dashboard/')) {
    return serveFile(res, join(ROOT, path.slice(1)));
  }

  // Shared browser/node modules (semver helpers, etc.)
  if (path.startsWith('/shared/')) {
    return serveFile(res, join(ROOT, path.slice(1)));
  }

  // Assets (stickers, sounds, character sprites)
  if (path.startsWith('/assets/') || path.startsWith('/characters/')) {
    return serveFile(res, join(ROOT, path.slice(1)));
  }

  // Vendored libraries (three.js, matter.js, three GLTFLoader).
  // Narrow allowlist so we don't expose the rest of node_modules.
  const VENDOR = {
    '/vendor/three.module.min.js':                    'three/build/three.module.min.js',
    '/vendor/three.core.min.js':                      'three/build/three.core.min.js',
    '/vendor/matter.min.js':                          'matter-js/build/matter.min.js',
    '/vendor/cannon-es.js':                           'cannon-es/dist/cannon-es.js',
    // GLTFLoader lives at /vendor/three/loaders/ so its internal
    // `../utils/BufferGeometryUtils.js` import resolves to a path we also
    // serve. Its `from 'three'` bare import is resolved by the importmap in
    // overlay.html / dashboard/index.html.
    '/vendor/three/loaders/GLTFLoader.js':            'three/examples/jsm/loaders/GLTFLoader.js',
    '/vendor/three/utils/BufferGeometryUtils.js':     'three/examples/jsm/utils/BufferGeometryUtils.js',
    '/vendor/three/utils/SkeletonUtils.js':           'three/examples/jsm/utils/SkeletonUtils.js',
    // Back-compat aliases for any downstream code that still points at the
    // flat paths. Safe to remove once everything uses /vendor/three/...
    '/vendor/GLTFLoader.js':                          'three/examples/jsm/loaders/GLTFLoader.js',
    '/vendor/BufferGeometryUtils.js':                 'three/examples/jsm/utils/BufferGeometryUtils.js',
  };
  if (VENDOR[path]) {
    return serveFile(res, join(ROOT, 'node_modules', VENDOR[path]));
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

  // Graceful shutdown from stop.bat / external scripts. Bound to 127.0.0.1
  // by the listen() call, so only local processes can trigger it.
  if (path === '/api/shutdown' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    log.info('Shutdown requested via /api/shutdown.');
    setTimeout(() => shutdown('http-shutdown'), 50);
    return;
  }

  // Release notes — CHANGELOG.md is regenerated at release time from git
  // commit messages, then shipped in the zip. Served as plain markdown so
  // the dashboard can parse and render it client-side.
  if (path === '/api/release-notes' && req.method === 'GET') {
    const changelogPath = join(ROOT, 'CHANGELOG.md');
    if (!existsSync(changelogPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('CHANGELOG.md not found — this install may be a dev checkout without a generated changelog.');
    }
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    return res.end(readFileSync(changelogPath));
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
        if (!settings.twitch?.userId) {
          throw new Error('Twitch is not connected. Add your Twitch credentials in Settings to chat from the dashboard.');
        }
        if (!settings.twitch?.accessToken) {
          throw new Error('Twitch OAuth is not complete. Open Settings → click "Connect Twitch" to authorize chat sending.');
        }
        if (twitchEventSub.status !== 'connected') {
          throw new Error('Twitch is still connecting — try again in a moment.');
        }
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
      character: 'characters/lilfokkermascot',
      model:     'assets/models',
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
      if (targetDir.endsWith('sounds')) rebuildSoundSet();
      // Notify overlays so things like sticker rain can pick up new uploads
      // without an explicit refresh.
      broadcast(overlays,   { type: 'assets-updated', kind: type });
      broadcast(dashboards, { type: 'assets-updated', kind: type });
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

  if (path === '/api/widgets' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(widgets));
  }

  if (path === '/api/widgets' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        if (!Array.isArray(incoming)) throw new Error('widgets must be an array');
        widgets.length = 0;
        widgets.push(...incoming);
        state.set('overlay.widgets', widgets);
        writeFileSync(join(ROOT, 'widgets.json'), JSON.stringify(widgets, null, 2));
        // Broadcast to overlays AND dashboards so every preview iframe rerenders.
        broadcastState('overlay.widgets', widgets);
        res.writeHead(200); res.end('{"ok":true}');
      } catch (err) { res.writeHead(400); res.end(err.message); }
    });
    return;
  }

  if (path === '/api/assets' && req.method === 'GET') {
    rebuildSoundSet();
    const assets = { sounds: [], stickers: [], characters: [], models: [], diceThemes: [] };
    try {
      const mDir = join(ROOT, 'assets/models');
      if (existsSync(mDir)) assets.models = readdirSync(mDir).filter(f => !f.startsWith('.') && /\.(gl[bt]f)$/i.test(f));
      const sDir = join(ROOT, 'assets/sounds');
      if (existsSync(sDir)) assets.sounds = readdirSync(sDir).filter(f => !f.startsWith('.'));
      const tDir = join(ROOT, 'assets/stickers');
      if (existsSync(tDir)) assets.stickers = readdirSync(tDir).filter(f => !f.startsWith('.'));
      const cDir = join(ROOT, 'characters/lilfokkermascot');
      if (existsSync(cDir)) assets.characters = readdirSync(cDir).filter(f => !f.startsWith('.'));
      // Dice themes: each subdir of assets/dice/ with at least one face-N.{png,jpg,jpeg,webp}
      const dDir = join(ROOT, 'assets/dice');
      if (existsSync(dDir)) {
        assets.diceThemes = readdirSync(dDir)
          .filter(name => !name.startsWith('.'))
          .filter(name => {
            const sub = join(dDir, name);
            try {
              if (!statSync(sub).isDirectory()) return false;
              return readdirSync(sub).some(f => /^face-\d+\.(png|jpe?g|webp)$/i.test(f));
            } catch { return false; }
          });
      }
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

        if (patch.autoUpdate) {
          settings.autoUpdate ??= {};
          if (typeof patch.autoUpdate.enabled === 'boolean') {
            settings.autoUpdate.enabled = patch.autoUpdate.enabled;
            setAutoInstall(patch.autoUpdate.enabled);
            log.info(`Auto-install mode ${patch.autoUpdate.enabled ? 'ENABLED' : 'disabled'}.`);
          }
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
      log.info(`Twitch OAuth success. Token stored; reconnecting EventSub.`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html>
<html><body style="font:16px system-ui;text-align:center;padding:50px;background:#0d0d14;color:#fff">
  <h1 style="color:#6BCB77;margin-bottom:6px;">✅ Twitch connected</h1>
  <p style="color:#aaa;margin-top:4px">You can close this tab. The FokkerPop dashboard Twitch badge should now turn green.</p>
  <button onclick="window.close()" style="margin-top:18px;padding:10px 24px;background:#9147FF;color:#fff;border:0;border-radius:8px;font-weight:800;cursor:pointer">Close</button>
</body></html>`);
      twitchEventSub.connect();
    } else {
      const detail = token.message || token.error_description || token.error || JSON.stringify(token);
      log.warn(`Twitch OAuth failed: ${detail}`);
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html>
<html><body style="font:16px system-ui;padding:40px;background:#0d0d14;color:#fff;line-height:1.5">
  <h1 style="color:#FF6B6B;">⚠️ Twitch authorisation failed</h1>
  <p>Twitch returned: <code style="background:#222;padding:4px 8px;border-radius:4px">${String(detail).replace(/</g,'&lt;')}</code></p>
  <p style="color:#aaa;margin-top:24px">Common fixes:</p>
  <ul style="color:#aaa">
    <li>Double-check <strong>Client Secret</strong> — a fresh paste from the Twitch Developer Console.</li>
    <li>In the Twitch Developer Console, register redirect URI <code>http://localhost:4747/auth/callback</code> exactly.</li>
    <li>Close this tab and try "Connect Twitch" again.</li>
  </ul>
</body></html>`);
    }
  } catch (e) {
    log.error('OAuth callback error:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body style="font:16px system-ui;padding:40px;background:#0d0d14;color:#fff">
<h1 style="color:#FF6B6B;">⚠️ OAuth server error</h1>
<p>${String(e.message).replace(/</g,'&lt;')}</p></body></html>`);
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
        send(ws, { type: 'state', path: 'obs.lastError', value: obs.lastError });
        send(ws, { type: 'state', path: 'obs.streaming', value: obs.streaming });
        send(ws, { type: 'state', path: 'update.available', value: getAvailableUpdate() });
      } else {
        // Overlay: send current state
        send(ws, { type: 'state', path: 'crowd.energy', value: state.get('crowd.energy') });
        send(ws, { type: 'state', path: 'goals',        value: state.get('goals')         });
        send(ws, { type: 'state', path: 'leaderboard',  value: state.get('leaderboard')   });
        send(ws, { type: 'state', path: 'session',      value: state.get('session')        });
        send(ws, { type: 'state', path: 'chatters',     value: state.get('chatters') ?? [] });
        send(ws, { type: 'state', path: 'overlay.positions',         value: state.get('overlay.positions') });
        send(ws, { type: 'state', path: 'overlay.elementVisibility', value: state.get('overlay.elementVisibility') ?? {} });
        send(ws, { type: 'state', path: 'overlay.layoutMode',        value: layoutMode });
        send(ws, { type: 'state', path: 'overlay.widgets',           value: widgets });
      }
      return;
    }

    // Overlays can only fire a hot-button widget they're hosting (server looks up the widget).
    if (!dashboards.has(ws)) {
      if (msg.type === '_overlay.widget-trigger' && typeof msg.id === 'string') {
        const w = widgets.find(w => w.id === msg.id);
        if ((w?.type === 'hot-button' || w?.type === 'hot-button-3d') && w.config?.effect) {
          broadcastEffect(w.config.effect, w.config.payload ?? {}, true);
        }
      }
      if (msg.type === '_overlay.dice-rolled' && typeof msg.result === 'number') {
        // Overlay dice settled and read a face — rebroadcast as a bus event so
        // Studio flows with trigger="dice.rolled" can branch on the result.
        log.info(`Dice ${msg.sides} rolled: ${msg.result} (widget ${msg.widgetId})`);
        bus.publish({
          type:    'dice.rolled',
          source:  'overlay',
          payload: { result: msg.result, sides: msg.sides, widgetId: msg.widgetId },
        });
      }
      if (msg.type === '_overlay.dice-tray-rolled' && Array.isArray(msg.dice)) {
        // Multi-overlay protection: only process the first result that comes back for the current rollId.
        if (msg.rollId && currentRollId && msg.rollId !== currentRollId) {
          log.debug(`Ignoring stale/duplicate roll result (msg.rollId=${msg.rollId}, currentRollId=${currentRollId})`);
          return;
        }
        currentRollId = null; // Reset once a valid result is processed

        log.info(`Dice tray rolled: [${msg.dice.map(d => `d${d.sides}:${d.result}`).join(', ')}] sum=${msg.sum}${msg.tag ? ` tag=${msg.tag}` : ''}`);
        const payload = { dice: msg.dice, sum: msg.sum, widgetId: msg.widgetId };
        if (msg.tag) payload.tag = msg.tag;

        // Auto-reply to chat if this was a !roll from chat
        if (msg.tag?.startsWith('chat-roll:')) {
          const user = msg.tag.split(':')[1];
          const isP  = !!msg.isPercentile;
          const detail = isP 
            ? `D100 [Red:${msg.dice[0].result}, Blue:${msg.dice[1].result}]`
            : msg.dice.map(d => `d${d.sides}:${d.result}`).join(', ');
          const reply = `@${user} 🎲 ${detail} → ${msg.sum}`;
          if (!msg.isTest && settings.twitch?.userId && settings.twitch?.accessToken && twitchEventSub.status === 'connected') {
            helix.sendChatMessage(settings.twitch.userId, reply).catch(err => log.error('Chat tray-roll reply failed:', err.message));
          } else {
            log.info(`[chat-roll tray-settle] ${reply}`);
          }
        }

        bus.publish({
          type:    'dice-tray.rolled',
          source:  'overlay',
          payload,
          isTest:  !!msg.isTest,
        });
      }
      if (msg.type === '_dashboard.save-position') {
        const positions = state.get('overlay.positions') ?? {};
        positions[msg.id] = { x: msg.x, y: msg.y };
        state.set('overlay.positions', positions);
        broadcastState('overlay.positions', positions);
      }
      if (msg.type === '_dashboard.element-visibility') {
        if (typeof msg.id === 'string' && msg.id) {
          const map = { ...(state.get('overlay.elementVisibility') ?? {}) };
          if (msg.visible === false) map[msg.id] = false;
          else                       delete map[msg.id];
          state.set('overlay.elementVisibility', map);
          broadcastState('overlay.elementVisibility', map);
        }
      }
      if (msg.type === '_overlay.resource-report') {
        // Overlay-side self-report: FPS, heap, widget inventory. Stored by ws
        // connection so we can attribute metrics per-overlay-instance in the
        // dashboard Resources page.
        overlayResourceReports.set(ws, {
          receivedAt: Date.now(),
          url:        String(msg.url || ''),
          fps:        Number(msg.fps) || 0,
          heap:       Number(msg.heap) || 0,
          heapLimit:  Number(msg.heapLimit) || 0,
          widgetCount: Number(msg.widgetCount) || 0,
          widgetTypes: msg.widgetTypes && typeof msg.widgetTypes === 'object' ? msg.widgetTypes : {},
          viewport:   msg.viewport && typeof msg.viewport === 'object' ? msg.viewport : null,
          live:       !!msg.live,
        });
      }
      if (msg.type === '_dashboard.save-size') {
        const w = widgets.find(x => x.id === msg.id);
        if (w) {
          w.config = w.config || {};
          w.config.width  = Math.max(1, Math.round(Number(msg.width)  || 0));
          w.config.height = Math.max(1, Math.round(Number(msg.height) || 0));
          try {
            writeFileSync(join(ROOT, 'widgets.json'), JSON.stringify(widgets, null, 2));
          } catch (err) {
            log.error('Failed to persist widgets.json after resize:', err.message);
          }
          state.set('overlay.widgets', widgets);
          broadcastState('overlay.widgets', widgets);
        }
      }
      return;
    }

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
      case '_dashboard.element-visibility': {
        // Per-element hide/show. Stored as { [id]: false } for elements the
        // user has explicitly hidden; visible-true is implicit (the absence
        // of an entry) so the file stays compact and easy to inspect.
        if (typeof msg.id !== 'string' || !msg.id) break;
        const map = { ...(state.get('overlay.elementVisibility') ?? {}) };
        if (msg.visible === false) {
          map[msg.id] = false;
        } else {
          delete map[msg.id];
        }
        state.set('overlay.elementVisibility', map);
        broadcastState('overlay.elementVisibility', map);
        break;
      }
      case '_dashboard.save-size': {
        const w = widgets.find(x => x.id === msg.id);
        if (w) {
          w.config = w.config || {};
          w.config.width  = Math.max(1, Math.round(Number(msg.width)  || 0));
          w.config.height = Math.max(1, Math.round(Number(msg.height) || 0));
          try {
            writeFileSync(join(ROOT, 'widgets.json'), JSON.stringify(widgets, null, 2));
          } catch (err) {
            log.error('Failed to persist widgets.json after resize:', err.message);
          }
          state.set('overlay.widgets', widgets);
          broadcastState('overlay.widgets', widgets);
        }
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
      case '_dashboard.shutdown':
        // User clicked "Stop FokkerPop" in the dashboard. Same graceful path
        // the SIGINT/SIGTERM handlers use — broadcasts _system.shutdown so
        // open overlays clear their effect queues before the server dies.
        log.info('Shutdown requested from dashboard.');
        setTimeout(() => shutdown('dashboard-request'), 50);
        break;
    }
  });

  ws.on('close', () => { overlays.delete(ws); dashboards.delete(ws); overlayResourceReports.delete(ws); });
  ws.on('error', () => { overlays.delete(ws); dashboards.delete(ws); overlayResourceReports.delete(ws); });

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

obs.on('status', (status, reason) => {
  broadcast(dashboards, { type: 'state', path: 'obs.status',    value: status });
  broadcast(dashboards, { type: 'state', path: 'obs.lastError', value: reason || '' });
});

obs.on('streaming', (live) => {
  broadcast(dashboards, { type: 'state', path: 'obs.streaming', value: live });
  onStreamingStateChange(live);
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

  setAutoInstall(!!settings.autoUpdate?.enabled);
  setStreamingProbe(() => obs.streaming);
  setAutoInstallHandler(() => applyUpdate({
    root: ROOT,
    onBeforeExit: () => broadcast(overlays, { type: '_system.shutdown' }),
  }));

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

  // Track when we last opened a browser. If a previous instance launched one
  // within the last 10 min, assume the user still has a window around and
  // skip launching a duplicate even if no client has reconnected yet.
  const launchMarker = join(ROOT, '.fokker-browser-launched');
  const markerAgeMs = existsSync(launchMarker)
    ? Date.now() - statSync(launchMarker).mtimeMs
    : Infinity;
  const RECENT_LAUNCH_MS = 10 * 60 * 1000;

  // Give any existing dashboard window up to 15s to reconnect and reload itself.
  // 15s covers a slow NSIS extract + the dashboard's client-side reconnect
  // backoff (1s/2s/3s/3s…).
  setTimeout(() => {
    if (dashboards.size > 0 || overlays.size > 0) {
      log.info(`Existing client reconnected (${dashboards.size} dashboard, ${overlays.size} overlay) — skipping new browser window.`);
      try { writeFileSync(launchMarker, String(Date.now())); } catch {}
    } else if (markerAgeMs < RECENT_LAUNCH_MS) {
      log.info(`A browser window was launched ${Math.round(markerAgeMs / 1000)}s ago — skipping duplicate. Open http://localhost:${activePort}/dashboard/ manually if needed.`);
    } else {
      log.info('No existing client reconnected within 15s — opening new browser window.');
      exec(cmd, () => {});
      try { writeFileSync(launchMarker, String(Date.now())); } catch {}
    }
  }, 15000);

  log.info('FokkerPop is ready! Use the dashboard to test your overlay.');
});

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`Received ${signal}, shutting down…`);

  // Send shutdown, then forcibly terminate each socket so any still-queued
  // effect frames get dropped instead of flushing to the overlay as a final
  // burst of alerts/fireworks right before the server dies.
  broadcast(overlays, { type: '_system.shutdown' });
  broadcast(dashboards, { type: '_system.shutdown' });
  for (const ws of [...overlays, ...dashboards]) {
    try { ws.terminate(); } catch {}
  }

  twitchEventSub.disconnect();
  obs.disconnect();
  state.flush();

  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (err) => { log.error('Uncaught exception:',  err.message, err.stack); });
process.on('unhandledRejection', (err) => { log.error('Unhandled rejection:', err?.message ?? err); });
