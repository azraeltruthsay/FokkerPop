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
      applyPathAndShake(ed.currentTime);
      applyCameraAtTime(ed.currentTime);
      renderTimelineHead();
      renderTimeDisplay();
    }
    // Suspend OrbitControls while a cameraTrack drives the camera so
    // user pan/zoom doesn't fight the animation. Re-enabled the instant
    // playback stops or the track is empty.
    const hasCamTrack = (activeScene()?.cameraTrack?.keyframes?.length || 0) > 0;
    orbit.enabled = !(ed.isPlaying && hasCamTrack);
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
  document.getElementById('scenes-cam-key').addEventListener('click', captureCameraKeyframe);
  document.getElementById('scenes-add-fork').addEventListener('click', addForkAtScrubber);
  document.getElementById('scenes-add-branch').addEventListener('click', addBranchAtScrubber);
  document.getElementById('scenes-mount-widget-id').addEventListener('change', (e) => {
    const s = activeScene(); if (!s) return;
    s.targetWidgetId = e.target.value || undefined;
    queueSave();
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
    refreshMountWidgetPicker();
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
  let html = sections.map(([key, label, sceneType]) => {
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

  // Lights — not files, so click-to-add rather than drag-to-place. Three
  // kinds covering 99% of scene-lighting needs; spot lights deferred to
  // later phases (extra params + cone widget complexity).
  html += `<div style="margin-bottom:12px;">
    <div style="font-size:.65rem; color:var(--text-dim); text-transform:uppercase; margin-bottom:4px;">Lights</div>
    <button class="btn btn-ghost btn-sm scene-add-light" data-light-kind="directional" style="width:100%; margin-bottom:3px; font-size:.65rem; text-align:left;">+ Directional</button>
    <button class="btn btn-ghost btn-sm scene-add-light" data-light-kind="point"       style="width:100%; margin-bottom:3px; font-size:.65rem; text-align:left;">+ Point</button>
    <button class="btn btn-ghost btn-sm scene-add-light" data-light-kind="ambient"     style="width:100%; margin-bottom:3px; font-size:.65rem; text-align:left;">+ Ambient</button>
  </div>`;

  root.innerHTML = html;

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
  root.querySelectorAll('.scene-add-light').forEach(btn => {
    btn.addEventListener('click', () => addLightToActiveScene(btn.dataset.lightKind));
  });
}

function addLightToActiveScene(kind) {
  const s = activeScene();
  if (!s) return;
  const id = 'light-' + Math.random().toString(36).slice(2, 10);
  // Sensible per-kind defaults. Directional sits up + to the side so it
  // throws a useful shadow direction; point sits above center; ambient
  // is positionless. Intensity ~1 is Three.js's neutral starting point.
  const defaults = {
    'directional': { transform: { position: [3, 4, 2], rotation: [0,0,0], scale: [1,1,1] }, light: { kind, intensity: 1.0, color: '#ffffff' } },
    'point':       { transform: { position: [0, 2, 2], rotation: [0,0,0], scale: [1,1,1] }, light: { kind, intensity: 1.0, color: '#ffffff', distance: 0 } },
    'ambient':     { transform: { position: [0, 0, 0], rotation: [0,0,0], scale: [1,1,1] }, light: { kind, intensity: 0.4, color: '#ffffff' } },
  }[kind] || { transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }, light: { kind, intensity: 1, color: '#ffffff' } };

  s.objects.push({
    id,
    type: 'light',
    name: `${kind} light`,
    ...defaults,
  });
  rebuildViewportFromActive();
  selectObject(id);
  renderTimeline();
  hideEmptyViewportHint(true);
  queueSave();
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
  // Also drop any path-follow visualizers + light-helpers; rebuild will
  // re-add them. Lights live on objectsByGuid so their cleanup happens
  // above, but their helpers are siblings tagged via userData.
  clearPathLines();
  const helperRemovals = [];
  ed.three.scene.traverse(o => { if (o.userData?.isLightHelper) helperRemovals.push(o); });
  for (const h of helperRemovals) ed.three.scene.remove(h);
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
        // Collect morph-capable meshes (Blender shape keys exported via
        // glTF). The inspector reads this list to render one slider per
        // shape key once the model is on-screen.
        const morphMeshes = [];
        inner.traverse(child => {
          if (child.isMesh && child.morphTargetDictionary && child.morphTargetInfluences) {
            morphMeshes.push({ mesh: child, dict: child.morphTargetDictionary });
          }
        });
        if (morphMeshes.length) group.userData.morphMeshes = morphMeshes;
        // If this object is currently selected and the inspector is open,
        // re-render so the newly-discovered morph sliders show up. Without
        // this the inspector would have rendered with zero morph rows
        // before the GLB finished loading.
        if (ed.selectedObjectId === obj.id) renderObjectInspector();
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
    } else if (obj.type === 'light') {
      const l = obj.light || {};
      const color = new THREE.Color(l.color || '#ffffff');
      const intensity = l.intensity ?? 1;
      let light;
      if (l.kind === 'ambient')        light = new THREE.AmbientLight(color, intensity);
      else if (l.kind === 'point')     light = new THREE.PointLight(color, intensity, l.distance ?? 0);
      else                             light = new THREE.DirectionalLight(color, intensity);
      light.userData.sceneObjectId = obj.id;
      if (l.kind !== 'ambient') applyTransform(light, obj.transform);
      ed.three.scene.add(light);
      ed.objectsByGuid.set(obj.id, light);

      // Visual gizmo so the streamer can see and select the light. Helpers
      // attach as children of the light so they move with it during gizmo
      // drags; raycast hits on the helper resolve back to the light id
      // via userData.sceneObjectId set above (Three.Object3D traversal
      // inherits userData on hit).
      if (l.kind === 'directional') {
        const helper = new THREE.DirectionalLightHelper(light, 0.4, 0xffff00);
        helper.userData.sceneObjectId = obj.id;
        helper.userData.isLightHelper = true;
        helper.traverse(c => { c.userData.sceneObjectId = obj.id; });
        ed.three.scene.add(helper);
      } else if (l.kind === 'point') {
        const helper = new THREE.PointLightHelper(light, 0.2, 0xffff00);
        helper.userData.sceneObjectId = obj.id;
        helper.userData.isLightHelper = true;
        helper.traverse(c => { c.userData.sceneObjectId = obj.id; });
        ed.three.scene.add(helper);
      }
      // Ambient lights have no position; no helper. The inspector is the
      // only way to find/edit them — the timeline row is too.
    }
  }

  // Build path-follow curves + visual lines. Mirrors the runtime player so
  // editor preview matches what the overlay renders. Lines are added to
  // the scene so the streamer can see the path while authoring; they're
  // pointer-events-irrelevant (Three.js doesn't raycast them by default).
  for (const obj of s.objects) {
    if (!obj.pathFollow || !ed.objectsByGuid.has(obj.id)) continue;
    const three = ed.objectsByGuid.get(obj.id);
    const pts = obj.pathFollow.points.map(p => new THREE.Vector3(...p));
    const curve = new THREE.CatmullRomCurve3(pts, !!obj.pathFollow.loop);
    three.userData.pathCurve = curve;
    three.userData.pathLoop  = !!obj.pathFollow.loop;
    three.userData.pathSpeed = obj.pathFollow.speed ?? 1;

    // Visual line: sample the curve at 64 points and draw it in cyan so
    // the path is visible against most viewport backgrounds.
    const samples = curve.getPoints(64);
    const geom = new THREE.BufferGeometry().setFromPoints(samples);
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x66ddff }));
    line.userData.isPathLine = true;
    line.userData.forObjectId = obj.id;
    ed.three.scene.add(line);
    three.userData.pathLine = line;
  }
}

