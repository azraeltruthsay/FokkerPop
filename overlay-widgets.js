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

// Canvas-drawn face-texture themes. `bg(ctx, s)` paints the background for a
// single face canvas of size s; `fontColor` is the number colour; `fontGlow`
// adds a blurred shadow for a neon effect; `color3d` / `metalness` /
// `roughness` tint the MeshStandardMaterial behind the texture.
const DIE_THEMES = {
  gold: {
    bg: (ctx, s) => { ctx.fillStyle = '#FFD700'; ctx.fillRect(0, 0, s, s); },
    fontColor: '#1a0f00',
    color3d: 0xFFD700, metalness: 0.15, roughness: 0.35,
  },
  silver: {
    bg: (ctx, s) => {
      const g = ctx.createLinearGradient(0, 0, s, s);
      g.addColorStop(0, '#e6e8ec'); g.addColorStop(1, '#b8bcc4');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    },
    fontColor: '#0a1622',
    color3d: 0xD0D4DA, metalness: 0.5, roughness: 0.22,
  },
  obsidian: {
    bg: (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.8);
      g.addColorStop(0, '#1a1a26'); g.addColorStop(1, '#050508');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    },
    fontColor: '#FFD700',
    color3d: 0x1a1a22, metalness: 0.4, roughness: 0.18,
  },
  marble: {
    bg: (ctx, s) => {
      ctx.fillStyle = '#f2efe6'; ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(110,110,128,0.32)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.moveTo(Math.random() * s, Math.random() * s);
        ctx.bezierCurveTo(Math.random() * s, Math.random() * s, Math.random() * s, Math.random() * s, Math.random() * s, Math.random() * s);
        ctx.stroke();
      }
    },
    fontColor: '#2a1515',
    color3d: 0xf2efe6, metalness: 0.05, roughness: 0.5,
  },
  wood: {
    bg: (ctx, s) => {
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, '#a0623a'); g.addColorStop(0.5, '#845028'); g.addColorStop(1, '#6b3f1e');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(50,25,10,0.35)';
      ctx.lineWidth = 1;
      for (let y = 6; y < s; y += 8 + Math.random() * 5) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(s * 0.3, y - 2, s * 0.7, y + 2, s, y + (Math.random() - 0.5) * 5);
        ctx.stroke();
      }
    },
    fontColor: '#f5e5c8',
    color3d: 0x6b3f1e, metalness: 0.0, roughness: 0.8,
  },
  neon: {
    bg: (ctx, s) => {
      ctx.fillStyle = '#0f0f1a'; ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(0,255,255,0.22)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(i * s / 5, 0); ctx.lineTo(i * s / 5, s);
        ctx.moveTo(0, i * s / 5); ctx.lineTo(s, i * s / 5);
        ctx.stroke();
      }
    },
    fontColor: '#00ffff', fontGlow: '#00ffff',
    color3d: 0x0a1020, metalness: 0.1, roughness: 0.3,
  },
  blood: {
    bg: (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.85);
      g.addColorStop(0, '#8b0000'); g.addColorStop(1, '#2a0000');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    },
    fontColor: '#ffeeee',
    color3d: 0x8b0000, metalness: 0.3, roughness: 0.4,
  },
};
const DIE_THEME_NAMES = Object.keys(DIE_THEMES);
function resolveTheme(name) { return DIE_THEMES[name] || DIE_THEMES.gold; }

// ── Image-based dice themes ────────────────────────────────────────────────
// Users drop PNGs into assets/dice/<theme>/face-<n>.png (optional theme.json
// for material overrides). The server exposes the list of available image
// themes via /api/assets.diceThemes; we lazy-fetch that list once and resolve
// each theme on first use.

let knownImageThemesPromise = null;
function getKnownImageThemes() {
  if (!knownImageThemesPromise) {
    knownImageThemesPromise = fetch('/api/assets')
      .then(r => r.json())
      .then(d => Array.isArray(d.diceThemes) ? d.diceThemes : [])
      .catch(() => []);
  }
  return knownImageThemesPromise;
}

function parseColorSpec(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v.startsWith('0x')) return parseInt(v.slice(2), 16);
    if (v.startsWith('#'))  return parseInt(v.slice(1), 16);
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function loadTexture(T, url) {
  return new Promise((res, rej) => {
    new T.TextureLoader().load(url, tex => { tex.colorSpace = T.SRGBColorSpace; res(tex); }, undefined, () => rej(new Error('texture load failed: ' + url)));
  });
}

const imageThemeCache = new Map(); // theme name -> Promise<themeData>
async function loadImageTheme(themeName) {
  if (imageThemeCache.has(themeName)) return imageThemeCache.get(themeName);
  const p = (async () => {
    const known = await getKnownImageThemes();
    if (!known.includes(themeName)) return null;
    let meta = null;
    try {
      const res = await fetch(`/assets/dice/${encodeURIComponent(themeName)}/theme.json`);
      if (res.ok) meta = await res.json();
    } catch { /* theme.json is optional */ }
    const color3d   = parseColorSpec(meta?.color3d) ?? 0xffffff;
    const metalness = Number.isFinite(meta?.metalness) ? meta.metalness : 0.1;
    const roughness = Number.isFinite(meta?.roughness) ? meta.roughness : 0.5;
    const rollSound = meta?.rollSound || null;
    const texByFace = new Map();
    return {
      color3d, metalness, roughness, rollSound,
      async makeFace(T, n, opts) {
        if (texByFace.has(n)) return texByFace.get(n);
        for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
          try {
            const tex = await loadTexture(T, `/assets/dice/${encodeURIComponent(themeName)}/face-${n}.${ext}`);
            texByFace.set(n, tex);
            return tex;
          } catch { /* try next ext */ }
        }
        // Missing face → fall back to canvas gold so the die still labels itself.
        return makeNumberTexture(T, n, DIE_THEMES.gold, opts);
      },
    };
  })();
  imageThemeCache.set(themeName, p);
  return p;
}

