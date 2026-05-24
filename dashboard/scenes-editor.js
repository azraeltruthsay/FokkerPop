import { resolveEasing, EASING_NAMES } from '/shared/easing.js';
import { audioBus }                    from '/shared/audio-bus.js';

const AUDIO_POLICIES = ['mix', 'duck-below', 'solo', 'cancel-below'];

// Studio Scenes editor — Phase 1 (v0.4.0).
//
// Mounts a Three.js viewport in the dashboard's 🎬 Scenes tab so the user
// can author scene compositions: drag assets in, manipulate them with the
// transform gizmo, scrub a timeline, and save back to the server. The save
// round-trip goes through POST /api/scenes (whole-array replace, matching
// the flows/widgets pattern).
//
// Lazy-initialized on first tab click — Three.js + GLTFLoader + controls
// are ~600KB and we don't want every dashboard page-load to pay that.
//
// Phase 1 scope: position/rotation/scale + opacity keyframes, linear
// interpolation, drag-to-place from asset library, click-to-select +
// transform gizmo, auto-keyframe on gizmo drag-end, timeline scrubbing,
// local viewport playback. Easing curves, audio bus, material/light
// channels, morph/path/shake, branch/fork clips — all later phases.

let THREE = null;
let OrbitControls = null;
let TransformControls = null;
let GLTFLoader = null;

const ed = {
  initialized: false,
  scenes: [],
  activeId: null,
  selectedObjectId: null,
  currentTime: 0,            // ms (scrubber position)
  autoKey: true,
  isPlaying: false,
  playStartTime: 0,
  saveDebounce: null,
  three: null,                // { scene, camera, renderer, orbit, transform }
  objectsByGuid: new Map(),   // sceneObjectId -> THREE.Object3D
  assets: { models: [], images: [], sounds: [], stickers: [] },
  audioPreview: { timeouts: [], handles: [] }, // editor ▶ Test mix preview
};
window.scenesEditor = ed;     // for debugging via DevTools

// ── Tab activation hook ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const navBtn = document.querySelector('[data-page="scenes"]');
  if (!navBtn) return;
  navBtn.addEventListener('click', () => {
    // Defer one frame so the page-scenes div is laid out (clientWidth>0)
    // before Three.js queries dimensions for the viewport.
    requestAnimationFrame(() => init().catch(err => console.error('scenes-editor init failed:', err)));
  });
});

async function init() {
  if (ed.initialized) return;
  ed.initialized = true;

  THREE              = await import('/vendor/three.module.min.js');
  OrbitControls      = (await import('/vendor/three/controls/OrbitControls.js')).OrbitControls;
  TransformControls  = (await import('/vendor/three/controls/TransformControls.js')).TransformControls;
  GLTFLoader         = (await import('/vendor/three/loaders/GLTFLoader.js')).GLTFLoader;

  setupViewport();
  bindToolbar();
  bindTimelineEvents();

  await refreshAssets();
  await refreshScenes();

  if (ed.scenes.length === 0) {
    newScene();
  } else {
    setActiveScene(ed.scenes[0].id);
  }
}

// ── Three.js viewport ────────────────────────────────────────────────
function setupViewport() {
  const container = document.getElementById('scenes-viewport');
  const w = container.clientWidth  || 600;
  const h = container.clientHeight || 400;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a14);

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
  camera.position.set(3, 2.5, 5);

  // Ground grid + axes so the user has a spatial reference frame.
  const grid = new THREE.GridHelper(10, 10, 0x444466, 0x222233);
  scene.add(grid);
  scene.add(new THREE.AxesHelper(0.5));

  // Same default lighting as the runtime scene-player.
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(3, 4, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%;';
  container.appendChild(renderer.domElement);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 0, 0);
  orbit.update();

  const transform = new TransformControls(camera, renderer.domElement);
  // TransformControls' API changed across three.js versions — newer builds
  // require getHelper() to retrieve the visual gizmo; older ones return
  // the gizmo directly. Try both so we work either way.
  const transformHelper = typeof transform.getHelper === 'function' ? transform.getHelper() : transform;
  scene.add(transformHelper);
  // While the gizmo is being dragged, suspend orbit so camera drag doesn't
  // fight the transform. On drag-end (auto-key on), commit a keyframe.
  transform.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (!e.value && ed.autoKey && ed.selectedObjectId) {
      writeKeyframeForSelected();
      queueSave();
    }
  });

  const raycaster = new THREE.Raycaster();
  ed.three = { scene, camera, renderer, orbit, transform, raycaster };

  renderer.domElement.addEventListener('click', onViewportClick);
  renderer.domElement.addEventListener('dragover', (e) => { e.preventDefault(); });
  renderer.domElement.addEventListener('drop', onViewportDrop);

  // Keep the renderer sized to its container as the user resizes the window
  // or switches sidebar widths. ResizeObserver covers both cases without
  // having to chase every layout-affecting event.
  new ResizeObserver(resizeViewport).observe(container);

  function animate() {
    requestAnimationFrame(animate);
    if (ed.isPlaying) {
      const elapsed = performance.now() - ed.playStartTime;
      const dur = activeScene()?.durationMs || 10000;
      if (elapsed >= dur) {
        ed.isPlaying = false;
        ed.currentTime = dur;
        // Tear down any in-flight preview audio so a looped track doesn't
        // keep playing after the visible timeline finishes.
        stopEditorPreviewAudio();
      } else {
        ed.currentTime = elapsed;
      }
      applyTracksAtTime(ed.currentTime);
      renderTimelineHead();
      renderTimeDisplay();
    }
    orbit.update();
    renderer.render(scene, camera);
  }
  animate();
}

