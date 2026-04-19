'use strict';

// Global state
window.assets = { sounds: [], stickers: [] };
let appState  = { session: {}, crowd: { energy: 0 }, goals: [], leaderboard: {} };

// Hide loading overlay immediately when script runs
(function() {
  const $l = document.getElementById('loading-overlay');
  if ($l) $l.style.display = 'none';
})();

function dashSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
window.dashSend = dashSend;

window.fireEffect = function (effect, payload, btn) {
  if (btn) {
    btn.classList.remove('fired');
    void btn.offsetWidth;
    btn.classList.add('fired');
    setTimeout(() => btn.classList.remove('fired'), 350);
  }
  dashSend({ type: '_dashboard.effect', effect, payload });
};

window.fireEvent = function (type, payload, btn) {
  if (btn) {
    btn.classList.remove('fired');
    void btn.offsetWidth;
    btn.classList.add('fired');
    setTimeout(() => btn.classList.remove('fired'), 350);
  }
  dashSend({ type: '_dashboard.test-event', event: { type, source: 'dashboard', payload } });
};

// ═══════════════════════════════════════════════ WebSocket

let ws        = null;
let retries   = 0;

const WS_URL  = `ws://${location.hostname}:${location.port || 4747}`;
const $badge  = document.getElementById('ws-badge');
const $tBadge = document.getElementById('twitch-badge');
const $oBadge = document.getElementById('obs-badge');
const $dot    = document.getElementById('live-dot');

function connect() {
  fetch('/api/assets').then(r => r.json()).then(a => {
    window.assets = a;
    populateGallery();
  }).catch(() => {});
  
  document.getElementById('overlay-url').textContent = `http://localhost:${location.port || 4747}/?live=1`;

  // Initial setup check
  try {
    fetch('/api/settings').then(r => r.json()).then(s => {
      appState.settings = s;
      // First-run banner: either no Twitch client creds OR no OBS password (against a local OBS that likely requires one).
      const noTwitch = !s.twitch?.clientId || !s.twitch?.clientSecret;
      const noObs    = !s.obs?.password && !s.obs?.address?.startsWith('ws://127.0.0.1');
      showFirstRunBanner(noTwitch);
      if (s.twitch) {
        const $id = document.getElementById('setup-client-id');
        const $sec = document.getElementById('setup-client-secret');
        if ($id) $id.value = s.twitch.clientId || '';
        if ($sec) $sec.value = s.twitch.clientSecret || '';
      }
      if (s.obs) {
        const $url = document.getElementById('setup-obs-url');
        const $pass = document.getElementById('setup-obs-password');
        if ($url) $url.value = s.obs.address || 'ws://127.0.0.1:4455';
        if ($pass) $pass.value = s.obs.password || '';
      }
      if (s.crowd) {
        const $drain  = document.getElementById('set-crowd-drain');
        const $sub    = document.getElementById('set-crowd-sub');
        const $follow = document.getElementById('set-crowd-follow');
        const $raid   = document.getElementById('set-crowd-raid');
        if ($drain)  $drain.value  = s.crowd.drainPerSec || 1;
        if ($sub)    $sub.value    = s.crowd.subBoost || 10;
        if ($follow) $follow.value = s.crowd.followBoost || 1;
        if ($raid)   $raid.value   = s.crowd.raidBoost || 20;
      }
      const $auto = document.getElementById('auto-update-cb');
      if ($auto) $auto.checked = !!s.autoUpdate?.enabled;
    }).catch(err => console.warn('Settings fetch failed:', err));
  } catch (err) {
    console.error('Setup initialization error:', err);
  }

  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => {
    retries = 0;
    setBadge('connected', '● Connected');
    $dot?.classList.add('active');
    ws.send(JSON.stringify({ type: 'register', client: 'dashboard' }));
  });
  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(msg);
  });
  ws.addEventListener('close', () => {
    retries++;
    setBadge('disconnected', '○ Disconnected');
    $dot?.classList.remove('active');
    // Tight backoff so an auto-update restart reconnects before the server's
    // skip-new-browser window expires: 1s, 2s, 3s, 3s, 3s, …
    setTimeout(connect, Math.min(1000 * retries, 3000));
  });
  ws.addEventListener('error', () => {
    setBadge('disconnected', '○ Server offline');
    $dot?.classList.remove('active');
  });
}

function populateGallery() {
  const $s = document.getElementById('gallery-sounds');
  const $t = document.getElementById('gallery-stickers');
  const $c = document.getElementById('gallery-characters');
  if (!$s || !$t || !$c) return;

  $s.innerHTML = (assets.sounds || []).map(f =>
    `<button class="btn btn-ghost btn-sm gallery-sound-btn" data-sound="${esc(f)}" style="font-size:0.7rem;">🔊 ${esc(f)}</button>`
  ).join('');
  $s.onclick = (e) => {
    const btn = e.target.closest('.gallery-sound-btn');
    if (btn) previewSound(btn.dataset.sound);
  };

  $t.innerHTML = (assets.stickers || []).map(f => 
    `<div title="${esc(f)}" style="width:40px; height:40px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; display:flex; align-items:center; justify-content:center; overflow:hidden; cursor:help;">
       <img src="/assets/stickers/${esc(f)}" style="max-width:80%; max-height:80%; object-fit:contain;">
     </div>`
  ).join('');

  $c.innerHTML = (assets.characters || []).map(f => 
    `<div title="${esc(f)}" style="width:60px; height:60px; background:var(--surface2); border:1px solid var(--border); border-radius:8px; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; gap:4px;">
       <img src="/characters/lilfokkermascot/${esc(f)}" style="max-width:70%; max-height:70%; object-fit:contain;">
       <span style="font-size:0.5rem; color:var(--text-dim)">${esc(f)}</span>
     </div>`
  ).join('');
}

window.triggerUpload = (type) => { document.getElementById('upload-' + type).click(); };

window.refreshAssets = function() {
  fetch('/api/assets').then(r => r.json()).then(a => {
    window.assets = a;
    populateGallery();
    // Re-render any config editors that embed sound dropdowns so new/removed files show up
    if (typeof renderConfigEditors === 'function') renderConfigEditors();
  }).catch(err => alert('Refresh failed: ' + err.message));
};

window.handleFileUpload = async function(type, file) {
  if (!file) return;
  
  const status = document.getElementById('error-reporter');
  const msgEl = document.getElementById('error-msg');

  try {
    const res = await fetch('/api/upload', {
      method:  'POST',
      headers: { 'x-filename': file.name, 'x-type': type },
      body:    file
    });
    if (res.ok) {
      alert('Upload successful!');
      fetch('/api/assets').then(r => r.json()).then(a => {
        window.assets = a;
        populateGallery();
      });
    } else {
      throw new Error(await res.text());
    }
  } catch (err) {
    if (status && msgEl) {
      msgEl.textContent = `Upload Failed: ${err.message}`;
      status.style.display = 'block';
    }
  }
};

function setBadge(cls, label) {
  $badge.className = `connection-badge ${cls}`;
  $badge.textContent = label;
}

function setTwitchBadge(status) {
  if (!$tBadge) return;
  const map = {
    connected:    { cls: 'connected',    label: '● Twitch Live' },
    connecting:   { cls: 'connecting',   label: '○ Connecting…' },
    disconnected: { cls: 'disconnected', label: '○ Twitch Offline' },
    error:        { cls: 'disconnected', label: '⚠️ Twitch Error' },
  };
  const { cls, label } = map[status] ?? map.disconnected;
  $tBadge.className   = `connection-badge ${cls}`;
  $tBadge.textContent = label;
}

