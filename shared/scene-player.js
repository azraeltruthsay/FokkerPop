import { resolveEasing } from './easing.js';

// FokkerPop scene player. Lazy-loaded on first 'scene-play' effect, then
// reused for subsequent scenes. Renders a scene JSON (see
// server/pipeline/scenes.js for the schema) into a fullscreen Three.js
// overlay layer with keyframe-driven animation.
//
// Phase 1 (v0.4.0):
//   - Object types: 'model' (GLB/GLTF), 'image-plane' (textured plane).
//   - Animates position, rotation (euler XYZ), scale, opacity via linear
//     interpolation between keyframes. RAF loop ticks at display refresh.
//   - Fullscreen mount only. Widget-mount mode deferred to Phase 7.
//   - No audio handling here; scene sounds still go through existing
//     playSound flows. Phase 3 introduces an audio bus with hierarchy.
//
// Loaded as an ES module (uses the same /vendor/three.module.min.js
// importmap entry as overlay-widgets.js). Single global scene at a time —
// a new playScene() tears down the previous one first.

let THREE = null;
let GLTFLoader = null;

// At-most-one scene plays at a time. Tracked here so the next playScene()
// can tear it down before mounting a new one.
let currentScene = null;

async function ensureLibs() {
  if (!THREE)      THREE      = await import('/vendor/three.module.min.js');
  if (!GLTFLoader) GLTFLoader = (await import('/vendor/three/loaders/GLTFLoader.js')).GLTFLoader;
}

export async function stopScene() {
  if (!currentScene) return;
  if (currentScene.rafId) cancelAnimationFrame(currentScene.rafId);
  try {
    currentScene.scene?.traverse?.(obj => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
      }
    });
    currentScene.renderer?.dispose?.();
    currentScene.renderer?.domElement?.remove?.();
    currentScene.container?.remove?.();
  } catch (err) {
    console.warn('[scene-player] teardown error:', err);
  }
  currentScene = null;
}

export async function playScene(sceneJson) {
  await ensureLibs();
  await stopScene();

  const container = document.createElement('div');
  container.id = 'fokker-scene-stage';
  // pointer-events:none so the scene layer never steals clicks from widgets
  // or layout-mode handles underneath. z-index above standard widget layer.
  container.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:9999; overflow:hidden;';
  document.body.appendChild(container);

  const w = window.innerWidth;
  const h = window.innerHeight;

  const scene  = new THREE.Scene();
  const camCfg = sceneJson.camera || {};
  const camera = new THREE.PerspectiveCamera(camCfg.fov || 50, w / h, 0.1, 100);
  const [cx, cy, cz] = camCfg.position || [0, 1.2, 4];
  const [lx, ly, lz] = camCfg.lookAt   || [0, 0, 0];
  camera.position.set(cx, cy, cz);
  camera.lookAt(lx, ly, lz);

  // Default 3-point-ish lighting — matches the model-3d widget so loaded
  // PBR models don't render flat-black. Phase 4 turns lights into
  // first-class scene objects with their own keyframe channels; until
  // then these defaults always exist alongside whatever the scene loads.
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(3, 4, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%;';
  container.appendChild(renderer.domElement);

  // objects: { [obj.id]: THREE.Object3D } — kept flat so track lookups by
  // objectId are O(1). Models load asynchronously; the placeholder Group
  // mounted immediately preserves transform/opacity until the GLB arrives.
  const objects = {};
  const loader  = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  for (const obj of sceneJson.objects || []) {
    if (obj.type === 'model') {
      const group = new THREE.Group();
      objects[obj.id] = group;
      applyTransform(group, obj.transform);
      scene.add(group);

      loader.load(`/assets/models/${obj.asset}`, (gltf) => {
        // Auto-fit to a 1-unit max-dim bounding box so arbitrary-scale
        // GLBs render at sane sizes (same trick the model-3d widget uses).
        const inner = gltf.scene;
        const box = new THREE.Box3().setFromObject(inner);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const s = 1 / maxDim;
        inner.scale.setScalar(s);
        const center = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
        inner.position.sub(center);
        group.add(inner);
      }, undefined, (err) => {
        console.warn(`[scene-player] failed to load model ${obj.asset}:`, err);
        // Magenta wireframe placeholder so the scene shape is still visible
        // and the streamer can see something went wrong without the scene
        // silently missing the object.
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshStandardMaterial({ color: 0xff00ff, wireframe: true })
        );
        group.add(m);
      });
    } else if (obj.type === 'image-plane') {
      const tex = texLoader.load(`/assets/images/${obj.asset}`);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      objects[obj.id] = mesh;
      applyTransform(mesh, obj.transform);
      scene.add(mesh);
    }
  }

  // Pre-sort keyframes once so the per-frame interpolation can do a tight
  // linear scan instead of resorting every tick.
  const tracks = (sceneJson.tracks || []).map(t => ({
    objectId: t.objectId,
    keyframes: [...(t.keyframes || [])].sort((a, b) => a.t - b.t),
  }));

  const stateRef = {
    container, renderer, scene, camera, objects, tracks,
    startTime: performance.now(),
    durationMs: sceneJson.durationMs || 10000,
    rafId: null,
  };
  currentScene = stateRef;

  function loop() {
    const elapsed = performance.now() - stateRef.startTime;
    if (elapsed >= stateRef.durationMs) {
      stopScene();
      return;
    }
    stateRef.rafId = requestAnimationFrame(loop);

    for (const track of stateRef.tracks) {
      const target = stateRef.objects[track.objectId];
      if (!target) continue;
      applyKeyframeAt(target, track.keyframes, elapsed);
    }
    renderer.render(scene, camera);
  }
  loop();
}

function applyTransform(obj, t) {
  if (!t) return;
  if (t.position) obj.position.set(...t.position);
  if (t.rotation) obj.rotation.set(...t.rotation);
  if (t.scale)    obj.scale.set(...t.scale);
}

// Locate the two keyframes bracketing t and linearly interpolate every
// channel they both specify. Channels missing on either side are left
// at their last applied value — lets the editor author "only animate
// position" without forcing the user to also key rotation/scale.
function applyKeyframeAt(obj, keyframes, t) {
  if (keyframes.length === 0) return;
  if (t <= keyframes[0].t) return applyKeyframe(obj, keyframes[0]);
  if (t >= keyframes[keyframes.length - 1].t) return applyKeyframe(obj, keyframes[keyframes.length - 1]);

  let i = 0;
  while (i < keyframes.length - 1 && keyframes[i + 1].t < t) i++;
  const a = keyframes[i];
  const b = keyframes[i + 1];
  const span     = b.t - a.t;
  const rawAlpha = span > 0 ? (t - a.t) / span : 0;
  // FROM keyframe's easing shapes the segment from a → b. Unknown/missing
  // names fall back to linear so a hand-edited scenes.json doesn't blow
  // up the player.
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
    setOpacity(obj, lerp(a.opacity, b.opacity, alpha));
  }
}

function applyKeyframe(obj, kf) {
  if (kf.position) obj.position.set(...kf.position);
  if (kf.rotation) obj.rotation.set(...kf.rotation);
  if (kf.scale)    obj.scale.set(...kf.scale);
  if (kf.opacity != null) setOpacity(obj, kf.opacity);
}

// Walks the subtree so opacity applies to all materials inside a loaded
// GLB. Forces transparent=true unconditionally — Three.js materials default
// to opaque and an opacity write without this flag has no visible effect.
function setOpacity(obj, op) {
  obj.traverse?.(child => {
    const mats = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : null;
    mats?.forEach(m => { m.transparent = true; m.opacity = op; });
  });
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