function resizeViewport() {
  if (!ed.three) return;
  const container = document.getElementById('scenes-viewport');
  if (!container) return;
  const w = container.clientWidth, h = container.clientHeight;
  if (w === 0 || h === 0) return;
  ed.three.renderer.setSize(w, h);
  ed.three.camera.aspect = w / h;
  ed.three.camera.updateProjectionMatrix();
  updateAspectGuide();
}

// Sizes the aspect-ratio guide div to fit the configured ratio inside the
// viewport's available space, centered. The guide is purely visual — it
// has no effect on the runtime, which always renders at the overlay
// window's actual size.
function updateAspectGuide() {
  const guide = document.getElementById('scenes-aspect-guide');
  if (!guide) return;
  const s = activeScene();
  const ratio = s?.aspectRatio;
  if (!ratio) { guide.style.display = 'none'; return; }
  const container = document.getElementById('scenes-viewport');
  const parent    = container?.parentElement;
  if (!parent) return;
  const cw = parent.clientWidth, ch = parent.clientHeight;
  if (cw === 0 || ch === 0) return;
  const containerRatio = cw / ch;
  let w, h;
  if (containerRatio > ratio) { h = ch; w = ch * ratio; }
  else                         { w = cw; h = cw / ratio; }
  guide.style.display = 'block';
  guide.style.width   = w + 'px';
  guide.style.height  = h + 'px';
  guide.style.left    = ((cw - w) / 2) + 'px';
  guide.style.top     = ((ch - h) / 2) + 'px';
}

// ── Toolbar ──────────────────────────────────────────────────────────
function bindToolbar() {
  document.querySelectorAll('[data-gizmo]').forEach(btn => {
    btn.addEventListener('click', () => {
      ed.three.transform.setMode(btn.dataset.gizmo);
      paintGizmoButtons();
    });
  });
  paintGizmoButtons();

  document.getElementById('scenes-auto-key').addEventListener('change', (e) => {
    ed.autoKey = e.target.checked;
  });
  document.getElementById('scenes-test-btn').addEventListener('click', () => {
    startEditorPreview();
  });
  document.getElementById('scenes-audio-add').addEventListener('click', addAudioEntry);
  document.getElementById('scenes-new-btn').addEventListener('click', newScene);
  document.getElementById('scenes-duration-input').addEventListener('change', (e) => {
    const s = activeScene();
    if (!s) return;
    s.durationMs = Math.max(100, parseInt(e.target.value, 10) || 10000);
    queueSave();
    renderTimeline();
    renderTimeDisplay();
  });
  document.getElementById('scenes-mount-mode').addEventListener('change', (e) => {
    const s = activeScene();
    if (!s) return;
    s.mountMode = e.target.value;
    queueSave();
  });
  document.getElementById('scenes-aspect-select').addEventListener('change', (e) => {
    const s = activeScene();
    if (!s) return;
    // Empty string = "Off" (no guide). Stored as null so saved JSON stays
    // explicit and the validator's "missing = no guide" path triggers.
    s.aspectRatio = e.target.value ? parseFloat(e.target.value) : null;
    updateAspectGuide();
    queueSave();
  });
}

function paintGizmoButtons() {
  const mode = ed.three.transform.mode;
  document.querySelectorAll('[data-gizmo]').forEach(btn => {
    btn.style.background = btn.dataset.gizmo === mode ? 'var(--accent)' : '';
    btn.style.color      = btn.dataset.gizmo === mode ? '#fff' : '';
  });
}

// ── Asset library ────────────────────────────────────────────────────
async function refreshAssets() {
  try {
    const res = await fetch('/api/assets');
    ed.assets = await res.json();
  } catch (err) {
    console.warn('Failed to load assets:', err);
  }
  renderAssetList();
  renderAudioList();
}

function renderAssetList() {
  const root = document.getElementById('scenes-asset-list');
  const sections = [
    ['models', '3D Models', 'model'],
    ['images', 'Images',    'image-plane'],
  ];
  root.innerHTML = sections.map(([key, label, sceneType]) => {
    const items = ed.assets[key] || [];
    if (items.length === 0) {
      return `<div style="margin-bottom:12px;">
        <div style="font-size:.65rem; color:var(--text-dim); text-transform:uppercase; margin-bottom:4px;">${label}</div>
        <div style="font-size:.65rem; color:var(--text-dim); opacity:.6; padding:6px 0;">(upload from Assets tab)</div>
      </div>`;
    }
    return `<div style="margin-bottom:12px;">
      <div style="font-size:.65rem; color:var(--text-dim); text-transform:uppercase; margin-bottom:4px;">${label}</div>
      ${items.map(name => `
        <div class="scene-asset-item"
             draggable="true"
             data-asset-name="${esc(name)}"
             data-scene-type="${sceneType}"
             style="padding:5px 8px; background:var(--surface2); border-radius:4px; font-size:.72rem; cursor:grab; margin-bottom:3px; user-select:none; border:1px solid transparent;"
             title="Drag onto the viewport to add to the active scene">${esc(name)}</div>
      `).join('')}
    </div>`;
  }).join('');

  root.querySelectorAll('.scene-asset-item').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        name: el.dataset.assetName,
        type: el.dataset.sceneType,
      }));
      el.style.opacity = '0.4';
    });
    el.addEventListener('dragend', (e) => { el.style.opacity = ''; });
  });
}