// Remove all path-visualization lines from the editor scene. Called when
// the active scene changes or a path is edited, so stale lines don't pile
// up. Same teardown pattern the light-helper cleanup uses.
function clearPathLines() {
  if (!ed.three) return;
  const toRemove = [];
  ed.three.scene.traverse(o => { if (o.userData?.isPathLine) toRemove.push(o); });
  for (const o of toRemove) {
    ed.three.scene.remove(o);
    o.geometry?.dispose?.();
    o.material?.dispose?.();
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
// selected. Name (editable), type-specific controls, delete. For models/
// image-planes: opacity slider + a Material section (color/emissive/
// metalness/roughness/wireframe). For lights: kind label + intensity +
// color + distance (point only). All edits write keyframes at scrubber
// time and live-apply to the viewport.
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

  const displayName = obj.name || obj.asset || obj.id;
  const sub = obj.type === 'light' ? `light · ${esc(obj.light?.kind || 'directional')}` : `${esc(obj.type)} · ${esc(obj.asset || '')}`;

  if (obj.type === 'light') {
    panel.innerHTML = renderLightInspectorHtml(obj, displayName, sub);
    bindLightInspector(obj);
  } else {
    panel.innerHTML = renderModelInspectorHtml(obj, displayName, sub);
    bindModelInspector(obj);
  }
}

function renderModelInspectorHtml(obj, displayName, sub) {
  const current = resolveCurrentVisualProps(obj.id);
  return `
    <div style="font-size:.65rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em;">Selected Object</div>
    <input type="text" id="scene-obj-name" class="input-field" value="${esc(displayName)}" placeholder="Name" style="margin:0; padding:4px 6px; font-size:.78rem;">
    <div style="font-size:.6rem; color:var(--text-dim);">${sub}</div>
    <div style="display:flex; align-items:center; gap:6px;">
      <span style="font-size:.65rem; color:var(--text-dim); min-width:48px;">Opacity</span>
      <input type="range" id="scene-obj-opacity" min="0" max="1" step="0.01" value="${current.opacity}" style="flex:1;">
      <span id="scene-obj-opacity-val" style="font-size:.65rem; min-width:28px; text-align:right; font-family:monospace;">${current.opacity.toFixed(2)}</span>
    </div>
    <details ${current.hasMaterial ? 'open' : ''}>
      <summary style="font-size:.65rem; color:var(--text-dim); cursor:pointer; padding:2px 0;">▾ Material</summary>
      <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px; padding-left:4px;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Tint</span>
          <input type="color" id="scene-mat-color" value="${current.color}" style="width:32px; height:22px; padding:0; border:none; background:none; cursor:pointer;">
          <span style="font-size:.6rem; font-family:monospace; opacity:.6;">${current.color}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Emissive</span>
          <input type="color" id="scene-mat-emissive" value="${current.emissive}" style="width:32px; height:22px; padding:0; border:none; background:none; cursor:pointer;">
          <span style="font-size:.6rem; font-family:monospace; opacity:.6;">${current.emissive}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Glow</span>
          <input type="range" id="scene-mat-emi-int" min="0" max="5" step="0.05" value="${current.emissiveIntensity}" style="flex:1;">
          <span id="scene-mat-emi-int-val" style="font-size:.6rem; min-width:24px; text-align:right; font-family:monospace;">${current.emissiveIntensity.toFixed(2)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Metal</span>
          <input type="range" id="scene-mat-metal" min="0" max="1" step="0.01" value="${current.metalness}" style="flex:1;">
          <span id="scene-mat-metal-val" style="font-size:.6rem; min-width:24px; text-align:right; font-family:monospace;">${current.metalness.toFixed(2)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Rough</span>
          <input type="range" id="scene-mat-rough" min="0" max="1" step="0.01" value="${current.roughness}" style="flex:1;">
          <span id="scene-mat-rough-val" style="font-size:.6rem; min-width:24px; text-align:right; font-family:monospace;">${current.roughness.toFixed(2)}</span>
        </div>
        <label style="display:inline-flex; align-items:center; gap:6px; font-size:.6rem; color:var(--text-dim);">
          <input type="checkbox" id="scene-mat-wire" ${current.wireframe ? 'checked' : ''}> Wireframe
        </label>
      </div>
    </details>
    ${renderMorphSectionHtml(obj)}
    ${renderPathSectionHtml(obj)}
    ${renderShakeSectionHtml(obj)}
    <button class="btn btn-ghost btn-sm" id="scene-obj-delete" style="color:var(--red);">🗑️ Delete Object</button>
  `;
}

function renderMorphSectionHtml(obj) {
  const three = ed.objectsByGuid.get(obj.id);
  const morphMeshes = three?.userData?.morphMeshes;
  if (!morphMeshes || morphMeshes.length === 0) return '';
  // Union of names across all morph-capable meshes (a GLB can have shape
  // keys on multiple meshes; same name on different meshes drives them
  // together, matching how Blender exports them).
  const names = new Set();
  for (const { dict } of morphMeshes) Object.keys(dict).forEach(n => names.add(n));
  const current = resolveCurrentMorphs(obj.id);
  const rows = [...names].map(name => {
    const v = current[name] ?? 0;
    return `<div style="display:flex; align-items:center; gap:6px;">
      <span style="font-size:.6rem; color:var(--text-dim); min-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(name)}</span>
      <input type="range" class="scene-morph-input" data-name="${esc(name)}" min="0" max="1" step="0.01" value="${v}" style="flex:1;">
      <span class="scene-morph-val" data-name="${esc(name)}" style="font-size:.6rem; min-width:28px; text-align:right; font-family:monospace;">${v.toFixed(2)}</span>
    </div>`;
  }).join('');
  return `
    <details>
      <summary style="font-size:.65rem; color:var(--text-dim); cursor:pointer; padding:2px 0;">▾ Morph Targets (${names.size})</summary>
      <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px; padding-left:4px;">${rows}</div>
    </details>`;
}

function renderPathSectionHtml(obj) {
  const pf = obj.pathFollow || null;
  const pointsJson = pf ? JSON.stringify(pf.points) : '';
  return `
    <details ${pf ? 'open' : ''}>
      <summary style="font-size:.65rem; color:var(--text-dim); cursor:pointer; padding:2px 0;">▾ Path Follow</summary>
      <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px; padding-left:4px;">
        <div style="font-size:.55rem; color:var(--text-dim); opacity:.7;">Control points as JSON: [[x,y,z], [x,y,z], ...]. ≥2 points. Overrides position keyframes.</div>
        <textarea id="scene-path-points" placeholder="[[0,0,0],[1,1,0],[2,0,-1]]" style="width:100%; min-height:44px; resize:vertical; font-family:monospace; font-size:.65rem; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:3px; padding:4px;">${esc(pointsJson)}</textarea>
        <div style="display:flex; gap:8px; align-items:center;">
          <label style="display:inline-flex; align-items:center; gap:4px; font-size:.6rem; color:var(--text-dim);">
            <input type="checkbox" id="scene-path-loop" ${pf?.loop ? 'checked' : ''}> Loop
          </label>
          <label style="display:inline-flex; align-items:center; gap:4px; font-size:.6rem; color:var(--text-dim);">Speed
            <input type="number" id="scene-path-speed" min="0.1" step="0.1" value="${pf?.speed ?? 1}" style="width:50px; margin:0; padding:2px 4px; font-size:.6rem;">
          </label>
          <button class="btn btn-ghost btn-sm" id="scene-path-clear" title="Remove path-follow from this object" style="margin-left:auto; padding:2px 8px; font-size:.6rem;">Clear</button>
        </div>
      </div>
    </details>`;
}

function renderShakeSectionHtml(obj) {
  const sh = resolveCurrentShake(obj.id);
  const has = sh.amplitude.some(v => v !== 0) || sh.frequency !== 0;
  return `
    <details ${has ? 'open' : ''}>
      <summary style="font-size:.65rem; color:var(--text-dim); cursor:pointer; padding:2px 0;">▾ Shake</summary>
      <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px; padding-left:4px;">
        <div style="display:flex; gap:4px; align-items:center;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:18px;">X</span>
          <input type="number" id="scene-shake-x" step="0.01" value="${sh.amplitude[0]}" style="flex:1; margin:0; padding:2px 4px; font-size:.65rem;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:18px;">Y</span>
          <input type="number" id="scene-shake-y" step="0.01" value="${sh.amplitude[1]}" style="flex:1; margin:0; padding:2px 4px; font-size:.65rem;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:18px;">Z</span>
          <input type="number" id="scene-shake-z" step="0.01" value="${sh.amplitude[2]}" style="flex:1; margin:0; padding:2px 4px; font-size:.65rem;">
        </div>
        <div style="display:flex; gap:4px; align-items:center;">
          <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Freq (Hz)</span>
          <input type="number" id="scene-shake-freq" min="0" step="0.5" value="${sh.frequency}" style="flex:1; margin:0; padding:2px 4px; font-size:.65rem;">
        </div>
        <div style="font-size:.55rem; color:var(--text-dim); opacity:.7;">Sets a shake keyframe at the scrubber time. All zeros = no shake.</div>
      </div>
    </details>`;
}

function resolveCurrentMorphs(objectId) {
  const out = {};
  const s = activeScene();
  const track = s?.tracks.find(tr => tr.objectId === objectId);
  if (!track) return out;
  const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
  for (const kf of kfs) {
    if (kf.t > ed.currentTime) break;
    if (kf.morphTargets) {
      for (const [name, w] of Object.entries(kf.morphTargets)) out[name] = w;
    }
  }
  return out;
}

function resolveCurrentShake(objectId) {
  const out = { amplitude: [0, 0, 0], frequency: 0 };
  const s = activeScene();
  const track = s?.tracks.find(tr => tr.objectId === objectId);
  if (!track) return out;
  const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
  for (const kf of kfs) {
    if (kf.t > ed.currentTime) break;
    if (kf.shake) {
      out.amplitude = [...kf.shake.amplitude];
      out.frequency = kf.shake.frequency;
    }
  }
  return out;
}

function bindModelInspector(obj) {
  document.getElementById('scene-obj-name').addEventListener('change', (e) => {
    obj.name = e.target.value.trim() || undefined;
    renderTimeline();
    queueSave();
  });
  document.getElementById('scene-obj-opacity').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById('scene-obj-opacity-val').textContent = v.toFixed(2);
    writeOpacityKeyframe(obj.id, ed.currentTime, v);
    const three = ed.objectsByGuid.get(obj.id);
    if (three) setObjOpacity(three, v);
    queueSave();
  });
  const onMaterialEdit = (patch) => {
    writeMaterialKeyframe(obj.id, ed.currentTime, patch);
    const three = ed.objectsByGuid.get(obj.id);
    if (three) setObjMaterial(three, patch);
    queueSave();
  };
  document.getElementById('scene-mat-color').addEventListener('input',     (e) => onMaterialEdit({ color: e.target.value }));
  document.getElementById('scene-mat-emissive').addEventListener('input',  (e) => onMaterialEdit({ emissive: e.target.value }));
  document.getElementById('scene-mat-emi-int').addEventListener('input',   (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById('scene-mat-emi-int-val').textContent = v.toFixed(2);
    onMaterialEdit({ emissiveIntensity: v });
  });
  document.getElementById('scene-mat-metal').addEventListener('input',     (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById('scene-mat-metal-val').textContent = v.toFixed(2);
    onMaterialEdit({ metalness: v });
  });
  document.getElementById('scene-mat-rough').addEventListener('input',     (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById('scene-mat-rough-val').textContent = v.toFixed(2);
    onMaterialEdit({ roughness: v });
  });
  document.getElementById('scene-mat-wire').addEventListener('change',     (e) => onMaterialEdit({ wireframe: e.target.checked }));

  // Morph target sliders — one slider per shape-key name discovered on the
  // loaded GLB. Writes a morphTargets keyframe at scrubber time on every
  // input event so the slider doubles as a keyframe-author tool.
  document.querySelectorAll('.scene-morph-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const name = input.dataset.name;
      const v = parseFloat(e.target.value);
      const valEl = document.querySelector(`.scene-morph-val[data-name="${CSS.escape(name)}"]`);
      if (valEl) valEl.textContent = v.toFixed(2);
      upsertKeyframe(obj.id, ed.currentTime, kf => {
        kf.morphTargets = { ...(kf.morphTargets || {}), [name]: v };
      });
      const three = ed.objectsByGuid.get(obj.id);
      if (three) setObjMorphs(three, { [name]: v });
      queueSave();
    });
  });

  // Path-follow controls. Edits go through commitPathEdit so we get the
  // same validate-then-rebuild-viewport behavior whether the textarea,
  // loop checkbox, or speed input changed.
  const commitPathEdit = () => {
    const pointsText = document.getElementById('scene-path-points').value.trim();
    if (!pointsText) {
      delete obj.pathFollow;
    } else {
      let pts;
      try { pts = JSON.parse(pointsText); } catch { /* bad JSON — skip */ return; }
      if (!Array.isArray(pts) || pts.length < 2) return;
      const loop  = document.getElementById('scene-path-loop').checked;
      const speed = parseFloat(document.getElementById('scene-path-speed').value) || 1;
      obj.pathFollow = { points: pts, loop, speed };
    }
    // Curve + visual line live on the Three.js object; cheapest to just
    // rebuild the viewport so the visualizer reflects the new path.
    rebuildViewportFromActive();
    selectObject(obj.id);
    queueSave();
  };
  document.getElementById('scene-path-points').addEventListener('change', commitPathEdit);
  document.getElementById('scene-path-loop').addEventListener('change', commitPathEdit);
  document.getElementById('scene-path-speed').addEventListener('change', commitPathEdit);
  document.getElementById('scene-path-clear').addEventListener('click', () => {
    delete obj.pathFollow;
    rebuildViewportFromActive();
    selectObject(obj.id);
    queueSave();
  });

  // Shake — all four inputs commit a single keyframe at scrubber time
  // with the current amplitude vec3 + frequency.
  const commitShakeEdit = () => {
    const x = parseFloat(document.getElementById('scene-shake-x').value) || 0;
    const y = parseFloat(document.getElementById('scene-shake-y').value) || 0;
    const z = parseFloat(document.getElementById('scene-shake-z').value) || 0;
    const f = Math.max(0, parseFloat(document.getElementById('scene-shake-freq').value) || 0);
    upsertKeyframe(obj.id, ed.currentTime, kf => {
      // All-zero amplitude + zero freq deletes the channel so the schema
      // stays tidy (validator-wise, zeros are valid but pointless).
      if (x === 0 && y === 0 && z === 0 && f === 0) delete kf.shake;
      else kf.shake = { amplitude: [x, y, z], frequency: f };
    });
    queueSave();
  };
  ['scene-shake-x', 'scene-shake-y', 'scene-shake-z', 'scene-shake-freq'].forEach(id => {
    document.getElementById(id).addEventListener('change', commitShakeEdit);
  });

  document.getElementById('scene-obj-delete').addEventListener('click', () => deleteSelectedObject(obj));
}