function showFirstRunBanner(show) {
  let b = document.getElementById('first-run-banner');
  if (!show) { if (b) b.style.display = 'none'; return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'first-run-banner';
    b.style.cssText = 'background:linear-gradient(90deg,#4D96FF,#9147FF); color:#fff; padding:10px 20px; font-size:.88rem; font-weight:700; display:flex; gap:12px; align-items:center; box-shadow:0 4px 16px rgba(0,0,0,0.35);';
    b.innerHTML = `
      <span style="font-size:1.2rem;">⚙️</span>
      <span>First time? Finish setup so Twitch + OBS hook up — <strong>Setup</strong> tab has Twitch OAuth and OBS WebSocket password fields.</span>
      <span style="margin-left:auto; display:inline-flex; gap:8px;">
        <button onclick="document.querySelector('.nav-item[data-page=&quot;setup&quot;]')?.click(); document.getElementById('first-run-banner').style.display='none';" style="background:#1a0f00; color:#FFD700; border:0; padding:6px 14px; border-radius:4px; cursor:pointer; font-weight:800; font-size:.82rem;">Open Setup</button>
        <button onclick="document.getElementById('first-run-banner').style.display='none'" style="background:rgba(0,0,0,0.2); border:0; color:#fff; padding:6px 10px; border-radius:4px; cursor:pointer;">Later</button>
      </span>`;
    document.body.insertBefore(b, document.body.firstChild);
  }
  b.style.display = 'flex';
}

function setObsBadge(status) {
  if (!$oBadge) return;
  const map = {
    connected:    { cls: 'connected',    label: '● OBS Live' },
    connecting:   { cls: 'connecting',   label: '○ Connecting…' },
    disconnected: { cls: 'disconnected', label: '○ OBS Offline' },
    error:        { cls: 'disconnected', label: '⚠️ OBS Error' },
  };
  const { cls, label } = map[status] ?? map.disconnected;
  $oBadge.className   = `connection-badge ${cls}`;
  $oBadge.textContent = label;
  applyObsHint();
}

let obsLastError = '';
function setObsLastError(msg) { obsLastError = msg || ''; applyObsHint(); }
function applyObsHint() {
  if (!$oBadge) return;
  const bad = $oBadge.classList.contains('disconnected');
  $oBadge.title = bad && obsLastError ? obsLastError : '';
  $oBadge.style.cursor = (bad && obsLastError) ? 'help' : '';
  let hint = document.getElementById('obs-badge-hint');
  if (bad && obsLastError) {
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'obs-badge-hint';
      hint.style.cssText = 'font-size:.62rem; color:var(--text-dim); margin:4px 0 10px; line-height:1.35; max-width:220px;';
      $oBadge.insertAdjacentElement('afterend', hint);
    }
    hint.textContent = obsLastError;
    hint.style.display = 'block';
  } else if (hint) {
    hint.style.display = 'none';
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'state-snapshot':
      appState = { ...appState, ...msg.state };
      refreshAll();
      break;

    case 'state':
      applyStateUpdate(msg.path, msg.value);
      break;

    case 'event-log':
      appendLog(msg.event);
      appendChatMessage(msg.event);
      break;

    case 'flow.node-fired':
      if (window.highlightNode) window.highlightNode(msg.nodeId);
      break;
  }
}

function appendChatMessage(event) {
  const $feed = document.getElementById('chat-feed');
  if (!$feed) return;

  const row = document.createElement('div');
  if (event.type === 'chat') {
    const p = event.payload;
    row.className = 'chat-msg';
    row.innerHTML = `<span class="chat-msg__user" style="color:${p.color || 'var(--accent)'}">${esc(p.user)}:</span><span class="chat-msg__text">${esc(p.message)}</span>`;
  } else {
    // Other events show as system messages
    const text = buildLogBody(event);
    row.className = 'chat-msg system';
    row.textContent = `[Alert] ${text}`;
  }

  $feed.appendChild(row);
  $feed.scrollTop = $feed.scrollHeight;
  while ($feed.children.length > 200) $feed.firstChild.remove();
}

// Deterministic hash-based color so each fake viewer keeps a stable color.
function chatColorFor(name) {
  const palette = ['#9147FF','#FF6B6B','#6BCB77','#4D96FF','#FF9A3C','#C77DFF','#00C9FF','#FFD93D','#FF6FC8','#FF5252'];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

window.sendChatMessage = function() {
  const $in = document.getElementById('chat-input');
  const message = $in.value.trim();
  if (!message) return;

  const twitchLive = (appState.twitch?.status === 'connected');
  if (twitchLive) {
    fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message })
    }).then(res => {
      if (res.ok) $in.value = '';
      else res.text().then(err => alert('Send failed: ' + err));
    });
  } else {
    // Twitch not connected — simulate locally so LilFokker can at least preview how it looks.
    const name = appState.settings?.twitch?.channelName || 'LilFokker';
    dashSend({
      type: '_dashboard.test-event',
      event: { type: 'chat', source: 'dashboard', payload: { user: name, message, color: '#FFD700' } }
    });
    $in.value = '';
  }
};

window.simulateViewerChat = function() {
  const $user = document.getElementById('sim-chat-user');
  const $msg  = document.getElementById('sim-chat-msg');
  const user    = ($user.value || 'TestViewer').trim();
  const message = $msg.value.trim();
  if (!message) return;
  dashSend({
    type:  '_dashboard.test-event',
    event: { type: 'chat', source: 'dashboard', payload: { user, message, color: chatColorFor(user) } }
  });
  $msg.value = '';
  $msg.focus();
};

function applyStateUpdate(path, value) {
  const parts = path.split('.');
  let node = appState;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] ??= {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;

  if (path === 'crowd.energy')   renderCrowd(value);
  if (path === 'goals')          renderGoals(value);
  if (path === 'leaderboard')    renderLeaderboard(value);
  if (path === 'session')        renderSession(value);
  if (path === 'twitch.status')  setTwitchBadge(value);
  if (path === 'obs.status')     setObsBadge(value);
  if (path === 'obs.lastError')  setObsLastError(value);
  if (path === 'version') {
    if (window.__fokkerBakedVersion == null) {
      window.__fokkerBakedVersion = value;
    } else if (window.__fokkerBakedVersion !== value) {
      console.info('FokkerPop updated', window.__fokkerBakedVersion, '→', value, '— reloading dashboard');
      location.reload();
      return;
    }
    setVersion(value);
  }
  if (path === 'overlay.layoutMode') {
    for (const id of ['layout-mode-cb', 'layout-mode-cb-2']) {
      const cb = document.getElementById(id);
      if (cb) cb.checked = value;
    }
  }
  if (path === 'overlay.volume') {
    const s = document.getElementById('volume-slider');
    const l = document.getElementById('volume-label');
    if (s) s.value = value;
    if (l) l.textContent = `${Math.round(value * 100)}%`;
  }
  if (path === 'update.available') renderUpdateBanner(value);
  if (path === 'obs.streaming') handleStreamingChange(!!value);
  if (path === 'overlay.widgets') { widgets = value || []; renderWidgetList(); }
}

let prevStreaming = false;
function handleStreamingChange(nowStreaming) {
  if (prevStreaming && !nowStreaming && window.__fokkerUpdateAfterStream) {
    // Stream just ended and user asked to defer update — fire it now.
    window.__fokkerUpdateAfterStream = false;
    console.info('Stream ended — applying deferred FokkerPop update.');
    dashSend({ type: '_dashboard.update-apply' });
  }
  prevStreaming = nowStreaming;
}