function onViewportDrop(e) {
  e.preventDefault();
  let payload;
  try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); }
  catch { return; }
  if (!payload?.name || !payload?.type) return;
  addObjectToActiveScene(payload.type, payload.name);
}

function addObjectToActiveScene(type, asset) {
  const s = activeScene();
  if (!s) return;
  const id = 'obj-' + Math.random().toString(36).slice(2, 10);
  s.objects.push({
    id, type, asset,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  s.tracks.push({
    objectId: id,
    keyframes: [{ t: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
  });
  rebuildViewportFromActive();
  selectObject(id);
  renderTimeline();
  hideEmptyViewportHint();
  queueSave();
}

// ── Viewport ↔ scene model sync ──────────────────────────────────────
function rebuildViewportFromActive() {
  // Clear current Three.js objects for the scene (preserve lights/grid/etc).
  for (const obj of ed.objectsByGuid.values()) {
    ed.three.scene.remove(obj);
    obj.traverse?.(child => {
      if (child.geometry) child.geometry.dispose?.();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
      }
    });
  }
  ed.objectsByGuid.clear();
  ed.three.transform.detach();
  ed.selectedObjectId = null;

  const s = activeScene();
  if (!s) return;

  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  for (const obj of s.objects) {
    if (obj.type === 'model') {
      const group = new THREE.Group();
      group.userData.sceneObjectId = obj.id;
      applyTransform(group, obj.transform);
      ed.three.scene.add(group);
      ed.objectsByGuid.set(obj.id, group);

      loader.load(`/assets/models/${obj.asset}`, (gltf) => {
        const inner = gltf.scene;
        // Tag children so click-raycasting can find which scene object they
        // belong to even when the user clicks a deep mesh inside the GLB.
        inner.traverse(c => { c.userData.sceneObjectId = obj.id; });
        const box = new THREE.Box3().setFromObject(inner);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const fit = 1 / maxDim;
        inner.scale.setScalar(fit);
        const center = box.getCenter(new THREE.Vector3()).multiplyScalar(fit);
        inner.position.sub(center);
        group.add(inner);
      }, undefined, (err) => {
        console.warn(`[scenes-editor] failed to load ${obj.asset}:`, err);
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(0.6, 0.6, 0.6),
          new THREE.MeshStandardMaterial({ color: 0xff00ff, wireframe: true })
        );
        m.userData.sceneObjectId = obj.id;
        group.add(m);
      });
    } else if (obj.type === 'image-plane') {
      const tex = texLoader.load(`/assets/images/${obj.asset}`);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.userData.sceneObjectId = obj.id;
      applyTransform(mesh, obj.transform);
      ed.three.scene.add(mesh);
      ed.objectsByGuid.set(obj.id, mesh);
    }
  }
}

function applyTransform(obj, t) {
  if (!t) return;
  if (t.position) obj.position.set(...t.position);
  if (t.rotation) obj.rotation.set(...t.rotation);
  if (t.scale)    obj.scale.set(...t.scale);
}

function onViewportClick(e) {
  // Skip if the click landed on the gizmo (TransformControls handles its own
  // pointer events; this guard prevents click-deselect when finishing a drag).
  if (ed.three.transform.dragging) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  * 2 - 1,
   -((e.clientY - rect.top)  / rect.height) * 2 + 1,
  );
  ed.three.raycaster.setFromCamera(ndc, ed.three.camera);
  const candidates = [...ed.objectsByGuid.values()];
  const hits = ed.three.raycaster.intersectObjects(candidates, true);
  if (hits.length === 0) {
    selectObject(null);
    return;
  }
  // Walk up to find the topmost sceneObjectId — handles deep meshes in GLBs.
  let node = hits[0].object;
  while (node && !node.userData.sceneObjectId) node = node.parent;
  selectObject(node?.userData.sceneObjectId || null);
}

function selectObject(id) {
  ed.selectedObjectId = id;
  if (id && ed.objectsByGuid.has(id)) {
    ed.three.transform.attach(ed.objectsByGuid.get(id));
  } else {
    ed.three.transform.detach();
  }
  renderObjectInspector();
  renderTimeline();
}

// Object inspector — surfaces in the right-hand panel when an object is
// selected. Name (editable, defaults to asset basename), opacity slider
// (writes a keyframe at scrubber time on every change), delete button.
// Hidden when nothing is selected. Phase 4+ will extend with material/
// light channels.
function renderObjectInspector() {
  const panel = document.getElementById('scenes-inspector');
  if (!panel) return;
  const s = activeScene();
  const obj = s?.objects.find(o => o.id === ed.selectedObjectId);
  if (!obj) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  panel.style.display = 'flex';

  // Resolve current-frame opacity from the track (last keyframe at or
  // before scrubber time). Lets the slider reflect what the player is
  // actually showing at this instant.
  const currentOpacity = (() => {
    const track = s.tracks.find(tr => tr.objectId === obj.id);
    if (!track) return 1;
    const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
    let val = 1;
    for (const kf of kfs) {
      if (kf.t > ed.currentTime) break;
      if (kf.opacity != null) val = kf.opacity;
    }
    return val;
  })();

  const displayName = obj.name || obj.asset;
  panel.innerHTML = `
    <div style="font-size:.65rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em;">Selected Object</div>
    <input type="text" id="scene-obj-name" class="input-field" value="${esc(displayName)}" placeholder="Name" style="margin:0; padding:4px 6px; font-size:.78rem;">
    <div style="font-size:.6rem; color:var(--text-dim);">${esc(obj.type)} · <span style="opacity:.7;">${esc(obj.asset)}</span></div>
    <div style="display:flex; align-items:center; gap:6px;">
      <span style="font-size:.65rem; color:var(--text-dim); min-width:48px;">Opacity</span>
      <input type="range" id="scene-obj-opacity" min="0" max="1" step="0.01" value="${currentOpacity}" style="flex:1;">
      <span id="scene-obj-opacity-val" style="font-size:.65rem; min-width:28px; text-align:right; font-family:monospace;">${currentOpacity.toFixed(2)}</span>
    </div>
    <button class="btn btn-ghost btn-sm" id="scene-obj-delete" style="color:var(--red);">🗑️ Delete Object</button>
  `;

  document.getElementById('scene-obj-name').addEventListener('change', (e) => {
    obj.name = e.target.value.trim() || undefined;
    renderTimeline();
    queueSave();
  });
  document.getElementById('scene-obj-opacity').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById('scene-obj-opacity-val').textContent = v.toFixed(2);
    // Always commit an opacity keyframe at scrubber time — the slider is
    // an explicit edit, not a transient gizmo drag, so auto-key on/off
    // doesn't gate it.
    writeOpacityKeyframe(obj.id, ed.currentTime, v);
    // Live-preview on the viewport object too.
    const three = ed.objectsByGuid.get(obj.id);
    if (three) setObjOpacity(three, v);
    queueSave();
  });
  document.getElementById('scene-obj-delete').addEventListener('click', () => {
    if (!confirm(`Delete "${displayName}"? (Removes its track too.)`)) return;
    s.objects = s.objects.filter(o => o.id !== obj.id);
    s.tracks  = s.tracks.filter(tr => tr.objectId !== obj.id);
    // Tear down the Three.js object.
    const three = ed.objectsByGuid.get(obj.id);
    if (three) {
      ed.three.scene.remove(three);
      three.traverse?.(child => {
        if (child.geometry) child.geometry.dispose?.();
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
        }
      });
    }
    ed.objectsByGuid.delete(obj.id);
    selectObject(null);
    renderTimeline();
    queueSave();
  });
}