// ── GLB die skins ──────────────────────────────────────────────────────────
// GLB meshes replace the *visual* of a procedural die. Physics + face-up
// detection still use the procedural polyhedron so rolls stay fair. The user
// is responsible for orienting their GLB so its visible faces line up with
// the procedural face normals (standard dice GLBs usually do).

const glbCache = new Map(); // url -> Promise<{gltf}>
async function loadGlb(url) {
  if (!glbCache.has(url)) {
    glbCache.set(url, (async () => {
      const { GLTFLoader } = await import('/vendor/three/loaders/GLTFLoader.js');
      return new Promise((res, rej) => {
        new GLTFLoader().load(url, res, undefined, rej);
      });
    })());
  }
  return glbCache.get(url);
}

async function buildDieGlbMesh(url, targetMaxDim) {
  const T = await loadThree();
  const gltf = await loadGlb(url);
  const obj = gltf.scene.clone(true);
  const box = new T.Box3().setFromObject(obj);
  const size = box.getSize(new T.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = targetMaxDim / maxDim;
  obj.scale.setScalar(s);
  const center = box.getCenter(new T.Vector3()).multiplyScalar(s);
  obj.position.sub(center);
  const group = new T.Group();
  group.add(obj);
  return group;
}

// Procedural environment map for PBR reflections. Horizon-blue sky, warm
// ground, a single hotspot for a virtual key light — cheap but gives metallic
// (gold/silver/obsidian) themes real-looking highlights.
function makeDiceEnvMap(T) {
  const w = 512, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.00, '#9db8d6');
  g.addColorStop(0.50, '#f4e9c8');
  g.addColorStop(1.00, '#3a2a1c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // Virtual sun — bright spot on the "sky" half.
  const sun = ctx.createRadialGradient(w * 0.6, h * 0.3, 0, w * 0.6, h * 0.3, h * 0.45);
  sun.addColorStop(0, 'rgba(255,255,255,0.85)');
  sun.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sun; ctx.fillRect(0, 0, w, h);
  const tex = new T.CanvasTexture(c);
  tex.mapping    = T.EquirectangularReflectionMapping;
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

// Install a PMREM-prefiltered env map on `scene.environment` so
// MeshPhysicalMaterial's clearcoat picks up proper mipmapped reflections.
// Returns the generated texture (so callers can dispose on unmount).
function installDiceEnv(T, renderer, scene) {
  const pmrem = new T.PMREMGenerator(renderer);
  const equirect = makeDiceEnvMap(T);
  const prefiltered = pmrem.fromEquirectangular(equirect).texture;
  equirect.dispose();
  pmrem.dispose();
  scene.environment = prefiltered;
  return prefiltered;
}

// Build an on-the-fly canvas theme from per-widget custom colour / PBR settings.
// Accepts `{ faceColor, numberColor, metalness, roughness }` — any missing
// field falls back to gold's value so partial configs still look like dice.
function makeCustomTheme(customCfg = {}) {
  const faceColor   = customCfg.faceColor   || '#FFD700';
  const numberColor = customCfg.numberColor || '#1a0f00';
  const metalness   = Number.isFinite(customCfg.metalness) ? customCfg.metalness : 0.2;
  const roughness   = Number.isFinite(customCfg.roughness) ? customCfg.roughness : 0.4;
  const color3d     = parseColorSpec(faceColor) ?? 0xFFD700;
  // Canvas theme shape for makeNumberTexture — it needs bg() + fontColor.
  const canvasTheme = {
    bg: (ctx, s) => { ctx.fillStyle = faceColor; ctx.fillRect(0, 0, s, s); },
    fontColor: numberColor,
    color3d, metalness, roughness,
  };
  return {
    color3d, metalness, roughness, rollSound: null,
    makeFace: async (T, n, opts) => makeNumberTexture(T, n, canvasTheme, opts),
  };
}

// Unified resolver: `custom` with per-widget config wins; else canvas preset;
// else image theme from disk; else gold fallback.
async function loadDieThemeData(themeName, customCfg) {
  if (themeName === 'custom') {
    return makeCustomTheme(customCfg || {});
  }
  if (DIE_THEMES[themeName]) {
    const t = DIE_THEMES[themeName];
    return {
      color3d: t.color3d, metalness: t.metalness, roughness: t.roughness, rollSound: null,
      makeFace: async (T, n, opts) => makeNumberTexture(T, n, t, opts),
    };
  }
  const img = await loadImageTheme(themeName);
  if (img) return img;
  return loadDieThemeData('gold');
}

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

// Face-shape metadata per die type. Drives per-face UV remapping and adaptive
// glyph sizing so a D20 face isn't rendered with the same number-size as a D6.
const FACE_SHAPE = { 4: 'triangle', 6: 'square', 8: 'triangle', 10: 'kite', 12: 'pentagon', 20: 'triangle' };
const FACE_BASE_FONT_PX = { triangle: 108, square: 152, pentagon: 166, kite: 124 };
function faceFontPx(shape, n) {
  const base = FACE_BASE_FONT_PX[shape] || 128;
  return n >= 10 ? Math.floor(base * 0.82) : base;
}

// Remap UVs so each face's vertices project onto a centered, roughly unit-disc
// region of UV space. This guarantees the number drawn at canvas center (0.5,
// 0.5) is always centered on the face regardless of die type, and scales
// naturally with the face's 3D size.
function remapFaceUVs(T, geo, faces) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const tmp = new T.Vector3();
  const worldUp = new T.Vector3(0, 1, 0);
  const worldX  = new T.Vector3(1, 0, 0);

  for (const face of faces) {
    // Pick an "up" tangent in the face plane. Prefer world +Y projected onto
    // the face; if the face itself is horizontal, fall back to +X. This keeps
    // glyphs oriented consistently ("up on the face" ≈ up in the world).
    const n = face.normal;
    const tangent = worldUp.clone().sub(n.clone().multiplyScalar(worldUp.dot(n)));
    if (tangent.lengthSq() < 0.01) {
      tangent.copy(worldX).sub(n.clone().multiplyScalar(worldX.dot(n)));
    }
    tangent.normalize();
    const bitangent = new T.Vector3().crossVectors(n, tangent).normalize();

    // Find centroid from all triangle vertices of the face.
    const centroid = new T.Vector3();
    let vCount = 0;
    for (const tri of face.tris) {
      for (let k = 0; k < 3; k++) {
        centroid.add(tmp.fromBufferAttribute(pos, tri * 3 + k));
        vCount++;
      }
    }
    centroid.divideScalar(vCount);

    // First pass: project each vertex, find max distance from centroid.
    const projected = []; // [{vi, u, v}]
    let maxR = 0;
    for (const tri of face.tris) {
      for (let k = 0; k < 3; k++) {
        const vi = tri * 3 + k;
        tmp.fromBufferAttribute(pos, vi).sub(centroid);
        const u = tmp.dot(tangent);
        const v = tmp.dot(bitangent);
        const r = Math.hypot(u, v);
        if (r > maxR) maxR = r;
        projected.push({ vi, u, v });
      }
    }
    // Second pass: write normalized UVs with a 4% margin inside the texture.
    const scale = 0.48 / (maxR || 1);
    for (const { vi, u, v } of projected) {
      uv[vi * 2]     = 0.5 + u * scale;
      uv[vi * 2 + 1] = 0.5 + v * scale;
    }
  }
  geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
}

async function buildDieMesh(sides, themeName = 'gold', options = {}) {
  const T = await loadThree();
  const theme = await loadDieThemeData(themeName, options.customTheme);
  const pipMode = sides === 6 && !!options.pips;
  let geo = {
    4:  new T.TetrahedronGeometry(0.95),
    6:  new T.BoxGeometry(1.2, 1.2, 1.2),
    8:  new T.OctahedronGeometry(1),
    10: buildPentagonalTrapezohedron(T),
    12: new T.DodecahedronGeometry(0.95),
    20: new T.IcosahedronGeometry(1),
  }[sides];
  // Force non-indexed so the clustering + UV remap below can index by triangle
  // without worrying about D6's indexed position buffer.
  if (geo.index) geo = geo.toNonIndexed();

  const pos = geo.attributes.position;
  const triCount = pos.count / 3;
  const triNormals = [];
  for (let i = 0; i < triCount; i++) {
    const a = new T.Vector3().fromBufferAttribute(pos, i * 3);
    const b = new T.Vector3().fromBufferAttribute(pos, i * 3 + 1);
    const c = new T.Vector3().fromBufferAttribute(pos, i * 3 + 2);
    triNormals.push(new T.Vector3().subVectors(b, a).cross(new T.Vector3().subVectors(c, a)).normalize());
  }
  // Cluster triangles whose normals match. D10's trapezohedron kites are ~16°
  // apart (dot ≈ 0.96); adjacent kites 72° apart (dot ≈ 0.31). Looser threshold
  // merges kite halves without false collisions.
  const threshold = sides === 10 ? 0.92 : 0.999;
  const faces = [];
  for (let i = 0; i < triNormals.length; i++) {
    const n = triNormals[i];
    const existing = faces.find(f => f.normal.dot(n) > threshold);
    if (existing) {
      existing.tris.push(i);
      existing.normal.add(n);
    } else {
      faces.push({ normal: n.clone(), tris: [i], index: faces.length });
    }
  }
  for (const f of faces) f.normal.normalize();

  remapFaceUVs(T, geo, faces);

  geo.clearGroups();
  faces.forEach((f, i) => {
    for (const tri of f.tris) geo.addGroup(tri * 3, 3, i);
  });

  const shape = FACE_SHAPE[sides] || 'square';
  const materials = await Promise.all(faces.map(async (_, i) => {
    const n = i + 1;
    const glyphPx = pipMode ? 0 : faceFontPx(shape, n);
    const map     = await theme.makeFace(T, n, { pip: pipMode, glyphPx });
    // Etched look: a grayscale bump map where the glyph area is recessed, so
    // three.js perturbs the surface normal around the number. Generated for
    // built-in canvas themes AND the `custom` theme — image themes bring
    // their own visuals and we don't want to force a generic engraving shape.
    const useBump = DIE_THEMES[themeName] || themeName === 'custom';
    const bumpMap = useBump ? makeEtchedBumpTexture(T, n, { pip: pipMode, glyphPx }) : null;
    const matOpts = {
      color:     theme.color3d,
      roughness: theme.roughness,
      metalness: theme.metalness,
      map,
      bumpMap,
      bumpScale: bumpMap ? 0.04 : 0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
    };
    return T.MeshPhysicalMaterial ? new T.MeshPhysicalMaterial(matOpts) : new T.MeshStandardMaterial(matOpts);
  }));
  const mesh = new T.Mesh(geo, materials);
  mesh.castShadow = true;
  return { mesh, faces };
}

// Pip layout (fraction of canvas width/height) for traditional D6 faces 1–6.
const PIP_POSITIONS = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.25], [0.72, 0.25], [0.28, 0.5], [0.72, 0.5], [0.28, 0.75], [0.72, 0.75]],
};

