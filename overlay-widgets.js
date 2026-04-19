// Dynamically-loaded widget renderers for the overlay.
// Imported once when physics-pit / dice / model-3d widgets are present.

let THREE = null;
let Matter = null;

async function loadThree() {
  if (!THREE) THREE = await import('/vendor/three.module.min.js');
  return THREE;
}

async function loadMatter() {
  if (Matter) return Matter;
  // Matter.js ships UMD only — inject as a classic <script> so it attaches to window.
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-fokker-matter]');
    if (existing) { existing.addEventListener('load', resolve, { once: true }); return; }
    const s = document.createElement('script');
    s.src = '/vendor/matter.min.js';
    s.dataset.fokkerMatter = '1';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load matter.js'));
    document.head.appendChild(s);
  });
  Matter = window.Matter;
  return Matter;
}

// ─── Physics Pit ──────────────────────────────────────────────────────────
// Matter.js-backed 2D container that drops emojis on a chosen event type.

const physicsPits = new Map(); // widget id -> { engine, render, runner, spawnQueue, el, dispose }

export async function mountPhysicsPit(widget, el) {
  const M = await loadMatter();
  const cfg = widget.config || {};
  const w = cfg.width  || 320;
  const h = cfg.height || 220;

  el.style.width  = w + 'px';
  el.style.height = h + 'px';
  el.style.position = 'absolute';
  el.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  canvas.style.cssText = 'display:block; width:100%; height:100%; border-radius:12px; background:rgba(8,8,16,0.35); border:1px solid rgba(255,255,255,0.08);';
  el.appendChild(canvas);

  const engine = M.Engine.create();
  engine.gravity.y = cfg.gravity ?? 1;

  // Walls + floor
  const thick = 40;
  const walls = [
    M.Bodies.rectangle(w/2, h + thick/2,  w + thick*2, thick, { isStatic: true }),  // floor
    M.Bodies.rectangle(-thick/2, h/2,     thick,       h*2,   { isStatic: true }),  // left
    M.Bodies.rectangle(w + thick/2, h/2,  thick,       h*2,   { isStatic: true }),  // right
  ];
  M.World.add(engine.world, walls);

  const render = M.Render.create({
    canvas,
    engine,
    options: { width: w, height: h, wireframes: false, background: 'transparent' }
  });
  M.Render.run(render);
  const runner = M.Runner.create();
  M.Runner.run(runner, engine);

  // Custom text overlay so we can render emojis inside bodies
  const ctx = canvas.getContext('2d');
  M.Events.on(render, 'afterRender', () => {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const body of engine.world.bodies) {
      if (!body.label?.startsWith('emoji:')) continue;
      const emoji = body.label.slice(6);
      ctx.font = `${body.circleRadius * 1.8}px serif`;
      ctx.translate(body.position.x, body.position.y);
      ctx.rotate(body.angle);
      ctx.fillText(emoji, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
  });

  function spawnEmojis(count) {
    const emojis = cfg.emojis?.length ? cfg.emojis : ['🎈','✨','💜','🎉','🔥'];
    for (let i = 0; i < count; i++) {
      const e = emojis[Math.floor(Math.random() * emojis.length)];
      const r = cfg.size || 18;
      const b = M.Bodies.circle(w * (0.2 + Math.random() * 0.6), -r, r, {
        restitution: 0.55, friction: 0.05, density: 0.002,
        label: 'emoji:' + e,
        render: { fillStyle: 'rgba(255,255,255,0.05)', strokeStyle: 'transparent' }
      });
      M.Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.2);
      M.World.add(engine.world, b);
    }
    // Prune if too many
    const emojiBodies = engine.world.bodies.filter(b => b.label?.startsWith('emoji:'));
    const max = cfg.maxAlive || 60;
    if (emojiBodies.length > max) {
      const drop = emojiBodies.slice(0, emojiBodies.length - max);
      for (const b of drop) M.World.remove(engine.world, b);
    }
  }

  // Initial fill for layout-mode visibility
  setTimeout(() => spawnEmojis(3), 50);

  const entry = {
    engine, render, runner, el,
    spawnEmojis,
    dispose: () => {
      M.Render.stop(render);
      M.Runner.stop(runner);
      M.Engine.clear(engine);
      render.canvas?.remove();
    }
  };
  physicsPits.set(widget.id, entry);
  return entry;
}

export function unmountPhysicsPit(widgetId) {
  const p = physicsPits.get(widgetId);
  if (p) { p.dispose(); physicsPits.delete(widgetId); }
}