function renderLightInspectorHtml(obj, displayName, sub) {
  const l = obj.light || {};
  const current = resolveCurrentLightProps(obj.id);
  const isPoint = (l.kind === 'point');
  return `
    <div style="font-size:.65rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em;">Selected Light</div>
    <input type="text" id="scene-obj-name" class="input-field" value="${esc(displayName)}" placeholder="Name" style="margin:0; padding:4px 6px; font-size:.78rem;">
    <div style="font-size:.6rem; color:var(--text-dim);">${sub}</div>
    <div style="display:flex; align-items:center; gap:6px;">
      <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Intensity</span>
      <input type="range" id="scene-light-intensity" min="0" max="5" step="0.05" value="${current.intensity}" style="flex:1;">
      <span id="scene-light-intensity-val" style="font-size:.6rem; min-width:28px; text-align:right; font-family:monospace;">${current.intensity.toFixed(2)}</span>
    </div>
    <div style="display:flex; align-items:center; gap:6px;">
      <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Color</span>
      <input type="color" id="scene-light-color" value="${current.color}" style="width:32px; height:22px; padding:0; border:none; background:none; cursor:pointer;">
      <span style="font-size:.6rem; font-family:monospace; opacity:.6;">${current.color}</span>
    </div>
    ${isPoint ? `
      <div style="display:flex; align-items:center; gap:6px;">
        <span style="font-size:.6rem; color:var(--text-dim); min-width:54px;">Distance</span>
        <input type="number" id="scene-light-distance" min="0" step="0.5" value="${l.distance ?? 0}" style="width:80px; margin:0; padding:2px 4px; font-size:.65rem;">
        <span style="font-size:.55rem; opacity:.6;">(0 = infinite)</span>
      </div>
    ` : ''}
    <button class="btn btn-ghost btn-sm" id="scene-obj-delete" style="color:var(--red);">🗑️ Delete Light</button>
  `;
}

function bindLightInspector(obj) {
  document.getElementById('scene-obj-name').addEventListener('change', (e) => {
    obj.name = e.target.value.trim() || undefined;
    renderTimeline();
    queueSave();
  });
  document.getElementById('scene-light-intensity').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById('scene-light-intensity-val').textContent = v.toFixed(2);
    writeLightKeyframe(obj.id, ed.currentTime, { intensity: v });
    const three = ed.objectsByGuid.get(obj.id);
    if (three?.isLight) three.intensity = v;
    queueSave();
  });
  document.getElementById('scene-light-color').addEventListener('input', (e) => {
    writeLightKeyframe(obj.id, ed.currentTime, { color: e.target.value });
    const three = ed.objectsByGuid.get(obj.id);
    if (three?.isLight) three.color.set(e.target.value);
    queueSave();
  });
  const distEl = document.getElementById('scene-light-distance');
  if (distEl) {
    distEl.addEventListener('change', (e) => {
      const v = Math.max(0, parseFloat(e.target.value) || 0);
      obj.light = { ...(obj.light || { kind: 'point' }), distance: v };
      const three = ed.objectsByGuid.get(obj.id);
      if (three?.isPointLight) three.distance = v;
      queueSave();
    });
  }
  document.getElementById('scene-obj-delete').addEventListener('click', () => deleteSelectedObject(obj));
}

// Common deletion path — used by both inspectors. Strips object + tracks
// and tears down the Three.js object (and any helper attached to it).
function deleteSelectedObject(obj) {
  const s = activeScene();
  if (!s) return;
  if (!confirm(`Delete "${obj.name || obj.asset || obj.id}"?`)) return;
  s.objects = s.objects.filter(o => o.id !== obj.id);
  s.tracks  = s.tracks.filter(tr => tr.objectId !== obj.id);
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
  // Light helpers are siblings of the light; rebuild to drop them.
  rebuildViewportFromActive();
  renderTimeline();
  queueSave();
}

