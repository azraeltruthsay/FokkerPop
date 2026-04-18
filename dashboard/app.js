'use strict';

// ═══════════════════════════════════════════════ WebSocket

let ws        = null;
let retries   = 0;
let appState  = { session: {}, crowd: { energy: 0 }, goals: [], leaderboard: {} };

const WS_URL  = `ws://${location.hostname}:${location.port || 4747}`;
const $badge  = document.getElementById('ws-badge');
const $dot    = document.getElementById('live-dot');

function connect() {
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

function dashSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

window.dashSend = dashSend;

// ═══════════════════════════════════════════════ Message handling

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
      break;
  }
}

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
}

function refreshAll() {
  renderSession(appState.session);
  renderCrowd(appState.crowd?.energy ?? 0);
  renderGoals(appState.goals ?? []);
  renderLeaderboard(appState.leaderboard ?? {});
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
  if (!goals?.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:.82rem;">No goals configured. Edit goals.json to add some.</p>'; return; }

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
          ${g.completed
            ? `<button class="btn btn-ghost btn-sm" onclick="dashSend({type:'_dashboard.goal-reset',id:'${g.id}'})">Reset</button>`
            : ''}
        </div>
      </div>`;
  }).join('');
}

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
    const authUrl = `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://localhost:4747/auth/callback')}&scope=${scopes}`;
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
    document.getElementById(`page-${btn.dataset.page}`)?.classList.add('active');
  });
});

// ═══════════════════════════════════════════════ Utilities

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════ Boot
connect();
