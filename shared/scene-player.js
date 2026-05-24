import { resolveEasing } from './easing.js';
import { audioBus }      from './audio-bus.js';

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

export async function stopScene(opts = {}) {
  if (!currentScene) return;
  // Emit a scene-end bus event so flows with trigger='scene-end' can fire.
  // The overlay's WS sends this; the server's _overlay.event handler
  // forwards it to bus + flow-engine. Skipped on { silent: true } stops
  // (used when one scene preempts another — we don't want both endings).
  if (!opts.silent && currentScene.sceneJson) {
    sendOverlayEvent({
      type: 'scene-end',
      payload: {
        sceneId:   currentScene.sceneJson.id,
        sceneName: currentScene.sceneJson.name,
      },
    });
  }
  if (currentScene.rafId) cancelAnimationFrame(currentScene.rafId);
  // Cancel scheduled fork clips + audio so a preempted scene doesn't leak
  // late-firing side effects past its end. Without this an audio loop or
  // delayed flow fork from scene A would still trigger while scene B
  // is playing.
  for (const id of currentScene.forkTimeouts || []) clearTimeout(id);
  for (const id of currentScene.audioTimeouts || []) clearTimeout(id);
  for (const handle of currentScene.audioHandles || []) {
    try { handle?.stop?.(); } catch {}
  }
  // Tear down the branch-wait WS listener + any active subscription so a
  // late event from the server doesn't trip an already-dead wait state.
  if (currentScene.busMsgListener && window.ws) {
    try { window.ws.removeEventListener('message', currentScene.busMsgListener); } catch {}
  }
  if (currentScene.waitState) {
    clearTimeout(currentScene.waitState.timeoutId);
    for (const t of currentScene.waitState.subscribedTypes || []) {
      sendWS({ type: '_overlay.unsubscribe-bus', eventType: t });
    }
  }
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
  // Preempt previous scene silently — don't fire its scene-end event, since
  // it was interrupted rather than completing naturally. Flows wanting to
  // catch every-scene-end can still observe the new scene's end.
  await stopScene({ silent: true });

  // Mount mode decides whether the renderer lives in a fullscreen overlay
  // layer or inside a placed widget. Widget mode finds the widget element
  // by data-id and uses its dimensions; if the widget can't be found the
  // player falls back to fullscreen so the scene still renders rather
  // than failing silently.
  let container, mountedInWidget = false;
  if (sceneJson.mountMode === 'widget' && sceneJson.targetWidgetId) {
    const widgetEl = document.querySelector(`.custom-widget[data-id="${sceneJson.targetWidgetId}"], #${CSS.escape(sceneJson.targetWidgetId)}`);
    if (widgetEl) {
      container = document.createElement('div');
      container.className = 'fokker-scene-stage-widget';
      container.style.cssText = 'position:absolute; inset:0; pointer-events:none; overflow:hidden;';
      widgetEl.appendChild(container);
      mountedInWidget = true;
    } else {
      console.warn(`[scene-player] mountMode='widget' but no widget with id "${sceneJson.targetWidgetId}" — falling back to fullscreen`);
    }
  }
  if (!container) {
    container = document.createElement('div');
    container.id = 'fokker-scene-stage';
    // pointer-events:none so the scene layer never steals clicks from widgets
    // or layout-mode handles underneath. z-index above standard widget layer.
    container.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:9999; overflow:hidden;';
    document.body.appendChild(container);
  }

  const w = mountedInWidget ? (container.clientWidth  || container.parentElement.clientWidth)  : window.innerWidth;
  const h = mountedInWidget ? (container.clientHeight || container.parentElement.clientHeight) : window.innerHeight;

  const scene  = new THREE.Scene();
  const camCfg = sceneJson.camera || {};
  const camera = new THREE.PerspectiveCamera(camCfg.fov || 50, w / h, 0.1, 100);
  const [cx, cy, cz] = camCfg.position || [0, 1.2, 4];
  const [lx, ly, lz] = camCfg.lookAt   || [0, 0, 0];
  camera.position.set(cx, cy, cz);
  camera.lookAt(lx, ly, lz);

  // Default 3-point-ish lighting only if the scene didn't author its own
  // lights. Once an author adds a light object the defaults step out so
  // they don't double-light the stage. Matches the model-3d widget's
  // lighting setup so loaded PBR models don't render flat-black in the
  // no-author-lights case.
  const sceneHasLights = (sceneJson.objects || []).some(o => o.type === 'light');
  if (!sceneHasLights) {
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(3, 4, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-3, 2, -2);
    scene.add(fill);
  }

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
        // Collect morph-capable meshes so per-frame keyframe application
        // can look up indices by Blender shape-key name. Stashed on the
        // group's userData so applyKeyframesAt can find them later.
        const morphMeshes = [];
        inner.traverse(child => {
          if (child.isMesh && child.morphTargetDictionary && child.morphTargetInfluences) {
            morphMeshes.push({ mesh: child, dict: child.morphTargetDictionary });
          }
        });
        if (morphMeshes.length) group.userData.morphMeshes = morphMeshes;
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
    } else if (obj.type === 'light') {
      const l = obj.light || {};
      let light;
      const color = new THREE.Color(l.color || '#ffffff');
      const intensity = l.intensity ?? 1;
      if (l.kind === 'ambient') {
        light = new THREE.AmbientLight(color, intensity);
      } else if (l.kind === 'point') {
        light = new THREE.PointLight(color, intensity, l.distance ?? 0);
      } else { // 'directional' default
        light = new THREE.DirectionalLight(color, intensity);
      }
      objects[obj.id] = light;
      if (l.kind !== 'ambient') applyTransform(light, obj.transform);
      scene.add(light);
    }
  }

  // Build path-follow curves once per object so the per-frame loop doesn't
  // rebuild them. CatmullRomCurve3 handles smoothing between control points.
  // Path-follow, when set, overrides position-keyframe interpolation for
  // that object — runtime checks userData.pathCurve before falling back
  // to keyframe lerp.
  for (const obj of sceneJson.objects || []) {
    if (!obj.pathFollow || !objects[obj.id]) continue;
    const pts = obj.pathFollow.points.map(p => new THREE.Vector3(...p));
    const curve = new THREE.CatmullRomCurve3(pts, !!obj.pathFollow.loop);
    objects[obj.id].userData.pathCurve  = curve;
    objects[obj.id].userData.pathLoop   = !!obj.pathFollow.loop;
    objects[obj.id].userData.pathSpeed  = obj.pathFollow.speed ?? 1;
  }

  // Pre-sort keyframes once so the per-frame interpolation can do a tight
  // linear scan instead of resorting every tick.
  const tracks = (sceneJson.tracks || []).map(t => ({
    objectId: t.objectId,
    keyframes: [...(t.keyframes || [])].sort((a, b) => a.t - b.t),
  }));
  const cameraKeyframes = sceneJson.cameraTrack?.keyframes
    ? [...sceneJson.cameraTrack.keyframes].sort((a, b) => a.t - b.t)
    : null;

  const stateRef = {
    container, renderer, scene, camera, objects, tracks, cameraKeyframes,
    sceneJson,                  // kept so stopScene can emit scene-end with id+name
    startTime: performance.now(),
    durationMs: sceneJson.durationMs || 10000,
    rafId: null,
    audioTimeouts: [],
    audioHandles:  [],
    forkTimeouts:  [],
    // Branch clips sorted by start so the per-frame "did we just cross
    // one?" check is a forward linear scan. _fired is mutated in-place
    // on the clip to mark already-triggered clips (cleared at scene end).
    branchClips: [...(sceneJson.branchClips || [])].sort((a, b) => a.start - b.start).map(c => ({ ...c, _fired: false })),
    waitState: null,             // { clip, enteredAt, timeoutId, subscribedTypes }
    busMsgListener: null,
  };
  currentScene = stateRef;

  // Listen for bus events forwarded by the server while the scene is in
  // a branch-clip wait state. Filters by stateRef so a stale message
  // arriving after teardown can't accidentally resolve a wait from a
  // since-preempted scene.
  if (window.ws) {
    stateRef.busMsgListener = (e) => {
      if (currentScene !== stateRef || !stateRef.waitState) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== 'bus-event' || !msg.event) return;
      handleBusEventForWait(stateRef, msg.event);
    };
    window.ws.addEventListener('message', stateRef.busMsgListener);
  }

  // Fork clips: scheduled fire-and-forget at their start times. Each
  // target dispatches via a different mechanism — flow/event/effect
  // round-trip through the server via WS; scene targets call playScene
  // locally (replaces the current scene). isTest passes through so
  // forks fired from a Studio test-preview behave consistently.
  for (const fc of sceneJson.forkClips || []) {
    const start = Math.max(0, fc.start || 0);
    if (start >= stateRef.durationMs) continue;
    const tid = setTimeout(() => {
      if (currentScene !== stateRef) return;
      dispatchForkTarget(fc.target, sceneJson);
    }, start);
    stateRef.forkTimeouts.push(tid);
  }

  // Schedule scene audio entries. Each plays through the shared audio bus
  // with its configured priority + policy — duck-below/solo/cancel-below
  // automatically affect existing playSound emissions (alerts, sfx) for
  // the duration the scene audio is live. Entries whose start time is
  // beyond the scene duration are skipped (silent — likely a misconfig).
  for (const a of sceneJson.audio || []) {
    const start = Math.max(0, a.start || 0);
    if (start >= stateRef.durationMs) continue;
    const tid = setTimeout(() => {
      if (currentScene !== stateRef) return; // scene was preempted
      const handle = audioBus.play({
        src: a.src,
        vol:      a.vol ?? 1,
        priority: a.priority ?? 60,   // scene-audio convention default
        policy:   a.policy   ?? 'mix',
        loop:     a.loop     ?? false,
        id:       `scene-${a.id}`,
      });
      if (handle) stateRef.audioHandles.push(handle);
    }, start);
    stateRef.audioTimeouts.push(tid);
  }

  function loop() {
    const realElapsed = performance.now() - stateRef.startTime;

    // Check if we just crossed a branch clip's start time and need to
    // enter a wait state. Skipped if we're already waiting (one branch
    // at a time). Forward linear scan since branchClips is pre-sorted.
    if (!stateRef.waitState) {
      for (const bc of stateRef.branchClips) {
        if (bc._fired) continue;
        if (realElapsed >= bc.start) {
          bc._fired = true;
          enterBranchWait(stateRef, bc);
          break;
        }
      }
    }

    // In wait state, animation uses a folded displayElapsed that cycles
    // within the loop region (or freezes at clip.start if no loop region
    // was authored). Real elapsed keeps advancing in performance.now()
    // terms — needed so the wait's timeout can fire on schedule.
    let displayElapsed = realElapsed;
    if (stateRef.waitState) {
      const { clip, enteredAt } = stateRef.waitState;
      if (clip.loopRegion) {
        const len = Math.max(1, clip.loopRegion.to - clip.loopRegion.from);
        displayElapsed = clip.loopRegion.from + ((performance.now() - enteredAt) % len);
      } else {
        displayElapsed = clip.start;
      }
    } else if (realElapsed >= stateRef.durationMs) {
      // Only natural scene end when not waiting — a wait that outlasts
      // the scene's durationMs holds the scene open until it resolves.
      stopScene();
      return;
    }
    stateRef.rafId = requestAnimationFrame(loop);

    for (const track of stateRef.tracks) {
      const target = stateRef.objects[track.objectId];
      if (!target) continue;
      applyKeyframeAt(target, track.keyframes, displayElapsed);
    }
    const elapsedSec = displayElapsed / 1000;
    for (const id in stateRef.objects) {
      const o = stateRef.objects[id];
      if (o.userData?.pathCurve) applyPathFollow(o, displayElapsed, stateRef.durationMs);
      if (o.userData?.currentShake) applyShakeDisplacement(o, elapsedSec);
    }
    if (stateRef.cameraKeyframes) applyCameraAt(camera, stateRef.cameraKeyframes, displayElapsed);
    renderer.render(scene, camera);
  }
  loop();
}

