'use strict';

/**
 * Fokker Studio (Beta)
 * A lightweight, dependency-free node-based flow editor.
 */

let flows = [];
let activeFlow = null;
let activeNode = null;
let zoom = 1;
let offset = { x: 0, y: 0 };

// Interaction state
let isDragging = false;
let isPanning = false;
let dragNode = null;
let dragPort = null;
let lastMouse = { x: 0, y: 0 };

// Canvas state
let $wrap, $nodes, $svg, $props, $fields, $flowSelect, $ctxMenu;
let studioInitialized = false;

// ─── Initialization ──────────────────────────────────────────────────────────

window.initStudio = async function() {
  $wrap = document.getElementById('studio-canvas-wrap');
  $nodes = document.getElementById('studio-nodes');
  $svg = document.getElementById('studio-svg');
  $props = document.getElementById('studio-props');
  $fields = document.getElementById('prop-fields');
  $flowSelect = document.getElementById('studio-flow-select');
  $ctxMenu = document.getElementById('studio-ctx-menu');

  if (!$wrap || studioInitialized) return;

  await fetchFlows();
  
  if (flows.length === 0) {
    flows.push({ id: 'flow-default', name: 'Default Flow', active: true, trigger: 'sub', nodes: { 't1': { id: 't1', type: 'trigger', x: 100, y: 100 } }, edges: [] });
  }

  renderFlowList();
  loadFlow(flows[0].id);
  
  // Canvas events
  $wrap.addEventListener('mousedown', onMouseDown);
  $wrap.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);
  $wrap.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mousedown', (e) => { if ($ctxMenu && !e.target.closest('#studio-ctx-menu')) hideContextMenu(); });

  studioInitialized = true;
};

async function fetchFlows() {
  try {
    const res = await fetch('/api/flows');
    flows = await res.json();
  } catch (err) { console.error('Flow fetch failed:', err); }
}

function renderFlowList() {
  if (!$flowSelect) return;
  $flowSelect.innerHTML = flows.map(f => `<option value="${f.id}" ${activeFlow?.id === f.id ? 'selected' : ''}>${esc(f.name || f.id)}</option>`).join('');
}

window.loadSelectedFlow = function() {
  loadFlow($flowSelect?.value);
};

function loadFlow(id) {
  activeFlow = flows.find(f => f.id === id);
  activeNode = null;
  if ($props) $props.style.display = 'none';
  renderCanvas();
}

// ─── Canvas Rendering ───────────────────────────────────────────────────────

function renderCanvas() {
  if (!$nodes || !$svg) return;

  $nodes.innerHTML = '';
  $svg.innerHTML = '';
  if (!activeFlow) return;

  // Render Nodes
  Object.values(activeFlow.nodes || {}).forEach(node => {
    const div = document.createElement('div');
    div.className = `studio-node ${activeNode?.id === node.id ? 'active' : ''}`;
    div.id = `node-${node.id}`;
    div.style.left = `${node.x}px`;
    div.style.top = `${node.y}px`;
    
    div.innerHTML = `
      <div class="studio-node__label">${node.type}</div>
      <div class="studio-node__content">${esc(node.label || node.action || '...') }</div>
      ${node.type !== 'trigger' ? '<div class="studio-port in" data-port="in"></div>' : ''}
      <div class="studio-port out" data-port="next"></div>
    `;

    // Multi-port handling for Chance logic
    if (node.action === 'chance') {
      const outPort = div.querySelector('.out');
      if (outPort) outPort.remove();
      div.innerHTML += `
        <div class="studio-port out" data-port="true" style="top:30%"><span class="studio-port__label">Yes</span></div>
        <div class="studio-port out" data-port="false" style="top:70%"><span class="studio-port__label">No</span></div>
      `;
    }
    if (node.action === 'filter') {
       const outPort = div.querySelector('.out');
       if (outPort) outPort.remove();
       div.innerHTML += `<div class="studio-port out" data-port="true"><span class="studio-port__label">True</span></div>`;
    }

    div.onmousedown = (e) => { e.stopPropagation(); selectNode(node); dragNode = node; };
    $nodes.appendChild(div);
  });

  // Render Edges
  (activeFlow.edges || []).forEach(edge => {
    drawEdge(edge);
  });

  updateTransform();
}

function updateTransform() {
  if ($nodes && $svg) {
    $nodes.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
    $svg.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
  }
}

