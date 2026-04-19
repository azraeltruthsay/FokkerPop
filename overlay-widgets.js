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

// Collision category bits: 0x0001 reserved for walls so they collide with
// everything; bodies on layer N get 1 << N. Layers 1..15 supported.
const WALL_CATEGORY = 0x0001;
function layerCategory(layer) { return 1 << Math.max(1, Math.min(15, layer | 0)); }

// Normalize old flat physics-pit config {triggerEvent, emojis, countPerEvent, ...}
// into the new spawns[] shape so older widgets.json files still work.
function normalizePitSpawns(cfg) {
  if (Array.isArray(cfg.spawns) && cfg.spawns.length) return cfg.spawns;
  if (cfg.triggerEvent || cfg.emojis) {
    return [{
      triggerEvent: cfg.triggerEvent || 'sub',
      emojis:       cfg.emojis?.length ? cfg.emojis : ['🎈','✨','💜','🎉','🔥'],
      count:        cfg.countPerEvent || 5,
      layer:        cfg.layer || 1,
    }];
  }
  return [];
}

// Maps a 0..100 metric value to a 0.3..2.0 gravity multiplier so the pit
// reacts to crowd energy / sub count etc. without letting bodies freeze or fly.
function reactiveMult(metricVal) {
  const v = Math.max(0, Math.min(100, Number(metricVal) || 0));
  return 0.3 + (v / 100) * 1.7;
}

export async function mountPhysicsPit(widget, el, getMetric) {
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
  const baseGravity = cfg.gravity ?? 1;
  engine.gravity.y = baseGravity;

  // Optional reactive gravity: update engine.gravity.y each frame based on a
  // state metric (e.g. crowd.energy) so the pit gets hypier as hype rises.
  if (cfg.reactiveGravity) {
    M.Events.on(engine, 'beforeUpdate', () => {
      const v = getMetric?.(cfg.reactiveGravity);
      engine.gravity.y = baseGravity * reactiveMult(v);
    });
  }

  // Walls + floor. Walls collide with everything (mask = 0xFFFF).
  const thick = 40;
  const wallFilter = { category: WALL_CATEGORY, mask: 0xFFFF };
  const walls = [
    M.Bodies.rectangle(w/2, h + thick/2,  w + thick*2, thick, { isStatic: true, collisionFilter: wallFilter }),  // floor
    M.Bodies.rectangle(-thick/2, h/2,     thick,       h*2,   { isStatic: true, collisionFilter: wallFilter }),  // left
    M.Bodies.rectangle(w + thick/2, h/2,  thick,       h*2,   { isStatic: true, collisionFilter: wallFilter }),  // right
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

  function spawnEmojis(emojis, count, layer) {
    const cat = layerCategory(layer || 1);
    // Layer N body: own category bit + collides with walls + its own category.
    const filter = { category: cat, mask: WALL_CATEGORY | cat };
    for (let i = 0; i < count; i++) {
      const e = emojis[Math.floor(Math.random() * emojis.length)];
      const r = cfg.size || 18;
      const b = M.Bodies.circle(w * (0.2 + Math.random() * 0.6), -r, r, {
        restitution: 0.55, friction: 0.05, density: 0.002,
        label: 'emoji:' + e,
        collisionFilter: filter,
        render: { fillStyle: 'rgba(255,255,255,0.05)', strokeStyle: 'transparent' }
      });
      M.Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.2);
      M.World.add(engine.world, b);
    }
    // Prune if too many.
    const emojiBodies = engine.world.bodies.filter(b => b.label?.startsWith('emoji:'));
    const max = cfg.maxAlive || 60;
    if (emojiBodies.length > max) {
      const drop = emojiBodies.slice(0, emojiBodies.length - max);
      for (const b of drop) M.World.remove(engine.world, b);
    }
  }

  // Initial preview fill so layout-mode shows something.
  setTimeout(() => {
    const rules = normalizePitSpawns(cfg);
    const first = rules[0];
    if (first) spawnEmojis(first.emojis, 3, first.layer);
  }, 50);

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
    const entry = physicsPits.get(w.id);
    if (!entry) continue;
    const rules = normalizePitSpawns(w.config || {});
    for (const rule of rules) {
      if (rule.triggerEvent && rule.triggerEvent !== event.type) continue;
      const emojis = rule.emojis?.length ? rule.emojis : ['🎈'];
      entry.spawnEmojis(emojis, rule.count || 5, rule.layer || 1);
    }
  }
}