export function onPhysicsPitEvent(widgets, event) {
  for (const w of widgets) {
    if (w.type !== 'physics-pit') continue;
    const cfg = w.config || {};
    if (cfg.triggerEvent && cfg.triggerEvent !== event.type) continue;
    const entry = physicsPits.get(w.id);
    if (!entry) continue;
    entry.spawnEmojis(cfg.countPerEvent || 5);
  }
}

// ─── Dice (D4 / D6 / D8 / D12 / D20) ──────────────────────────────────────
// three.js-rendered polyhedra with a minimal custom rigid-body sim. When the
// die settles we detect which face is pointing up and report the number back
// to the server so flow engine nodes can branch on the rolled value.

const diceWidgets = new Map(); // widget id -> { scene, renderer, cleanup }

const DICE_SIDES = [4, 6, 8, 12, 20];

// Map each triangulated face in three's built-in geometries back to the
// canonical face count for the polyhedron. D12's pentagonal faces get 3
// triangles each, so dodecahedron actually has 36 triangles; we cluster them.
const DICE_FACE_TRIS = { 4: 1, 6: 2, 8: 1, 12: 3, 20: 1 };

async function buildDieMesh(sides) {
  const T = await loadThree();
  const geo = {
    4:  new T.TetrahedronGeometry(0.95),
    6:  new T.BoxGeometry(1.2, 1.2, 1.2),
    8:  new T.OctahedronGeometry(1),
    12: new T.DodecahedronGeometry(0.95),
    20: new T.IcosahedronGeometry(1),
  }[sides];

  // Compute triangle face normals in body space, then group into canonical faces.
  const pos = geo.attributes.position;
  const triCount = pos.count / 3;
  const triNormals = [];
  for (let i = 0; i < triCount; i++) {
    const a = new T.Vector3().fromBufferAttribute(pos, i * 3);
    const b = new T.Vector3().fromBufferAttribute(pos, i * 3 + 1);
    const c = new T.Vector3().fromBufferAttribute(pos, i * 3 + 2);
    const n = new T.Vector3().subVectors(b, a).cross(new T.Vector3().subVectors(c, a)).normalize();
    triNormals.push(n);
  }
  // Cluster triangles whose normals match (within epsilon) to form canonical faces.
  const faces = [];
  for (let i = 0; i < triNormals.length; i++) {
    const n = triNormals[i];
    const existing = faces.find(f => f.normal.dot(n) > 0.999);
    if (existing) existing.tris.push(i);
    else faces.push({ normal: n.clone(), tris: [i], index: faces.length });
  }

  // Build group-based material: each face group gets its own material with a
  // number texture. three.js uses geometry.groups to map triangles to material
  // indices; we reassign groups accordingly.
  geo.clearGroups();
  faces.forEach((f, i) => {
    for (const tri of f.tris) geo.addGroup(tri * 3, 3, i);
  });

  const materials = faces.map((_, i) => new T.MeshStandardMaterial({
    color: 0xFFD700, roughness: 0.35, metalness: 0.15,
    map: makeNumberTexture(T, i + 1),
  }));
  const mesh = new T.Mesh(geo, materials);
  mesh.castShadow = true;
  return { mesh, faces };
}

function makeNumberTexture(T, n) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFD700'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#1a0f00';
  ctx.font = 'bold 70px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), size / 2, size / 2 + 5);
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