function writeOpacityKeyframe(objectId, t, opacity) {
  const s = activeScene();
  if (!s) return;
  let track = s.tracks.find(tr => tr.objectId === objectId);
  if (!track) {
    track = { objectId, keyframes: [] };
    s.tracks.push(track);
  }
  const tr = Math.max(0, Math.round(t));
  const existing = track.keyframes.find(k => k.t === tr);
  if (existing) {
    existing.opacity = opacity;
  } else {
    track.keyframes.push({ t: tr, opacity });
    track.keyframes.sort((a, b) => a.t - b.t);
  }
  renderTimeline();
}

// ── Keyframe writing ─────────────────────────────────────────────────
function writeKeyframeForSelected() {
  const s = activeScene();
  if (!s || !ed.selectedObjectId) return;
  const obj3d = ed.objectsByGuid.get(ed.selectedObjectId);
  if (!obj3d) return;

  let track = s.tracks.find(t => t.objectId === ed.selectedObjectId);
  if (!track) {
    track = { objectId: ed.selectedObjectId, keyframes: [] };
    s.tracks.push(track);
  }

  const t = Math.max(0, Math.round(ed.currentTime));
  const kf = {
    t,
    position: [obj3d.position.x, obj3d.position.y, obj3d.position.z],
    rotation: [obj3d.rotation.x, obj3d.rotation.y, obj3d.rotation.z],
    scale:    [obj3d.scale.x,    obj3d.scale.y,    obj3d.scale.z],
  };

  // Replace an existing keyframe at the same time, otherwise insert
  // sorted. Keeping the array sorted lets the player do a linear scan
  // without re-sorting per frame.
  const existingIdx = track.keyframes.findIndex(k => k.t === t);
  if (existingIdx >= 0) {
    track.keyframes[existingIdx] = kf;
  } else {
    track.keyframes.push(kf);
    track.keyframes.sort((a, b) => a.t - b.t);
  }
  renderTimeline();
}

function applyTracksAtTime(t) {
  const s = activeScene();
  if (!s) return;
  for (const track of s.tracks) {
    const obj3d = ed.objectsByGuid.get(track.objectId);
    if (!obj3d) continue;
    applyKeyframesAt(obj3d, track.keyframes, t);
  }
}

function applyKeyframesAt(obj, keyframes, t) {
  if (!keyframes || keyframes.length === 0) return;
  const sorted = keyframes;
  if (t <= sorted[0].t) return applyKeyframe(obj, sorted[0]);
  if (t >= sorted[sorted.length - 1].t) return applyKeyframe(obj, sorted[sorted.length - 1]);
  let i = 0;
  while (i < sorted.length - 1 && sorted[i + 1].t < t) i++;
  const a = sorted[i], b = sorted[i + 1];
  const span     = b.t - a.t;
  const rawAlpha = span > 0 ? (t - a.t) / span : 0;
  const alpha    = resolveEasing(a.easing)(rawAlpha);
  if (a.position && b.position) obj.position.set(
    lerp(a.position[0], b.position[0], alpha),
    lerp(a.position[1], b.position[1], alpha),
    lerp(a.position[2], b.position[2], alpha),
  );
  if (a.rotation && b.rotation) obj.rotation.set(
    lerp(a.rotation[0], b.rotation[0], alpha),
    lerp(a.rotation[1], b.rotation[1], alpha),
    lerp(a.rotation[2], b.rotation[2], alpha),
  );
  if (a.scale && b.scale) obj.scale.set(
    lerp(a.scale[0], b.scale[0], alpha),
    lerp(a.scale[1], b.scale[1], alpha),
    lerp(a.scale[2], b.scale[2], alpha),
  );
  if (a.opacity != null && b.opacity != null) {
    setObjOpacity(obj, lerp(a.opacity, b.opacity, alpha));
  }
}