// Entered when realElapsed crosses a branch clip's start. Subscribes to
// the wait's event type via the server's bus-subscription bridge, and
// arms a setTimeout for the timeout target (if configured). The wait
// resolves on the first matching event whose payload satisfies any
// branch's match (first-match-wins; empty match = unconditional
// fallback) — see handleBusEventForWait for resolution logic.
function enterBranchWait(stateRef, clip) {
  if (!clip.wait || !clip.wait.eventType) return;
  const eventType = clip.wait.eventType;
  sendWS({ type: '_overlay.subscribe-bus', eventType });
  const subscribedTypes = new Set([eventType]);
  let timeoutId = null;
  if (clip.timeout?.ms > 0) {
    timeoutId = setTimeout(() => {
      // Skip if another path already resolved us (the listener cleared
      // waitState first) or if the scene was preempted.
      if (currentScene !== stateRef || stateRef.waitState?.clip !== clip) return;
      resolveBranchWait(stateRef, clip, clip.timeout.target);
    }, clip.timeout.ms);
  }
  stateRef.waitState = { clip, enteredAt: performance.now(), timeoutId, subscribedTypes };
}

function handleBusEventForWait(stateRef, event) {
  const ws = stateRef.waitState;
  if (!ws) return;
  const clip = ws.clip;
  if (event.type !== clip.wait.eventType) return;
  // First-match-wins. Empty match {} matches anything (fallback branch).
  // Match keys check against event.payload first, then top-level event
  // — covers both `{ value: 6 }` (payload) and `{ user: 'X' }` if
  // somebody declared a top-level user field.
  const branches = clip.branches || [];
  for (const br of branches) {
    if (matchesEvent(br.match, event)) {
      resolveBranchWait(stateRef, clip, br.target);
      return;
    }
  }
  // No branch matched the event. The simplest call is to ignore it and
  // keep waiting — gives the streamer "any event that matches NO branch
  // is invalid input" semantics. Timeout still applies.
}