// Walks the track from t=0 to ed.currentTime, returning the most recent
// values for opacity + material channels. Lets the inspector reflect what
// the viewport is actually showing (rather than defaulting to fresh values).
function resolveCurrentVisualProps(objectId) {
  const out = {
    opacity: 1,
    color: '#ffffff', emissive: '#000000',
    emissiveIntensity: 0, metalness: 0.5, roughness: 0.5,
    wireframe: false,
    hasMaterial: false,
  };
  const s = activeScene();
  const track = s?.tracks.find(tr => tr.objectId === objectId);
  if (!track) return out;
  const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
  for (const kf of kfs) {
    if (kf.t > ed.currentTime) break;
    if (kf.opacity != null) out.opacity = kf.opacity;
    if (kf.material) {
      out.hasMaterial = true;
      if (kf.material.color    != null) out.color    = kf.material.color;
      if (kf.material.emissive != null) out.emissive = kf.material.emissive;
      if (kf.material.emissiveIntensity != null) out.emissiveIntensity = kf.material.emissiveIntensity;
      if (kf.material.metalness != null) out.metalness = kf.material.metalness;
      if (kf.material.roughness != null) out.roughness = kf.material.roughness;
      if (kf.material.wireframe != null) out.wireframe = kf.material.wireframe;
    }
  }
  return out;
}

function resolveCurrentLightProps(objectId) {
  const s = activeScene();
  const obj = s?.objects.find(o => o.id === objectId);
  const base = { intensity: obj?.light?.intensity ?? 1, color: obj?.light?.color ?? '#ffffff' };
  const track = s?.tracks.find(tr => tr.objectId === objectId);
  if (!track) return base;
  const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
  for (const kf of kfs) {
    if (kf.t > ed.currentTime) break;
    if (kf.light?.intensity != null) base.intensity = kf.light.intensity;
    if (kf.light?.color     != null) base.color     = kf.light.color;
  }
  return base;
}

function writeOpacityKeyframe(objectId, t, opacity) {
  upsertKeyframe(objectId, t, kf => { kf.opacity = opacity; });
}
function writeMaterialKeyframe(objectId, t, patch) {
  upsertKeyframe(objectId, t, kf => { kf.material = { ...(kf.material || {}), ...patch }; });
}
function writeLightKeyframe(objectId, t, patch) {
  upsertKeyframe(objectId, t, kf => { kf.light = { ...(kf.light || {}), ...patch }; });
}