function applyKeyframe(obj, kf) {
  if (kf.position) obj.position.set(...kf.position);
  if (kf.rotation) obj.rotation.set(...kf.rotation);
  if (kf.scale)    obj.scale.set(...kf.scale);
  if (kf.opacity != null) setObjOpacity(obj, kf.opacity);
}

// Walks the subtree so opacity applies to all materials inside a loaded
// GLB. Force-sets transparent=true (Three.js's opaque-by-default materials
// would otherwise ignore opacity writes).
function setObjOpacity(obj, op) {
  obj.traverse?.(child => {
    const mats = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : null;
    mats?.forEach(m => { m.transparent = true; m.opacity = op; });
  });
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ── Scenes list ──────────────────────────────────────────────────────
async function refreshScenes() {
  try {
    const res = await fetch('/api/scenes');
    ed.scenes = await res.json();
  } catch (err) {
    console.warn('Failed to load scenes:', err);
    ed.scenes = [];
  }
  renderScenesList();
}

function renderScenesList() {
  const root = document.getElementById('scenes-list');
  if (ed.scenes.length === 0) {
    root.innerHTML = `<div style="color:var(--text-dim); font-size:.7rem; opacity:.6; padding:8px 0;">No scenes yet. Click + New Scene below.</div>`;
    return;
  }
  root.innerHTML = ed.scenes.map(s => `
    <div class="scene-list-item ${s.id === ed.activeId ? 'is-active' : ''}"
         data-scene-id="${s.id}"
         style="padding:6px 8px; background:${s.id === ed.activeId ? 'var(--accent)' : 'var(--surface2)'};
                color:${s.id === ed.activeId ? '#fff' : 'var(--text)'};
                border-radius:4px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:6px;">
      <span style="flex:1; font-size:.78rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(s.name)}</span>
      <button class="btn btn-ghost btn-sm scene-rename-btn" data-scene-id="${s.id}" title="Rename" style="padding:2px 6px; font-size:.65rem;">✎</button>
      <button class="btn btn-ghost btn-sm scene-delete-btn" data-scene-id="${s.id}" title="Delete" style="padding:2px 6px; font-size:.65rem; color:var(--red);">✕</button>
    </div>
  `).join('');
  root.querySelectorAll('.scene-list-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      setActiveScene(el.dataset.sceneId);
    });
  });
  root.querySelectorAll('.scene-rename-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = ed.scenes.find(x => x.id === btn.dataset.sceneId);
      if (!s) return;
      const name = prompt('Scene name:', s.name);
      if (name && name.trim()) {
        s.name = name.trim();
        renderScenesList();
        queueSave();
      }
    });
  });
  root.querySelectorAll('.scene-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = ed.scenes.find(x => x.id === btn.dataset.sceneId);
      if (!s) return;
      if (!confirm(`Delete scene "${s.name}"?`)) return;
      ed.scenes = ed.scenes.filter(x => x.id !== btn.dataset.sceneId);
      if (ed.activeId === btn.dataset.sceneId) {
        ed.activeId = ed.scenes[0]?.id || null;
      }
      renderScenesList();
      setActiveScene(ed.activeId);
      queueSave();
    });
  });
}

function newScene() {
  const id = 'scene-' + Math.random().toString(36).slice(2, 10);
  ed.scenes.push({
    id,
    name: `Scene ${ed.scenes.length + 1}`,
    durationMs: 10000,
    mountMode: 'fullscreen',
    aspectRatio: 16 / 9,
    camera: { type: 'perspective', position: [0, 1.2, 4], lookAt: [0, 0, 0], fov: 50 },
    objects: [],
    tracks: [],
  });
  renderScenesList();
  setActiveScene(id);
  queueSave();
}

function setActiveScene(id) {
  ed.activeId = id;
  ed.currentTime = 0;
  ed.isPlaying = false;
  stopEditorPreviewAudio();
  const s = activeScene();
  if (s) {
    document.getElementById('scenes-duration-input').value = s.durationMs;
    document.getElementById('scenes-mount-mode').value     = s.mountMode || 'fullscreen';
    document.getElementById('scenes-aspect-select').value  = s.aspectRatio ? String(s.aspectRatio) : '';
    hideEmptyViewportHint(s.objects.length > 0);
  }
  rebuildViewportFromActive();
  renderScenesList();
  renderAudioList();
  renderTimeline();
  renderTimeDisplay();
  updateAspectGuide();
}

function hideEmptyViewportHint(hide) {
  const el = document.getElementById('scenes-viewport-empty');
  if (!el) return;
  el.style.display = hide ? 'none' : 'flex';
}

function activeScene() {
  return ed.scenes.find(s => s.id === ed.activeId) || null;
}

// ── Timeline ─────────────────────────────────────────────────────────
function bindTimelineEvents() {
  const body = document.getElementById('scenes-timeline-body');
  body.addEventListener('click', (e) => {
    // Click on the track strip background → seek scrubber. The keyframe
    // diamond's own click handler stops propagation before we get here.
    const strip = e.target.closest('.scene-track-strip');
    if (!strip) return;
    const rect = strip.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const dur = activeScene()?.durationMs || 10000;
    ed.currentTime = Math.max(0, Math.min(dur, Math.round(ratio * dur)));
    ed.isPlaying = false;
    applyTracksAtTime(ed.currentTime);
    renderTimelineHead();
    renderTimeDisplay();
  });
}