function makeNumberTexture(T, n, theme, opts = {}) {
  const t = theme && theme.bg ? theme : resolveTheme('gold');
  const size = 256;  // Doubled from 128 for sharper readability at a distance.
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  t.bg(ctx, size);
  if (t.fontGlow) {
    ctx.shadowColor = t.fontGlow;
    ctx.shadowBlur  = 36;
  }
  if (opts.pip && n >= 1 && n <= 6) {
    ctx.fillStyle = t.fontColor;
    const r = size * 0.09;
    for (const [fx, fy] of PIP_POSITIONS[n]) {
      ctx.beginPath();
      ctx.arc(fx * size, fy * size, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Caller picks fontSize per face-shape; fall back to 150 if unspecified.
    const fontSize = opts.glyphPx || (n >= 10 ? 120 : 150);
    ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Dark contrast outline so the number pops on any theme.
    ctx.lineWidth   = Math.floor(fontSize * 0.09);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(String(n), size / 2, size / 2 + Math.floor(fontSize * 0.05));
    ctx.fillStyle = t.fontColor;
    ctx.fillText(String(n), size / 2, size / 2 + Math.floor(fontSize * 0.05));
    // Underline on 6 and 9 so they're unambiguous at weird angles.
    if (n === 6 || n === 9) {
      ctx.strokeStyle = t.fontColor;
      ctx.lineWidth = Math.floor(fontSize * 0.08);
      const w = fontSize * 0.35;
      const y = size / 2 + fontSize * 0.48;
      ctx.beginPath();
      ctx.moveTo(size / 2 - w / 2, y);
      ctx.lineTo(size / 2 + w / 2, y);
      ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

// Grayscale bump map that matches the glyph geometry: the face surface is
// high (white) and the glyph area is low (black), so three.js renders the
// number as if it were engraved into the die. Stacked with the color texture
// and clearcoat, it reads as a classic etched-and-inked die.
function makeEtchedBumpTexture(T, n, opts = {}) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  if (opts.pip && n >= 1 && n <= 6) {
    const r = size * 0.09;
    for (const [fx, fy] of PIP_POSITIONS[n]) {
      ctx.beginPath();
      ctx.arc(fx * size, fy * size, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const fontSize = opts.glyphPx || (n >= 10 ? 120 : 150);
    ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), size / 2, size / 2 + Math.floor(fontSize * 0.05));
    if (n === 6 || n === 9) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.floor(fontSize * 0.08);
      const w = fontSize * 0.35;
      const y = size / 2 + fontSize * 0.48;
      ctx.beginPath();
      ctx.moveTo(size / 2 - w / 2, y);
      ctx.lineTo(size / 2 + w / 2, y);
      ctx.stroke();
    }
  }
  const tex = new T.CanvasTexture(c);
  // Bump maps are linear data, not sRGB color, so leave default colorSpace.
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

  const envTex = installDiceEnv(T, renderer, scene);

  const built = await buildDieMesh(side, cfg.theme, { pips: !!cfg.pips, customTheme: cfg.customTheme });
  const faces = built.faces;
  let mesh = built.mesh;
  if (cfg.meshUrl) {
    try {
      // Swap in the GLB as the visual; procedural `faces` still drive face-up
      // detection. Scale the GLB to roughly the procedural die's extent.
      const extent = side === 6 ? 1.2 : 2.0;
      mesh = await buildDieGlbMesh(cfg.meshUrl, extent);
      built.mesh.geometry.dispose();
      const mats = Array.isArray(built.mesh.material) ? built.mesh.material : [built.mesh.material];
      for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
    } catch (err) {
      console.warn('[dice] GLB load failed, falling back to procedural mesh:', cfg.meshUrl, err);
    }
  }
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
    window.playSound?.(cfg.rollSound ?? 'dice1.wav', 0.6);
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
      envTex?.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
      // Traverse walks both Mesh (procedural) and Group (GLB) trees uniformly.
      mesh.traverse?.((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose?.(); m.bumpMap?.dispose?.(); m.dispose?.(); });
      });
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
// Uses cannon-es for 3D physics and the authentic polyhedron meshes from the
// single-die widget (buildDieMesh). Each die gets its own cannon-es shape —
// C.Box for D6s, C.ConvexPolyhedron for D4/D8/D10/D12/D20 — so they tumble
// and settle on real faces. Accepts a mixed dice spec:
//   cfg.dice = [{sides: 20, count: 1}, {sides: 6, count: 2}]
// (or legacy cfg.count which defaults to N D6s). Reports
// dice-tray.rolled { widgetId, dice: [{sides,result}], sum } after all settle.

const diceTrays = new Map();

// Normalize dice config. Accepts new `dice: [{sides,count}]` or legacy
// `count: N` (all D6). Clamps total dice to 20 to keep physics reasonable.
function normalizeDiceSpec(cfg) {
  let spec;
  if (Array.isArray(cfg.dice) && cfg.dice.length) {
    spec = cfg.dice
      .map(d => ({
        sides: DICE_SIDES.includes(Number(d.sides)) ? Number(d.sides) : 6,
        count: Math.max(1, Math.min(20, Number(d.count) || 1)),
        isPercentile: !!d.isPercentile
      }));
  } else {
    spec = [{ sides: 6, count: Math.max(1, Math.min(20, Number(cfg.count) || 2)) }];
  }
  let total = 0;
  const clamped = [];
  for (const d of spec) {
    if (total >= 20) break;
    const count = Math.min(d.count, 20 - total);
    clamped.push({ sides: d.sides, count, isPercentile: d.isPercentile });
    total += count;
  }
  return clamped;
}

// Deduplicate a non-indexed BufferGeometry's position buffer into unique
// vertices (within eps), returning { verts, indexMap }. indexMap[i] = unique
// index for triangle-vertex i in the original attribute.
function dedupeVerts(geo, eps = 0.0005) {
  const pos = geo.attributes.position;
  const verts = [];
  const indexMap = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let found = -1;
    for (let j = 0; j < verts.length; j++) {
      const u = verts[j];
      if (Math.abs(u[0] - x) < eps && Math.abs(u[1] - y) < eps && Math.abs(u[2] - z) < eps) { found = j; break; }
    }
    if (found < 0) { found = verts.length; verts.push([x, y, z]); }
    indexMap[i] = found;
  }
  return { verts, indexMap };
}

// Sort face vertex indices CCW around the face centroid when viewed from
// outside (along face normal). cannon-es ConvexPolyhedron requires this
// winding so its computed face normals point outward.
function sortFaceCCW(indices, verts, normal) {
  const n = { x: normal.x, y: normal.y, z: normal.z };
  let cx = 0, cy = 0, cz = 0;
  for (const i of indices) { cx += verts[i][0]; cy += verts[i][1]; cz += verts[i][2]; }
  cx /= indices.length; cy /= indices.length; cz /= indices.length;

  // Build an orthonormal basis (u, v) on the face plane. Pick any axis not
  // parallel to the normal, cross to get u, cross again to get v.
  const refX = Math.abs(n.y) > 0.9 ? 1 : 0;
  const refY = Math.abs(n.y) > 0.9 ? 0 : 1;
  const refZ = 0;
  let ux = n.y * refZ - n.z * refY;
  let uy = n.z * refX - n.x * refZ;
  let uz = n.x * refY - n.y * refX;
  const uL = Math.hypot(ux, uy, uz) || 1;
  ux /= uL; uy /= uL; uz /= uL;
  const vx = n.y * uz - n.z * uy;
  const vy = n.z * ux - n.x * uz;
  const vz = n.x * uy - n.y * ux;

  return indices.slice().sort((ia, ib) => {
    const a = verts[ia], b = verts[ib];
    const ax = a[0] - cx, ay = a[1] - cy, az = a[2] - cz;
    const bx = b[0] - cx, by = b[1] - cy, bz = b[2] - cz;
    const aa = Math.atan2(ax * vx + ay * vy + az * vz, ax * ux + ay * uy + az * uz);
    const ba = Math.atan2(bx * vx + by * vy + bz * vz, bx * ux + by * uy + bz * uz);
    return aa - ba;
  });
}

// Build a die rigid-body primitive: three.js mesh (scaled) + cannon-es shape
// + per-face metadata (normal in body space, face number). For D6 we use a
// simple C.Box for speed; all other polyhedra use C.ConvexPolyhedron derived
// from the clustered faces so they settle on authentic facets.
async function buildDieRigidBody(C, sides, scale, theme, options = {}) {
  const { mesh: proceduralMesh, faces } = await buildDieMesh(sides, theme, options);
  proceduralMesh.scale.setScalar(scale);

  // Physics shape is always derived from the procedural geometry — the GLB
  // (if any) is a visual-only skin. Compute the shape BEFORE any mesh swap
  // so the procedural geometry is still alive.
  let shape;
  if (sides === 6) {
    // BoxGeometry(1.2) → half-extent 0.6, then visual scale → 0.6 * scale.
    const he = 0.6 * scale;
    shape = new C.Box(new C.Vec3(he, he, he));
  } else {
    const { verts, indexMap } = dedupeVerts(proceduralMesh.geometry);
    const cannonVerts = verts.map(v => new C.Vec3(v[0] * scale, v[1] * scale, v[2] * scale));
    const cannonFaces = faces.map(face => {
      const vertSet = new Set();
      for (const tri of face.tris) {
        vertSet.add(indexMap[tri * 3]);
        vertSet.add(indexMap[tri * 3 + 1]);
        vertSet.add(indexMap[tri * 3 + 2]);
      }
      return sortFaceCCW([...vertSet], verts, face.normal);
    });
    shape = new C.ConvexPolyhedron({ vertices: cannonVerts, faces: cannonFaces });
  }

  // GLB skin: replace the visual mesh while keeping procedural physics/faces.
  let mesh = proceduralMesh;
  if (options.meshUrl) {
    try {
      mesh = await buildDieGlbMesh(options.meshUrl, scale * 2);
      proceduralMesh.geometry.dispose();
      const mats = Array.isArray(proceduralMesh.material) ? proceduralMesh.material : [proceduralMesh.material];
      for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
    } catch (err) {
      console.warn('[dice] GLB load failed, falling back to procedural mesh:', options.meshUrl, err);
    }
  }

  // Cache face metadata for readFaceUp. Normals are unit vectors in body space.
  const faceMeta = faces.map(f => ({ normal: { x: f.normal.x, y: f.normal.y, z: f.normal.z }, number: f.index + 1 }));
  return { mesh, shape, faces: faceMeta };
}

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
  // Steep camera tilt so top faces (where the settled number lives) are readable.
  const camera = new T.PerspectiveCamera(52, w / h, 0.1, 100);
  camera.position.set(0, 5.5, 3);
  camera.lookAt(0, 0.2, 0);

  scene.add(new T.AmbientLight(0xffffff, 0.85));
  const key = new T.DirectionalLight(0xffffff, 1.1);
  key.position.set(3, 5, 3);
  scene.add(key);
  // Secondary light aimed straight down so top faces never fall into shadow.
  const top = new T.DirectionalLight(0xffffff, 0.7);
  top.position.set(0, 6, 0.01);
  scene.add(top);

  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%; border-radius:12px; background:rgba(8,8,16,0.25); border:1px solid rgba(255,255,255,0.08);';
  el.appendChild(renderer.domElement);

  const envTex = installDiceEnv(T, renderer, scene);

  // Post-settle result overlay — guarantees the sum is readable even when a
  // die lands at an awkward angle. Fades in on settle, out ~5s later.
  const resultEl = document.createElement('div');
  resultEl.style.cssText = 'position:absolute; top:8px; left:0; right:0; text-align:center; font:900 22px system-ui,sans-serif; color:#FFD700; text-shadow:0 2px 10px rgba(0,0,0,0.9),0 0 4px rgba(0,0,0,0.9); pointer-events:none; opacity:0; transition:opacity 0.35s ease; letter-spacing:0.04em;';
  el.appendChild(resultEl);
  let resultFadeTimer = null;
  function showResult(text) {
    resultEl.textContent = text;
    resultEl.style.opacity = '1';
    clearTimeout(resultFadeTimer);
    resultFadeTimer = setTimeout(() => { resultEl.style.opacity = '0'; }, 5000);
  }

  const world = new C.World({ gravity: new C.Vec3(0, -20, 0) });
  world.broadphase = new C.NaiveBroadphase();
  world.allowSleep = true;
  world.defaultContactMaterial.restitution = 0.3;
  world.defaultContactMaterial.friction    = 0.4;

  const halfX = cfg.trayWidth  ?? 2.5;
  const halfZ = cfg.trayDepth  ?? 1.6;
  const wallH = 1.2;
  const wallT = 0.08;

  world.addBody(new C.Body({ type: C.Body.STATIC, shape: new C.Plane(),
    quaternion: new C.Quaternion().setFromEuler(-Math.PI / 2, 0, 0) }));
  const wall = (w2, h2, d2, px, py, pz) => world.addBody(new C.Body({
    type: C.Body.STATIC, shape: new C.Box(new C.Vec3(w2, h2, d2)), position: new C.Vec3(px, py, pz)
  }));
  wall(wallT, wallH / 2, halfZ + wallT, -halfX - wallT, wallH / 2, 0);
  wall(wallT, wallH / 2, halfZ + wallT,  halfX + wallT, wallH / 2, 0);
  wall(halfX + wallT, wallH / 2, wallT, 0, wallH / 2, -halfZ - wallT);
  wall(halfX + wallT, wallH / 2, wallT, 0, wallH / 2,  halfZ + wallT);

  const trayGeo = new T.PlaneGeometry(halfX * 2, halfZ * 2);
  const trayMat = new T.MeshStandardMaterial({ color: 0x181822, roughness: 0.8 });
  const trayMesh = new T.Mesh(trayGeo, trayMat);
  trayMesh.rotation.x = -Math.PI / 2;
  scene.add(trayMesh);
  scene.add(new T.Box3Helper(new T.Box3(new T.Vector3(-halfX, 0, -halfZ), new T.Vector3(halfX, wallH, halfZ)), 0x9147FF));

  const dieScale = cfg.dieSize ?? 0.55;

  const dice = []; // { body, mesh, faces, sides, settled, stillFor, result }
  let rollActive = false;
  let currentTag = null; // propagated from the triggering event to the settle message
  let currentRollId = null;
  let currentIsTest = false;

  function readFaceUp(body, faces) {
    const q = new T.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    const up = new T.Vector3(0, 1, 0);
    const tmp = new T.Vector3();
    let best = -Infinity, num = 1;
    for (const f of faces) {
      tmp.set(f.normal.x, f.normal.y, f.normal.z).applyQuaternion(q);
      const d = tmp.dot(up);
      if (d > best) { best = d; num = f.number; }
    }
    return num;
  }

  function disposeDie(d) {
    world.removeBody(d.body);
    scene.remove(d.mesh);
    d.mesh.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose?.(); m.bumpMap?.dispose?.(); m.dispose?.(); });
    });
  }

  async function spawnDie(sides, theme, opts = {}) {
    const { mesh, shape, faces } = await buildDieRigidBody(C, sides, dieScale, theme, opts);
    const body = new C.Body({
      mass: 0.5, shape,
      position: new C.Vec3((Math.random() - 0.5) * halfX, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * halfZ),
      angularDamping: 0.15, linearDamping: 0.08,
    });
    body.velocity.set((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3);
    body.angularVelocity.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
    body.quaternion.setFromEuler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    world.addBody(body);
    scene.add(mesh);
    dice.push({ body, mesh, faces, sides, settled: false, stillFor: 0, result: null, isPercentile: !!opts.isPercentile });
  }

  async function rollTray(specOverride, themeOverride, optsOverride) {
    for (const d of dice) disposeDie(d);
    dice.length = 0;
    rollActive = true;
    currentTag = (optsOverride && optsOverride.tag) || null;
    currentRollId = (optsOverride && optsOverride.rollId) || null;
    currentIsTest = !!(optsOverride && optsOverride.isTest);
    const spec = (Array.isArray(specOverride) && specOverride.length)
      ? normalizeDiceSpec({ dice: specOverride })
      : normalizeDiceSpec(cfg);
    const theme = themeOverride || cfg.theme;
    const baseOpts = { pips: !!cfg.pips, meshUrl: cfg.meshUrl, customTheme: cfg.customTheme, ...(optsOverride || {}) };
    for (const group of spec) {
      const groupOpts = { ...baseOpts, isPercentile: group.isPercentile };
      if (group.pips !== undefined) groupOpts.pips = !!group.pips;
      if (group.meshUrl) groupOpts.meshUrl = group.meshUrl;
      if (group.customTheme) groupOpts.customTheme = group.customTheme;
      for (let i = 0; i < group.count; i++) await spawnDie(group.sides, group.theme || theme, groupOpts);
    }
    // Roll sound precedence: cfg override > image theme's rollSound > dice1.
    let sound = cfg.rollSound;
    if (!sound && theme) {
      try { sound = (await loadDieThemeData(theme)).rollSound; } catch { /* ignore */ }
    }
    window.playSound?.(sound ?? 'dice1.wav', 0.6);
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
      if (!d.settled && vel2 < 0.01 && ang2 < 0.01) {
        d.stillFor += dt;
        if (d.stillFor > 0.6) {
          d.settled = true;
          d.result = readFaceUp(d.body, d.faces);
          console.info(`[dice-tray] die settled: d${d.sides}=${d.result}`);
        }
      } else if (!d.settled) {
        d.stillFor = 0;
        allSettled = false;
      }
    }

    if (rollActive && dice.length > 0 && allSettled && dice.every(d => d.settled)) {
      rollActive = false;
      const results = dice.map(d => ({ sides: d.sides, result: d.result }));
      let sum = results.reduce((s, r) => s + r.result, 0);

      // Percentile shorthand: 2× D10 flagged as isPercentile → show as DD (tens face × 10 + units).
      let label;
      const isP100 = results.length === 2 && results.every(r => r.sides === 10) && dice.every(d => d.isPercentile);
      if (isP100) {
        const tens = (results[0].result % 10) * 10;  // treat face 10 as 0 in tens slot
        const units = results[1].result % 10;
        const percentile = tens + units === 0 ? 100 : tens + units;
        sum = percentile; // Sync reported sum with visual result
        label = `D100 = ${percentile}  (Red: ${results[0].result} · Blue: ${results[1].result})`;
      } else {
        const mixed = new Set(results.map(r => r.sides)).size > 1;
        const faces = results.map(r => mixed ? `d${r.sides}:${r.result}` : r.result).join(', ');
        label = `[${faces}] = ${sum}`;
      }
      showResult(label);
      const settleMsg = { type: '_overlay.dice-tray-rolled', widgetId: widget.id, dice: results, sum };
      if (isP100)        settleMsg.isPercentile = true;
      if (currentTag)    settleMsg.tag = currentTag;
      if (currentRollId) settleMsg.rollId = currentRollId;
      if (currentIsTest) settleMsg.isTest = true;
      sendToServer?.(settleMsg);
    }

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  // Seed preview dice so layout-mode renders something.
  setTimeout(async () => {
    const spec = normalizeDiceSpec(cfg);
    const preview = spec.slice(0, 2);
    const baseOpts = { pips: !!cfg.pips, meshUrl: cfg.meshUrl, customTheme: cfg.customTheme };
    for (const g of preview) {
      const opts = { ...baseOpts };
      if (g.pips !== undefined) opts.pips = !!g.pips;
      if (g.meshUrl) opts.meshUrl = g.meshUrl;
      if (g.customTheme) opts.customTheme = g.customTheme;
      await spawnDie(g.sides, g.theme || cfg.theme, opts);
    }
  }, 60);

  const entry = {
    rollTray,
    dispose: () => {
      cancelAnimationFrame(rafId);
      clearTimeout(resultFadeTimer);
      for (const d of dice) disposeDie(d);
      envTex?.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
      resultEl.remove();
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

export function triggerDiceTray(widgets, event) {
  const eventType = typeof event === 'string' ? event : event?.type;
  const p = typeof event === 'object' ? (event?.payload ?? {}) : {};
  const diceOverride  = p.dice  ?? null;
  const themeOverride = p.theme ?? null;
  const tag           = p.tag   ?? null;
  const rid           = p.rollId ?? null;
  const isTest        = !!event?.isTest;
  const optsOverride  = (p.pips !== undefined || p.meshUrl || tag || rid || isTest) ? {} : null;
  if (optsOverride) {
    if (p.pips !== undefined) optsOverride.pips = !!p.pips;
    if (p.meshUrl)            optsOverride.meshUrl = p.meshUrl;
    if (tag)                  optsOverride.tag = tag;
    if (rid)                  optsOverride.rollId = rid;
    if (isTest)               optsOverride.isTest = true;
  }
  for (const w of widgets) {
    if (w.type !== 'dice-tray') continue;
    const cfg = w.config || {};
    if (cfg.triggerEvent && cfg.triggerEvent !== eventType) continue;
    const entry = diceTrays.get(w.id);
    if (!entry) {
      console.warn('[dice-tray] no mounted entry for widget', w.id, '— widget still loading or mount failed?');
      continue;
    }
    Promise.resolve(entry.rollTray(diceOverride, themeOverride, optsOverride))
      .catch(err => console.error('[dice-tray] rollTray failed for', w.id, err));
  }
}

// Exposed so the dashboard's custom-dice picker can list available themes
// without duplicating the list.
export function listDieThemes() { return DIE_THEME_NAMES.slice(); }

// ─── Hot Button 3D (clickable 3D mesh that fires a configured effect) ─────

const hotButtons3D = new Map();

export async function mountHotButton3D(widget, el, sendToServer, isLayoutMode) {
  const T = await loadThree();
  const cfg = widget.config || {};

  const w = cfg.width || 200;
  const h = cfg.height || 200;
  el.style.width  = w + 'px';
  el.style.height = h + 'px';
  el.style.position = 'absolute';
  el.innerHTML = '';
  el.style.cursor = 'pointer';

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(40, w / h, 0.1, 100);
  camera.position.set(0, 0, 3.2);

  scene.add(new T.AmbientLight(0xffffff, 0.7));
  const key = new T.DirectionalLight(0xffffff, 1.2);
  key.position.set(2, 4, 3);
  scene.add(key);

  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'display:block; width:100%; height:100%; border-radius:50%; background:radial-gradient(circle, rgba(145,71,255,0.15), rgba(8,8,16,0.6));';
  el.appendChild(renderer.domElement);

  // Emoji-on-sphere
  const emoji = cfg.emoji || cfg.label || '🎆';
  const texSize = 256;
  const canvas = document.createElement('canvas');
  canvas.width = texSize; canvas.height = texSize;
  const ctx = canvas.getContext('2d');
  ctx.font = `${Math.floor(texSize * 0.78)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, texSize / 2, texSize / 2 + 4);
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;

  const sphereGeo = new T.SphereGeometry(0.85, 40, 30);
  const sphereMat = new T.MeshStandardMaterial({ color: cfg.color || 0xFFD700, roughness: 0.3, metalness: 0.25 });
  const sphere = new T.Mesh(sphereGeo, sphereMat);
  scene.add(sphere);

  const sprite = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(1.6, 1.6, 1.6);
  sprite.position.set(0, 0, 0.1);
  scene.add(sprite);

  let hovered = false;
  let pulse = 0;
  let rafId = null;
  function loop(now) {
    sphere.rotation.y += 0.006;
    const target = 1 + (hovered ? 0.08 : 0) + Math.max(0, pulse);
    sphere.scale.lerp(new T.Vector3(target, target, target), 0.25);
    sprite.scale.lerp(new T.Vector3(1.6 * target, 1.6 * target, 1.6 * target), 0.25);
    pulse = Math.max(0, pulse - 0.04);
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  const onEnter = () => { hovered = true; };
  const onLeave = () => { hovered = false; };
  const onClick = (e) => {
    if (isLayoutMode?.()) return;
    e.stopPropagation();
    pulse = 0.35;
    sendToServer?.({ type: '_overlay.widget-trigger', id: widget.id });
  };
  renderer.domElement.addEventListener('mouseenter', onEnter);
  renderer.domElement.addEventListener('mouseleave', onLeave);
  renderer.domElement.addEventListener('click', onClick);

  const entry = {
    pulse: () => { pulse = 0.35; },
    dispose: () => {
      cancelAnimationFrame(rafId);
      renderer.domElement.removeEventListener('mouseenter', onEnter);
      renderer.domElement.removeEventListener('mouseleave', onLeave);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.dispose();
      renderer.domElement.remove();
      sphereGeo.dispose(); sphereMat.dispose();
      tex.dispose();
    },
  };
  hotButtons3D.set(widget.id, entry);
  return entry;
}

export function unmountHotButton3D(widgetId) {
  const h = hotButtons3D.get(widgetId);
  if (h) { h.dispose(); hotButtons3D.delete(widgetId); }
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
  const { GLTFLoader } = await import('/vendor/three/loaders/GLTFLoader.js');
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
  for (const id of [...hotButtons3D.keys()])  unmountHotButton3D(id);
}