function drawEdge(edge) {
  if (!$svg) return;
  
  const src = activeFlow.nodes[edge.src];
  const dst = activeFlow.nodes[edge.dst];
  if (!src || !dst) return;

  // Calculate port positions (relative to offset/zoom)
  const srcEl = document.getElementById(`node-${src.id}`);
  const dstEl = document.getElementById(`node-${dst.id}`);
  if (!srcEl || !dstEl) return;

  const outPort = srcEl.querySelector(`.out[data-port="${edge.outPort}"]`);
  const inPort  = dstEl.querySelector(`.in`);
  if (!outPort || !inPort) return;

  const x1 = src.x + outPort.offsetLeft + 6;
  const y1 = src.y + outPort.offsetTop + 6;
  const x2 = dst.x + inPort.offsetLeft + 6;
  const y2 = dst.y + inPort.offsetTop + 6;

  const dx = Math.abs(x1 - x2) * 0.5;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
  $svg.appendChild(path);
}

// ─── Interaction ───────────────────────────────────────────────────────────

function onMouseDown(e) {
  lastMouse = { x: e.clientX, y: e.clientY };
  
  const port = e.target.closest('.studio-port.out');
  if (port) {
    dragPort = { node: activeNode, id: port.dataset.port, x1: e.clientX, y1: e.clientY };
    return;
  }

  isPanning = true;
  if ($wrap) $wrap.style.cursor = 'grabbing';
}

function onMouseMove(e) {
  const dx = e.clientX - lastMouse.x;
  const dy = e.clientY - lastMouse.y;
  lastMouse = { x: e.clientX, y: e.clientY };

  if (isPanning) {
    offset.x += dx;
    offset.y += dy;
    updateTransform();
  } else if (dragNode) {
    dragNode.x += dx / zoom;
    dragNode.y += dy / zoom;
    renderCanvas();
  }
}

function onMouseUp(e) {
  if (dragPort) {
    const inPort = e.target.closest('.studio-port.in');
    if (inPort) {
      const dstNodeId = inPort.parentElement.id.replace('node-', '');
      activeFlow.edges = activeFlow.edges || [];
      activeFlow.edges.push({ src: dragPort.node.id, outPort: dragPort.id, dst: dstNodeId });
    }
  }

  isPanning = false;
  dragNode = null;
  dragPort = null;
  if ($wrap) $wrap.style.cursor = 'grab';
  renderCanvas();
}

function onWheel(e) {
  e.preventDefault();
  const d = e.deltaY > 0 ? 0.9 : 1.1;
  zoom = Math.max(0.2, Math.min(2, zoom * d));
  updateTransform();
}

function onKeyDown(e) {
  if (!activeNode) return;
  // Delete or Backspace removes the selected node (guard: not while typing in an input)
  if ((e.key === 'Delete' || e.key === 'Backspace') && e.target === document.body) {
    window.deleteActiveNode();
  }
}

function onContextMenu(e) {
  e.preventDefault();
  const rect = $wrap.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const nodeEl = e.target.closest('.studio-node');
  let html = '';

  if (nodeEl) {
    const nodeId = nodeEl.id.replace('node-', '');
    const node   = activeFlow?.nodes?.[nodeId];
    if (node) {
      selectNode(node);
      html = `
        <div class="ctx-header">${esc(node.label || node.action || node.type)}</div>
        <div class="ctx-item" onclick="cloneNode('${nodeId}')">👯 Clone Node</div>
        <div class="ctx-item" onclick="disconnectNode('${nodeId}')">🔌 Disconnect All</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" onclick="deleteActiveNode()" style="color:var(--red)">🗑️ Delete Node (Del)</div>
      `;
    }
  } else {
    html = `
      <div class="ctx-header">Add Component</div>
      <div class="ctx-item" onclick="addNode('action', 'spawnEffect', ${x}, ${y})">🎇 Effect</div>
      <div class="ctx-item" onclick="addNode('action', 'showBanner', ${x}, ${y})">📢 Banner</div>
      <div class="ctx-item" onclick="addNode('action', 'playSound', ${x}, ${y})">🔊 Sound</div>
      <div class="ctx-item" onclick="addNode('action', 'startTimer', ${x}, ${y})">⏲️ Timer</div>
      <div class="ctx-divider"></div>
      <div class="ctx-header">Flow</div>
      <div class="ctx-item" onclick="createNewFlow()">🎨 New Flow</div>
      <div class="ctx-item" onclick="duplicateActiveFlow()">👯 Duplicate Current Flow</div>
      <div class="ctx-item" onclick="deleteActiveFlow()" style="color:var(--red)">🗑️ Delete Current Flow</div>
    `;
  }

  showContextMenu(e.clientX, e.clientY, html);
}