function renderUpdateBanner(info) {
  const el  = document.getElementById('update-banner');
  const txt = document.getElementById('update-banner-text');
  const btn = document.getElementById('update-install-btn');
  if (!el) return;
  if (!info?.version) { el.style.display = 'none'; return; }
  const label = `v${info.version} available` + (info.ready ? '' : ' — downloading…');
  if (txt) txt.textContent = label;
  if (btn) {
    btn.disabled   = !info.ready;
    btn.style.opacity = info.ready ? '1' : '0.55';
    btn.style.cursor  = info.ready ? 'pointer' : 'not-allowed';
    btn.textContent   = info.ready ? 'Install Now' : 'Preparing…';
  }
  el.style.display = 'block';
}

window.saveAutoUpdate = function (enabled) {
  fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ autoUpdate: { enabled: !!enabled } })
  }).then(r => {
    if (!r.ok) alert('Could not save Auto-Install preference.');
  });
};

// ═══════════════════════════════════════════════ Custom widgets
let widgets = [];

async function loadWidgets() {
  const r = await fetch('/api/widgets').catch(() => null);
  if (!r?.ok) return;
  widgets = await r.json();
  renderWidgetList();
}

function saveWidgets() {
  return fetch('/api/widgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(widgets) });
}

const EFFECT_OPTIONS = ['balloon','firework','firework-salvo','confetti','sticker-rain','crowd-explosion','alert-banner'];
const EVENT_OPTIONS  = ['follow','sub','sub.gifted','cheer','raid','hype-train.start','hype-train.progress','hype-train.end','chat','redeem'];

window.addWidget = function (type) {
  const id = 'w-' + Date.now().toString(36);
  const base = { id, type, x: 40, y: 10 };
  if (type === 'counter')     base.config = { visible: true, label: 'SUBS TODAY', metric: 'session.subCount', fontSize: 36, color: '#9147FF' };
  if (type === 'text')        base.config = { visible: true, text: 'STARTING SOON', fontSize: 48, color: '#FFD700' };
  if (type === 'recent')      base.config = { visible: true, label: 'LATEST CHATTER', fontSize: 24, color: '#6BCB77' };
  if (type === 'hot-button')  base.config = { visible: true, label: '🎆 FIRE', effect: 'firework-salvo', payload: { count: 3 }, fontSize: 28, color: '#FFD700' };
  if (type === 'event-badge') base.config = { visible: true, label: '💜 SUB', eventType: 'sub', fontSize: 22, color: '#9147FF' };
  if (type === 'progress-bar') base.config = { visible: true, label: 'SUB GOAL', metric: 'session.subCount', target: 50, color: '#9147FF', fontSize: 16, barWidth: 240, barHeight: 14 };
  if (type === 'leaderboard-top') base.config = { visible: true, label: 'TOP BITS', category: 'bits', topN: 3, fontSize: 16, color: '#FFFFFF' };
  if (type === 'physics-pit') base.config = {
    visible: true, autoHide: true, size: 18, gravity: 1, width: 320, height: 220, maxAlive: 60,
    spawns: [
      { triggerEvent: 'sub',   emojis: ['🎈','✨'], count: 6, layer: 1 },
      { triggerEvent: 'cheer', emojis: ['💎'],      count: 4, layer: 2 },
    ],
  };
  if (type === 'physics-pit-3d') base.config = {
    visible: true, autoHide: true, gravity: 1, width: 360, height: 260, maxAlive: 40,
    size: 0.25, pitWidth: 3, pitDepth: 2, pitHeight: 4,
    spawns: [
      { triggerEvent: 'sub',   emojis: ['🎈','✨'], count: 6, layer: 1 },
      { triggerEvent: 'cheer', emojis: ['💎'],      count: 4, layer: 2 },
    ],
  };
  if (type === 'dice')        base.config = { visible: true, autoHide: true, sides: 20, triggerEvent: 'redeem', width: 220, height: 220 };
  if (type === 'dice-tray')   base.config = { visible: true, autoHide: true, count: 2, triggerEvent: 'redeem', width: 420, height: 280, dieSize: 0.45, trayWidth: 2.5, trayDepth: 1.6 };
  if (type === 'model-3d')    base.config = { visible: true, modelUrl: '', rotationSpeed: 0.005, scale: 1, reactiveScale: '', width: 300, height: 300 };
  widgets.push(base);
  saveWidgets().then(renderWidgetList);
};

window.deleteWidget = function (id) {
  if (!confirm('Delete this widget?')) return;
  widgets = widgets.filter(w => w.id !== id);
  saveWidgets().then(renderWidgetList);
};

// Physics-pit spawn-rule editors
window.addPitSpawn = function (id) {
  const w = widgets.find(x => x.id === id);
  if (!w) return;
  w.config = w.config || {};
  w.config.spawns = w.config.spawns ?? [];
  w.config.spawns.push({ triggerEvent: 'follow', emojis: ['🎈'], count: 5, layer: (w.config.spawns.length || 0) + 1 });
  saveWidgets().then(renderWidgetList);
};
window.removePitSpawn = function (id, i) {
  const w = widgets.find(x => x.id === id);
  if (!w?.config?.spawns) return;
  w.config.spawns.splice(i, 1);
  saveWidgets().then(renderWidgetList);
};
window.updatePitSpawn = function (id, i, field, value) {
  const w = widgets.find(x => x.id === id);
  if (!w?.config?.spawns?.[i]) return;
  w.config.spawns[i][field] = value;
  clearTimeout(updatePitSpawn._t);
  updatePitSpawn._t = setTimeout(saveWidgets, 300);
};

window.updateWidgetField = function (id, field, value) {
  const w = widgets.find(w => w.id === id);
  if (!w) return;
  w.config = w.config || {};
  if (field === 'fontSize') value = parseInt(value, 10) || 0;
  if (field === 'payload') { try { value = JSON.parse(value); } catch { return; } }
  if (field === 'visible') value = !!value;
  w.config[field] = value;
  clearTimeout(updateWidgetField._t);
  updateWidgetField._t = setTimeout(saveWidgets, 300);
};

function renderWidgetList() {
  const host = document.getElementById('widget-list');
  if (!host) return;
  if (!widgets.length) { host.innerHTML = '<p style="color:var(--text-dim); font-size:.82rem;">No widgets yet. Add one from the buttons above.</p>'; return; }

  host.innerHTML = widgets.map(w => {
    const c = w.config || {};
    const visible = c.visible !== false;
    const typeLabel = {
      counter: 'Counter', text: 'Text', recent: 'Latest Chatter',
      'hot-button': 'Hot Button', 'event-badge': 'Event Badge',
      'progress-bar': 'Progress Bar', 'leaderboard-top': 'Leaderboard Top-N',
      'physics-pit': 'Physics Pit (2D)', 'physics-pit-3d': 'Physics Pit (3D)',
      dice: 'Dice', 'dice-tray': 'Dice Tray', 'model-3d': '3D Model',
    }[w.type] || w.type;
    const body = (() => {
      if (w.type === 'counter') return `
        <input class="input-field" value="${esc(c.label ?? '')}" placeholder="Label" oninput="updateWidgetField('${w.id}','label',this.value)">
        <input class="input-field" value="${esc(c.metric ?? '')}" placeholder="Metric path (e.g. session.subCount)" oninput="updateWidgetField('${w.id}','metric',this.value)" style="font-family:monospace;">`;
      if (w.type === 'text') return `
        <input class="input-field" value="${esc(c.text ?? '')}" placeholder="Text" oninput="updateWidgetField('${w.id}','text',this.value)">`;
      if (w.type === 'recent') return `
        <input class="input-field" value="${esc(c.label ?? '')}" placeholder="Label" oninput="updateWidgetField('${w.id}','label',this.value)">`;
      if (w.type === 'hot-button') return `
        <input class="input-field" value="${esc(c.label ?? '')}" placeholder="Button label / emoji" oninput="updateWidgetField('${w.id}','label',this.value)" style="max-width:180px;">
        <select class="input-field" onchange="updateWidgetField('${w.id}','effect',this.value)">
          ${EFFECT_OPTIONS.map(e => `<option value="${e}" ${e === c.effect ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        <input class="input-field" value='${esc(JSON.stringify(c.payload ?? {}))}' placeholder='{"count":3}' oninput="updateWidgetField('${w.id}','payload',this.value)" style="font-family:monospace;">`;
      if (w.type === 'event-badge') return `
        <input class="input-field" value="${esc(c.label ?? '')}" placeholder="Badge text (e.g. 💜 SUB)" oninput="updateWidgetField('${w.id}','label',this.value)" style="max-width:180px;">
        <select class="input-field" onchange="updateWidgetField('${w.id}','eventType',this.value)" title="Flashes when an event of this type fires">
          ${EVENT_OPTIONS.map(e => `<option value="${e}" ${e === c.eventType ? 'selected' : ''}>${e}</option>`).join('')}
        </select>`;
      if (w.type === 'progress-bar') return `
        <input class="input-field" value="${esc(c.label ?? '')}" placeholder="Label" oninput="updateWidgetField('${w.id}','label',this.value)" style="max-width:180px;">
        <input class="input-field" value="${esc(c.metric ?? '')}" placeholder="Metric (e.g. session.subCount)" oninput="updateWidgetField('${w.id}','metric',this.value)" style="font-family:monospace;">
        <input class="input-field" type="number" value="${c.target ?? 100}" oninput="updateWidgetField('${w.id}','target',parseFloat(this.value)||0)" style="max-width:100px;" title="Target value">`;
      if (w.type === 'leaderboard-top') return `
        <input class="input-field" value="${esc(c.label ?? '')}" placeholder="Label" oninput="updateWidgetField('${w.id}','label',this.value)" style="max-width:180px;">
        <select class="input-field" onchange="updateWidgetField('${w.id}','category',this.value)" title="Leaderboard category">
          ${['bits','subs','gifts'].map(e => `<option value="${e}" ${e === c.category ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        <input class="input-field" type="number" min="1" max="10" value="${c.topN ?? 3}" oninput="updateWidgetField('${w.id}','topN',parseInt(this.value)||1)" style="max-width:80px;" title="Top N">`;
      if (w.type === 'physics-pit' || w.type === 'physics-pit-3d') {
        const is3d = w.type === 'physics-pit-3d';
        const spawns = c.spawns ?? (c.triggerEvent ? [{ triggerEvent: c.triggerEvent, emojis: c.emojis ?? [], count: c.countPerEvent ?? 5, layer: 1 }] : []);
        const rows = spawns.map((s, i) => `
          <div class="input-row" style="margin-top:6px; padding:8px; background:rgba(255,255,255,0.03); border-radius:6px;">
            <select class="input-field" onchange="updatePitSpawn('${w.id}',${i},'triggerEvent',this.value)" style="max-width:130px;" title="Event type that drops these emojis">
              ${EVENT_OPTIONS.map(e => `<option value="${e}" ${e === s.triggerEvent ? 'selected' : ''}>${e}</option>`).join('')}
            </select>
            <input class="input-field" value="${esc((s.emojis ?? []).join(' '))}" placeholder="Emojis (space-separated)" oninput="updatePitSpawn('${w.id}',${i},'emojis',this.value.split(/\\s+/).filter(Boolean))">
            <input class="input-field" type="number" value="${s.count ?? 5}" oninput="updatePitSpawn('${w.id}',${i},'count',parseInt(this.value)||0)" style="max-width:70px;" title="Count per event">
            <input class="input-field" type="number" min="1" max="15" value="${s.layer ?? 1}" oninput="updatePitSpawn('${w.id}',${i},'layer',parseInt(this.value)||1)" style="max-width:70px;" title="Collision layer (same layer collides, different layers pass through)">
            <button class="btn btn-ghost btn-sm" onclick="removePitSpawn('${w.id}',${i})" style="color:var(--red);">✕</button>
          </div>`).join('');
        const sizeStep = is3d ? '0.05' : '1';
        const sizeVal  = c.size ?? (is3d ? 0.25 : 18);
        const sizeHint = is3d ? 'Sphere radius (world units)' : 'Emoji radius px';
        return `
          <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px; flex-wrap:wrap;">
            <input class="input-field" type="number" step="0.1" value="${c.gravity ?? 1}" oninput="updateWidgetField('${w.id}','gravity',parseFloat(this.value)||0)" style="max-width:90px;" title="Gravity">
            <input class="input-field" type="number" step="${sizeStep}" value="${sizeVal}" oninput="updateWidgetField('${w.id}','size',parseFloat(this.value)||0)" style="max-width:90px;" title="${sizeHint}">
            <input class="input-field" type="number" value="${c.maxAlive ?? (is3d ? 40 : 60)}" oninput="updateWidgetField('${w.id}','maxAlive',parseInt(this.value)||0)" style="max-width:90px;" title="Max alive">
            ${is3d ? `
              <input class="input-field" type="number" step="0.1" value="${c.pitWidth ?? 3}" oninput="updateWidgetField('${w.id}','pitWidth',parseFloat(this.value)||0)" style="max-width:90px;" title="Pit width (world units, half-extent doubled)">
              <input class="input-field" type="number" step="0.1" value="${c.pitDepth ?? 2}" oninput="updateWidgetField('${w.id}','pitDepth',parseFloat(this.value)||0)" style="max-width:90px;" title="Pit depth">
              <input class="input-field" type="number" step="0.1" value="${c.pitHeight ?? 4}" oninput="updateWidgetField('${w.id}','pitHeight',parseFloat(this.value)||0)" style="max-width:90px;" title="Pit height">
            ` : ''}
            <input class="input-field" value="${esc(c.reactiveGravity ?? '')}" placeholder="Reactive gravity metric (e.g. crowd.energy)" oninput="updateWidgetField('${w.id}','reactiveGravity',this.value)" style="max-width:240px; font-family:monospace;" title="Scales gravity 0.3×–2.0× based on a 0–100 state metric">
            <button class="btn btn-ghost btn-sm" onclick="addPitSpawn('${w.id}')" style="margin-left:auto;">+ Spawn Rule</button>
          </div>
          <p style="font-size:.7rem; color:var(--text-dim); margin:4px 0;">Each spawn rule = trigger event + emojis + count + <strong>layer</strong>. Objects on the same layer collide; different layers pass through each other.${is3d ? ' 3D pit uses cannon-es rigid bodies.' : ''}</p>
          ${rows || '<p style="font-size:.75rem; color:var(--text-dim);">No spawn rules yet. Click "+ Spawn Rule".</p>'}`;
      }
      if (w.type === 'dice') return `
        <select class="input-field" onchange="updateWidgetField('${w.id}','sides',parseInt(this.value))" title="Die type">
          ${[4,6,8,10,12,20].map(n => `<option value="${n}" ${n === c.sides ? 'selected' : ''}>D${n}</option>`).join('')}
        </select>
        <select class="input-field" onchange="updateWidgetField('${w.id}','triggerEvent',this.value)" title="Event type that rolls the die">
          ${EVENT_OPTIONS.map(e => `<option value="${e}" ${e === c.triggerEvent ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        <span style="font-size:.7rem; color:var(--text-dim);">Result fires bus event <code>dice.rolled</code> {result, sides} — use Studio to branch on it.</span>`;
      if (w.type === 'dice-tray') return `
        <input class="input-field" type="number" min="1" max="20" value="${c.count ?? 2}" oninput="updateWidgetField('${w.id}','count',parseInt(this.value)||1)" style="max-width:80px;" title="Number of D6 dice in the tray">
        <select class="input-field" onchange="updateWidgetField('${w.id}','triggerEvent',this.value)" title="Event type that rolls the tray">
          ${EVENT_OPTIONS.map(e => `<option value="${e}" ${e === c.triggerEvent ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        <input class="input-field" type="number" step="0.05" value="${c.dieSize ?? 0.45}" oninput="updateWidgetField('${w.id}','dieSize',parseFloat(this.value)||0)" style="max-width:80px;" title="Die half-extent (world units)">
        <span style="font-size:.7rem; color:var(--text-dim);">Rolls N D6s together. Result fires bus event <code>dice-tray.rolled</code> {dice:[{sides,result}], sum}.</span>`;
      if (w.type === 'model-3d') {
        const models = (window.assets?.models) || [];
        return `
          <select class="input-field" onchange="updateWidgetField('${w.id}','modelUrl',this.value)" title="Uploaded GLB / GLTF model">
            <option value="">-- No model --</option>
            ${models.map(m => { const url = '/assets/models/' + m; return `<option value="${esc(url)}" ${url === c.modelUrl ? 'selected' : ''}>${esc(m)}</option>`; }).join('')}
          </select>
          <button class="btn btn-ghost btn-sm" onclick="triggerUpload('model')">➕ Upload GLB</button>
          <input class="input-field" type="number" step="0.001" value="${c.rotationSpeed ?? 0.005}" oninput="updateWidgetField('${w.id}','rotationSpeed',parseFloat(this.value)||0)" style="max-width:110px;" title="Y-axis rotation per frame (rad)">
          <input class="input-field" value="${esc(c.reactiveScale ?? '')}" placeholder="Reactive metric (e.g. crowd.energy)" oninput="updateWidgetField('${w.id}','reactiveScale',this.value)" style="max-width:200px; font-family:monospace;" title="Optional state path that scales the model">`;
      }
      return '';
    })();
    const autoHideTypes = new Set(['physics-pit', 'physics-pit-3d', 'dice', 'dice-tray', 'event-badge']);
    const showAutoHide = autoHideTypes.has(w.type);
    return `
      <div class="card" style="margin-bottom:10px; padding:12px; background:var(--surface2); ${visible ? '' : 'opacity:0.55;'}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="font-size:.65rem; font-weight:800; color:var(--accent2); letter-spacing:.1em; text-transform:uppercase;">${typeLabel} <span style="color:var(--text-dim); font-weight:500; margin-left:6px;">${w.id}</span></div>
          <div style="display:flex; gap:10px; align-items:center;">
            <label style="display:inline-flex; align-items:center; gap:6px; font-size:.72rem; color:var(--text-dim); cursor:pointer;">
              <input type="checkbox" ${visible ? 'checked' : ''} onchange="updateWidgetField('${w.id}','visible',this.checked); renderWidgetList();"> visible
            </label>
            ${showAutoHide ? `<label style="display:inline-flex; align-items:center; gap:6px; font-size:.72rem; color:var(--text-dim); cursor:pointer;" title="Hide until the trigger event fires; fade back out after 8 s">
              <input type="checkbox" ${c.autoHide ? 'checked' : ''} onchange="updateWidgetField('${w.id}','autoHide',this.checked)"> auto-hide
            </label>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="deleteWidget('${w.id}')" style="color:var(--red);">Delete</button>
          </div>
        </div>
        <div class="input-row">${body}</div>
        <div class="input-row" style="margin-top:8px;">
          <input class="input-field" type="number" value="${c.fontSize ?? 32}" oninput="updateWidgetField('${w.id}','fontSize',this.value)" style="max-width:100px;" title="Font size (px)">
          <input class="input-field" value="${esc(c.color ?? '#FFFFFF')}" oninput="updateWidgetField('${w.id}','color',this.value)" style="max-width:120px; font-family:monospace;" title="Text color">
        </div>
      </div>
    `;
  }).join('');
}

// Load widget list when dashboard connects
loadWidgets();

window.applyUpdate = function () {
  // Stream-aware gating — installing restarts the overlay, which would blip on stream.
  if (appState.obs?.streaming) {
    const choice = prompt(
      'OBS is streaming right now. Installing will briefly restart the overlay.\n\n' +
      'Type "now" to install anyway, or "later" to auto-install when your stream ends.\n' +
      '(Leave blank and press Cancel to do nothing.)',
      'later'
    );
    if (choice == null) return;
    if (/^later/i.test(choice)) {
      window.__fokkerUpdateAfterStream = true;
      const txt = document.getElementById('update-banner-text');
      if (txt) txt.textContent += ' — will install when stream ends';
      return;
    }
    if (!/^now/i.test(choice)) return; // unrecognized answer = cancel
  }
  const btn = document.getElementById('update-install-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; btn.style.opacity = '0.55'; btn.style.cursor = 'not-allowed'; }
  dashSend({ type: '_dashboard.update-apply' });
};

function setVersion(v) {
  if (!v) return;
  const cleanV = String(v).startsWith('v') ? v : `v${v}`;
  document.querySelectorAll('.v-badge, .v-string').forEach(el => { el.textContent = cleanV; });

  // Safety check: Is he actually on the latest?
  if (v && v < '0.2.49') {
    const el = document.getElementById('error-reporter');
    const msgEl = document.getElementById('error-msg');
    if (el && msgEl) {
      msgEl.innerHTML = `⚠️ UPDATE FAILED: You are running an old version (${v}). Please run the Auto-Updater EXE again and ensure you overwrite everything!`;
      el.style.background = 'var(--gold)';
      el.style.display = 'block';
    }
  }
}

function refreshAll() {
  renderSession(appState.session);
  renderCrowd(appState.crowd?.energy ?? 0);
  renderGoals(appState.goals ?? []);
  renderLeaderboard(appState.leaderboard ?? {});
  if (appState.version) setVersion(appState.version);
}

// ═══════════════════════════════════════════════ Renderers

// Track previous stat values for bump animation
const _prevStats = { subCount: null, bitsTotal: null, followCount: null, raidCount: null };

function renderSession(s) {
  if (!s) return;

  const fields = [
    { id: 'stat-subs',    key: 'subCount',    val: s.subCount    ?? 0 },
    { id: 'stat-bits',    key: 'bitsTotal',   val: s.bitsTotal   ?? 0 },
    { id: 'stat-follows', key: 'followCount', val: s.followCount ?? 0 },
    { id: 'stat-raids',   key: 'raidCount',   val: s.raidCount   ?? 0 },
  ];

  for (const { id, key, val } of fields) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = val.toLocaleString();
    if (_prevStats[key] !== null && val !== _prevStats[key]) {
      el.classList.remove('bump');
      void el.offsetWidth;  // force reflow to restart animation
      el.classList.add('bump');
      setTimeout(() => el.classList.remove('bump'), 450);
    }
    _prevStats[key] = val;
  }
}

function renderCrowd(energy) {
  const pct  = Math.max(0, Math.min(100, energy));
  const fill = document.getElementById('db-crowd-fill');
  if (!fill) return;
  fill.style.width = `${pct}%`;
  fill.classList.toggle('hot', pct >= 76);
  fill.classList.toggle('max', pct >= 99);
  const val = document.getElementById('db-crowd-val');
  if (val) val.textContent = `${Math.round(pct)} / 100`;
}

function renderLeaderboard(lb) {
  renderLbSection('live-lb-bits',  lb?.bits  ?? {}, 'bits');
  renderLbSection('live-lb-gifts', lb?.gifts ?? {}, 'gifts');
}

function renderLbSection(elId, data, unit) {
  const el      = document.getElementById(elId);
  if (!el) return;
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!entries.length) { el.innerHTML = '<span style="color:var(--text-dim)">—</span>'; return; }
  el.innerHTML  = entries.map(([user, val], i) =>
    `<div style="display:flex;justify-content:space-between">
       <span>${['🥇','🥈','🥉','4.','5.'][i] ?? (i+1+'.')} <strong>${esc(user)}</strong></span>
       <span style="color:var(--text-dim)">${val.toLocaleString()} ${unit}</span>
     </div>`
  ).join('');
}

window.switchSubTab = function(btn, pageId) {
  document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.config-sub-page').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(pageId)?.classList.add('active');
  if (pageId === 'config-commands') renderCommandsConfig();
};

function renderGoals(goals) {
  const el = document.getElementById('goals-list');
  if (!el) return;
  if (!goals?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:.82rem;">No goals configured. Use <strong>+ Add Goal</strong> below to create one.</p>'; return; }

  el.innerHTML = goals.map(g => {
    const current = getNestedVal(appState, g.metric) ?? 0;
    const pct     = Math.min(100, (current / g.target) * 100).toFixed(1);
    return `
      <div class="goal-row ${g.completed ? 'completed' : ''} ${!g.active ? 'inactive' : ''}">
        <div class="goal-row__info">
          <div class="goal-row__name">
            ${esc(g.label)}
            ${g.completed ? '<span style="color:var(--gold);margin-left:6px">✅ Done</span>' : ''}
          </div>
          <div class="goal-row__progress">${current.toLocaleString()} / ${g.target.toLocaleString()} (${pct}%)</div>
          <div class="goal-row__track"><div class="goal-row__fill" style="width:${pct}%"></div></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
          <label class="toggle" title="${g.active ? 'Active' : 'Inactive'}">
            <input type="checkbox" ${g.active ? 'checked' : ''} onchange="dashSend({type:'_dashboard.goal-toggle',id:'${g.id}'})">
            <div class="toggle-slider"></div>
          </label>
          ${g.reward?.effect ? `<button class="btn btn-ghost btn-sm" onclick="dashSend({type:'_dashboard.effect',effect:'${g.reward.effect}',payload:{}})">Test Reward</button>` : ''}
          ${g.completed
            ? `<button class="btn btn-ghost btn-sm" onclick="dashSend({type:'_dashboard.goal-reset',id:'${g.id}'})">Reset</button>`
            : ''}
        </div>
      </div>`;
  }).join('');

  renderConfigEditors(); // sync config editor if open
}

window.previewSound = function(file) {
  if (!file) {
    alert('Pick a sound from the dropdown first.');
    return;
  }
  const src = `/assets/sounds/${encodeURIComponent(file)}`;
  const audio = new Audio(src);
  audio.volume = 0.5; // safe default for previews
  audio.addEventListener('error', () => {
    console.warn(`Preview failed: could not load ${src}`, audio.error);
    alert(`Could not load "${file}". Is the file still in assets/sounds/?`);
  });
  audio.play().catch(err => {
    console.warn('Preview blocked:', err.message);
    alert(`Could not play "${file}": ${err.message}`);
  });
};

function buildSoundSelect(cls, current, vol = 1.0) {
  const sounds = assets.sounds ?? [];
  return `
    <div style="display:flex; flex-direction:column; gap:6px; flex:1;">
      <div style="display:flex; gap:6px;">
        <select class="input-field ${cls}" style="flex:1;">
          <option value="">-- No Sound --</option>
          ${sounds.map(s => `<option value="${esc(s)}" ${s === current ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" onclick="previewSound(this.previousElementSibling.value)" title="Play Sample">▶️</button>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:0.6rem; color:var(--text-dim); min-width:40px;">Vol: ${Math.round(vol * 100)}%</span>
        <input type="range" class="v-slider ${cls}-vol" min="0" max="1" step="0.05" value="${vol}" 
          oninput="this.previousElementSibling.textContent = 'Vol: ' + Math.round(this.value * 100) + '%'"
          style="flex:1; height:4px; accent-color:var(--accent);">
      </div>
    </div>`;
}

function renderConfigEditors() {
  renderGoalsConfig();
  renderRedeemsConfig();
  renderCommandsConfig();
}

// Goals editor dirty-tracking: while the user has unsaved edits, skip re-renders
// triggered by server-side goals state updates (e.g. a goal completing mid-stream).
let goalsEditorDirty = false;
let goalsEditorWired = false;

function setGoalsDirty(v) {
  goalsEditorDirty = v;
  const dot = document.getElementById('goals-dirty-dot');
  const btn = document.getElementById('goals-save-btn');
  if (dot) dot.style.display = v ? 'inline' : 'none';
  if (btn) {
    btn.textContent = v ? 'Save ●' : 'Save';
    btn.classList.toggle('btn-gold', v);
  }
}

function wireGoalsEditor(el) {
  if (goalsEditorWired) return;
  goalsEditorWired = true;
  el.addEventListener('input',  () => setGoalsDirty(true));
  el.addEventListener('click', (e) => {
    // Any click inside a card (Delete button, etc.) counts as dirty.
    if (e.target.closest('.card')) setGoalsDirty(true);
  });
}

function renderGoalsConfig() {
  const gContainer = document.getElementById('config-goals-container');
  if (!gContainer) return;
  wireGoalsEditor(gContainer);
  if (goalsEditorDirty) return; // preserve in-progress edits
  {
    gContainer.innerHTML = appState.goals.map((g, i) => `
      <div class="card" style="margin-bottom:10px;padding:12px;background:var(--surface2);">
        <div class="input-row">
          <input class="input-field g-id" placeholder="ID" value="${esc(g.id)}" style="max-width:120px;">
          <input class="input-field g-label" placeholder="Label" value="${esc(g.label)}">
          <input class="input-field g-target" type="number" placeholder="Target" value="${g.target}" style="max-width:100px;">
          <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red);">Delete</button>
        </div>
        <div class="input-row" style="margin-top:10px;">
          <input class="input-field g-metric" placeholder="Metric (e.g. session.subCount)" value="${esc(g.metric)}" style="flex:1;">
          ${buildEffectSelect('g-effect', g.reward?.effect)}
        </div>
        <div class="input-row" style="margin-top:10px; align-items:flex-start;">
          ${buildSoundSelect('g-sound', g.reward?.sound, g.reward?.vol ?? 1.0)}
        </div>
      </div>
    `).join('');
  }
}

function renderRedeemsConfig() {
  const rContainer = document.getElementById('config-redeems-container');
  if (rContainer) {
    fetch('/api/redeems').then(r => r.json()).then(redeems => {
      rContainer.innerHTML = Object.entries(redeems).filter(([k]) => k !== '_comment').map(([title, def]) => `
        <div class="card" style="margin-bottom:10px;padding:12px;background:var(--surface2);">
          <div class="input-row">
            <input class="input-field r-title" placeholder="Reward Title" value="${esc(title)}">
            ${buildEffectSelect('r-effect', def.effect)}
          </div>
          <div class="input-row" style="margin-top:10px; align-items:flex-start;">
            <input class="input-field r-count" type="number" placeholder="Count" value="${def.count ?? ''}" style="max-width:80px;">
            ${buildSoundSelect('r-sound', def.sound, def.vol ?? 1.0)}
            <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red); margin-top:5px;">Delete</button>
          </div>
        </div>
      `).join('');
    });
  }
}

window.renderCommandsConfig = function() {
  const cContainer = document.getElementById('config-commands-container');
  if (cContainer) {
    fetch('/api/commands').then(r => r.json()).then(commands => {
      cContainer.innerHTML = Object.entries(commands).filter(([k]) => k !== '_comment').map(([trigger, def]) => `
        <div class="card" style="margin-bottom:10px;padding:12px;background:var(--surface2);">
          <div class="input-row">
            <input class="input-field c-trigger" placeholder="!command" value="${esc(trigger)}" style="max-width:140px;">
            ${buildEffectSelect('c-effect', def.effect)}
          </div>
          <div class="input-row" style="margin-top:10px; align-items:flex-start;">
            <input class="input-field c-cooldown" type="number" placeholder="Cooldown (s)" value="${def.cooldown ?? 5}" style="max-width:100px;">
            ${buildSoundSelect('c-sound', def.sound, def.vol ?? 1.0)}
            <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red); margin-top:5px;">Delete</button>
          </div>
        </div>
      `).join('');
    });
  }
};

function buildEffectSelect(cls, current) {
  const effects = ['balloon', 'firework', 'firework-salvo', 'confetti', 'sticker-rain', 'crowd-explosion', 'alert-banner'];
  return `
    <select class="input-field ${cls}" style="flex:1;">
      <option value="">-- Select Effect --</option>
      ${effects.map(e => `<option value="${e}" ${e === current ? 'selected' : ''}>Effect: ${e}</option>`).join('')}
    </select>`;
}

window.addCommandConfig = function() {
  const container = document.getElementById('config-commands-container');
  const div = document.createElement('div');
  div.className = 'card';
  div.style.cssText = 'margin-bottom:10px;padding:12px;background:var(--surface2);';
  div.innerHTML = `
    <div class="input-row">
      <input class="input-field c-trigger" placeholder="!command" value="!new" style="max-width:140px;">
      ${buildEffectSelect('c-effect', 'firework')}
    </div>
    <div class="input-row" style="margin-top:10px; align-items:flex-start;">
      <input class="input-field c-cooldown" type="number" placeholder="Cooldown (s)" value="10" style="max-width:100px;">
      ${buildSoundSelect('c-sound', '', 1.0)}
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red); margin-top:5px;">Delete</button>
    </div>`;
  container.appendChild(div);
};

window.saveCommandsConfig = function() {
  const cmds = {};
  document.querySelectorAll('#config-commands-container .card').forEach(card => {
    const trigger = card.querySelector('.c-trigger').value.toLowerCase().trim();
    const effect  = card.querySelector('.c-effect').value;
    const cooldown = parseInt(card.querySelector('.c-cooldown').value);
    const sound   = card.querySelector('.c-sound').value;
    const vol     = parseFloat(card.querySelector('.c-sound-vol').value);
    if (trigger) {
      cmds[trigger] = { effect, cooldown: isNaN(cooldown) ? 10 : cooldown };
      if (sound) {
        cmds[trigger].sound = sound;
        cmds[trigger].vol   = vol;
      }
    }
  });

  fetch('/api/commands', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(cmds)
  }).then(r => r.ok ? alert('Commands saved!') : alert('Save failed'));
};

window.addGoalConfig = function() {
  setGoalsDirty(true);
  const container = document.getElementById('config-goals-container');
  const div = document.createElement('div');
  div.className = 'card';
  div.style.cssText = 'margin-bottom:10px;padding:12px;background:var(--surface2);';
  div.innerHTML = `
    <div class="input-row">
      <input class="input-field g-id" placeholder="ID" value="new-goal" style="max-width:120px;">
      <input class="input-field g-label" placeholder="Label" value="New Goal">
      <input class="input-field g-target" type="number" placeholder="Target" value="100" style="max-width:100px;">
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red);">Delete</button>
    </div>
    <div class="input-row" style="margin-top:10px;">
      <input class="input-field g-metric" placeholder="Metric" value="session.subCount" style="flex:1;">
      ${buildEffectSelect('g-effect', 'firework-salvo')}
    </div>
    <div class="input-row" style="margin-top:10px; align-items:flex-start;">
      ${buildSoundSelect('g-sound', '', 1.0)}
    </div>`;
  container.appendChild(div);
};

window.saveGoalsConfig = function() {
  const goals = Array.from(document.querySelectorAll('#config-goals-container .card')).map(card => {
    const sound = card.querySelector('.g-sound').value;
    const vol   = parseFloat(card.querySelector('.g-sound-vol').value);
    const reward = { type: 'effect', effect: card.querySelector('.g-effect').value };
    if (sound) {
      reward.sound = sound;
      reward.vol   = vol;
    }
    return {
      id:        card.querySelector('.g-id').value,
      label:     card.querySelector('.g-label').value,
      target:    parseInt(card.querySelector('.g-target').value),
      metric:    card.querySelector('.g-metric').value,
      reward,
      active:    true,
      completed: false
    };
  });

  fetch('/api/goals', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(goals)
  }).then(r => {
    if (r.ok) {
      setGoalsDirty(false);
      renderGoalsConfig();
      alert('Goals saved!');
    } else {
      alert('Save failed');
    }
  });
};

window.addRedeemConfig = function() {
  const container = document.getElementById('config-redeems-container');
  const div = document.createElement('div');
  div.className = 'card';
  div.style.cssText = 'margin-bottom:10px;padding:12px;background:var(--surface2);';
  div.innerHTML = `
    <div class="input-row">
      <input class="input-field r-title" placeholder="Reward Title" value="">
      ${buildEffectSelect('r-effect', 'balloon')}
    </div>
    <div class="input-row" style="margin-top:10px; align-items:flex-start;">
      <input class="input-field r-count" type="number" placeholder="Count" value="10" style="max-width:80px;">
      ${buildSoundSelect('r-sound', '', 1.0)}
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red); margin-top:5px;">Delete</button>
    </div>`;
  container.appendChild(div);
};

window.saveRedeemsConfig = function() {
  const redeems = {};
  document.querySelectorAll('#config-redeems-container .card').forEach(card => {
    const title  = card.querySelector('.r-title').value;
    const effect = card.querySelector('.r-effect').value;
    const count  = parseInt(card.querySelector('.r-count').value);
    const sound  = card.querySelector('.r-sound').value;
    const vol    = parseFloat(card.querySelector('.r-sound-vol').value);
    if (title) {
      redeems[title] = { effect };
      if (!isNaN(count)) redeems[title].count = count;
      if (sound) {
        redeems[title].sound = sound;
        redeems[title].vol   = vol;
      }
    }
  });

  fetch('/api/redeems', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(redeems)
  }).then(r => r.ok ? alert('Redeems saved!') : alert('Save failed'));
};

function getNestedVal(obj, path) {
  return path?.split('.').reduce((o, k) => o?.[k], obj);
}

// ═══════════════════════════════════════════════ Event Log

const MAX_LOG_ENTRIES = 150;
const $log = document.getElementById('event-log');

let activeFilter = 'all';

const TYPE_CLASS = {
  follow:               'follow',
  sub:                  'sub',
  'sub.gifted':         'gifted',
  'sub.combo':          'combo',
  cheer:                'cheer',
  raid:                 'raid',
  redeem:               'redeem',
  'hype-train.start':   'hype',
  'hype-train.progress':'hype',
  'hype-train.end':     'hype',
};

// Which CSS class names each filter pill should reveal
const FILTER_GROUPS = {
  all:    null,  // null = show everything
  sub:    new Set(['sub', 'gifted', 'combo']),
  cheer:  new Set(['cheer']),
  follow: new Set(['follow']),
  raid:   new Set(['raid']),
  redeem: new Set(['redeem']),
};

function rowMatchesFilter(row, filter) {
  if (!filter || filter === 'all') return true;
  const group = FILTER_GROUPS[filter];
  return group ? group.has(row.dataset.type) : true;
}

window.fetchSystemLogs = function() {
  const el = document.getElementById('system-logs');
  if (!el) return;
  fetch('/api/logs').then(r => r.text()).then(txt => {
    el.textContent = txt;
    el.scrollTop = el.scrollHeight;
  }).catch(err => {
    el.textContent = 'Failed to fetch logs: ' + err.message;
  });
};

function appendLog(event) {
  if (!event) return;
  const ts   = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const cls  = TYPE_CLASS[event.type] ?? 'other';
  const body = buildLogBody(event);

  const row = document.createElement('div');
  row.className = 'log-entry';
  row.dataset.type = cls;
  if (!rowMatchesFilter(row, activeFilter)) row.classList.add('hidden');

  row.innerHTML =
    `<span class="log-ts">${ts}</span>` +
    `<span class="log-type ${cls}">${esc(event.type)}</span>` +
    `<span class="log-body">${esc(body)}</span>`;

  $log.prepend(row);

  while ($log.children.length > MAX_LOG_ENTRIES) $log.lastChild?.remove();
}

function buildLogBody(event) {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'follow':        return p.user;
    case 'sub':           return `${p.user} · Tier ${p.tier ?? '1000'}${p.message ? ' · "' + p.message + '"' : ''}`;
    case 'sub.gifted':    return `${p.user} gifted ${p.count ?? 1} to ${p.recipient ?? 'chat'}`;
    case 'cheer':         return `${p.user} · ${p.bits} bits${p.message ? ' · "' + p.message + '"' : ''}`;
    case 'raid':          return `${p.user} · ${p.viewers} viewers`;
    case 'redeem':        return `${p.user} · ${p.rewardTitle}${p.input ? ' · "' + p.input + '"' : ''}`;
    case 'sub.combo':     return `${p.label} ×${p.level} (${p.count} subs)`;
    default:              return JSON.stringify(p).slice(0, 80);
  }
}

window.clearLog = function () { $log.innerHTML = ''; };

// ── Log filter pills ──────────────────────────────────────────────────────────
document.getElementById('log-filters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.log-filter');
  if (!btn) return;

  document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeFilter = btn.dataset.filter ?? 'all';

  document.querySelectorAll('#event-log .log-entry').forEach(row => {
    row.classList.toggle('hidden', !rowMatchesFilter(row, activeFilter));
  });
});

// ═══════════════════════════════════════════════ Effect / Event helpers

window.fireCombo = function (level, label, btn) {
  if (btn) {
    btn.classList.remove('fired');
    void btn.offsetWidth;
    btn.classList.add('fired');
    setTimeout(() => btn.classList.remove('fired'), 350);
  }
  dashSend({ type: '_dashboard.effect', effect: 'combo-display', payload: { level, label, expiresAt: Date.now() + 20000, count: level * 2 } });
};

window.sendCustomAlert = function () {
  const tier    = document.getElementById('custom-tier').value;
  const icon    = document.getElementById('custom-icon').value || '✨';
  const text    = document.getElementById('custom-text').value || 'Alert!';
  const subText = document.getElementById('custom-sub').value;
  dashSend({ type: '_dashboard.effect', effect: 'alert-banner', payload: { tier, icon, text, subText: subText || undefined } });
};

// ── Simulator Helpers ─────────────────────────────────────────────────────────

window.simFireRedeem = function() {
  const sel   = document.getElementById('sim-redeem-select');
  const title = sel.value;
  if (!title) return;
  window.fireEvent('redeem', { user: 'SimulatedUser', rewardTitle: title });
};

window.simFireCheer = function() {
  const user = document.getElementById('sim-cheer-user').value || 'ChatterBox';
  const bits = parseInt(document.getElementById('sim-cheer-bits').value) || 1;
  const msg  = document.getElementById('sim-cheer-msg').value;
  window.fireEvent('cheer', { user, bits, message: msg });
};

window.simFireGift = function() {
  const user  = document.getElementById('sim-gift-user').value || 'GiftBot';
  const count = parseInt(document.getElementById('sim-gift-count').value) || 1;
  window.fireEvent('sub.gifted', { user, count });
};

function populateSimulatorRedeems() {
  const sel = document.getElementById('sim-redeem-select');
  if (!sel) return;
  fetch('/api/redeems').then(r => r.json()).then(redeems => {
    const options = Object.keys(redeems).filter(k => k !== '_comment');
    if (!options.length) {
      sel.innerHTML = '<option value="">-- No Redeems Found --</option>';
      return;
    }
    sel.innerHTML = options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  });
}

// ═══════════════════════════════════════════════ Setup helpers

window.saveObsSettings = function() {
  const address  = document.getElementById('setup-obs-url').value.trim();
  const password = document.getElementById('setup-obs-password').value.trim();

  fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ obs: { address, password } }),
  }).then(r => r.ok ? alert('OBS Settings saved!') : alert('Save failed'));
};

window.saveEngineSettings = function() {
  const crowd = {
    drainPerSec: parseFloat(document.getElementById('set-crowd-drain').value),
    subBoost:    parseInt(document.getElementById('set-crowd-sub').value),
    followBoost: parseInt(document.getElementById('set-crowd-follow').value),
    raidBoost:   parseInt(document.getElementById('set-crowd-raid').value)
  };

  fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ crowd }),
  }).then(r => r.ok ? alert('Engine Settings saved!') : alert('Save failed'));
};

