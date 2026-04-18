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

// Canvas state
const $wrap = document.getElementById('studio-canvas-wrap');
const $nodes = document.getElementById('studio-nodes');
const $svg = document.getElementById('studio-svg');
const $props = document.getElementById('studio-props');
const $fields = document.getElementById('prop-fields');
const $flowSelect = document.getElementById('studio-flow-select');

// Interaction state
let isDragging = false;
let isPanning = false;
let dragNode = null;
let dragPort = null;
let lastMouse = { x: 0, y: 0 };

// ─── Initialization ──────────────────────────────────────────────────────────

window.initStudio = async function() {
  await fetchFlows();
  renderFlowList();
  if (flows.length > 0) loadFlow(flows[0].id);
  
  // Canvas events
  $wrap.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  $wrap.addEventListener('wheel', onWheel, { passive: false });
};

async function fetchFlows() {
  try {
    const res = await fetch('/api/flows');
    flows = await res.json();
  } catch (err) { console.error('Flow fetch failed:', err); }
}

function renderFlowList() {
  $flowSelect.innerHTML = flows.map(f => `<option value="${f.id}" ${activeFlow?.id === f.id ? 'selected' : ''}>${esc(f.name || f.id)}</option>`).join('');
}

window.loadSelectedFlow = function() {
  loadFlow($flowSelect.value);
};

function loadFlow(id) {
  activeFlow = flows.find(f => f.id === id);
  activeNode = null;
  $props.style.display = 'none';
  renderCanvas();
}

// ─── Canvas Rendering ───────────────────────────────────────────────────────

function renderCanvas() {
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
      div.querySelector('.out').remove();
      div.innerHTML += `
        <div class="studio-port out" data-port="true" style="top:30%"><span class="studio-port__label">Yes</span></div>
        <div class="studio-port out" data-port="false" style="top:70%"><span class="studio-port__label">No</span></div>
      `;
    }
    if (node.action === 'filter') {
       div.querySelector('.out').remove();
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
  $nodes.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
  $svg.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
}

function drawEdge(edge) {
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
  $wrap.style.cursor = 'grabbing';
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
  $wrap.style.cursor = 'grab';
  renderCanvas();
}

function onWheel(e) {
  e.preventDefault();
  const d = e.deltaY > 0 ? 0.9 : 1.1;
  zoom = Math.max(0.2, Math.min(2, zoom * d));
  updateTransform();
}

// ─── Node Management ────────────────────────────────────────────────────────

window.addNode = function(type, action) {
  if (!activeFlow) return;
  const id = 'n' + Date.now();
  const node = { id, type, action, x: -offset.x / zoom + 100, y: -offset.y / zoom + 100, data: {} };
  
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

function renderProps() {
  $props.style.display = 'flex';
  const n = activeNode;
  
  let html = `<div><label>Node ID</label><input class="input-field" value="${n.id}" disabled></div>`;
  html += `<div><label>Label</label><input class="input-field" value="${esc(n.label || '')}" oninput="activeNode.label=this.value;renderCanvas()"></div>`;

  if (n.type === 'trigger') {
    html += `<div><label>Event Type</label><input class="input-field" value="${esc(activeFlow.trigger)}" oninput="activeFlow.trigger=this.value"></div>`;
  }

  if (n.action === 'delay') {
    html += `<div><label>Wait (ms)</label><input type="number" class="input-field" value="${n.data.ms || 1000}" oninput="activeNode.data.ms=parseInt(this.value)"></div>`;
  }

  if (n.action === 'chance') {
    html += `<div><label>Probability (%)</label><input type="range" min="0" max="100" value="${n.data.probability || 50}" oninput="activeNode.data.probability=parseInt(this.value)"></div>`;
  }

  if (n.action === 'spawnEffect') {
    html += `<div><label>Effect</label><input class="input-field" value="${esc(n.data.effect || '')}" oninput="activeNode.data.effect=this.value;renderCanvas()"></div>`;
  }

  if (n.action === 'filter') {
    html += `<div><label>Field (e.g. payload.bits)</label><input class="input-field" value="${esc(n.data.field || '')}" oninput="activeNode.data.field=this.value"></div>`;
    html += `<div><label>Value</label><input class="input-field" value="${esc(n.data.value || '')}" oninput="activeNode.data.value=this.value"></div>`;
  }

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