function showContextMenu(x, y, html) {
  if (!$ctxMenu) return;
  $ctxMenu.innerHTML = html;
  $ctxMenu.style.display = 'block';
  $ctxMenu.style.left = `${x}px`;
  $ctxMenu.style.top = `${y}px`;

  // Adjust if off-screen
  const mRect = $ctxMenu.getBoundingClientRect();
  if (x + mRect.width > window.innerWidth) $ctxMenu.style.left = `${x - mRect.width}px`;
  if (y + mRect.height > window.innerHeight) $ctxMenu.style.top = `${y - mRect.height}px`;
}

function hideContextMenu() {
  if ($ctxMenu) $ctxMenu.style.display = 'none';
}

window.cloneNode = function(id) {
  const node = activeFlow?.nodes?.[id];
  if (!node) return;
  const newNode = JSON.parse(JSON.stringify(node));
  newNode.id = 'n' + Date.now();
  newNode.x += 30;
  newNode.y += 30;
  activeFlow.nodes[newNode.id] = newNode;
  hideContextMenu();
  selectNode(newNode);
};

window.disconnectNode = function(id) {
  if (!activeFlow) return;
  activeFlow.edges = (activeFlow.edges || []).filter(e => e.src !== id && e.dst !== id);
  hideContextMenu();
  renderCanvas();
};

window.deleteActiveFlow = function() {
  if (!activeFlow) return;
  if (!confirm(`Delete flow "${activeFlow.name || activeFlow.id}"?`)) return;
  flows = flows.filter(f => f.id !== activeFlow.id);
  activeFlow = flows[0] || null;
  hideContextMenu();
  renderFlowList();
  if (activeFlow) loadFlow(activeFlow.id);
  else renderCanvas();
};

window.duplicateActiveFlow = function() {
  if (!activeFlow) return;
  const newFlow = JSON.parse(JSON.stringify(activeFlow));
  newFlow.id = 'flow-' + Date.now();
  newFlow.name = (newFlow.name || 'Untitled') + ' (Copy)';
  flows.push(newFlow);
  hideContextMenu();
  renderFlowList();
  loadFlow(newFlow.id);
};

// ─── Node Management ────────────────────────────────────────────────────────

window.addNode = function(type, action, startX, startY) {
  if (!activeFlow) return;
  const id = 'n' + Date.now();
  
  // Default to center if no coords provided
  const x = startX !== undefined ? (startX - offset.x) / zoom : -offset.x / zoom + 100;
  const y = startY !== undefined ? (startY - offset.y) / zoom : -offset.y / zoom + 100;

  const node = { id, type, action, x, y, data: {} };
  
  activeFlow.nodes = activeFlow.nodes || {};
  activeFlow.nodes[id] = node;
  selectNode(node);
  renderCanvas();
};

function selectNode(node) {
  activeNode = node;
  renderCanvas();
  renderProps();
}

const EXPR_HINT = `<div style="font-size:0.6rem;color:var(--text-dim);margin-top:2px;">Supports <code style="background:rgba(145,71,255,0.15);padding:1px 4px;border-radius:3px;">{{ expressions }}</code></div>`;

const EXPR_REF = `
  <details style="margin-top:8px;">
    <summary style="font-size:0.62rem;color:var(--text-dim);cursor:pointer;letter-spacing:0.05em;text-transform:uppercase;">Variables reference</summary>
    <div style="font-size:0.65rem;color:var(--text-dim);line-height:2;margin-top:6px;font-family:monospace;">
      <div><span style="color:var(--accent2)">payload.user</span> · .bits · .count · .viewers</div>
      <div><span style="color:var(--accent2)">chatters</span> — recent chatter list</div>
      <div><span style="color:var(--accent2)">pick(chatters)</span> — random chatter</div>
      <div><span style="color:var(--accent2)">session</span>.subCount · .bitsTotal</div>
      <div><span style="color:var(--accent2)">crowd</span>.energy</div>
      <div><span style="color:var(--accent2)">leaderboard</span>.bits · .gifts</div>
      <div><span style="color:var(--accent2)">plural(n, 'sub')</span> → "3 subs"</div>
      <div><span style="color:var(--accent2)">clamp(v, min, max)</span></div>
      <div>Full JS — ternary, Math, etc.</div>
    </div>
  </details>`;

function exprField(label, dataKey, value, extra = '') {
  return `<div class="prop-field">
    <label>${label}</label>
    <input class="input-field" value="${esc(value)}" placeholder="{{ expression }}"
      oninput="activeNode.data.${dataKey}=this.value${extra}" style="font-family:monospace;font-size:0.78rem;">
    ${EXPR_HINT}
  </div>`;
}