window.resetLayout = function() {
  if (confirm('Reset all widget positions to defaults?')) {
    dashSend({ type: '_dashboard.reset-layout' });
  }
};

window.saveCredentialsAndAuth = function () {
  const clientId     = document.getElementById('setup-client-id').value.trim();
  const clientSecret = document.getElementById('setup-client-secret').value.trim();
  const status       = document.getElementById('twitch-status');

  if (!clientId || !clientSecret) {
    status.textContent = '⚠️ Fill in both Client ID and Client Secret.';
    status.style.color = 'var(--orange)';
    return;
  }

  fetch('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ twitch: { clientId, clientSecret } }),
  }).then(() => {
    const scopes = [
      'channel:read:subscriptions',
      'bits:read',
      'channel:read:redemptions',
      'moderator:read:followers',
      'channel:read:hype_train',
      'user:read:chat',
      'user:write:chat',
    ].join('+');
    const authUrl = `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(`http://localhost:${location.port || 4747}/auth/callback`)}&scope=${scopes}`;
    status.textContent = 'Opening Twitch authorisation window…';
    status.style.color = 'var(--accent2)';
    window.open(authUrl, '_blank');
  }).catch(() => {
    status.textContent = '⚠️ Could not reach the server.';
    status.style.color = 'var(--red)';
  });
};

window.copyOverlayUrl = function () {
  const url = document.getElementById('overlay-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = event.target;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
};

document.getElementById('overlay-url').textContent = `http://localhost:${location.port || 4747}/`;

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════ Boot
connect();