function renderTimeline() {
  const body = document.getElementById('scenes-timeline-body');
  const s = activeScene();
  if (!s) {
    body.innerHTML = `<div style="padding:20px; color:var(--text-dim); font-size:.72rem; opacity:.6;">No active scene.</div>`;
    return;
  }
  if (s.tracks.length === 0) {
    body.innerHTML = `<div style="padding:20px; color:var(--text-dim); font-size:.72rem; opacity:.6;">Add an object to the scene to start a track.</div>`;
    return;
  }
  const dur = s.durationMs || 10000;
  body.innerHTML = s.tracks.map(track => {
    const obj = s.objects.find(o => o.id === track.objectId);
    const label = obj ? `${esc(obj.name || obj.asset)} <span style="opacity:.5;">(${obj.type})</span>` : track.objectId;
    const isSelected = track.objectId === ed.selectedObjectId;
    const kfs = (track.keyframes || []).map(kf => {
      const pct = Math.max(0, Math.min(100, (kf.t / dur) * 100));
      // Eased keyframes get an orange outline so the streamer can spot the
      // non-linear segments at a glance without opening the context menu.
      const fillColor   = isSelected ? '#fff' : 'var(--accent)';
      const borderColor = kf.easing && kf.easing !== 'linear' ? '#ff9933' : '#000';
      const borderWidth = kf.easing && kf.easing !== 'linear' ? '2px' : '1px';
      const easingHint  = kf.easing ? ` • ${kf.easing}` : '';
      return `<div class="scene-keyframe"
                   data-object-id="${track.objectId}"
                   data-keyframe-t="${kf.t}"
                   title="t=${kf.t}ms${easingHint} (drag to retime, right-click for options)"
                   style="position:absolute; left:${pct}%; top:50%; transform:translate(-50%,-50%) rotate(45deg);
                          width:10px; height:10px; background:${fillColor};
                          border:${borderWidth} solid ${borderColor}; cursor:ew-resize;"></div>`;
    }).join('');
    return `
      <div class="scene-track-row" data-object-id="${track.objectId}"
           style="display:flex; align-items:center; height:32px; border-bottom:1px solid rgba(255,255,255,0.04); ${isSelected ? 'background:rgba(145,71,255,0.15);' : ''}">
        <div style="width:160px; padding:0 10px; font-size:.7rem; color:var(--text); flex-shrink:0; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${label}</div>
        <div class="scene-track-strip" style="flex:1; position:relative; height:100%; cursor:crosshair;">${kfs}</div>
      </div>`;
  }).join('') + `<div id="scene-playhead" style="position:absolute; top:0; bottom:0; left:0; width:2px; background:#ff6;
                       transform:translateX(0); pointer-events:none; box-shadow:0 0 4px #ff6;"></div>`;

  body.querySelectorAll('.scene-track-row').forEach(row => {
    const label = row.firstElementChild;
    label.addEventListener('click', () => selectObject(row.dataset.objectId));
  });
  body.querySelectorAll('.scene-keyframe').forEach(diamond => bindKeyframeDiamond(diamond));

  renderTimelineHead();
}

function renderTimelineHead() {
  const body = document.getElementById('scenes-timeline-body');
  const head = body.querySelector('#scene-playhead');
  if (!head) return;
  const strip = body.querySelector('.scene-track-strip');
  if (!strip) return;
  const dur = activeScene()?.durationMs || 10000;
  const ratio = Math.max(0, Math.min(1, ed.currentTime / dur));
  const stripRect = strip.getBoundingClientRect();
  const bodyRect  = body.getBoundingClientRect();
  const px = (stripRect.left - bodyRect.left) + ratio * stripRect.width + body.scrollLeft;
  head.style.transform = `translateX(${px}px)`;
}

function renderTimeDisplay() {
  const el = document.getElementById('scenes-time-display');
  if (!el) return;
  const dur = activeScene()?.durationMs || 10000;
  el.textContent = `${fmtMs(ed.currentTime)} / ${fmtMs(dur)}`;
}

