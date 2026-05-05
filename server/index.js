import { createServer }                                  from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, createWriteStream, statSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join, normalize, resolve, sep, relative, isAbsolute, basename } from 'node:path';
import { exec, spawn }                         from 'node:child_process';
import { WebSocketServer, WebSocket }          from 'ws';

import bus                        from './bus.js';
import state                      from './state.js';
import { applyPipeline }          from './pipeline/index.js';
import { TwitchEventSub }         from './twitch/eventsub.js';
import flowEngine, { TEST_PAYLOADS } from './pipeline/flow-engine.js';
import obs                   from './obs.js';
import * as helix            from './twitch/helix.js';
import settings, { ROOT, loadedFrom, saveSettings } from './settings-loader.js';

import log                        from './logger.js';
import { makeCtx, resolveDeep }   from './template.js';
import { scheduleChecks, checkForUpdate, applyUpdate, getAvailable as getAvailableUpdate, setAutoInstall, setStreamingProbe, setAutoInstallHandler, onStreamingStateChange } from './update-checker.js';
import { parseChatRollSpec, expandPercentile, canRenderInTray } from '../shared/dice.js';
import { importPolyPop }          from './polypop-import.js';

process.title = 'FokkerPop';

// ── Config ────────────────────────────────────────────────────────────────────
// Env var wins so `PORT=4800 npm start` and smoke tests can pick a free port
// without mutating settings.json.
const PORT    = parseInt(process.env.PORT, 10) || settings.server?.port || 4747;
const BIND    = '127.0.0.1';   // local only — never expose to LAN
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Loud breadcrumb when settings.json was unreadable on boot and we recovered
// from .bak (typical: prior NSIS update taskkill'd a settings write mid-flight).
// Without this, a successful recovery is silent and Fokker would only notice
// indirectly by Twitch staying connected when he expected it to break.
if (loadedFrom === 'settings.json.bak') {
  log.warn('settings.json was unreadable on boot — recovered from settings.json.bak (Twitch creds preserved).');
} else if (loadedFrom === 'settings.example.json') {
  log.warn('settings.json missing — booted from settings.example.json. Twitch creds need to be re-connected in the dashboard.');
}

// Ensure user-asset directories exist so first-boot uploads land somewhere
// instead of erroring. Sounds and stickers were always shipped pre-populated,
// but images/ is new in v0.3.29 — without this, /api/upload's createWriteStream
// fails with ENOENT until the user manually creates the folder.
for (const dir of ['assets/sounds', 'assets/stickers', 'assets/images', 'assets/models']) {
  try { mkdirSync(join(ROOT, dir), { recursive: true }); } catch {}
}

const goals    = loadAndEnsureJson('goals.json',   []);
const redeems  = loadAndEnsureJson('redeems.json', {});
const commands = loadAndEnsureJson('commands.json', {});
const flows    = loadAndEnsureJson('flows.json',   []);
const widgets  = loadAndEnsureJson('widgets.json', []);
state.set('goals', goals);
state.set('overlay.widgets', widgets);
flowEngine.setFlows(flows);

const commandCooldowns = new Map();

// Tier hierarchy: a higher tier always satisfies a lower-tier requirement.
// `broadcaster` is implicit at every level — it's Fokker's stream, he can
// always fire his own commands. Dashboard simulator events (source:
// 'dashboard') are treated as broadcaster too since they originate from the
// dashboard which is auth-bound to Fokker's machine.
function userMatchesAllow(event, allow) {
  if (!allow || allow === 'anyone') return true;
  if (event.source === 'dashboard') return true;
  const badges = event.payload?.badges || [];
  const sets = new Set(badges.map(b => b?.set_id ?? b));
  if (sets.has('broadcaster')) return true;
  switch (allow) {
    case 'mod':        return sets.has('moderator');
    case 'vip':        return sets.has('moderator') || sets.has('vip');
    case 'subscriber': return sets.has('moderator') || sets.has('vip') || sets.has('subscriber');
    case 'broadcaster': return false;  // already handled above; viewers don't qualify
    default:           return false;   // unknown allow value → fail closed
  }
}