function selectField(label, dataKey, options, current) {
  return `<div class="prop-field">
    <label>${label}</label>
    <select class="input-field" oninput="activeNode.data.${dataKey}=this.value">
      ${options.map(o => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select>
  </div>`;
}

function renderProps() {
  const $props = document.getElementById('studio-props');
  const $fields = document.getElementById('prop-fields');
  if (!$props || !$fields) return;

  $props.style.display = 'flex';
  const n = activeNode;

  let html = `<div class="prop-field"><label>Node ID</label><input class="input-field" value="${n.id}" disabled></div>`;
  html += `<div class="prop-field"><label>Label</label><input class="input-field" value="${esc(n.label || '')}" oninput="activeNode.label=this.value;renderCanvas()"></div>`;

  if (n.type === 'trigger') {
    const triggerOptions = ['sub', 'follow', 'cheer', 'raid', 'redeem', 'hype-train.start', 'hype-train.progress', 'hype-train.end'];
    html += selectField('Event Type', 'trigger', triggerOptions, activeFlow.trigger);
  }

  if (n.action === 'delay') {
    html += exprField('Wait (ms)', 'ms', n.data.ms ?? 1000);
    html += `<div style="font-size:0.6rem; color:var(--text-dim); margin-top:-8px; margin-bottom:8px;">(1000 = 1 second)</div>`;
  }

  if (n.action === 'chance') {
    html += exprField('Probability (%)', 'probability', n.data.probability ?? 50);
    html += `<div style="font-size:0.6rem; color:var(--text-dim); margin-top:-8px; margin-bottom:8px;">(50 = Half the time it happens)</div>`;
  }

  if (n.action === 'spawnEffect') {
    const effectOptions = ['balloon', 'firework', 'firework-salvo', 'confetti', 'sticker-rain', 'crowd-explosion', 'alert-banner'];
    html += selectField('Effect Type', 'effect', effectOptions, n.data.effect);
    html += exprField('Payload (JSON)', 'payload', JSON.stringify(n.data.payload || {}));
  }

  if (n.action === 'showBanner') {
    html += exprField('Main Text', 'text', n.data.text || '');
    html += exprField('Sub Text', 'subText', n.data.subText || '');
    html += selectField('Tier', 'tier', ['S', 'A', 'B', 'C'], n.data.tier || 'B');
    html += exprField('Icon', 'icon', n.data.icon || '📢');
  }

  if (n.action === 'setEnergy') {
    html += exprField('Value (0–100) or {{ expr }}', 'amount', n.data.amount ?? 100);
  }

  if (n.action === 'updateStat') {
    html += exprField('Path (e.g. session.subCount)', 'path', n.data.path || '');
    html += exprField('Increment By', 'by', n.data.by ?? 1);
  }

  if (n.action === 'playSound') {
    // assets is global from app.js
    const soundOptions = window.assets?.sounds || [];
    html += selectField('Sound File', 'file', ['', ...soundOptions], n.data.file || '');
    html += exprField('Volume (0–1)', 'volume', n.data.volume ?? 1);
  }

  if (n.action === 'startTimer') {
    html += exprField('Label', 'label', n.data.label || 'COUNTDOWN');
    html += exprField('Seconds', 'seconds', n.data.seconds ?? 60);
  }

  if (n.action === 'obsScene') {
    html += exprField('Scene Name', 'scene', n.data.scene || '');
  }

  if (n.action === 'filter') {
    html += exprField('Value to check', 'field', n.data.field || '');
    html += selectField('Comparison', 'operator', ['==', '!=', '>', '<', '>=', '<='], n.data.operator || '==');
    html += exprField('Target Value', 'value', n.data.value || '');
  }

  html += EXPR_REF;
  $fields.innerHTML = html;
}

window.deleteActiveNode = function() {
  if (!activeNode || !activeFlow) return;
  delete activeFlow.nodes[activeNode.id];
  activeFlow.edges = (activeFlow.edges || []).filter(e => e.src !== activeNode.id && e.dst !== activeNode.id);
  activeNode = null;
  $props.style.display = 'none';
  renderCanvas();
};

// ─── Flow Management ────────────────────────────────────────────────────────

window.createNewFlow = function() {
  const name = prompt('Flow Name:', 'New Flow');
  if (!name) return;
  const id = 'flow-' + Date.now();
  const flow = { id, name, active: true, trigger: 'sub', nodes: {}, edges: [] };
  flows.push(flow);
  renderFlowList();
  loadFlow(id);
};

window.saveStudioFlows = async function() {
  try {
    const res = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flows)
    });
    if (res.ok) alert('All flows saved and live!');
  } catch (err) { alert('Save failed'); }
};

// ─── Utilities ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