// Shared upsert: find-or-create a track + find-or-create a keyframe at t,
// then let the caller mutate the keyframe. Keeps the three writer wrappers
// trivial and the sort-once-after-insert pattern in one place.
function upsertKeyframe(objectId, t, mutate) {
  const s = activeScene();
  if (!s) return;
  let track = s.tracks.find(tr => tr.objectId === objectId);
  if (!track) {
    track = { objectId, keyframes: [] };
    s.tracks.push(track);
  }
  const tr = Math.max(0, Math.round(t));
  let kf = track.keyframes.find(k => k.t === tr);
  if (!kf) {
    kf = { t: tr };
    track.keyframes.push(kf);
    track.keyframes.sort((a, b) => a.t - b.t);
  }
  mutate(kf);
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

// Path-follow overrides position, then shake adds sine displacement.
// Same order the runtime player uses so the editor preview matches.
function applyPathAndShake(t) {
  const s = activeScene();
  if (!s) return;
  const dur = s.durationMs || 10000;
  const elapsedSec = t / 1000;
  for (const obj of s.objects) {
    const three = ed.objectsByGuid.get(obj.id);
    if (!three) continue;
    if (three.userData?.pathCurve) {
      const speed = three.userData.pathSpeed ?? 1;
      let alpha = (t / Math.max(1, dur)) * speed;
      if (three.userData.pathLoop) alpha = alpha - Math.floor(alpha);
      else                          alpha = Math.max(0, Math.min(1, alpha));
      const p = three.userData.pathCurve.getPoint(alpha);
      three.position.set(p.x, p.y, p.z);
    }
    const sh = three.userData?.currentShake;
    if (sh) {
      const w = 2 * Math.PI * sh.frequency;
      three.position.x += sh.amplitude[0] * Math.sin(w * elapsedSec + 0);
      three.position.y += sh.amplitude[1] * Math.sin(w * elapsedSec + 1.7);
      three.position.z += sh.amplitude[2] * Math.sin(w * elapsedSec + 3.4);
    }
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
  if (a.material && b.material) {
    const m = {};
    if (a.material.color    != null && b.material.color    != null) m.color    = lerpHex(a.material.color, b.material.color, alpha);
    if (a.material.emissive != null && b.material.emissive != null) m.emissive = lerpHex(a.material.emissive, b.material.emissive, alpha);
    if (a.material.emissiveIntensity != null && b.material.emissiveIntensity != null) m.emissiveIntensity = lerp(a.material.emissiveIntensity, b.material.emissiveIntensity, alpha);
    if (a.material.metalness != null && b.material.metalness != null) m.metalness = lerp(a.material.metalness, b.material.metalness, alpha);
    if (a.material.roughness != null && b.material.roughness != null) m.roughness = lerp(a.material.roughness, b.material.roughness, alpha);
    if (a.material.wireframe != null) m.wireframe = a.material.wireframe;
    setObjMaterial(obj, m);
  }
  if (a.light && b.light && obj.isLight) {
    if (a.light.intensity != null && b.light.intensity != null) obj.intensity = lerp(a.light.intensity, b.light.intensity, alpha);
    if (a.light.color     != null && b.light.color     != null) obj.color.set(lerpHex(a.light.color, b.light.color, alpha));
  }
  if (a.morphTargets || b.morphTargets) {
    setObjMorphs(obj, mergedMorphAt(a.morphTargets, b.morphTargets, alpha));
  }
  if (a.shake || b.shake) {
    const aAmp = a.shake?.amplitude || [0, 0, 0];
    const bAmp = b.shake?.amplitude || [0, 0, 0];
    obj.userData.currentShake = {
      amplitude: [
        lerp(aAmp[0], bAmp[0], alpha),
        lerp(aAmp[1], bAmp[1], alpha),
        lerp(aAmp[2], bAmp[2], alpha),
      ],
      frequency: lerp(a.shake?.frequency || 0, b.shake?.frequency || 0, alpha),
    };
  } else {
    obj.userData.currentShake = null;
  }
}

function applyKeyframe(obj, kf) {
  if (kf.position) obj.position.set(...kf.position);
  if (kf.rotation) obj.rotation.set(...kf.rotation);
  if (kf.scale)    obj.scale.set(...kf.scale);
  if (kf.opacity != null) setObjOpacity(obj, kf.opacity);
  if (kf.material) setObjMaterial(obj, kf.material);
  if (kf.light && obj.isLight) {
    if (kf.light.intensity != null) obj.intensity = kf.light.intensity;
    if (kf.light.color     != null) obj.color.set(kf.light.color);
  }
  if (kf.morphTargets) setObjMorphs(obj, kf.morphTargets);
  if (kf.shake) {
    obj.userData.currentShake = {
      amplitude: [...kf.shake.amplitude],
      frequency: kf.shake.frequency,
    };
  } else {
    obj.userData.currentShake = null;
  }
}

function mergedMorphAt(aM, bM, alpha) {
  const names = new Set([...Object.keys(aM || {}), ...Object.keys(bM || {})]);
  const out = {};
  for (const n of names) out[n] = lerp(aM?.[n] ?? 0, bM?.[n] ?? 0, alpha);
  return out;
}

function setObjMorphs(obj, weights) {
  const meshes = obj.userData?.morphMeshes;
  if (!meshes) return;
  for (const { mesh, dict } of meshes) {
    for (const [name, w] of Object.entries(weights)) {
      const idx = dict[name];
      if (idx != null) mesh.morphTargetInfluences[idx] = w;
    }
  }
}

function setObjMaterial(obj, m) {
  obj.traverse?.(child => {
    const mats = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : null;
    if (!mats) return;
    for (const mat of mats) {
      if (m.color    != null && mat.color)    mat.color.set(m.color);
      if (m.emissive != null && mat.emissive) mat.emissive.set(m.emissive);
      if (m.emissiveIntensity != null && 'emissiveIntensity' in mat) mat.emissiveIntensity = m.emissiveIntensity;
      if (m.metalness != null && 'metalness' in mat) mat.metalness = m.metalness;
      if (m.roughness != null && 'roughness' in mat) mat.roughness = m.roughness;
      if (m.wireframe != null && 'wireframe' in mat) mat.wireframe = m.wireframe;
    }
  });
}

function lerpHex(aHex, bHex, alpha) {
  const a = parseHex(aHex), b = parseHex(bHex);
  return '#' + [
    Math.round(lerp(a[0], b[0], alpha)),
    Math.round(lerp(a[1], b[1], alpha)),
    Math.round(lerp(a[2], b[2], alpha)),
  ].map(n => n.toString(16).padStart(2, '0')).join('');
}
function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
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
    refreshMountWidgetPicker();
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
    applyPathAndShake(ed.currentTime);
    applyCameraAtTime(ed.currentTime);
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
  const dur = s.durationMs || 10000;
  const cameraKfs = s.cameraTrack?.keyframes || [];
  const forkClips = s.forkClips || [];
  const branchClips = s.branchClips || [];
  // Camera track always renders, even with zero keyframes — gives the
  // streamer a visible target for the "📷 Key Camera" button. Object
  // tracks below it appear only when at least one object exists.
  const cameraRowHtml = `
    <div class="scene-track-row" data-camera-track="1"
         style="display:flex; align-items:center; height:32px; border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(255,200,80,0.06);">
      <div style="width:160px; padding:0 10px; font-size:.7rem; color:var(--text); flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">📷 Camera</div>
      <div class="scene-track-strip" data-camera-strip="1" style="flex:1; position:relative; height:100%; cursor:crosshair;">
        ${cameraKfs.map(kf => {
          const pct = Math.max(0, Math.min(100, (kf.t / dur) * 100));
          const easingHint = kf.easing ? ` • ${kf.easing}` : '';
          const borderColor = kf.easing && kf.easing !== 'linear' ? '#ff9933' : '#000';
          const borderWidth = kf.easing && kf.easing !== 'linear' ? '2px' : '1px';
          return `<div class="scene-cam-keyframe"
                       data-keyframe-t="${kf.t}"
                       title="Camera t=${kf.t}ms${easingHint} (drag to retime, right-click for options)"
                       style="position:absolute; left:${pct}%; top:50%; transform:translate(-50%,-50%) rotate(45deg);
                              width:10px; height:10px; background:#ffcc55;
                              border:${borderWidth} solid ${borderColor}; cursor:ew-resize;"></div>`;
        }).join('')}
      </div>
    </div>`;

  // Fork-clip row: green diamonds, distinct from camera (gold) and object
  // (purple/orange) keyframes. Always rendered so the "+ Add Fork" button
  // has a visible target row even when no forks exist yet.
  const forksRowHtml = `
    <div class="scene-track-row"
         style="display:flex; align-items:center; height:32px; border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(80,220,120,0.06);">
      <div style="width:160px; padding:0 10px; font-size:.7rem; color:var(--text); flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🔀 Forks</div>
      <div class="scene-track-strip" data-fork-strip="1" style="flex:1; position:relative; height:100%; cursor:crosshair;">
        ${forkClips.map(fc => {
          const pct = Math.max(0, Math.min(100, (fc.start / dur) * 100));
          const targetLabel = fc.target ? `${fc.target.type}${fc.target.flowId ? ':'+fc.target.flowId : ''}${fc.target.sceneId ? ':'+fc.target.sceneId : ''}${fc.target.eventType ? ':'+fc.target.eventType : ''}${fc.target.effect ? ':'+fc.target.effect : ''}` : '(unset)';
          return `<div class="scene-fork-keyframe"
                       data-fork-id="${esc(fc.id)}"
                       title="Fork @ ${fc.start}ms → ${esc(targetLabel)} (drag to retime, right-click for options)"
                       style="position:absolute; left:${pct}%; top:50%; transform:translate(-50%,-50%) rotate(45deg);
                              width:10px; height:10px; background:#66dd88;
                              border:1px solid #000; cursor:ew-resize;"></div>`;
        }).join('')}
      </div>
    </div>`;

  // Branch-clip row: red diamonds. Pinned alongside forks so all
  // control-flow markers are visually adjacent. Loop region (if set)
  // renders as a faint horizontal bar under the diamond to make it
  // obvious which clips have authored wait loops vs. freeze-frame
  // waits.
  const branchesRowHtml = `
    <div class="scene-track-row"
         style="display:flex; align-items:center; height:32px; border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(220,80,120,0.06);">
      <div style="width:160px; padding:0 10px; font-size:.7rem; color:var(--text); flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🌿 Branches</div>
      <div class="scene-track-strip" data-branch-strip="1" style="flex:1; position:relative; height:100%; cursor:crosshair;">
        ${branchClips.map(bc => {
          const pct = Math.max(0, Math.min(100, (bc.start / dur) * 100));
          const loopBarHtml = bc.loopRegion ? (() => {
            const lf = Math.max(0, Math.min(100, (bc.loopRegion.from / dur) * 100));
            const lt = Math.max(0, Math.min(100, (bc.loopRegion.to   / dur) * 100));
            return `<div style="position:absolute; left:${lf}%; width:${lt - lf}%; top:60%; height:4px; background:rgba(220,80,120,0.5); border-radius:2px; pointer-events:none;"></div>`;
          })() : '';
          const branchCount = (bc.branches || []).length;
          return `${loopBarHtml}<div class="scene-branch-keyframe"
                       data-branch-id="${esc(bc.id)}"
                       title="Branch @ ${bc.start}ms · wait ${esc(bc.wait?.eventType || '?')} · ${branchCount} branches (drag to retime, right-click to edit)"
                       style="position:absolute; left:${pct}%; top:40%; transform:translate(-50%,-50%) rotate(45deg);
                              width:11px; height:11px; background:#dd5078;
                              border:1px solid #000; cursor:ew-resize;"></div>`;
        }).join('')}
      </div>
    </div>`;

  if (s.tracks.length === 0) {
    body.innerHTML = cameraRowHtml + forksRowHtml + branchesRowHtml + `<div style="padding:20px; color:var(--text-dim); font-size:.72rem; opacity:.6;">Add an object to the scene to start a track.</div>`;
    bindCameraKeyframes(body);
    bindForkKeyframes(body);
    bindBranchKeyframes(body);
    return;
  }
  body.innerHTML = cameraRowHtml + forksRowHtml + branchesRowHtml + s.tracks.map(track => {
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
  bindCameraKeyframes(body);
  bindForkKeyframes(body);
  bindBranchKeyframes(body);

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

// ── Fork clips ───────────────────────────────────────────────────────
// Fire-and-forget timeline markers. Reach into the flow engine / bus
// from a scene mid-playback. v0.4.6 supports four target types:
//   - effect: broadcast an overlay effect (e.g. sticker-rain)
//   - flow:   fire a flow by id (server side runs its chain)
//   - event:  publish a bus event (so other flows can trigger on it)
//   - scene:  play another scene (replaces the current one)
// Branch clips (pause-and-wait, with loop region) deferred to v0.4.7 —
// the runtime path needs a server↔overlay event bridge that's its own
// architecture. CYOA in v0.4.6 works via scene-end → awaitResult flow.

function addForkAtScrubber() {
  const s = activeScene();
  if (!s) return;
  if (!s.forkClips) s.forkClips = [];
  // Default to firing the lightest no-config effect (confetti) so a
  // newly-added fork doesn't look like a no-op. The streamer edits the
  // target via right-click to pick what they actually want.
  s.forkClips.push({
    id: 'fork-' + Math.random().toString(36).slice(2, 10),
    start: Math.max(0, Math.round(ed.currentTime)),
    target: { type: 'effect', effect: 'confetti', payload: {} },
  });
  renderTimeline();
  queueSave();
}

function bindForkKeyframes(body) {
  body.querySelectorAll('.scene-fork-keyframe').forEach(diamond => bindForkDiamond(diamond));
}

function bindForkDiamond(diamond) {
  diamond.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openForkContextMenu(e.clientX, e.clientY, diamond.dataset.forkId);
  });
  diamond.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const forkId = diamond.dataset.forkId;
    const startX = e.clientX;
    const startT = (activeScene()?.forkClips || []).find(f => f.id === forkId)?.start ?? 0;
    const strip = diamond.closest('.scene-track-strip');
    const stripRect = strip.getBoundingClientRect();
    const dur = activeScene()?.durationMs || 10000;
    let moved = false;
    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      if (!moved && Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      let newT = Math.round(startT + (dx / stripRect.width) * dur);
      if (mv.shiftKey) newT = Math.round(newT / 100) * 100;
      newT = Math.max(0, Math.min(dur, newT));
      const fc = (activeScene()?.forkClips || []).find(f => f.id === forkId);
      if (!fc) return;
      fc.start = newT;
      diamond.style.left = ((newT / dur) * 100) + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (moved) { renderTimeline(); queueSave(); }
      else {
        // Click = open menu (no separate seek behavior since forks have
        // no playhead semantic the way object/camera keyframes do).
        const rect = diamond.getBoundingClientRect();
        openForkContextMenu(rect.left + rect.width, rect.top, forkId);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function openForkContextMenu(x, y, forkId) {
  closeKeyframeContextMenu();
  const s = activeScene();
  const fc = s?.forkClips?.find(f => f.id === forkId);
  if (!fc) return;

  const menu = document.createElement('div');
  menu.id = 'scene-kf-menu';
  menu.style.cssText = `position:fixed; left:${x}px; top:${y}px; background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:8px 10px; box-shadow:0 8px 24px rgba(0,0,0,0.5); z-index:99999; font-size:.72rem; min-width:240px; display:flex; flex-direction:column; gap:6px;`;

  // studio.js owns the flow list; expose it via window so we can populate
  // the dropdown without re-fetching. Falls back to an empty list if the
  // Studio tab hasn't been opened yet.
  const flowList = window.flows || [];
  const sceneList = (ed.scenes || []).filter(sc => sc.id !== s.id);
  menu.innerHTML = `
    <div style="font-size:.6rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em;">🔀 Fork @ ${fmtMs(fc.start)}</div>
    <label style="display:flex; align-items:center; gap:6px;">Type
      <select id="fork-type" class="input-field" style="flex:1; margin:0; padding:2px 4px;">
        <option value="effect" ${fc.target?.type === 'effect' ? 'selected' : ''}>Effect</option>
        <option value="flow"   ${fc.target?.type === 'flow'   ? 'selected' : ''}>Flow</option>
        <option value="scene"  ${fc.target?.type === 'scene'  ? 'selected' : ''}>Scene</option>
        <option value="event"  ${fc.target?.type === 'event'  ? 'selected' : ''}>Event</option>
      </select>
    </label>
    <div id="fork-config"></div>
    <div style="display:flex; gap:8px; margin-top:4px;">
      <button class="btn btn-ghost btn-sm" id="fork-delete" style="color:var(--red); flex:1;">✕ Delete</button>
      <button class="btn btn-primary btn-sm" id="fork-done" style="flex:1;">Done</button>
    </div>
  `;
  document.body.appendChild(menu);

  const cfgEl = menu.querySelector('#fork-config');
  const renderCfg = () => {
    const type = menu.querySelector('#fork-type').value;
    if (type === 'effect') {
      cfgEl.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">Effect
          <input id="fork-effect" class="input-field" style="flex:1; margin:0; padding:2px 4px;" value="${esc(fc.target?.effect || 'confetti')}">
        </label>`;
    } else if (type === 'flow') {
      cfgEl.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">Flow
          <select id="fork-flow" class="input-field" style="flex:1; margin:0; padding:2px 4px;">
            ${flowList.map(f => `<option value="${esc(f.id)}" ${f.id === fc.target?.flowId ? 'selected' : ''}>${esc(f.name || f.id)}</option>`).join('') || `<option value="">(no flows)</option>`}
          </select>
        </label>`;
    } else if (type === 'scene') {
      cfgEl.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">Scene
          <select id="fork-scene" class="input-field" style="flex:1; margin:0; padding:2px 4px;">
            ${sceneList.map(sc => `<option value="${esc(sc.id)}" ${sc.id === fc.target?.sceneId ? 'selected' : ''}>${esc(sc.name || sc.id)}</option>`).join('') || `<option value="">(no other scenes)</option>`}
          </select>
        </label>`;
    } else if (type === 'event') {
      cfgEl.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">Type
          <input id="fork-event-type" class="input-field" style="flex:1; margin:0; padding:2px 4px;" value="${esc(fc.target?.eventType || 'custom')}">
        </label>`;
    }
  };
  renderCfg();
  menu.querySelector('#fork-type').addEventListener('change', renderCfg);
  menu.querySelector('#fork-done').addEventListener('click', () => {
    const type = menu.querySelector('#fork-type').value;
    const t = { type };
    if (type === 'effect') { t.effect = menu.querySelector('#fork-effect').value.trim() || 'confetti'; t.payload = {}; }
    if (type === 'flow')   t.flowId  = menu.querySelector('#fork-flow')?.value || '';
    if (type === 'scene')  t.sceneId = menu.querySelector('#fork-scene')?.value || '';
    if (type === 'event')  { t.eventType = menu.querySelector('#fork-event-type').value.trim() || 'custom'; t.payload = {}; }
    fc.target = t;
    renderTimeline();
    queueSave();
    closeKeyframeContextMenu();
  });
  menu.querySelector('#fork-delete').addEventListener('click', () => {
    activeScene().forkClips = (activeScene().forkClips || []).filter(f => f.id !== forkId);
    renderTimeline();
    queueSave();
    closeKeyframeContextMenu();
  });
  setTimeout(() => {
    const off = (ev) => {
      if (!menu.contains(ev.target)) { closeKeyframeContextMenu(); document.removeEventListener('mousedown', off); }
    };
    document.addEventListener('mousedown', off);
  }, 0);
}

// ── Branch clips ─────────────────────────────────────────────────────
// Pause-and-wait timeline markers. Authored at a time T with an optional
// loop region (animation cycles while waiting), a wait config (event
// type to listen for), an ordered branches list (first-match-wins on
// the event payload), and an optional timeout. v0.4.7 supports
// wait.kind='event' only — derived kinds (chat-command, redeem) land
// in a later phase as match-shortcut sugar over the event primitive.

function addBranchAtScrubber() {
  const s = activeScene();
  if (!s) return;
  if (!s.branchClips) s.branchClips = [];
  const t = Math.max(0, Math.round(ed.currentTime));
  s.branchClips.push({
    id: 'branch-' + Math.random().toString(36).slice(2, 10),
    start: t,
    // Default loop region of 1 second past the clip start so the scene
    // doesn't freeze on a single frame while waiting — the streamer
    // tunes from there.
    loopRegion: { from: t, to: Math.min(s.durationMs, t + 1000) },
    wait: { kind: 'event', eventType: 'dice-rolled' },
    // Single fallback branch jumping to scene-end. Streamers add their
    // real branches via the editor; the default exists so an unedited
    // branch clip still completes the scene rather than waiting forever.
    branches: [{ match: {}, target: { type: 'scene-end' } }],
    timeout: { ms: 30000, target: { type: 'scene-end' } },
  });
  renderTimeline();
  queueSave();
}

function bindBranchKeyframes(body) {
  body.querySelectorAll('.scene-branch-keyframe').forEach(d => bindBranchDiamond(d));
}

function bindBranchDiamond(diamond) {
  diamond.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openBranchEditor(e.clientX, e.clientY, diamond.dataset.branchId);
  });
  diamond.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const branchId = diamond.dataset.branchId;
    const startX = e.clientX;
    const startT = (activeScene()?.branchClips || []).find(b => b.id === branchId)?.start ?? 0;
    const strip = diamond.closest('.scene-track-strip');
    const stripRect = strip.getBoundingClientRect();
    const dur = activeScene()?.durationMs || 10000;
    let moved = false;
    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      if (!moved && Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      let newT = Math.round(startT + (dx / stripRect.width) * dur);
      if (mv.shiftKey) newT = Math.round(newT / 100) * 100;
      newT = Math.max(0, Math.min(dur, newT));
      const bc = (activeScene()?.branchClips || []).find(b => b.id === branchId);
      if (!bc) return;
      // Slide the loop region by the same delta so it stays anchored
      // around the branch clip — the streamer's typical authoring
      // intent is "the loop happens right before this branch fires."
      if (bc.loopRegion) {
        const delta = newT - bc.start;
        bc.loopRegion.from = Math.max(0, bc.loopRegion.from + delta);
        bc.loopRegion.to   = Math.max(bc.loopRegion.from + 100, bc.loopRegion.to + delta);
      }
      bc.start = newT;
      diamond.style.left = ((newT / dur) * 100) + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (moved) { renderTimeline(); queueSave(); }
      else {
        const rect = diamond.getBoundingClientRect();
        openBranchEditor(rect.left + rect.width, rect.top, branchId);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// Branch clip editor — wider than the simple right-click menus since
// it has to surface wait config + loop region + multiple branches +
// timeout. Built as a floating panel so it can grow as branches are
// added. Closes on outside click (after a one-tick delay).
function openBranchEditor(x, y, branchId) {
  closeKeyframeContextMenu();
  const s = activeScene();
  const bc = s?.branchClips?.find(b => b.id === branchId);
  if (!bc) return;

  const menu = document.createElement('div');
  menu.id = 'scene-kf-menu';
  // Position so the editor stays on-screen if the click was near the
  // right or bottom edge of the viewport. Cap height so the branch
  // list scrolls inside the panel rather than overflowing.
  const left = Math.min(x, window.innerWidth - 380);
  const top  = Math.min(y, window.innerHeight - 360);
  menu.style.cssText = `position:fixed; left:${left}px; top:${top}px; background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:10px 12px; box-shadow:0 8px 24px rgba(0,0,0,0.5); z-index:99999; font-size:.7rem; width:360px; max-height:80vh; overflow-y:auto; display:flex; flex-direction:column; gap:8px;`;
  document.body.appendChild(menu);
  renderBranchEditor(menu, bc);

  setTimeout(() => {
    const off = (ev) => {
      if (!menu.contains(ev.target)) { closeKeyframeContextMenu(); document.removeEventListener('mousedown', off); }
    };
    document.addEventListener('mousedown', off);
  }, 0);
}

function renderBranchEditor(menu, bc) {
  const dur = activeScene()?.durationMs || 10000;
  const sceneList = (ed.scenes || []).filter(sc => sc.id !== activeScene().id);
  const flowList  = window.flows || [];

  menu.innerHTML = `
    <div style="font-size:.6rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em;">🌿 Branch @ ${fmtMs(bc.start)}</div>

    <fieldset style="border:1px solid var(--border); border-radius:4px; padding:6px 8px; display:flex; flex-direction:column; gap:4px;">
      <legend style="font-size:.6rem; color:var(--text-dim); padding:0 4px;">Wait For</legend>
      <label style="display:flex; align-items:center; gap:6px;">Event type
        <input id="bc-wait-type" class="input-field" style="flex:1; margin:0; padding:2px 4px;" value="${esc(bc.wait?.eventType || 'dice-rolled')}">
      </label>
      <div style="font-size:.55rem; color:var(--text-dim); opacity:.7;">e.g. dice-rolled (from rollDice), chat (from chat messages), or any custom event your flows publish.</div>
    </fieldset>

    <fieldset style="border:1px solid var(--border); border-radius:4px; padding:6px 8px; display:flex; flex-direction:column; gap:4px;">
      <legend style="font-size:.6rem; color:var(--text-dim); padding:0 4px;">Loop Region</legend>
      <label style="display:inline-flex; align-items:center; gap:6px;">
        <input type="checkbox" id="bc-loop-on" ${bc.loopRegion ? 'checked' : ''}> Cycle animation while waiting
      </label>
      <div id="bc-loop-range" style="display:${bc.loopRegion ? 'flex' : 'none'}; gap:6px; align-items:center;">
        <span>from</span>
        <input type="number" id="bc-loop-from" min="0" max="${dur}" step="100" value="${bc.loopRegion?.from ?? bc.start}" style="width:80px; margin:0; padding:2px 4px;">
        <span>to</span>
        <input type="number" id="bc-loop-to"   min="0" max="${dur}" step="100" value="${bc.loopRegion?.to ?? (bc.start + 1000)}" style="width:80px; margin:0; padding:2px 4px;">
        <span style="opacity:.7;">ms</span>
      </div>
    </fieldset>

    <fieldset style="border:1px solid var(--border); border-radius:4px; padding:6px 8px; display:flex; flex-direction:column; gap:4px;">
      <legend style="font-size:.6rem; color:var(--text-dim); padding:0 4px;">Branches (first match wins)</legend>
      <div id="bc-branches" style="display:flex; flex-direction:column; gap:6px;"></div>
      <button id="bc-add-branch" class="btn btn-ghost btn-sm" style="padding:2px 8px; align-self:flex-start; font-size:.65rem;">+ Add Branch</button>
    </fieldset>

    <fieldset style="border:1px solid var(--border); border-radius:4px; padding:6px 8px; display:flex; flex-direction:column; gap:4px;">
      <legend style="font-size:.6rem; color:var(--text-dim); padding:0 4px;">Timeout</legend>
      <label style="display:inline-flex; align-items:center; gap:6px;">
        <input type="checkbox" id="bc-to-on" ${bc.timeout ? 'checked' : ''}>
        After <input type="number" id="bc-to-ms" min="100" step="500" value="${bc.timeout?.ms ?? 30000}" style="width:80px; margin:0; padding:2px 4px;"> ms
      </label>
      <div id="bc-to-target-wrap" style="display:${bc.timeout ? 'block' : 'none'};"></div>
    </fieldset>

    <div style="display:flex; gap:8px;">
      <button class="btn btn-ghost btn-sm" id="bc-delete" style="color:var(--red); flex:1;">✕ Delete branch clip</button>
      <button class="btn btn-primary btn-sm" id="bc-save"    style="flex:1;">Save</button>
    </div>
  `;

  const branchListEl = menu.querySelector('#bc-branches');
  const renderBranchList = () => {
    branchListEl.innerHTML = (bc.branches || []).map((br, idx) => `
      <div data-branch-idx="${idx}" style="background:var(--surface2); padding:6px; border-radius:4px; display:flex; flex-direction:column; gap:4px;">
        <div style="display:flex; gap:4px; align-items:center;">
          <span style="font-size:.55rem; color:var(--text-dim); min-width:36px;">match</span>
          <input class="bc-match-json" data-idx="${idx}" style="flex:1; padding:2px 4px; font-family:monospace; font-size:.65rem; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:3px;" value="${esc(JSON.stringify(br.match || {}))}" placeholder='{"value":6}'>
          <button class="bc-del-branch btn btn-ghost btn-sm" data-idx="${idx}" style="padding:2px 6px; font-size:.6rem; color:var(--red);">✕</button>
        </div>
        <div class="bc-target-wrap" data-idx="${idx}"></div>
      </div>
    `).join('');
    // Render target editor for each branch.
    branchListEl.querySelectorAll('.bc-target-wrap').forEach(wrap => {
      const idx = parseInt(wrap.dataset.idx, 10);
      wrap.innerHTML = targetEditorHtml('branch-' + idx, bc.branches[idx].target, sceneList, flowList, dur);
      bindTargetEditor(wrap, 'branch-' + idx, target => { bc.branches[idx].target = target; });
    });
    branchListEl.querySelectorAll('.bc-match-json').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        try { bc.branches[idx].match = JSON.parse(e.target.value || '{}'); }
        catch { /* keep last good — input retains the bad text for fixing */ }
      });
    });
    branchListEl.querySelectorAll('.bc-del-branch').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        bc.branches.splice(idx, 1);
        if (bc.branches.length === 0) bc.branches.push({ match: {}, target: { type: 'scene-end' } });
        renderBranchList();
      });
    });
  };
  renderBranchList();
  menu.querySelector('#bc-add-branch').addEventListener('click', () => {
    bc.branches.push({ match: {}, target: { type: 'jump', time: Math.min(dur, bc.start + 1000) } });
    renderBranchList();
  });

  // Loop region toggle.
  menu.querySelector('#bc-loop-on').addEventListener('change', (e) => {
    const range = menu.querySelector('#bc-loop-range');
    if (e.target.checked) {
      range.style.display = 'flex';
      if (!bc.loopRegion) bc.loopRegion = { from: bc.start, to: Math.min(dur, bc.start + 1000) };
    } else {
      range.style.display = 'none';
      delete bc.loopRegion;
    }
  });

  // Timeout toggle + target editor.
  const renderTimeoutTarget = () => {
    const wrap = menu.querySelector('#bc-to-target-wrap');
    if (!bc.timeout) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = targetEditorHtml('to', bc.timeout.target, sceneList, flowList, dur);
    bindTargetEditor(wrap, 'to', target => { bc.timeout.target = target; });
  };
  renderTimeoutTarget();
  menu.querySelector('#bc-to-on').addEventListener('change', (e) => {
    if (e.target.checked) {
      bc.timeout = bc.timeout || { ms: 30000, target: { type: 'scene-end' } };
      menu.querySelector('#bc-to-target-wrap').style.display = 'block';
    } else {
      delete bc.timeout;
      menu.querySelector('#bc-to-target-wrap').style.display = 'none';
    }
    renderTimeoutTarget();
  });

  menu.querySelector('#bc-save').addEventListener('click', () => {
    bc.wait = { kind: 'event', eventType: menu.querySelector('#bc-wait-type').value.trim() || 'dice-rolled' };
    if (menu.querySelector('#bc-loop-on').checked) {
      const lf = parseInt(menu.querySelector('#bc-loop-from').value, 10) || bc.start;
      const lt = parseInt(menu.querySelector('#bc-loop-to').value,   10) || (bc.start + 1000);
      bc.loopRegion = { from: Math.max(0, lf), to: Math.max(lf + 100, lt) };
    }
    if (menu.querySelector('#bc-to-on').checked) {
      bc.timeout = bc.timeout || { ms: 30000, target: { type: 'scene-end' } };
      bc.timeout.ms = Math.max(100, parseInt(menu.querySelector('#bc-to-ms').value, 10) || 30000);
    }
    renderTimeline();
    queueSave();
    closeKeyframeContextMenu();
  });
  menu.querySelector('#bc-delete').addEventListener('click', () => {
    activeScene().branchClips = (activeScene().branchClips || []).filter(b => b.id !== bc.id);
    renderTimeline();
    queueSave();
    closeKeyframeContextMenu();
  });
}

// Reusable target editor HTML — used by branch[].target and timeout.target.
// The prefix arg disambiguates IDs when multiple editors live in the same
// container (each branch row + the timeout row).
function targetEditorHtml(prefix, target, sceneList, flowList, dur) {
  const t = target || { type: 'jump', time: 0 };
  const types = ['jump', 'scene', 'scene-end', 'flow', 'effect'];
  return `
    <div style="display:flex; gap:4px; flex-direction:column;">
      <div style="display:flex; gap:4px; align-items:center;">
        <span style="font-size:.55rem; color:var(--text-dim); min-width:36px;">→</span>
        <select id="tgt-type-${prefix}" class="input-field" style="flex:1; margin:0; padding:2px 4px; font-size:.65rem;">
          ${types.map(tt => `<option value="${tt}" ${tt === t.type ? 'selected' : ''}>${tt}</option>`).join('')}
        </select>
      </div>
      <div id="tgt-cfg-${prefix}" style="padding-left:42px; font-size:.65rem;"></div>
    </div>
  `;
}

function bindTargetEditor(wrap, prefix, onChange) {
  const typeSel = wrap.querySelector(`#tgt-type-${prefix}`);
  const cfgEl   = wrap.querySelector(`#tgt-cfg-${prefix}`);
  const s = activeScene();
  const sceneList = (ed.scenes || []).filter(sc => sc.id !== s.id);
  const flowList  = window.flows || [];
  const dur = s.durationMs || 10000;

  const target = (() => {
    // Recover current target from the enclosing data so re-renders keep
    // selected values. Caller passes onChange; we mutate via the same.
    return { type: typeSel.value };
  })();

  const renderCfg = () => {
    const type = typeSel.value;
    if (type === 'jump') {
      cfgEl.innerHTML = `time <input id="tgt-${prefix}-time" type="number" min="0" max="${dur}" step="100" style="width:80px; padding:2px 4px;"> ms`;
    } else if (type === 'scene') {
      cfgEl.innerHTML = `<select id="tgt-${prefix}-scene" class="input-field" style="margin:0; padding:2px 4px; font-size:.65rem;">${sceneList.map(sc => `<option value="${esc(sc.id)}">${esc(sc.name || sc.id)}</option>`).join('') || '<option>(no other scenes)</option>'}</select>`;
    } else if (type === 'flow') {
      cfgEl.innerHTML = `<select id="tgt-${prefix}-flow" class="input-field" style="margin:0; padding:2px 4px; font-size:.65rem;">${flowList.map(f => `<option value="${esc(f.id)}">${esc(f.name || f.id)}</option>`).join('') || '<option>(no flows)</option>'}</select>`;
    } else if (type === 'effect') {
      cfgEl.innerHTML = `effect <input id="tgt-${prefix}-effect" class="input-field" style="width:140px; padding:2px 4px;" value="confetti">`;
    } else {
      cfgEl.innerHTML = '';
    }
    pushTarget();
    cfgEl.querySelectorAll('input,select').forEach(el => el.addEventListener('change', pushTarget));
  };
  const pushTarget = () => {
    const type = typeSel.value;
    const out = { type };
    if (type === 'jump')   out.time    = parseInt(document.getElementById(`tgt-${prefix}-time`)?.value, 10) || 0;
    if (type === 'scene')  out.sceneId = document.getElementById(`tgt-${prefix}-scene`)?.value || '';
    if (type === 'flow')   out.flowId  = document.getElementById(`tgt-${prefix}-flow`)?.value || '';
    if (type === 'effect') { out.effect = document.getElementById(`tgt-${prefix}-effect`)?.value || 'confetti'; out.payload = {}; }
    onChange(out);
  };
  typeSel.addEventListener('change', renderCfg);
  renderCfg();
}