// ─── Dice (D4 / D6 / D8 / D12 / D20) ──────────────────────────────────────
// three.js-rendered polyhedra with a minimal custom rigid-body sim. When the
// die settles we detect which face is pointing up and report the number back
// to the server so flow engine nodes can branch on the rolled value.

const diceWidgets = new Map(); // widget id -> { scene, renderer, cleanup }

const DICE_SIDES = [4, 6, 8, 10, 12, 20];

// Build an authentic pentagonal trapezohedron — the real D10 shape. 10 kite
// faces, each as 2 triangles sharing an apex→belt edge. With these proportions
// the two triangles of each kite have normals within ~16° of each other (dot
// ≈ 0.96), so the downstream face clusterer (threshold looser for 10-sided)
// merges them into a single face while adjacent kites (72° apart) stay
// distinct. No manual group bookkeeping needed.
function buildPentagonalTrapezohedron(T) {
  const r = 0.68;  // belt radius
  const z = 0.18;  // belt y-height (upper belt at +z, lower at -z)
  const a = 1.08;  // apex y-distance
  const top = [0,  a, 0];
  const bot = [0, -a, 0];
  const upper = [], lower = [];
  for (let i = 0; i < 5; i++) {
    const au = (i / 5) * Math.PI * 2;
    upper.push([r * Math.cos(au), z, r * Math.sin(au)]);
    const al = ((i + 0.5) / 5) * Math.PI * 2;
    lower.push([r * Math.cos(al), -z, r * Math.sin(al)]);
  }
  // Vertex layout: 0=top apex, 1=bot apex, 2..6 upper belt, 7..11 lower belt
  const verts = [top, bot, ...upper, ...lower].flat();
  const idx = [];
  // 5 upper kites (top apex + U_i + L_i + U_{i+1}), each = 2 triangles
  for (let i = 0; i < 5; i++) {
    const u = 2 + i, uN = 2 + ((i + 1) % 5);
    const l = 7 + i;
    idx.push(0, u, l);
    idx.push(0, l, uN);
  }
  // 5 lower kites (bot apex + L_i + U_{i+1} + L_{i+1})
  for (let i = 0; i < 5; i++) {
    const uN = 2 + ((i + 1) % 5);
    const l = 7 + i, lN = 7 + ((i + 1) % 5);
    idx.push(1, lN, uN);
    idx.push(1, uN, l);
  }
  const indexed = new T.BufferGeometry();
  indexed.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
  indexed.setIndex(idx);
  const g = indexed.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

async function buildDieMesh(sides) {
  const T = await loadThree();
  const geo = {
    4:  new T.TetrahedronGeometry(0.95),
    6:  new T.BoxGeometry(1.2, 1.2, 1.2),
    8:  new T.OctahedronGeometry(1),
    10: buildPentagonalTrapezohedron(T),
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
  // Cluster triangles whose normals match within epsilon to form canonical
  // faces. For D10's trapezohedron the two triangles of a kite have normals
  // ~16° apart (dot ≈ 0.96), whereas adjacent kites are 72° apart (dot ≈ 0.31),
  // so a looser threshold merges kite-halves without false collisions.
  const threshold = sides === 10 ? 0.92 : 0.999;
  const faces = [];
  for (let i = 0; i < triNormals.length; i++) {
    const n = triNormals[i];
    const existing = faces.find(f => f.normal.dot(n) > threshold);
    if (existing) {
      existing.tris.push(i);
      // Re-average the face normal so it represents the kite (not just the first tri).
      existing.normal.add(n);
    } else {
      faces.push({ normal: n.clone(), tris: [i], index: faces.length });
    }
  }
  for (const f of faces) f.normal.normalize();

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

// ─── Dice Tray (multi-die pit with summed/individual readback) ────────────
// Uses cannon-es for 3D physics and three.js BoxGeometry bodies (D6 first
// pass — the tray rolls N D6s as ConvexPolyhedron-approximated cubes so
// they tumble realistically and the face-up is readable). Reports
// dice-tray.rolled { widgetId, dice: [{sides,result}], sum } after all settle.

const diceTrays = new Map();

export async function mountDiceTray(widget, el, sendToServer) {
  const T = await loadThree();
  const C = await loadCannon();
  const cfg = widget.config || {};

  const w = cfg.width || 420;
  const h = cfg.height || 280;
  el.style.width  = w + 'px';
  el.style.height = h + 'px';
  el.style.position = 'absolute';
  el.innerHTML = '';

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 4, 6);
  camera.lookAt(0, 0, 0);

  scene.add(new T.AmbientLight(0xffffff, 0.7));
  const key = new T.DirectionalLight(0xffffff, 1.1);
  key.position.set(3, 5, 3);
  scene.add(key);

  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%; border-radius:12px; background:rgba(8,8,16,0.25); border:1px solid rgba(255,255,255,0.08);';
  el.appendChild(renderer.domElement);

  const world = new C.World({ gravity: new C.Vec3(0, -20, 0) });
  world.broadphase = new C.NaiveBroadphase();
  world.allowSleep = true;
  world.defaultContactMaterial.restitution = 0.3;
  world.defaultContactMaterial.friction    = 0.4;

  // Tray dimensions
  const halfX = cfg.trayWidth  ?? 2.5;
  const halfZ = cfg.trayDepth  ?? 1.6;
  const wallH = 1.2;
  const wallT = 0.08;

  // Ground + walls
  world.addBody(new C.Body({ type: C.Body.STATIC, shape: new C.Plane(),
    quaternion: new C.Quaternion().setFromEuler(-Math.PI / 2, 0, 0) }));
  const wall = (w2, h2, d2, px, py, pz) => world.addBody(new C.Body({
    type: C.Body.STATIC, shape: new C.Box(new C.Vec3(w2, h2, d2)), position: new C.Vec3(px, py, pz)
  }));
  wall(wallT, wallH / 2, halfZ + wallT, -halfX - wallT, wallH / 2, 0);
  wall(wallT, wallH / 2, halfZ + wallT,  halfX + wallT, wallH / 2, 0);
  wall(halfX + wallT, wallH / 2, wallT, 0, wallH / 2, -halfZ - wallT);
  wall(halfX + wallT, wallH / 2, wallT, 0, wallH / 2,  halfZ + wallT);

  // Tray visual
  const trayGeo = new T.PlaneGeometry(halfX * 2, halfZ * 2);
  const trayMat = new T.MeshStandardMaterial({ color: 0x181822, roughness: 0.8 });
  const trayMesh = new T.Mesh(trayGeo, trayMat);
  trayMesh.rotation.x = -Math.PI / 2;
  scene.add(trayMesh);
  scene.add(new T.Box3Helper(new T.Box3(new T.Vector3(-halfX, 0, -halfZ), new T.Vector3(halfX, wallH, halfZ)), 0x9147FF));

  // Pre-build D6 textures (shared across all dice in this tray)
  const faceTextures = [1, 2, 3, 4, 5, 6].map(n => {
    const s = 128;
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#FFD700'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#1a0f00';
    ctx.font = 'bold 80px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), s / 2, s / 2 + 4);
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  });

  // Cube-face -> number mapping. three.js BoxGeometry groups materials by
  // side: [+X, -X, +Y, -Y, +Z, -Z]. Standard dice have opposite faces
  // summing to 7: 1↔6, 2↔5, 3↔4.
  const FACE_NUMBERS = [1, 6, 2, 5, 3, 4];
  const FACE_NORMALS = [
    new T.Vector3( 1, 0,  0),
    new T.Vector3(-1, 0,  0),
    new T.Vector3( 0, 1,  0),
    new T.Vector3( 0,-1,  0),
    new T.Vector3( 0, 0,  1),
    new T.Vector3( 0, 0, -1),
  ];

  const dice = []; // { body, mesh, settled, stillFor, result? }
  let rollActive = false;

  function spawnDice(count) {
    const size = cfg.dieSize ?? 0.45;
    for (let i = 0; i < count; i++) {
      const body = new C.Body({
        mass: 0.5, shape: new C.Box(new C.Vec3(size, size, size)),
        position: new C.Vec3((Math.random() - 0.5) * halfX, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * halfZ),
        angularDamping: 0.15, linearDamping: 0.08,
      });
      body.velocity.set((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3);
      body.angularVelocity.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
      body.quaternion.setFromEuler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      world.addBody(body);

      const mats = faceTextures.map(tex => new T.MeshStandardMaterial({ map: tex, roughness: 0.35 }));
      const mesh = new T.Mesh(new T.BoxGeometry(size * 2, size * 2, size * 2), mats);
      scene.add(mesh);
      dice.push({ body, mesh, settled: false, stillFor: 0, result: null });
    }
  }

  function readFaceUp(body) {
    const q = new T.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    const up = new T.Vector3(0, 1, 0);
    let best = -Infinity, num = 1;
    for (let i = 0; i < 6; i++) {
      const n = FACE_NORMALS[i].clone().applyQuaternion(q);
      const d = n.dot(up);
      if (d > best) { best = d; num = FACE_NUMBERS[i]; }
    }
    return num;
  }

  function rollTray() {
    // Remove previous dice
    for (const d of dice) {
      world.removeBody(d.body);
      scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mesh.material.forEach(m => m.dispose());
    }
    dice.length = 0;
    rollActive = true;
    const n = Math.max(1, Math.min(20, cfg.count ?? 2));
    spawnDice(n);
  }

  let last = performance.now();
  let rafId = null;
  function loop(now) {
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now;
    world.step(1 / 60, dt, 3);

    let allSettled = true;
    for (const d of dice) {
      d.mesh.position.set(d.body.position.x, d.body.position.y, d.body.position.z);
      d.mesh.quaternion.set(d.body.quaternion.x, d.body.quaternion.y, d.body.quaternion.z, d.body.quaternion.w);
      const vel2 = d.body.velocity.lengthSquared();
      const ang2 = d.body.angularVelocity.lengthSquared();
      if (!d.settled && vel2 < 0.05 && ang2 < 0.05) {
        d.stillFor += dt;
        if (d.stillFor > 0.4) {
          d.settled = true;
          d.result = readFaceUp(d.body);
        }
      } else if (!d.settled) {
        d.stillFor = 0;
        allSettled = false;
      }
    }

    if (rollActive && dice.length > 0 && allSettled && dice.every(d => d.settled)) {
      rollActive = false;
      const results = dice.map(d => ({ sides: 6, result: d.result }));
      const sum = results.reduce((s, r) => s + r.result, 0);
      sendToServer?.({ type: '_overlay.dice-tray-rolled', widgetId: widget.id, dice: results, sum });
    }

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  // Seed one idle die so layout mode shows the tray.
  setTimeout(() => spawnDice(1), 60);

  const entry = {
    rollTray,
    dispose: () => {
      cancelAnimationFrame(rafId);
      for (const d of dice) { scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.forEach(m => m.dispose()); }
      faceTextures.forEach(t => t.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      trayGeo.dispose(); trayMat.dispose();
    }
  };
  diceTrays.set(widget.id, entry);
  return entry;
}

export function unmountDiceTray(widgetId) {
  const t = diceTrays.get(widgetId);
  if (t) { t.dispose(); diceTrays.delete(widgetId); }
}

export function triggerDiceTray(widgets, eventType) {
  for (const w of widgets) {
    if (w.type !== 'dice-tray') continue;
    const cfg = w.config || {};
    if (cfg.triggerEvent && cfg.triggerEvent !== eventType) continue;
    const entry = diceTrays.get(w.id);
    entry?.rollTray?.();
  }
}

// ─── 3D Physics Pit (three.js + cannon-es) ───────────────────────────────
// Like the 2D pit but with real 3D rigid bodies. Bodies are textured spheres
// (emoji rendered onto a canvas texture). Collision layers map directly to
// cannon-es CollisionFilterGroup / Mask.

let CANNON = null;
async function loadCannon() {
  if (!CANNON) CANNON = await import('/vendor/cannon-es.js');
  return CANNON;
}

const physicsPits3D = new Map();

export async function mountPhysicsPit3D(widget, el, getMetric) {
  const T = await loadThree();
  const C = await loadCannon();
  const cfg = widget.config || {};

  const w = cfg.width || 360;
  const h = cfg.height || 260;
  el.style.width  = w + 'px';
  el.style.height = h + 'px';
  el.style.position = 'absolute';
  el.innerHTML = '';

  // ── three.js scene ─────────────────────────────────────────
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 4, 7);
  camera.lookAt(0, 0.8, 0);

  scene.add(new T.AmbientLight(0xffffff, 0.6));
  const key = new T.DirectionalLight(0xffffff, 1.2);
  key.position.set(4, 8, 5);
  scene.add(key);

  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%; border-radius:12px; background:rgba(8,8,16,0.3); border:1px solid rgba(255,255,255,0.08);';
  el.appendChild(renderer.domElement);

  // ── cannon world ───────────────────────────────────────────
  const baseG3 = 9.82 * (cfg.gravity ?? 1);
  const world = new C.World({ gravity: new C.Vec3(0, -baseG3, 0) });
  world.broadphase = new C.NaiveBroadphase();
  world.allowSleep = true;

  const halfX = cfg.pitWidth  ?? 3.0;
  const halfZ = cfg.pitDepth  ?? 2.0;
  const pitHeight = cfg.pitHeight ?? 4.0;

  const WALL_GROUP = 1;
  const wallMat = new C.Material('wall');
  // Ground
  world.addBody(new C.Body({
    type: C.Body.STATIC, shape: new C.Plane(),
    quaternion: new C.Quaternion().setFromEuler(-Math.PI / 2, 0, 0),
    position: new C.Vec3(0, 0, 0),
    collisionFilterGroup: WALL_GROUP, collisionFilterMask: 0xFFFF,
    material: wallMat,
  }));
  // Walls (4 sides)
  const wallT = 0.05;
  const wall = (w2, h2, d2, px, py, pz) => {
    const body = new C.Body({ type: C.Body.STATIC, shape: new C.Box(new C.Vec3(w2, h2, d2)),
      position: new C.Vec3(px, py, pz), collisionFilterGroup: WALL_GROUP, collisionFilterMask: 0xFFFF, material: wallMat });
    world.addBody(body);
  };
  wall(wallT, pitHeight/2, halfZ + wallT, -halfX - wallT, pitHeight/2, 0); // left
  wall(wallT, pitHeight/2, halfZ + wallT,  halfX + wallT, pitHeight/2, 0); // right
  wall(halfX + wallT, pitHeight/2, wallT, 0, pitHeight/2, -halfZ - wallT); // back
  wall(halfX + wallT, pitHeight/2, wallT, 0, pitHeight/2,  halfZ + wallT); // front

  // Visual floor outline so LilFokker can see where the pit actually is.
  const floorGeo = new T.PlaneGeometry(halfX * 2, halfZ * 2);
  const floorMat = new T.MeshStandardMaterial({ color: 0x0f0f1a, side: T.DoubleSide, transparent: true, opacity: 0.55 });
  const floorMesh = new T.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  scene.add(floorMesh);
  // Subtle wireframe walls so the volume is visible
  const wireMat = new T.LineBasicMaterial({ color: 0x9147FF, transparent: true, opacity: 0.35 });
  const bb = new T.Box3(new T.Vector3(-halfX, 0, -halfZ), new T.Vector3(halfX, pitHeight, halfZ));
  scene.add(new T.Box3Helper(bb, 0x9147FF));

  // ── bodies + meshes ────────────────────────────────────────
  const items = [];  // { body, mesh, layer }

  function emojiTexture(emoji) {
    const s = 128;
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const ctx = c.getContext('2d');
    ctx.font = `${Math.floor(s * 0.8)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, s / 2, s / 2);
    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    return t;
  }

  function spawnEmojis(emojis, count, layer) {
    const layerBit = 1 << Math.max(1, Math.min(15, layer | 0));
    // Layer-N body: own bit set; mask = walls + same-layer bit.
    const filterGroup = layerBit;
    const filterMask  = WALL_GROUP | layerBit;
    for (let i = 0; i < count; i++) {
      const e = emojis[Math.floor(Math.random() * emojis.length)];
      const r = (cfg.size ?? 0.25);
      const body = new C.Body({
        mass: 0.4, shape: new C.Sphere(r),
        position: new C.Vec3((Math.random() - 0.5) * halfX * 1.5, pitHeight + Math.random() * 1, (Math.random() - 0.5) * halfZ * 0.6),
        linearDamping: 0.05, angularDamping: 0.05,
        collisionFilterGroup: filterGroup, collisionFilterMask: filterMask,
        material: wallMat,
      });
      body.angularVelocity.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
      world.addBody(body);

      const sprite = new T.Sprite(new T.SpriteMaterial({ map: emojiTexture(e), transparent: true }));
      sprite.scale.set(r * 2.4, r * 2.4, r * 2.4);
      scene.add(sprite);
      items.push({ body, mesh: sprite, layer });
    }
    // Prune the oldest bodies if we exceed maxAlive.
    const max = cfg.maxAlive || 40;
    while (items.length > max) {
      const old = items.shift();
      world.removeBody(old.body);
      scene.remove(old.mesh);
      old.mesh.material.map?.dispose();
      old.mesh.material.dispose();
    }
  }

  let last = performance.now();
  let rafId = null;
  function loop(now) {
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now;
    if (cfg.reactiveGravity) {
      world.gravity.y = -baseG3 * reactiveMult(getMetric?.(cfg.reactiveGravity));
    }
    world.step(1 / 60, dt, 3);
    for (const it of items) {
      it.mesh.position.set(it.body.position.x, it.body.position.y, it.body.position.z);
    }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  // Seed a couple of bodies so layout mode shows something.
  setTimeout(() => spawnEmojis(['🎈'], 2, 1), 50);

  const entry = {
    spawnEmojis,
    dispose: () => {
      cancelAnimationFrame(rafId);
      for (const it of items) { scene.remove(it.mesh); it.mesh.material.map?.dispose(); it.mesh.material.dispose(); }
      renderer.dispose();
      renderer.domElement.remove();
      floorGeo.dispose(); floorMat.dispose();
    },
  };
  physicsPits3D.set(widget.id, entry);
  return entry;
}

export function unmountPhysicsPit3D(widgetId) {
  const p = physicsPits3D.get(widgetId);
  if (p) { p.dispose(); physicsPits3D.delete(widgetId); }
}

export function onPhysicsPit3DEvent(widgets, event) {
  for (const w of widgets) {
    if (w.type !== 'physics-pit-3d') continue;
    const entry = physicsPits3D.get(w.id);
    if (!entry) continue;
    const rules = normalizePitSpawns(w.config || {});
    for (const rule of rules) {
      if (rule.triggerEvent && rule.triggerEvent !== event.type) continue;
      const emojis = rule.emojis?.length ? rule.emojis : ['🎈'];
      entry.spawnEmojis(emojis, rule.count || 5, rule.layer || 1);
    }
  }
}

// ─── 3D Model (GLB / GLTF) ────────────────────────────────────────────────

const modelWidgets = new Map();

export async function mountModel3D(widget, el, getStateRef) {
  const T = await loadThree();
  const { GLTFLoader } = await import('/vendor/GLTFLoader.js');
  const cfg = widget.config || {};

  const w = cfg.width || 300;
  const h = cfg.height || 300;
  el.style.width  = w + 'px';
  el.style.height = h + 'px';
  el.style.position = 'absolute';
  el.innerHTML = '';

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, w / h, 0.1, 100);
  camera.position.set(0, 1.2, 4);
  camera.lookAt(0, 0.6, 0);

  scene.add(new T.AmbientLight(0xffffff, 0.65));
  const key = new T.DirectionalLight(0xffffff, 1.15);
  key.position.set(3, 4, 2);
  scene.add(key);
  const fill = new T.DirectionalLight(0x88aaff, 0.35);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%; border-radius:12px; background:rgba(8,8,16,0.2); border:1px solid rgba(255,255,255,0.08);';
  el.appendChild(renderer.domElement);

  let pivot = null;
  const loader = new GLTFLoader();
  if (cfg.modelUrl) {
    loader.load(cfg.modelUrl, (gltf) => {
      const obj = gltf.scene;
      // Auto-fit model into a 2-unit bounding sphere so arbitrary-scale GLBs render sanely.
      const box = new T.Box3().setFromObject(obj);
      const size = box.getSize(new T.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const s = 1.8 / maxDim;
      obj.scale.setScalar(s);
      const center = box.getCenter(new T.Vector3()).multiplyScalar(s);
      obj.position.sub(center);
      pivot = new T.Group();
      pivot.add(obj);
      scene.add(pivot);
    }, undefined, (err) => {
      console.warn('[model-3d] failed to load', cfg.modelUrl, err);
      // Show a placeholder cube so the widget isn't just a blank box.
      pivot = new T.Group();
      const m = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ color: 0x9147FF }));
      pivot.add(m);
      scene.add(pivot);
    });
  } else {
    pivot = new T.Group();
    const m = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ color: 0x9147FF }));
    pivot.add(m);
    scene.add(pivot);
  }

  let rafId = null;
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (pivot) {
      pivot.rotation.y += cfg.rotationSpeed ?? 0.005;
      // Optional state-reactive scale
      if (cfg.reactiveScale) {
        const v = getStateRef?.(cfg.reactiveScale) ?? 0;
        const base = cfg.scale ?? 1;
        const k = Math.min(2, Math.max(0.3, base + (Number(v) || 0) * (cfg.reactiveMultiplier ?? 0.01)));
        pivot.scale.setScalar(k);
      }
    }
    renderer.render(scene, camera);
  }
  loop();

  const entry = {
    dispose: () => {
      cancelAnimationFrame(rafId);
      renderer.dispose();
      renderer.domElement.remove();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
      });
    }
  };
  modelWidgets.set(widget.id, entry);
  return entry;
}

export function unmountModel3D(widgetId) {
  const m = modelWidgets.get(widgetId);
  if (m) { m.dispose(); modelWidgets.delete(widgetId); }
}

export function clearAll() {
  for (const id of [...physicsPits.keys()])   unmountPhysicsPit(id);
  for (const id of [...physicsPits3D.keys()]) unmountPhysicsPit3D(id);
  for (const id of [...diceWidgets.keys()])   unmountDice(id);
  for (const id of [...diceTrays.keys()])     unmountDiceTray(id);
  for (const id of [...modelWidgets.keys()])  unmountModel3D(id);
}
