'use strict';

// ═══════════════════════════════════════════════ WebSocket

let ws        = null;
let retries   = 0;
let appState  = { session: {}, crowd: { energy: 0 }, goals: [], leaderboard: {} };
let assets    = { sounds: [], stickers: [] };

const WS_URL  = `ws://${location.hostname}:${location.port || 4747}`;
const $badge  = document.getElementById('ws-badge');
const $tBadge = document.getElementById('twitch-badge');
const $dot    = document.getElementById('live-dot');

function connect() {
  fetch('/api/assets').then(r => r.json()).then(a => assets = a).catch(() => {});
  
  // Initial setup check
  try {
    fetch('/api/settings').then(r => r.json()).then(s => {
      if (s.twitch) {
        const $id = document.getElementById('setup-client-id');
        const $sec = document.getElementById('setup-client-secret');
        if ($id) $id.value = s.twitch.clientId || '';
        if ($sec) $sec.value = s.twitch.clientSecret || '';
        
        // Auto-switch to setup if credentials missing
        if (!s.twitch.clientId || !s.twitch.clientSecret) {
          document.querySelector('.nav-item[data-page="setup"]')?.click();
        }
      }
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
    setTimeout(connect, Math.min(2000 * retries, 15000));
  });
  ws.addEventListener('error', () => {
    setBadge('disconnected', '○ Server offline');
    $dot?.classList.remove('active');
  });
}

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

function dashSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
window.dashSend = dashSend;

function applyStateUpdate(path, value) {
  const parts = path.split('.');
  let node = appState;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] ??= {};
    node = node[parts[i]];
  }
  node[parts.at(-1)] = value;

  if (path === 'crowd.energy')   renderCrowd(value);
  if (path === 'goals')          renderGoals(value);
  if (path === 'leaderboard')    renderLeaderboard(value);
  if (path === 'session')        renderSession(value);
  if (path === 'twitch.status')  setTwitchBadge(value);
  if (path === 'overlay.volume') {
    const s = document.getElementById('volume-slider');
    const l = document.getElementById('volume-label');
    if (s) s.value = value;
    if (l) l.textContent = `${Math.round(value * 100)}%`;
  }
}

function setVersion(v) {
  if (!v) return;
  document.querySelectorAll('.v-badge, .v-string').forEach(el => { el.textContent = `v${v}`; });
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

function renderGoals(goals) {
  const el = document.getElementById('goals-list');
  if (!el) return;
  if (!goals?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:.82rem;">No goals configured. Edit the Config tab to add some.</p>'; return; }

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

function renderConfigEditors() {
  const gContainer = document.getElementById('config-goals-container');
  if (gContainer) {
    gContainer.innerHTML = appState.goals.map((g, i) => `
      <div class="card" style="margin-bottom:10px;padding:12px;background:var(--surface2);">
        <div class="input-row">
          <input class="input-field g-id" placeholder="ID" value="${esc(g.id)}" style="max-width:120px;">
          <input class="input-field g-label" placeholder="Label" value="${esc(g.label)}">
          <input class="input-field g-target" type="number" placeholder="Target" value="${g.target}" style="max-width:100px;">
          <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red);">Delete</button>
        </div>
        <div class="input-row" style="margin-top:8px;">
          <input class="input-field g-metric" placeholder="Metric (e.g. session.subCount)" value="${esc(g.metric)}">
          ${buildEffectSelect('g-effect', g.reward?.effect)}
        </div>
      </div>
    `).join('');
  }

  const rContainer = document.getElementById('config-redeems-container');
  if (rContainer) {
    fetch('/api/redeems').then(r => r.json()).then(redeems => {
      rContainer.innerHTML = Object.entries(redeems).filter(([k]) => k !== '_comment').map(([title, def]) => `
        <div class="card" style="margin-bottom:10px;padding:12px;background:var(--surface2);">
          <div class="input-row">
            <input class="input-field r-title" placeholder="Reward Title" value="${esc(title)}">
            ${buildEffectSelect('r-effect', def.effect)}
          </div>
          <div class="input-row" style="margin-top:8px;">
            <input class="input-field r-count" type="number" placeholder="Count" value="${def.count ?? ''}" style="max-width:80px;">
            ${buildSoundSelect('r-sound', def.sound)}
            <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red);">Delete</button>
          </div>
        </div>
      `).join('');
    });
  }
}

function buildEffectSelect(cls, current) {
  const effects = ['balloon', 'firework', 'firework-salvo', 'confetti', 'sticker-rain', 'crowd-explosion', 'alert-banner'];
  return `
    <select class="input-field ${cls}" style="flex:1;">
      <option value="">-- Select Effect --</option>
      ${effects.map(e => `<option value="${e}" ${e === current ? 'selected' : ''}>Effect: ${e}</option>`).join('')}
    </select>`;
}

function buildSoundSelect(cls, current) {
  const sounds = assets.sounds ?? [];
  return `
    <select class="input-field ${cls}" style="flex:1;">
      <option value="">-- No Sound --</option>
      ${sounds.map(s => `<option value="${s}" ${s === current ? 'selected' : ''}>Sound: ${s}</option>`).join('')}
    </select>`;
}

window.addGoalConfig = function() {
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
    <div class="input-row" style="margin-top:8px;">
      <input class="input-field g-metric" placeholder="Metric" value="session.subCount">
      ${buildEffectSelect('g-effect', 'firework-salvo')}
    </div>`;
  container.appendChild(div);
};

window.saveGoalsConfig = function() {
  const goals = Array.from(document.querySelectorAll('#config-goals-container .card')).map(card => ({
    id:        card.querySelector('.g-id').value,
    label:     card.querySelector('.g-label').value,
    target:    parseInt(card.querySelector('.g-target').value),
    metric:    card.querySelector('.g-metric').value,
    reward:    { type: 'effect', effect: card.querySelector('.g-effect').value },
    active:    true,
    completed: false
  }));

  fetch('/api/goals', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(goals)
  }).then(r => r.ok ? alert('Goals saved!') : alert('Save failed'));
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
    <div class="input-row" style="margin-top:8px;">
      <input class="input-field r-count" type="number" placeholder="Count" value="10" style="max-width:80px;">
      ${buildSoundSelect('r-sound', '')}
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.card').remove()" style="color:var(--red);">Delete</button>
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
    if (title) {
      redeems[title] = { effect };
      if (!isNaN(count)) redeems[title].count = count;
      if (sound)         redeems[title].sound = sound;
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

function triggerRipple(btn) {
  if (!btn) return;
  btn.classList.remove('fired');
  void btn.offsetWidth;
  btn.classList.add('fired');
  setTimeout(() => btn.classList.remove('fired'), 350);
}

window.fireEffect = function (effect, payload, btn) {
  triggerRipple(btn);
  dashSend({ type: '_dashboard.effect', effect, payload });
};

window.fireEvent = function (type, payload, btn) {
  triggerRipple(btn);
  dashSend({ type: '_dashboard.test-event', event: { type, source: 'dashboard', payload } });
};

window.fireCombo = function (level, label, btn) {
  triggerRipple(btn);
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

// ═══════════════════════════════════════════════ Navigation

document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    document.getElementById(`page-${page}`)?.classList.add('active');
    if (page === 'effects') populateSimulatorRedeems();
  });
});

// ═══════════════════════════════════════════════ Utilities

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════ Boot
connect();