function fmtMs(ms) {
  const m  = Math.floor(ms / 60000);
  const s  = Math.floor((ms % 60000) / 1000);
  const mm = String(ms % 1000).padStart(3, '0');
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${mm}`;
}

// ── Save ─────────────────────────────────────────────────────────────
function queueSave() {
  clearTimeout(ed.saveDebounce);
  ed.saveDebounce = setTimeout(saveNow, 800);
}

async function saveNow() {
  try {
    const res = await fetch('/api/scenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ed.scenes),
    });
    if (!res.ok) {
      const msg = await res.text();
      // Surface the validator's human message in the existing error banner.
      window.errorReporter?.report?.('scenes', `Save failed: ${msg}`);
      console.warn('Save failed:', msg);
      return;
    }
    flashSaveStatus();
  } catch (err) {
    console.warn('Save error:', err);
  }
}

function flashSaveStatus() {
  const el = document.getElementById('scenes-save-status');
  if (!el) return;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1200);
}

// ── Scene audio ──────────────────────────────────────────────────────
function addAudioEntry() {
  const s = activeScene();
  if (!s) return;
  if (!s.audio) s.audio = [];
  const sounds = ed.assets.sounds || [];
  s.audio.push({
    id: 'aud-' + Math.random().toString(36).slice(2, 10),
    src: sounds[0] || '',
    start: 0,
    priority: 60,           // scene-audio convention
    policy: 'mix',
    vol: 1,
    loop: false,
  });
  renderAudioList();
  queueSave();
}

function renderAudioList() {
  const root = document.getElementById('scenes-audio-list');
  if (!root) return;
  const s = activeScene();
  if (!s) { root.innerHTML = ''; return; }
  const entries = s.audio || [];
  if (entries.length === 0) {
    root.innerHTML = `<div style="font-size:.65rem; color:var(--text-dim); opacity:.6; padding:4px 0;">No audio. Click + Add.</div>`;
    return;
  }
  const sounds = ed.assets.sounds || [];
  root.innerHTML = entries.map((a, idx) => `
    <div data-audio-id="${a.id}" style="background:var(--surface); padding:6px; border-radius:4px; display:flex; flex-direction:column; gap:4px; font-size:.65rem;">
      <div style="display:flex; gap:4px; align-items:center;">
        <select class="aud-src input-field" style="flex:1; margin:0; padding:2px; font-size:.65rem;">
          ${sounds.map(snd => `<option value="${esc(snd)}" ${snd === a.src ? 'selected' : ''}>${esc(snd)}</option>`).join('')}
          ${sounds.includes(a.src) ? '' : `<option value="${esc(a.src)}" selected>${esc(a.src || '(none)')}</option>`}
        </select>
        <button class="aud-delete btn btn-ghost btn-sm" title="Delete" style="padding:2px 6px; font-size:.65rem; color:var(--red);">✕</button>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <span style="opacity:.7; min-width:36px;">start</span>
        <input type="number" class="aud-start" value="${a.start ?? 0}" min="0" step="100" style="width:70px; margin:0; padding:2px 4px; font-size:.65rem;">ms
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <span style="opacity:.7; min-width:36px;">vol</span>
        <input type="range" class="aud-vol" min="0" max="1" step="0.01" value="${a.vol ?? 1}" style="flex:1;">
        <span class="aud-vol-val" style="min-width:28px; text-align:right; font-family:monospace;">${(a.vol ?? 1).toFixed(2)}</span>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <span style="opacity:.7; min-width:36px;">prio</span>
        <input type="range" class="aud-pri" min="0" max="100" step="1" value="${a.priority ?? 60}" style="flex:1;">
        <span class="aud-pri-val" style="min-width:28px; text-align:right; font-family:monospace;">${a.priority ?? 60}</span>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <select class="aud-policy input-field" style="flex:1; margin:0; padding:2px; font-size:.65rem;">
          ${AUDIO_POLICIES.map(p => `<option value="${p}" ${p === (a.policy || 'mix') ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <label style="display:inline-flex; align-items:center; gap:4px;">
          <input type="checkbox" class="aud-loop" ${a.loop ? 'checked' : ''}> loop
        </label>
      </div>
    </div>
  `).join('');

  root.querySelectorAll('[data-audio-id]').forEach(row => {
    const aid = row.dataset.audioId;
    const get = () => activeScene()?.audio?.find(x => x.id === aid);
    row.querySelector('.aud-src')?.addEventListener('change', (e) => { const a = get(); if (a) { a.src = e.target.value; queueSave(); } });
    row.querySelector('.aud-start')?.addEventListener('change', (e) => {
      const a = get(); if (!a) return;
      a.start = Math.max(0, parseInt(e.target.value, 10) || 0);
      queueSave();
    });
    row.querySelector('.aud-vol')?.addEventListener('input', (e) => {
      const a = get(); if (!a) return;
      a.vol = parseFloat(e.target.value);
      row.querySelector('.aud-vol-val').textContent = a.vol.toFixed(2);
      queueSave();
    });
    row.querySelector('.aud-pri')?.addEventListener('input', (e) => {
      const a = get(); if (!a) return;
      a.priority = parseInt(e.target.value, 10);
      row.querySelector('.aud-pri-val').textContent = a.priority;
      queueSave();
    });
    row.querySelector('.aud-policy')?.addEventListener('change', (e) => { const a = get(); if (a) { a.policy = e.target.value; queueSave(); } });
    row.querySelector('.aud-loop')?.addEventListener('change', (e) => { const a = get(); if (a) { a.loop = e.target.checked; queueSave(); } });
    row.querySelector('.aud-delete')?.addEventListener('click', () => {
      const s = activeScene(); if (!s) return;
      s.audio = (s.audio || []).filter(x => x.id !== aid);
      renderAudioList();
      queueSave();
    });
  });
}

// Editor ▶ Test — drives the viewport playhead from currentTime and
// schedules scene audio through the same bus the runtime uses, so the
// mix Fokker hears in the editor matches what plays on overlay.
function startEditorPreview() {
  stopEditorPreviewAudio();
  const s = activeScene();
  if (!s) return;
  ed.currentTime = 0;
  ed.playStartTime = performance.now();
  ed.isPlaying = true;
  for (const a of s.audio || []) {
    const start = Math.max(0, a.start || 0);
    if (start >= s.durationMs) continue;
    const tid = setTimeout(() => {
      if (!ed.isPlaying) return; // user stopped before this fired
      const handle = audioBus.play({
        src: a.src,
        vol:      a.vol ?? 1,
        priority: a.priority ?? 60,
        policy:   a.policy ?? 'mix',
        loop:     a.loop ?? false,
        id:       `editor-${a.id}`,
      });
      if (handle) ed.audioPreview.handles.push(handle);
    }, start);
    ed.audioPreview.timeouts.push(tid);
  }
}

function stopEditorPreviewAudio() {
  for (const t of ed.audioPreview.timeouts) clearTimeout(t);
  for (const h of ed.audioPreview.handles) { try { h?.stop?.(); } catch {} }
  ed.audioPreview.timeouts = [];
  ed.audioPreview.handles  = [];
}

// ── Keyframe interaction ─────────────────────────────────────────────
// Mousedown-driven so we can disambiguate click (seek) from drag (retime).
// Right-click opens the easing+delete context menu instead of seeking.
function bindKeyframeDiamond(diamond) {
  diamond.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openKeyframeContextMenu(e.clientX, e.clientY, diamond.dataset.objectId, parseInt(diamond.dataset.keyframeT, 10));
  });

  diamond.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left only
    e.preventDefault();
    e.stopPropagation();
    const objId  = diamond.dataset.objectId;
    const startT = parseInt(diamond.dataset.keyframeT, 10);
    const startX = e.clientX;
    const strip  = diamond.closest('.scene-track-strip');
    const stripRect = strip.getBoundingClientRect();
    const dur = activeScene()?.durationMs || 10000;
    let moved = false;

    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      if (!moved && Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      let newT = Math.round(startT + (dx / stripRect.width) * dur);
      // Shift snaps to 100ms grid for tidy keyframe placement.
      if (mv.shiftKey) newT = Math.round(newT / 100) * 100;
      newT = Math.max(0, Math.min(dur, newT));
      const track = activeScene()?.tracks.find(tr => tr.objectId === objId);
      if (!track) return;
      const kf = track.keyframes.find(k => k.t === parseInt(diamond.dataset.keyframeT, 10));
      if (!kf) return;
      // Refuse the move if there's already a keyframe at newT — the second
      // would shadow the first and a re-sort would scramble interpolation.
      // Player accepts only one kf per t.
      if (newT !== kf.t && track.keyframes.some(k => k.t === newT && k !== kf)) return;
      kf.t = newT;
      diamond.dataset.keyframeT = String(newT);
      diamond.style.left = ((newT / dur) * 100) + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (moved) {
        const track = activeScene()?.tracks.find(tr => tr.objectId === objId);
        if (track) track.keyframes.sort((a, b) => a.t - b.t);
        renderTimeline();
        queueSave();
      } else {
        // Click — seek + select
        selectObject(objId);
        ed.currentTime = startT;
        ed.isPlaying = false;
        applyTracksAtTime(startT);
        renderTimelineHead();
        renderTimeDisplay();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function openKeyframeContextMenu(x, y, objectId, t) {
  closeKeyframeContextMenu();
  const track = activeScene()?.tracks.find(tr => tr.objectId === objectId);
  const kf    = track?.keyframes.find(k => k.t === t);
  if (!kf) return;

  const menu = document.createElement('div');
  menu.id = 'scene-kf-menu';
  menu.style.cssText = `position:fixed; left:${x}px; top:${y}px; background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:6px 0; box-shadow:0 8px 24px rgba(0,0,0,0.5); z-index:99999; font-size:.72rem; min-width:200px; max-height:80vh; overflow-y:auto;`;

  const head = document.createElement('div');
  head.textContent = `Keyframe at ${fmtMs(t)}`;
  head.style.cssText = 'padding:4px 12px; color:var(--text-dim); font-size:.6rem; text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid var(--border);';
  menu.appendChild(head);

  const easingHead = document.createElement('div');
  easingHead.textContent = 'Easing → next keyframe:';
  easingHead.style.cssText = 'padding:6px 12px 2px; color:var(--text-dim); font-size:.6rem;';
  menu.appendChild(easingHead);

  const currentEasing = kf.easing || 'linear';
  EASING_NAMES.forEach(name => {
    const item = document.createElement('div');
    item.textContent = (currentEasing === name ? '✓ ' : '  ') + name;
    item.style.cssText = 'padding:4px 12px; cursor:pointer; user-select:none;';
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface2)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', () => {
      // Store nothing when reverting to linear — keeps scenes.json minimal
      // for the common case and matches the schema's "missing = linear".
      if (name === 'linear') delete kf.easing;
      else kf.easing = name;
      renderTimeline();
      queueSave();
      closeKeyframeContextMenu();
    });
    menu.appendChild(item);
  });

  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px; background:var(--border); margin:4px 0;';
  menu.appendChild(divider);

  const del = document.createElement('div');
  del.textContent = '✕ Delete keyframe';
  del.style.cssText = 'padding:6px 12px; cursor:pointer; color:var(--red); user-select:none;';
  del.addEventListener('mouseenter', () => { del.style.background = 'var(--surface2)'; });
  del.addEventListener('mouseleave', () => { del.style.background = ''; });
  del.addEventListener('click', () => {
    track.keyframes = track.keyframes.filter(k => k.t !== t);
    renderTimeline();
    queueSave();
    closeKeyframeContextMenu();
  });
  menu.appendChild(del);

  document.body.appendChild(menu);
  // Dismiss on outside click. Attach one tick later so the originating
  // right-click doesn't immediately close the menu.
  setTimeout(() => {
    const off = (ev) => {
      if (!menu.contains(ev.target)) {
        closeKeyframeContextMenu();
        document.removeEventListener('mousedown', off);
      }
    };
    document.addEventListener('mousedown', off);
  }, 0);
}

function closeKeyframeContextMenu() {
  document.getElementById('scene-kf-menu')?.remove();
}

// ── Utilities ────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[c]));
}