function matchesEvent(match, event) {
  if (!match || Object.keys(match).length === 0) return true;
  const payload = event.payload || {};
  for (const [k, v] of Object.entries(match)) {
    const actual = payload[k] !== undefined ? payload[k] : event[k];
    if (actual !== v) return false;
  }
  return true;
}

function resolveBranchWait(stateRef, clip, target) {
  // Tear down subscriptions + timeout regardless of target type so a
  // late-arriving second event can't double-fire the resolution.
  if (stateRef.waitState) {
    clearTimeout(stateRef.waitState.timeoutId);
    for (const t of stateRef.waitState.subscribedTypes || []) {
      sendWS({ type: '_overlay.unsubscribe-bus', eventType: t });
    }
    stateRef.waitState = null;
  }
  if (!target) return;
  switch (target.type) {
    case 'jump':
      // Resume scene at target.time by shifting startTime so
      // performance.now() - startTime == target.time. The branch clip's
      // _fired flag stays true so we don't re-enter the same wait if
      // the jump lands before its start (unusual but tolerated).
      stateRef.startTime = performance.now() - (target.time || 0);
      break;
    case 'scene':
      sendWS({ type: '_overlay.play-scene', sceneId: target.sceneId });
      break;
    case 'scene-end':
      stopScene();
      break;
    case 'flow':
      sendWS({ type: '_overlay.run-flow', flowId: target.flowId });
      // Resume scene from clip.start so post-branch content plays next.
      stateRef.startTime = performance.now() - clip.start;
      break;
    case 'effect':
      sendWS({ type: '_overlay.fire-effect', effect: target.effect, payload: target.payload ?? {} });
      stateRef.startTime = performance.now() - clip.start;
      break;
  }
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
  // Material channels interpolate float-wise; color/emissive lerp in RGB.
  // Wireframe doesn't lerp — it snaps when the next keyframe is reached
  // (handled via applyKeyframe's clamp branches above).
  if (a.material && b.material) {
    const lerpMat = {};
    if (a.material.color    != null && b.material.color    != null) lerpMat.color    = lerpHex(a.material.color, b.material.color, alpha);
    if (a.material.emissive != null && b.material.emissive != null) lerpMat.emissive = lerpHex(a.material.emissive, b.material.emissive, alpha);
    if (a.material.emissiveIntensity != null && b.material.emissiveIntensity != null) lerpMat.emissiveIntensity = lerp(a.material.emissiveIntensity, b.material.emissiveIntensity, alpha);
    if (a.material.metalness != null && b.material.metalness != null) lerpMat.metalness = lerp(a.material.metalness, b.material.metalness, alpha);
    if (a.material.roughness != null && b.material.roughness != null) lerpMat.roughness = lerp(a.material.roughness, b.material.roughness, alpha);
    // Wireframe takes the FROM value during the segment; the snap to b's
    // value happens at the clamp branch when t >= b.t.
    if (a.material.wireframe != null) lerpMat.wireframe = a.material.wireframe;
    setMaterial(obj, lerpMat);
  }
  if (a.light && b.light && obj.isLight) {
    if (a.light.intensity != null && b.light.intensity != null) obj.intensity = lerp(a.light.intensity, b.light.intensity, alpha);
    if (a.light.color     != null && b.light.color     != null) obj.color.set(lerpHex(a.light.color, b.light.color, alpha));
  }
  // Morph targets — per-name weights from the bracketing keyframes. A name
  // present on only one side lerps from/to 0 so unspecified morphs settle
  // back to neutral instead of holding stale weights forever.
  if (a.morphTargets || b.morphTargets) {
    setMorphs(obj, mergedMorphAt(a.morphTargets, b.morphTargets, alpha));
  }
  // Shake amplitude/frequency interpolate; the actual sine displacement
  // is applied later (after path-follow) in applyShakeDisplacement so it
  // can use real elapsed time rather than just the segment alpha.
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

// Returns a merged morph-weight map for the interpolation step. Names
// missing on either keyframe lerp from/to 0 so unspecified morphs go back
// to neutral, matching how AE/Blender treat missing channels.
function mergedMorphAt(aM, bM, alpha) {
  const names = new Set([...Object.keys(aM || {}), ...Object.keys(bM || {})]);
  const out = {};
  for (const n of names) out[n] = lerp(aM?.[n] ?? 0, bM?.[n] ?? 0, alpha);
  return out;
}

function setMorphs(obj, weights) {
  const meshes = obj.userData?.morphMeshes;
  if (!meshes) return;
  for (const { mesh, dict } of meshes) {
    for (const [name, w] of Object.entries(weights)) {
      const idx = dict[name];
      if (idx != null) mesh.morphTargetInfluences[idx] = w;
    }
  }
}

function applyKeyframe(obj, kf) {
  if (kf.position) obj.position.set(...kf.position);
  if (kf.rotation) obj.rotation.set(...kf.rotation);
  if (kf.scale)    obj.scale.set(...kf.scale);
  if (kf.opacity != null) setOpacity(obj, kf.opacity);
  if (kf.material) setMaterial(obj, kf.material);
  if (kf.light && obj.isLight) {
    if (kf.light.intensity != null) obj.intensity = kf.light.intensity;
    if (kf.light.color     != null) obj.color.set(kf.light.color);
  }
  if (kf.morphTargets) setMorphs(obj, kf.morphTargets);
  if (kf.shake) {
    obj.userData.currentShake = {
      amplitude: [...kf.shake.amplitude],
      frequency: kf.shake.frequency,
    };
  } else {
    obj.userData.currentShake = null;
  }
}

// Walks the subtree so material updates land on every mesh inside a
// loaded GLB. Each channel is guarded against per-frame re-assignment
// when the value hasn't changed — without this, opacity/material
// interpolation marks the material dirty every animation frame and
// triggers shader recompiles on overlays, producing visible stutter
// during animated scenes.
function setMaterial(obj, m) {
  obj.traverse?.(child => {
    const mats = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : null;
    if (!mats) return;
    for (const mat of mats) {
      if (m.color != null && mat.color) {
        const hex = '#' + mat.color.getHexString();
        if (hex !== m.color) mat.color.set(m.color);
      }
      if (m.emissive != null && mat.emissive) {
        const hex = '#' + mat.emissive.getHexString();
        if (hex !== m.emissive) mat.emissive.set(m.emissive);
      }
      if (m.emissiveIntensity != null && 'emissiveIntensity' in mat && mat.emissiveIntensity !== m.emissiveIntensity) mat.emissiveIntensity = m.emissiveIntensity;
      if (m.metalness != null && 'metalness' in mat && mat.metalness !== m.metalness) mat.metalness = m.metalness;
      if (m.roughness != null && 'roughness' in mat && mat.roughness !== m.roughness) mat.roughness = m.roughness;
      if (m.wireframe != null && 'wireframe' in mat && mat.wireframe !== m.wireframe) mat.wireframe = m.wireframe;
    }
  });
}

// RGB lerp in 0..1 space, returned as a hex string. Used both for material
// color and light color interpolation; keeping it stringly-typed lets the
// caller pass the result straight to Three.Color.set().
function lerpHex(aHex, bHex, alpha) {
  const a = parseHex(aHex), b = parseHex(bHex);
  const r = Math.round(lerp(a[0], b[0], alpha));
  const g = Math.round(lerp(a[1], b[1], alpha));
  const bl = Math.round(lerp(a[2], b[2], alpha));
  return '#' + [r, g, bl].map(n => n.toString(16).padStart(2, '0')).join('');
}
function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Walks the subtree so opacity applies to all materials inside a loaded
// GLB. Forces transparent=true unconditionally — Three.js materials default
// to opaque and an opacity write without this flag has no visible effect.
function setOpacity(obj, op) {
  obj.traverse?.(child => {
    const mats = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : null;
    mats?.forEach(m => {
      if (!m.transparent) m.transparent = true;
      if (m.opacity !== op) m.opacity = op;
    });
  });
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Targets the player can dispatch from forkClips (and, in v0.4.7, from
// branchClips). flow/event/effect targets round-trip through the server
// because they need to reach flow-engine.processEvent or the broadcast
// bus; scene targets are handled locally (replaces current scene).
function dispatchForkTarget(target, srcSceneJson) {
  if (!target) return;
  switch (target.type) {
    case 'flow':
      sendWS({ type: '_overlay.run-flow', flowId: target.flowId });
      break;
    case 'event':
      sendWS({ type: '_overlay.event', event: { type: target.eventType, payload: target.payload ?? {} } });
      break;
    case 'effect':
      // Round-tripped (not dispatched locally) so OTHER overlays — a
      // multi-monitor setup or split browser source — see the effect
      // too, and the server's flow-engine can react if anything else
      // is listening for it.
      sendWS({ type: '_overlay.fire-effect', effect: target.effect, payload: target.payload ?? {} });
      break;
    case 'scene':
      sendWS({ type: '_overlay.play-scene', sceneId: target.sceneId });
      break;
  }
}

// Send an event/command back to the server. Used by scene-end emission
// and fork-clip dispatchers. Tolerant of missing window.ws (e.g., the
// Studio preview iframe sometimes uses its own bridge) — caller just
// no-ops in that case rather than failing the whole scene playback.
function sendOverlayEvent(payload) {
  sendWS({ type: '_overlay.event', event: payload });
}
function sendWS(payload) {
  try {
    const ws = window.ws || window.fokkerWs || null;
    if (ws && ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(payload));
    }
  } catch (err) {
    console.warn('[scene-player] sendWS failed:', err);
  }
}

// Path-follow: object's position comes from curve.getPoint(alpha). speed
// scales how fast the curve is traversed (default 1 = full curve over
// scene duration); loop=true makes alpha wrap so the object cycles the
// path. When loop=false and alpha exceeds 1, the object holds at the end.
function applyPathFollow(obj, elapsed, durationMs) {
  const curve = obj.userData.pathCurve;
  const loop  = obj.userData.pathLoop;
  const speed = obj.userData.pathSpeed ?? 1;
  let alpha = (elapsed / Math.max(1, durationMs)) * speed;
  if (loop) alpha = alpha - Math.floor(alpha);
  else      alpha = Math.max(0, Math.min(1, alpha));
  const p = curve.getPoint(alpha);
  obj.position.set(p.x, p.y, p.z);
}

// Per-axis phase offsets so X/Y/Z aren't synchronized — synced motion
// looks like a single 1D oscillation rather than chaotic shake.
const SHAKE_PHASES = [0, 1.7, 3.4];
function applyShakeDisplacement(obj, elapsedSec) {
  const s = obj.userData.currentShake;
  if (!s) return;
  const w = 2 * Math.PI * s.frequency;
  obj.position.x += s.amplitude[0] * Math.sin(w * elapsedSec + SHAKE_PHASES[0]);
  obj.position.y += s.amplitude[1] * Math.sin(w * elapsedSec + SHAKE_PHASES[1]);
  obj.position.z += s.amplitude[2] * Math.sin(w * elapsedSec + SHAKE_PHASES[2]);
}

// Camera keyframes drive the renderer camera each frame. Same bracketing
// + easing pattern as object tracks; lookAt is applied last so position
// and lookAt changes in the same keyframe land in the correct order
// (Three.js's lookAt re-derives matrices from current position).
function applyCameraAt(cam, keyframes, t) {
  if (keyframes.length === 0) return;
  if (t <= keyframes[0].t) return applyCameraKeyframe(cam, keyframes[0]);
  if (t >= keyframes[keyframes.length - 1].t) return applyCameraKeyframe(cam, keyframes[keyframes.length - 1]);
  let i = 0;
  while (i < keyframes.length - 1 && keyframes[i + 1].t < t) i++;
  const a = keyframes[i], b = keyframes[i + 1];
  const span = b.t - a.t;
  const alpha = resolveEasing(a.easing)((t - a.t) / Math.max(1, span));
  if (a.position && b.position) {
    cam.position.set(
      lerp(a.position[0], b.position[0], alpha),
      lerp(a.position[1], b.position[1], alpha),
      lerp(a.position[2], b.position[2], alpha),
    );
  }
  if (a.fov != null && b.fov != null) {
    cam.fov = lerp(a.fov, b.fov, alpha);
    cam.updateProjectionMatrix();
  }
  if (a.lookAt && b.lookAt) {
    cam.lookAt(
      lerp(a.lookAt[0], b.lookAt[0], alpha),
      lerp(a.lookAt[1], b.lookAt[1], alpha),
      lerp(a.lookAt[2], b.lookAt[2], alpha),
    );
  }
}
function applyCameraKeyframe(cam, kf) {
  if (kf.position) cam.position.set(...kf.position);
  if (kf.fov != null) { cam.fov = kf.fov; cam.updateProjectionMatrix(); }
  if (kf.lookAt) cam.lookAt(...kf.lookAt);
}