// ── Mount-mode widget picker ─────────────────────────────────────────
async function refreshMountWidgetPicker() {
  const wrap = document.getElementById('scenes-mount-widget-wrap');
  const sel  = document.getElementById('scenes-mount-widget-id');
  if (!wrap || !sel) return;
  const s = activeScene();
  if (s?.mountMode !== 'widget') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'inline-flex';
  // Pull the live widget list every time the picker opens. Cheap (small
  // JSON) and avoids stale-id problems if the user just added a widget
  // in the Layout tab without refreshing the dashboard.
  let widgets = [];
  try { widgets = await (await fetch('/api/widgets')).json(); } catch {}
  const current = s.targetWidgetId || '';
  if (widgets.length === 0) {
    sel.innerHTML = `<option value="">(no widgets — add one in Layout first)</option>`;
  } else {
    sel.innerHTML = widgets.map(w => {
      const label = `${w.type}${w.config?.label ? ' · ' + w.config.label : ''} (${w.id.slice(0, 8)})`;
      return `<option value="${esc(w.id)}" ${w.id === current ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
    if (!current && widgets[0]) {
      s.targetWidgetId = widgets[0].id;
      queueSave();
    }
  }
}

// ── Camera track ─────────────────────────────────────────────────────
function captureCameraKeyframe() {
  const s = activeScene();
  if (!s) return;
  if (!s.cameraTrack) s.cameraTrack = { keyframes: [] };
  const cam = ed.three.camera;
  const orbit = ed.three.orbit;
  // OrbitControls keeps the target separate from camera.matrix; reading
  // .target gives the lookAt point the user has been orbiting around.
  const target = orbit.target;
  const t = Math.max(0, Math.round(ed.currentTime));
  const kf = {
    t,
    position: [cam.position.x, cam.position.y, cam.position.z],
    lookAt:   [target.x, target.y, target.z],
    fov:      cam.fov,
  };
  const existing = s.cameraTrack.keyframes.find(k => k.t === t);
  if (existing) {
    Object.assign(existing, kf);
  } else {
    s.cameraTrack.keyframes.push(kf);
    s.cameraTrack.keyframes.sort((a, b) => a.t - b.t);
  }
  renderTimeline();
  queueSave();
}

function bindCameraKeyframes(body) {
  body.querySelectorAll('.scene-cam-keyframe').forEach(diamond => bindCamKeyframeDiamond(diamond));
}

// Camera keyframes use the same mousedown-driven click/drag pattern as
// object keyframes, but write into scene.cameraTrack.keyframes and the
// right-click menu's edits target the camera kf.
function bindCamKeyframeDiamond(diamond) {
  diamond.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCameraKeyframeMenu(e.clientX, e.clientY, parseInt(diamond.dataset.keyframeT, 10));
  });
  diamond.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startT = parseInt(diamond.dataset.keyframeT, 10);
    const startX = e.clientX;
    const strip = diamond.closest('.scene-track-strip');
    const stripRect = strip.getBoundingClientRect();
    const dur = activeScene()?.durationMs || 10000;
    let moved = false;
    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      if (!moved && Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      let newT = Math.round(startT + (dx / stripRect.width) * dur);
      if (mv.shiftKey) newT = Math.round(newT / 100) * 100;
      newT = Math.max(0, Math.min(dur, newT));
      const kfs = activeScene()?.cameraTrack?.keyframes;
      if (!kfs) return;
      const kf = kfs.find(k => k.t === parseInt(diamond.dataset.keyframeT, 10));
      if (!kf) return;
      if (newT !== kf.t && kfs.some(k => k.t === newT && k !== kf)) return;
      kf.t = newT;
      diamond.dataset.keyframeT = String(newT);
      diamond.style.left = ((newT / dur) * 100) + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (moved) {
        const kfs = activeScene()?.cameraTrack?.keyframes;
        if (kfs) kfs.sort((a, b) => a.t - b.t);
        renderTimeline();
        queueSave();
      } else {
        ed.currentTime = startT;
        ed.isPlaying = false;
        applyTracksAtTime(startT);
        applyPathAndShake(startT);
        applyCameraAtTime(startT);
        renderTimelineHead();
        renderTimeDisplay();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function openCameraKeyframeMenu(x, y, t) {
  closeKeyframeContextMenu();
  const kfs = activeScene()?.cameraTrack?.keyframes;
  const kf  = kfs?.find(k => k.t === t);
  if (!kf) return;
  const menu = document.createElement('div');
  menu.id = 'scene-kf-menu';
  menu.style.cssText = `position:fixed; left:${x}px; top:${y}px; background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:6px 0; box-shadow:0 8px 24px rgba(0,0,0,0.5); z-index:99999; font-size:.72rem; min-width:200px; max-height:80vh; overflow-y:auto;`;
  const head = document.createElement('div');
  head.textContent = `📷 Camera @ ${fmtMs(t)}`;
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
      if (name === 'linear') delete kf.easing; else kf.easing = name;
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
    activeScene().cameraTrack.keyframes = kfs.filter(k => k.t !== t);
    renderTimeline();
    queueSave();
    closeKeyframeContextMenu();
  });
  menu.appendChild(del);
  document.body.appendChild(menu);
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

// Applies the camera state at time t from cameraTrack keyframes. Skips if
// the active scene has no cameraTrack (lets OrbitControls stay in charge).
function applyCameraAtTime(t) {
  const s = activeScene();
  const kfs = s?.cameraTrack?.keyframes;
  if (!kfs || kfs.length === 0) return;
  const cam = ed.three.camera;
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  let from, to;
  if (t <= sorted[0].t) from = to = sorted[0];
  else if (t >= sorted[sorted.length - 1].t) from = to = sorted[sorted.length - 1];
  else {
    let i = 0;
    while (i < sorted.length - 1 && sorted[i + 1].t < t) i++;
    from = sorted[i]; to = sorted[i + 1];
  }
  if (from === to) {
    if (from.position) cam.position.set(...from.position);
    if (from.fov != null) { cam.fov = from.fov; cam.updateProjectionMatrix(); }
    if (from.lookAt) { ed.three.orbit.target.set(...from.lookAt); cam.lookAt(...from.lookAt); }
    return;
  }
  const span = to.t - from.t;
  const alpha = resolveEasing(from.easing)((t - from.t) / Math.max(1, span));
  if (from.position && to.position) cam.position.set(
    lerp(from.position[0], to.position[0], alpha),
    lerp(from.position[1], to.position[1], alpha),
    lerp(from.position[2], to.position[2], alpha),
  );
  if (from.fov != null && to.fov != null) {
    cam.fov = lerp(from.fov, to.fov, alpha);
    cam.updateProjectionMatrix();
  }
  if (from.lookAt && to.lookAt) {
    const lx = lerp(from.lookAt[0], to.lookAt[0], alpha);
    const ly = lerp(from.lookAt[1], to.lookAt[1], alpha);
    const lz = lerp(from.lookAt[2], to.lookAt[2], alpha);
    // Sync OrbitControls' target so when playback ends and the user
    // resumes orbit-control, the rotation pivot is where we left it.
    ed.three.orbit.target.set(lx, ly, lz);
    cam.lookAt(lx, ly, lz);
  }
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
        applyPathAndShake(startT);
        applyCameraAtTime(startT);
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