function fireCommand(text, event) {
  if (!text.startsWith('!')) return;
  const cmd = commands[text.toLowerCase().trim()];
  if (!cmd) return;

  // Default-deny: any command without an explicit `allow` is broadcaster-only.
  // This is the safer default — if someone shares a flashy chat command in a
  // tutorial somewhere, viewers don't end up triggering it on Fokker's stream
  // for free. Free commands opt in with "allow": "anyone".
  const allow = cmd.allow ?? 'broadcaster';
  if (!userMatchesAllow(event, allow)) {
    // Visible at default log level so a "why isn't !bub working?" diagnosis
    // takes 5 seconds of log scrolling instead of a code dive.
    log.info(`Chat command ${text.trim()} blocked: needs "allow":"${allow}", user "${event.payload?.user || 'unknown'}" doesn't qualify.`);
    return;
  }

  const now = Date.now();
  const last = commandCooldowns.get(text) ?? 0;
  // ?? not || so cooldown:0 means "no cooldown" instead of "use default 5s".
  if (now - last < (cmd.cooldown ?? 5) * 1000) return;
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
  // Random-sound resolution.
  //   sound: "*"           → pick any uploaded sound
  //   sound: ["a","b","c"] → pick from this exact list (filtered to ones on disk)
  // After this block payload.sound is a real filename or undefined.
  if (payload?.sound === '*' || Array.isArray(payload?.sound)) {
    const pool = Array.isArray(payload.sound)
      ? payload.sound.filter(s => availableSounds.has(s))
      : [...availableSounds];
    if (pool.length) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      payload = { ...payload, sound: pick };
      log.debug(`Random sound for "${effect}": ${pool.length} candidate(s) → ${pick}`);
    } else {
      log.warn(`Effect "${effect}" requested random sound but no candidates exist on disk.`);
      payload = { ...payload, sound: undefined };
    }
  }
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
  '.webp': 'image/webp',
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

  // Guard: path must be within ROOT. The previous startsWith guard didn't
  // enforce a separator boundary, so e.g. a sibling directory
  // `<ROOT>-backup` would lower-case-match `<ROOT>`. Use the path module's
  // relative() — if the result starts with .. or is absolute, it's outside.
  const rel = relative(root, safe);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
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

  // Cross-origin write protection. State-mutating verbs (POST/PUT/PATCH/DELETE)
  // require an Origin header from the same host the server is listening on.
  // Stops a website the user is browsing from POSTing to /api/upload,
  // /api/widgets, /api/shutdown, etc. via a "simple" CORS request that
  // doesn't trigger preflight. GETs are intentionally not gated — read
  // endpoints already rely on browser SOP for response confidentiality.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      log.warn(`HTTP ${req.method} ${path} rejected: bad Origin ${req.headers.origin || '(none)'} from ${req.socket.remoteAddress}`);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden — Origin must match the server host.');
    }
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
    // Render the version directly into the HTML so it's correct on first paint
    // — no dependency on the WebSocket round-trip, no risk of seeing the stale
    // "v..." placeholder during connect, no cache-staleness across browser tabs
    // opened at different points in the install's lifetime.
    try {
      const html = readFileSync(join(ROOT, 'dashboard/index.html'), 'utf8')
        .replace(/(<span class="v-(?:badge|string)")>v\.\.\.</g, `$1>v${VERSION}<`);
      res.writeHead(200, {
        'Content-Type':           'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control':          'no-cache',
      });
      return res.end(html);
    } catch {
      return serveFile(res, join(ROOT, 'dashboard/index.html'));
    }
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

  // Pulls the broadcaster's current Channel Point custom rewards from
  // Twitch Helix and merges any new titles into redeems.json. Existing
  // entries are preserved (we don't want to clobber Fokker's effect/sound
  // wiring); new ones get a stub `{}` so the title shows up in the Studio
  // dropdown immediately. Triggered by the 🔄 button on the Redeem
  // trigger's "Specific Reward" dropdown.
  if (path === '/api/redeems/refresh-from-twitch' && req.method === 'POST') {
    (async () => {
      try {
        const { userId, accessToken } = settings.twitch ?? {};
        if (!userId || !accessToken) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Twitch is not connected. Open Settings → Connect Twitch first.' }));
          return;
        }
        const rewards = await helix.getCustomRewards(userId, accessToken);
        const titles  = rewards.map(r => r.title).filter(Boolean);
        let added = 0;
        for (const title of titles) {
          if (!Object.prototype.hasOwnProperty.call(redeems, title)) {
            redeems[title] = {};
            added++;
          }
        }
        if (added > 0) {
          writeFileSync(join(ROOT, 'redeems.json'), JSON.stringify(redeems, null, 2));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, added, totalFromTwitch: titles.length }));
      } catch (err) {
        log.error('Refresh redeems from Twitch failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // Translate the dashboard's hotkey strings ("Alt+1", "Ctrl+Shift+F1")
  // into AutoHotkey v2 hotkey syntax ("!1", "^+{F1}"). Returns null if a
  // key name can't be safely encoded — caller writes a comment line in the
  // generated script instead of producing broken bindings.
  function comboToAhk(combo) {
    if (!combo) return null;
    const parts = combo.split('+').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;  // require at least one modifier + a key
    const MOD = { Alt: '!', Ctrl: '^', Shift: '+', Meta: '#' };
    let mods = '';
    let key  = '';
    for (const p of parts) {
      if (Object.prototype.hasOwnProperty.call(MOD, p)) mods += MOD[p];
      else key = p;
    }
    if (!key) return null;
    if (key.length === 1) return mods + key.toLowerCase();
    // Function keys, navigation keys, etc. use { } in AHK v2.
    if (/^F\d{1,2}$/.test(key)) return mods + '{' + key + '}';
    const SPECIAL = new Set(['Tab','Enter','Space','Escape','Backspace','Delete','Insert','Home','End','PageUp','PageDown','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
    const SPECIAL_MAP = { Escape: 'Esc', Backspace: 'Backspace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PgUp', PageDown: 'PgDn' };
    if (SPECIAL.has(key)) return mods + '{' + (SPECIAL_MAP[key] || key) + '}';
    return null;
  }

  // HTTP equivalent of the _dashboard.run-flow WS message — same single-
  // chain semantics, isTest=false (so OBS reacts). Designed for AutoHotkey
  // to call when the dashboard isn't focused. AHK passes Origin via
  // Msxml2.XMLHTTP.SetRequestHeader so the existing CSRF gate is happy
  // without a separate auth path.
  if (path.startsWith('/api/run-flow/') && req.method === 'POST') {
    const flowId = decodeURIComponent(path.slice('/api/run-flow/'.length));
    const flow = flows.find(f => f.id === flowId);
    if (!flow) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'flow not found', flowId }));
    }
    const eventType = flow.trigger;
    const payload   = { ...(TEST_PAYLOADS[eventType] || {}) };
    flowEngine.testFlow(flowId, {
      source:  'http-hotkey',
      type:    eventType,
      payload,
      isTest:  false,
    }, broadcastEffect);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, flowId, name: flow.name }));
  }

  // Builds the AutoHotkey v2 script body. Used by both the download endpoint
  // and the wizard's install endpoint, which writes this same body to the
  // user's Windows Startup folder. Generating once-per-call is fine — flows
  // can change between calls and we want the latest set every time.
  function buildAhkScript() {
    const flowsWithHotkeys = flows.filter(f => f.active && f.hotkey);
    const port = activePort;
    const lines = [];
    lines.push('#Requires AutoHotkey v2.0');
    lines.push('#SingleInstance Force');
    lines.push('; FokkerPop generated hotkey script — re-run the Studio "Set Up Global Hotkeys" wizard after editing flows.');
    lines.push(`; Generated for FokkerPop v${VERSION} on port ${port}.`);
    lines.push(`; Active hotkey flows: ${flowsWithHotkeys.length}`);
    lines.push('');
    lines.push(`PORT := ${port}`);
    lines.push('');
    if (flowsWithHotkeys.length === 0) {
      lines.push('; No flows currently have a hotkey configured.');
      lines.push('; Open Studio, pick a flow, click the trigger node, set Hotkey, then re-run the wizard.');
    } else {
      for (const f of flowsWithHotkeys) {
        const ahkCombo = comboToAhk(f.hotkey);
        if (!ahkCombo) {
          lines.push(`; (skipped: couldn't translate ${JSON.stringify(f.hotkey)} for flow ${f.name || f.id})`);
          continue;
        }
        const safeName = (f.name || f.id).replace(/[^\x20-\x7e]/g, '?');
        const safeId   = JSON.stringify(f.id);
        lines.push(`${ahkCombo}::SendFokkerFlow(${safeId})  ; ${f.hotkey} — ${safeName}`);
      }
    }
    lines.push('');
    lines.push('SendFokkerFlow(flowId) {');
    lines.push('    try {');
    lines.push('        whr := ComObject("Msxml2.XMLHTTP")');
    lines.push('        whr.Open("POST", "http://localhost:" . PORT . "/api/run-flow/" . flowId, false)');
    lines.push('        whr.SetRequestHeader("Origin", "http://localhost:" . PORT)');
    lines.push('        whr.Send()');
    lines.push('    }');
    lines.push('}');
    return lines.join('\r\n');
  }

  // Candidate AHK install locations. Order matters: prefer v2 64-bit (the
  // default for new installs), fall back to other v2 builds, lastly v1
  // (which would refuse to run our v2-marked script anyway, so a v1-only
  // detection should still report installed=true but flag wrongVersion).
  function detectAhk() {
    const programFiles    = process.env['ProgramFiles']      || 'C:\\Program Files';
    const programFiles86  = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const userPrograms    = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : '';
    const candidates = [
      { path: join(programFiles,   'AutoHotkey', 'v2', 'AutoHotkey64.exe'), v2: true },
      { path: join(programFiles,   'AutoHotkey', 'v2', 'AutoHotkey32.exe'), v2: true },
      { path: join(programFiles86, 'AutoHotkey', 'v2', 'AutoHotkey32.exe'), v2: true },
      ...(userPrograms ? [{ path: join(userPrograms, 'AutoHotkey', 'v2', 'AutoHotkey64.exe'), v2: true }] : []),
      { path: join(programFiles,   'AutoHotkey', 'AutoHotkey.exe'),         v2: false },
      { path: join(programFiles86, 'AutoHotkey', 'AutoHotkey.exe'),         v2: false },
    ];
    for (const c of candidates) {
      if (existsSync(c.path)) return { installed: true, v2: c.v2, path: c.path };
    }
    return { installed: false, v2: false, path: null };
  }

  // Wizard step 1: report AHK install state without changing anything.
  if (path === '/api/system/ahk-status' && req.method === 'GET') {
    const info = detectAhk();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(info));
  }

  // Wizard step 2: write the current AHK script into the user's Windows
  // Startup folder so it auto-launches on login. Re-runnable — overwrites
  // the same file each call so the user's latest hotkeys are reflected.
  // Returns the path so the wizard can tell the user where it landed.
  if (path === '/api/system/install-ahk-script' && req.method === 'POST') {
    try {
      const appData = process.env.APPDATA;
      if (!appData) throw new Error('APPDATA env var missing — this endpoint only works on Windows.');
      const startupDir = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      mkdirSync(startupDir, { recursive: true });
      const scriptPath = join(startupDir, 'fokkerpop-hotkeys.ahk');
      writeFileSync(scriptPath, buildAhkScript());
      log.info(`AHK hotkey script installed to ${scriptPath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, path: scriptPath }));
    } catch (err) {
      log.error('Install AHK script failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Wizard step 3: launch the installed script so it's running NOW (rather
  // than only after next Windows login). Uses #SingleInstance Force in the
  // script body so re-runs replace the prior AHK instance cleanly.
  // Detached + unref so closing FokkerPop doesn't kill AHK.
  if (path === '/api/system/launch-ahk-script' && req.method === 'POST') {
    try {
      const ahk = detectAhk();
      if (!ahk.installed) throw new Error('AutoHotkey not detected. Install AutoHotkey v2 first.');
      if (!ahk.v2)        throw new Error('AutoHotkey v1 detected; FokkerPop scripts require v2. Install AutoHotkey v2 from autohotkey.com.');
      const appData = process.env.APPDATA;
      if (!appData) throw new Error('APPDATA env var missing.');
      const scriptPath = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'fokkerpop-hotkeys.ahk');
      if (!existsSync(scriptPath)) throw new Error('Hotkey script not yet installed. Run install step first.');
      const child = spawn(ahk.path, [scriptPath], { detached: true, stdio: 'ignore' });
      child.unref();
      log.info(`AHK launched: ${ahk.path} ${scriptPath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      log.error('Launch AHK script failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Disable global hotkeys: delete the Startup-folder script so it stops
  // auto-launching at login. We deliberately don't `taskkill` the running
  // AHK instance — that could nuke other AHK scripts the user is running
  // for unrelated reasons. The wizard tells them to right-click the tray
  // icon → Exit if they want it gone right now.
  if (path === '/api/system/uninstall-ahk-script' && req.method === 'POST') {
    try {
      const appData = process.env.APPDATA;
      if (!appData) throw new Error('APPDATA env var missing.');
      const scriptPath = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'fokkerpop-hotkeys.ahk');
      const existed = existsSync(scriptPath);
      if (existed) {
        // Use the unlinkSync from fs — already imported via the named imports
        // (existsSync, etc.). Add unlinkSync to that list at the top of the file.
        unlinkSync(scriptPath);
        log.info(`AHK hotkey script removed: ${scriptPath}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, removed: existed }));
    } catch (err) {
      log.error('Uninstall AHK script failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Plain download — kept for the manual "I want the file myself" path.
  if (path === '/api/run-flow.ahk' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type':        'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="fokkerpop-hotkeys.ahk"',
    });
    return res.end(buildAhkScript());
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
      image:     'assets/images',
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

    // Per-type extension allowlist. Without this, an .fbx model upload (or
    // any other format) lands silently in the folder but the asset listing
    // (and the dashboard's selection dropdowns) filter it back out — so
    // users see "upload succeeded" then can't find their file. Issue #8.
    const ALLOWED_EXTS = {
      sound:     ['.wav', '.mp3', '.ogg', '.m4a'],
      sticker:   ['.png', '.webp', '.gif', '.jpg', '.jpeg', '.svg'],
      image:     ['.png', '.webp', '.gif', '.jpg', '.jpeg', '.svg'],
      character: ['.png', '.webp', '.jpg', '.jpeg'],
      model:     ['.glb', '.gltf'],
    };
    const allowed = ALLOWED_EXTS[type];
    if (allowed) {
      const ext = (extname(name) || '').toLowerCase();
      if (!allowed.includes(ext)) {
        log.warn(`Upload rejected: ${name} (type=${type}, ext=${ext || '(none)'}) — not in allowed list ${allowed.join(', ')}`);
        res.writeHead(400);
        res.end(`This ${type} format isn't supported. Allowed: ${allowed.join(', ')}. ` +
          (type === 'model' ? 'Re-export from your modeling tool as .glb (the universal "JPEG of 3D" format) — Three.js loads it natively. .fbx/.obj/.stl/.usd/.abc/.ply aren\'t supported.' : ''));
        return;
      }
    }

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

  // Wipe widgets.json and restore the shipped default layout from
  // widgets.example.json. Backs up the current widgets.json to .bak first
  // so a one-click mistake is recoverable. Used by the "Reset Widgets to
  // Default" button on the Layout page.
  if (path === '/api/widgets/reset' && req.method === 'POST') {
    try {
      const target  = join(ROOT, 'widgets.json');
      const backup  = join(ROOT, 'widgets.json.bak');
      const example = join(ROOT, 'widgets.example.json');
      if (!existsSync(example)) throw new Error('widgets.example.json missing — cannot restore defaults.');
      if (existsSync(target)) {
        try { copyFileSync(target, backup); }
        catch (err) { log.warn('widgets.json.bak write failed:', err.message); }
      }
      const defaults = JSON.parse(readFileSync(example, 'utf8'));
      if (!Array.isArray(defaults)) throw new Error('widgets.example.json is not an array.');
      widgets.length = 0;
      widgets.push(...defaults);
      state.set('overlay.widgets', widgets);
      writeFileSync(target, JSON.stringify(widgets, null, 2));
      broadcastState('overlay.widgets', widgets);
      log.info(`Widgets reset to default (${widgets.length} widgets); previous saved to widgets.json.bak.`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: widgets.length, backup: existsSync(backup) }));
    } catch (err) {
      log.error('Widget reset failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (path === '/api/assets' && req.method === 'GET') {
    rebuildSoundSet();
    const assets = { sounds: [], stickers: [], images: [], characters: [], models: [], diceThemes: [] };
    try {
      const mDir = join(ROOT, 'assets/models');
      if (existsSync(mDir)) assets.models = readdirSync(mDir).filter(f => !f.startsWith('.') && /\.(gl[bt]f)$/i.test(f));
      const sDir = join(ROOT, 'assets/sounds');
      if (existsSync(sDir)) assets.sounds = readdirSync(sDir).filter(f => !f.startsWith('.'));
      const tDir = join(ROOT, 'assets/stickers');
      if (existsSync(tDir)) assets.stickers = readdirSync(tDir).filter(f => !f.startsWith('.'));
      const iDir = join(ROOT, 'assets/images');
      if (existsSync(iDir)) assets.images = readdirSync(iDir).filter(f => !f.startsWith('.') && /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
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

        saveSettings();

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

  // PolyPop project importer — accepts the raw .pop JSON body, returns the
  // parsed shape (redeems / commands / audioFiles) so the dashboard can show
  // it inline and let the user pick Append vs Replace. Doesn't touch
  // redeems.json or commands.json itself; the dashboard re-uses the existing
  // /api/redeems + /api/commands POSTs to apply.
  if (path === '/api/import-polypop' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', d => {
      body += d;
      if (body.length > 5 * 1024 * 1024) {  // 5 MB hard cap
        aborted = true;
        res.writeHead(413); res.end('Project file too large (>5 MB).');
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const pop = JSON.parse(body);
        const result = importPolyPop(pop);
        log.info(`PolyPop import: ${Object.keys(result.redeems).length} redeems, ${Object.keys(result.commands).length} commands, ${result.audioFiles.length} audio refs.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        log.warn('PolyPop import failed:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
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
      saveSettings();
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

// Block cross-origin WebSocket connections. The IP check below blocks remote
// callers, but anything running locally — a website the streamer is visiting,
// a malicious browser extension — can also reach 127.0.0.1 from the user's
// own browser. Without an Origin gate, any such page can connect, register
// as a dashboard, and trigger _dashboard.shutdown / _dashboard.update-apply
// / _dashboard.effect / _dashboard.save-position / _dashboard.element-visibility
// / etc. Same-origin enforcement: Origin must match the server's own host
// (which is what the dashboard, overlay, and OBS browser source all send).
function isAllowedOrigin(origin, host) {
  if (!origin || !host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: ({ origin, req }, done) => {
    const ip = req.socket.remoteAddress;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      log.warn(`WS connection rejected: non-local IP ${ip}`);
      return done(false, 403, 'Local only');
    }
    if (!isAllowedOrigin(origin, req.headers.host)) {
      log.warn(`WS connection rejected: bad Origin ${origin || '(none)'} from ${ip}`);
      return done(false, 403, 'Origin not allowed');
    }
    done(true);
  },
});

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  // Belt-and-braces: verifyClient already enforced this, but keep the check
  // in case the WSS instance gets reconstructed without verifyClient.
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
          state.flush();
          broadcastState('overlay.widgets', widgets);
        }
      }
      return;
    }

    switch (msg.type) {
      case '_dashboard.test-event':
        bus.publish({ source: 'dashboard', isTest: true, ...(msg.event ?? {}) });
        break;
      case '_dashboard.test-flow': {
        // Studio "Test This Trigger" — runs only the right-clicked flow's
        // chain with a synthetic event, without fanning out to every flow
        // listening to the same trigger type.
        const flow = flows.find(f => f.id === msg.flowId);
        if (!flow) break;
        const eventType = flow.trigger;
        const payload   = { ...(TEST_PAYLOADS[eventType] || {}), ...(msg.payload || {}) };
        flowEngine.testFlow(msg.flowId, {
          source:  'dashboard',
          type:    eventType,
          payload,
          isTest:  true,
        }, broadcastEffect);
        break;
      }
      case '_dashboard.run-flow': {
        // Hotkey-triggered manual run (issue #3). Same single-chain semantics
        // as test-flow, but isTest=false so the OBS-bound overlay reacts —
        // this is meant as a stream-deck-style live trigger, not a preview.
        const flow = flows.find(f => f.id === msg.flowId);
        if (!flow) break;
        const eventType = flow.trigger;
        const payload   = { ...(TEST_PAYLOADS[eventType] || {}), ...(msg.payload || {}) };
        flowEngine.testFlow(msg.flowId, {
          source:  'dashboard',
          type:    eventType,
          payload,
          isTest:  false,
        }, broadcastEffect);
        break;
      }
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
        // Force immediate flush — the default 300ms debounce loses drags if
        // the user runs the updater EXE (NSIS taskkill /F) right after
        // dragging. state.flush() is a tmp+rename atomic write so it's safe
        // to call on every drag-end.
        state.flush();
        broadcastState('overlay.positions', positions);
        break;
      }
      case '_dashboard.element-visibility': {
        // Stored as { [id]: false } for elements the user has explicitly
        // hidden; visible-true is implicit (the absence of an entry) so the
        // file stays compact and easy to inspect.
        if (typeof msg.id !== 'string' || !msg.id) break;
        const map = { ...(state.get('overlay.elementVisibility') ?? {}) };
        if (msg.visible === false) {
          map[msg.id] = false;
        } else {
          delete map[msg.id];
        }
        state.set('overlay.elementVisibility', map);
        state.flush();
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
          state.flush();
          broadcastState('overlay.widgets', widgets);
        }
        break;
      }
      case '_dashboard.reset-layout':
        state.set('overlay.positions', {});
        state.flush();
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
            onBeforeExit: () => {
              // Persist whatever's in the debounced flush buffer before NSIS
              // taskkills us — otherwise the last 300 ms of widget drags /
              // saves get lost across the update.
              try { state.flush(); } catch {}
              broadcast(overlays, { type: '_system.shutdown' });
            },
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
      case '_dashboard.check-update':
        // Manual GitHub release poll (otherwise runs automatically every 30
        // min via update-checker.js). Result lands on every dashboard via the
        // `update.available` state path the auto-poll already broadcasts on.
        log.info('Manual update check requested from dashboard.');
        checkForUpdate({
          currentVersion:        VERSION,
          root:                  ROOT,
          broadcastToDashboards: (msg) => broadcast(dashboards, msg),
        }).then(() => {
          // Echo a no-op state so the dashboard can clear its "Checking…" UI.
          send(ws, { type: 'state', path: 'update.checked-at', value: Date.now() });
        }).catch(err => {
          send(ws, { type: 'state', path: 'update.check-error', value: err.message });
        });
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

// Live stream stats poller (issue #4 cluster A). Twitch EventSub doesn't
// surface viewer count, current category, or stream title — those need a
// 60s Helix poll. Surfaces as state.twitch.live so Studio templates can
// reference {{ twitch.live.viewers }}, {{ twitch.live.title }}, etc., and
// dashboards/widgets can react to live/offline transitions.
//
// 60s cadence is conservative: viewer counts move on minutes, not seconds,
// and Helix is rate-limited globally per app. Skips while Twitch is not
// connected so offline dev sessions don't spam errors.
const STREAM_POLL_INTERVAL_MS = 60_000;
let streamPollTimer = null;
async function pollStreamStats() {
  try {
    const { userId, accessToken } = settings.twitch ?? {};
    if (!userId || !accessToken) return;
    if (twitchEventSub.status !== 'connected') return;
    const stream = await helix.getStreamInfo(userId, accessToken);
    const prev   = state.get('twitch.live') ?? {};
    let live;
    if (stream) {
      const startedAt = stream.started_at ? new Date(stream.started_at).getTime() : Date.now();
      live = {
        isLive:    true,
        viewers:   stream.viewer_count ?? 0,
        title:     stream.title ?? '',
        game:      stream.game_name ?? '',
        gameId:    stream.game_id ?? '',
        startedAt,
        uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        language:  stream.language ?? '',
      };
    } else {
      live = { isLive: false, viewers: 0, title: prev.title ?? '', game: prev.game ?? '', gameId: '', startedAt: 0, uptimeSec: 0, language: '' };
    }
    state.set('twitch.live', live);
    broadcast(dashboards, { type: 'state', path: 'twitch.live', value: live });
    broadcast(overlays,   { type: 'state', path: 'twitch.live', value: live });
    if (prev.isLive !== live.isLive) {
      log.info(`Twitch stream ${live.isLive ? 'WENT LIVE' : 'went offline'}${live.isLive ? ` (${live.game || 'no category'}, ${live.viewers} viewer${live.viewers === 1 ? '' : 's'})` : ''}`);
    }
  } catch (err) {
    log.debug('Stream stats poll failed:', err.message);
  }
}
function startStreamPoller() {
  if (streamPollTimer) return;
  streamPollTimer = setInterval(pollStreamStats, STREAM_POLL_INTERVAL_MS);
  // Kick once immediately so the first sample lands well before the first interval.
  pollStreamStats();
}
twitchEventSub.on('status', (status) => {
  if (status === 'connected') startStreamPoller();
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
    onBeforeExit: () => {
      try { state.flush(); } catch {}
      broadcast(overlays, { type: '_system.shutdown' });
    },
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