export async function mountDice(widget, el, sendToServer) {
  const T = await loadThree();
  const cfg = widget.config || {};
  const side = DICE_SIDES.includes(cfg.sides) ? cfg.sides : 20;

  const w = cfg.width || 220;
  const h = cfg.height || 220;
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.position = 'absolute';
  el.innerHTML = '';

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(40, w / h, 0.1, 100);
  camera.position.set(0, 3, 5.5);
  camera.lookAt(0, 0, 0);

  scene.add(new T.AmbientLight(0xffffff, 0.8));
  const key = new T.DirectionalLight(0xffffff, 1.1);
  key.position.set(3, 5, 4);
  scene.add(key);

  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%; border-radius:12px; background:rgba(8,8,16,0.2); border:1px solid rgba(255,255,255,0.08);';
  el.appendChild(renderer.domElement);

  const { mesh, faces } = await buildDieMesh(side);
  scene.add(mesh);

  const state = { pos: new T.Vector3(0, 3, 0), vel: new T.Vector3(), spin: new T.Vector3(), quat: new T.Quaternion(), settled: true, stillFor: 0, rollId: null };
  mesh.position.copy(state.pos);

  function startRoll(rollId) {
    state.pos.set((Math.random() - 0.5) * 0.6, 3.8, (Math.random() - 0.5) * 0.6);
    state.vel.set((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2);
    state.spin.set((Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24);
    state.quat.setFromEuler(new T.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
    state.settled = false;
    state.stillFor = 0;
    state.rollId = rollId || ('r' + Date.now().toString(36));
  }

  const GRAVITY = 9.5, FLOOR = -1.4, BOUNCE = 0.38, DAMPING = 0.985, SPIN_DAMPING = 0.975;

  function step(dt) {
    state.vel.y -= GRAVITY * dt;
    state.pos.addScaledVector(state.vel, dt);

    // Ground bounce
    if (state.pos.y < FLOOR) {
      state.pos.y = FLOOR;
      if (Math.abs(state.vel.y) > 0.3) state.vel.y = -state.vel.y * BOUNCE;
      else state.vel.y = 0;
      state.vel.x *= 0.85; state.vel.z *= 0.85;
      // Every bounce, pull spin toward rest a bit
      state.spin.multiplyScalar(0.7);
    }

    // Side walls (keep in box)
    const bound = 1.6;
    if (state.pos.x < -bound) { state.pos.x = -bound; state.vel.x = Math.abs(state.vel.x) * BOUNCE; }
    if (state.pos.x >  bound) { state.pos.x =  bound; state.vel.x = -Math.abs(state.vel.x) * BOUNCE; }
    if (state.pos.z < -bound) { state.pos.z = -bound; state.vel.z = Math.abs(state.vel.z) * BOUNCE; }
    if (state.pos.z >  bound) { state.pos.z =  bound; state.vel.z = -Math.abs(state.vel.z) * BOUNCE; }

    state.vel.multiplyScalar(DAMPING);

    // Integrate orientation
    if (state.spin.lengthSq() > 0.0001) {
      const angle = state.spin.length() * dt;
      const axis = state.spin.clone().normalize();
      const dq = new T.Quaternion().setFromAxisAngle(axis, angle);
      state.quat.premultiply(dq).normalize();
      state.spin.multiplyScalar(SPIN_DAMPING);
    }

    mesh.position.copy(state.pos);
    mesh.quaternion.copy(state.quat);

    // Settle detection
    const settled = state.pos.y <= FLOOR + 0.01 && state.vel.lengthSq() < 0.02 && state.spin.lengthSq() < 0.02;
    if (settled) state.stillFor += dt; else state.stillFor = 0;
    if (!state.settled && state.stillFor > 0.35) {
      state.settled = true;
      const result = readFaceUp();
      sendToServer?.({ type: '_overlay.dice-rolled', widgetId: widget.id, sides: side, result, rollId: state.rollId });
    }
  }

  function readFaceUp() {
    const up = new T.Vector3(0, 1, 0);
    let best = -Infinity, bestFace = 1;
    for (const f of faces) {
      const n = f.normal.clone().applyQuaternion(state.quat);
      const d = n.dot(up);
      if (d > best) { best = d; bestFace = f.index + 1; }
    }
    return bestFace;
  }

  let last = performance.now();
  let rafId = null;
  function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    if (!state.settled) step(dt);
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  // Initial rest pose so layout-mode preview shows something
  mesh.position.copy(state.pos);

  const entry = {
    rollDie: startRoll,
    dispose: () => {
      cancelAnimationFrame(rafId);
      renderer.dispose();
      renderer.domElement.remove();
      for (const m of mesh.material) { m.map?.dispose(); m.dispose(); }
      mesh.geometry.dispose();
    }
  };
  diceWidgets.set(widget.id, entry);
  return entry;
}

export function unmountDice(widgetId) {
  const d = diceWidgets.get(widgetId);
  if (d) { d.dispose(); diceWidgets.delete(widgetId); }
}

export function triggerDice(widgets, eventType) {
  for (const w of widgets) {
    if (w.type !== 'dice') continue;
    const cfg = w.config || {};
    if (cfg.triggerEvent && cfg.triggerEvent !== eventType) continue;
    const entry = diceWidgets.get(w.id);
    entry?.rollDie?.();
  }
}

export function clearAll() {
  for (const id of [...physicsPits.keys()]) unmountPhysicsPit(id);
  for (const id of [...diceWidgets.keys()]) unmountDice(id);
}
