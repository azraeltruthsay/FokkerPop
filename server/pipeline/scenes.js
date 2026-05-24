import { EASING_NAMES } from '../../shared/easing.js';

// Scene schema + helpers.
//
// A Scene is a named, schedulable composition rendered as a Three.js
// overlay layer. Authored in Studio's "🎬 Scenes" tab and triggered from
// flows via the playScene action (see flow-engine.js).
//
// Phase 1 (v0.4.0) ships position/rotation/scale + opacity keyframes,
// linear interpolation, fullscreen mount only, and the model + image-plane
// object types. Later phases add easing curves, material/light/camera
// channels, morph targets, path-following, audio tracks with priority
// hierarchy, branch/fork clips for CYOA-style scenes, and widget-mount
// mode. The schema is forward-compatible: unknown fields are ignored by
// the validator and preserved by the editor on save.
//
// Schema (v0.4.0):
// {
//   id:         string,                   // unique
//   name:       string,
//   durationMs: number,                   // total scene length in ms
//   mountMode:  'fullscreen' | 'widget',  // 'widget' is stubbed for Phase 7
//   targetWidgetId?: string,              // required when mountMode === 'widget'
//   aspectRatio?: number,                 // editor-only guide overlay (e.g. 16/9
//                                          // = 1.7778). Doesn't affect runtime.
//                                          // Missing = no guide shown.
//   camera: {
//     type:     'perspective',            // 'orthographic' deferred to Phase 4
//     position: [x, y, z],
//     lookAt:   [x, y, z],
//     fov:      number                    // degrees
//   },
//   objects: [
//     {
//       id:    string,                    // unique within scene
//       type:  'model' | 'image-plane' | 'light',  // Phase 5+: text/sticker-emitter/audio-emitter/group
//       asset?: string,                   // filename in assets/{models,images} for model/image-plane
//                                          // (required for those types). Not used by 'light'.
//       name?: string,                    // display label in editor; defaults to asset basename
//       light?: {                         // required for type='light'
//         kind: 'ambient' | 'directional' | 'point',
//         intensity?: number,             // default 1
//         color?:     string,             // hex, default '#ffffff'
//         distance?:  number              // point only, default 0 = infinite
//       },
//       transform: {                      // initial pose; tracks override per-frame
//         position: [x, y, z],
//         rotation: [x, y, z],            // euler radians, XYZ order
//         scale:    [x, y, z]
//       }
//     }
//   ],
//   cameraTrack?: {                       // animates the scene camera over time;
//     keyframes: [                        // when present, overrides initial camera{}
//       { t, position?, lookAt?, fov?, easing? }
//     ]
//   },
//   audio?: [                              // optional list of scene sounds
//     {
//       id:       string,
//       src:      string,                   // filename in assets/sounds
//       start:    number,                   // ms from scene start
//       priority?: number,                  // 0..100, default 50
//       policy?:  'mix' | 'duck-below' |    // default 'mix'
//                 'solo' | 'cancel-below',
//       vol?:     number,                   // 0..1, default 1
//       loop?:    boolean                   // default false
//     }
//   ],
//   tracks: [
//     {
//       objectId: string,                 // must match an objects[].id
//       keyframes: [
//         {
//           t:        number,             // ms from scene start
//           position?: [x, y, z],
//           rotation?: [x, y, z],
//           scale?:    [x, y, z],
//           opacity?:  number,            // 0..1
//           material?: {                  // model + image-plane channels
//             color?:             string, // hex, multiplied with texture
//             emissive?:          string, // hex, additive glow
//             emissiveIntensity?: number, // 0..2
//             metalness?:         number, // 0..1
//             roughness?:         number, // 0..1
//             wireframe?:         boolean // snaps (no lerp)
//           },
//           light?: {                     // type='light' channels
//             intensity?: number,         // 0..N
//             color?:     string          // hex
//           },
//           easing?:   string             // see shared/easing.js;
//                                          // missing = 'linear'. Determines
//                                          // the curve from THIS keyframe
//                                          // to the NEXT one (Blender FCurve
//                                          // convention).
//         }
//       ]
//     }
//   ]
// }

const VALID_MOUNT_MODES   = new Set(['fullscreen', 'widget']);
const VALID_OBJECT_TYPES  = new Set(['model', 'image-plane', 'light']);
const VALID_LIGHT_KINDS   = new Set(['ambient', 'directional', 'point']);
const VALID_CAMERA_TYPES  = new Set(['perspective']);
const VALID_EASING_NAMES  = new Set(EASING_NAMES);
const VALID_AUDIO_POLICIES = new Set(['mix', 'duck-below', 'solo', 'cancel-below']);

// Accepts #rgb and #rrggbb. Used in keyframe channel validation so a
// typo'd color (missing #, hex letter beyond f, wrong length) gets
// rejected with a clear human message rather than rendering silently
// black at runtime.
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function isHexColor(s) {
  return typeof s === 'string' && HEX_COLOR_RE.test(s);
}
function isNumInRange(n, lo, hi) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

function isVec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function isNonEmptyString(s) {
  return typeof s === 'string' && s.length > 0;
}

// Strict-but-tolerant validator: returns { ok: true, scene } on success,
// or { ok: false, error: 'human message' } on a violation we should reject.
// Unknown fields are not flagged — forward-compat with later phases.
export function validateScene(scene) {
  if (!scene || typeof scene !== 'object') return { ok: false, error: 'scene must be an object' };
  if (!isNonEmptyString(scene.id))         return { ok: false, error: 'scene.id is required' };
  if (!isNonEmptyString(scene.name))       return { ok: false, error: `scene "${scene.id}": name is required` };
  if (!(typeof scene.durationMs === 'number' && scene.durationMs > 0)) {
    return { ok: false, error: `scene "${scene.id}": durationMs must be a positive number` };
  }
  if (!VALID_MOUNT_MODES.has(scene.mountMode)) {
    return { ok: false, error: `scene "${scene.id}": mountMode must be one of ${[...VALID_MOUNT_MODES].join('|')}` };
  }
  if (scene.mountMode === 'widget' && !isNonEmptyString(scene.targetWidgetId)) {
    return { ok: false, error: `scene "${scene.id}": targetWidgetId required for widget mount mode` };
  }
  if (scene.aspectRatio != null && !(typeof scene.aspectRatio === 'number' && scene.aspectRatio > 0 && Number.isFinite(scene.aspectRatio))) {
    return { ok: false, error: `scene "${scene.id}": aspectRatio must be a positive number` };
  }

  // Camera — defaults applied if absent (lets the editor save scenes before
  // the user picks a camera; we don't want strictness to block saves).
  const cam = scene.camera ?? {};
  if (cam.type && !VALID_CAMERA_TYPES.has(cam.type)) {
    return { ok: false, error: `scene "${scene.id}": camera.type must be one of ${[...VALID_CAMERA_TYPES].join('|')}` };
  }
  if (cam.position && !isVec3(cam.position)) return { ok: false, error: `scene "${scene.id}": camera.position must be [x,y,z]` };
  if (cam.lookAt   && !isVec3(cam.lookAt))   return { ok: false, error: `scene "${scene.id}": camera.lookAt must be [x,y,z]` };

  // Objects
  if (!Array.isArray(scene.objects)) return { ok: false, error: `scene "${scene.id}": objects must be an array` };
  const objectIds = new Set();
  for (const obj of scene.objects) {
    if (!isNonEmptyString(obj.id))             return { ok: false, error: `scene "${scene.id}": every object needs an id` };
    if (objectIds.has(obj.id))                 return { ok: false, error: `scene "${scene.id}": duplicate object id "${obj.id}"` };
    objectIds.add(obj.id);
    if (!VALID_OBJECT_TYPES.has(obj.type))     return { ok: false, error: `scene "${scene.id}" object "${obj.id}": type must be one of ${[...VALID_OBJECT_TYPES].join('|')}` };
    // Asset is required for visual objects (model, image-plane). Lights
    // don't reference an asset; they specify their light{} block instead.
    if (obj.type === 'light') {
      if (!obj.light || typeof obj.light !== 'object') {
        return { ok: false, error: `scene "${scene.id}" object "${obj.id}": light block is required for type='light'` };
      }
      if (!VALID_LIGHT_KINDS.has(obj.light.kind)) {
        return { ok: false, error: `scene "${scene.id}" object "${obj.id}": light.kind must be one of ${[...VALID_LIGHT_KINDS].join('|')}` };
      }
      if (obj.light.intensity != null && !(typeof obj.light.intensity === 'number' && obj.light.intensity >= 0)) {
        return { ok: false, error: `scene "${scene.id}" object "${obj.id}": light.intensity must be a non-negative number` };
      }
      if (obj.light.color != null && !isHexColor(obj.light.color)) {
        return { ok: false, error: `scene "${scene.id}" object "${obj.id}": light.color must be hex (#rgb or #rrggbb)` };
      }
      if (obj.light.distance != null && !(typeof obj.light.distance === 'number' && obj.light.distance >= 0)) {
        return { ok: false, error: `scene "${scene.id}" object "${obj.id}": light.distance must be a non-negative number` };
      }
    } else {
      if (!isNonEmptyString(obj.asset))        return { ok: false, error: `scene "${scene.id}" object "${obj.id}": asset is required` };
    }
    if (obj.transform) {
      const t = obj.transform;
      if (t.position && !isVec3(t.position))   return { ok: false, error: `scene "${scene.id}" object "${obj.id}": transform.position must be [x,y,z]` };
      if (t.rotation && !isVec3(t.rotation))   return { ok: false, error: `scene "${scene.id}" object "${obj.id}": transform.rotation must be [x,y,z]` };
      if (t.scale    && !isVec3(t.scale))      return { ok: false, error: `scene "${scene.id}" object "${obj.id}": transform.scale must be [x,y,z]` };
    }
  }

  // Audio (optional)
  if (scene.audio != null) {
    if (!Array.isArray(scene.audio)) return { ok: false, error: `scene "${scene.id}": audio must be an array` };
    const audioIds = new Set();
    for (const a of scene.audio) {
      if (!isNonEmptyString(a.id))     return { ok: false, error: `scene "${scene.id}": every audio entry needs an id` };
      if (audioIds.has(a.id))          return { ok: false, error: `scene "${scene.id}": duplicate audio id "${a.id}"` };
      audioIds.add(a.id);
      if (!isNonEmptyString(a.src))    return { ok: false, error: `scene "${scene.id}" audio "${a.id}": src is required` };
      if (!(typeof a.start === 'number' && Number.isFinite(a.start) && a.start >= 0)) {
        return { ok: false, error: `scene "${scene.id}" audio "${a.id}": start must be a non-negative number` };
      }
      if (a.priority != null && !(typeof a.priority === 'number' && a.priority >= 0 && a.priority <= 100)) {
        return { ok: false, error: `scene "${scene.id}" audio "${a.id}": priority must be 0..100` };
      }
      if (a.policy != null && !VALID_AUDIO_POLICIES.has(a.policy)) {
        return { ok: false, error: `scene "${scene.id}" audio "${a.id}": policy must be one of ${[...VALID_AUDIO_POLICIES].join('|')}` };
      }
      if (a.vol != null && !(typeof a.vol === 'number' && a.vol >= 0 && a.vol <= 1)) {
        return { ok: false, error: `scene "${scene.id}" audio "${a.id}": vol must be 0..1` };
      }
      if (a.loop != null && typeof a.loop !== 'boolean') {
        return { ok: false, error: `scene "${scene.id}" audio "${a.id}": loop must be boolean` };
      }
    }
  }

  // Tracks
  if (!Array.isArray(scene.tracks)) return { ok: false, error: `scene "${scene.id}": tracks must be an array` };
  for (const tr of scene.tracks) {
    if (!isNonEmptyString(tr.objectId))     return { ok: false, error: `scene "${scene.id}": every track needs an objectId` };
    if (!objectIds.has(tr.objectId))        return { ok: false, error: `scene "${scene.id}": track references unknown object "${tr.objectId}"` };
    if (!Array.isArray(tr.keyframes))       return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}": keyframes must be an array` };
    for (const kf of tr.keyframes) {
      if (!(typeof kf.t === 'number' && Number.isFinite(kf.t) && kf.t >= 0)) {
        return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}": every keyframe needs a non-negative numeric t` };
      }
      if (kf.position && !isVec3(kf.position)) return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: position must be [x,y,z]` };
      if (kf.rotation && !isVec3(kf.rotation)) return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: rotation must be [x,y,z]` };
      if (kf.scale    && !isVec3(kf.scale))    return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: scale must be [x,y,z]` };
      if (kf.opacity != null && !(typeof kf.opacity === 'number' && kf.opacity >= 0 && kf.opacity <= 1)) {
        return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: opacity must be 0..1` };
      }
      if (kf.easing != null && !VALID_EASING_NAMES.has(kf.easing)) {
        return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: easing must be one of ${[...VALID_EASING_NAMES].join('|')}` };
      }
      if (kf.material != null) {
        const m = kf.material;
        if (typeof m !== 'object') return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: material must be an object` };
        if (m.color    != null && !isHexColor(m.color))    return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: material.color must be hex` };
        if (m.emissive != null && !isHexColor(m.emissive)) return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: material.emissive must be hex` };
        if (m.emissiveIntensity != null && !isNumInRange(m.emissiveIntensity, 0, 5)) {
          return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: material.emissiveIntensity must be 0..5` };
        }
        if (m.metalness != null && !isNumInRange(m.metalness, 0, 1)) return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: material.metalness must be 0..1` };
        if (m.roughness != null && !isNumInRange(m.roughness, 0, 1)) return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: material.roughness must be 0..1` };
        if (m.wireframe != null && typeof m.wireframe !== 'boolean') {
          return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: material.wireframe must be boolean` };
        }
      }
      if (kf.light != null) {
        const l = kf.light;
        if (typeof l !== 'object') return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: light must be an object` };
        if (l.intensity != null && !(typeof l.intensity === 'number' && l.intensity >= 0)) {
          return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: light.intensity must be a non-negative number` };
        }
        if (l.color != null && !isHexColor(l.color)) {
          return { ok: false, error: `scene "${scene.id}" track "${tr.objectId}" t=${kf.t}: light.color must be hex` };
        }
      }
    }
  }

  // Camera track (optional) — animates the scene camera. When present and
  // non-empty, the player drives the camera from its keyframes; otherwise
  // the camera stays at the initial scene.camera{} pose.
  if (scene.cameraTrack != null) {
    if (typeof scene.cameraTrack !== 'object') return { ok: false, error: `scene "${scene.id}": cameraTrack must be an object` };
    if (!Array.isArray(scene.cameraTrack.keyframes)) {
      return { ok: false, error: `scene "${scene.id}": cameraTrack.keyframes must be an array` };
    }
    for (const kf of scene.cameraTrack.keyframes) {
      if (!(typeof kf.t === 'number' && Number.isFinite(kf.t) && kf.t >= 0)) {
        return { ok: false, error: `scene "${scene.id}": cameraTrack keyframe needs non-negative numeric t` };
      }
      if (kf.position && !isVec3(kf.position)) return { ok: false, error: `scene "${scene.id}" cameraTrack t=${kf.t}: position must be [x,y,z]` };
      if (kf.lookAt   && !isVec3(kf.lookAt))   return { ok: false, error: `scene "${scene.id}" cameraTrack t=${kf.t}: lookAt must be [x,y,z]` };
      if (kf.fov != null && !isNumInRange(kf.fov, 1, 179)) {
        return { ok: false, error: `scene "${scene.id}" cameraTrack t=${kf.t}: fov must be 1..179 degrees` };
      }
      if (kf.easing != null && !VALID_EASING_NAMES.has(kf.easing)) {
        return { ok: false, error: `scene "${scene.id}" cameraTrack t=${kf.t}: easing must be one of ${[...VALID_EASING_NAMES].join('|')}` };
      }
    }
  }

  return { ok: true, scene };
}

// Returns a blank scene with sensible defaults. Used by the editor's "+ New
// Scene" button so the user lands on a working stage rather than an empty
// JSON shell.
export function defaultScene(id, name = 'Untitled Scene') {
  return {
    id,
    name,
    durationMs: 10000,
    mountMode: 'fullscreen',
    aspectRatio: 16 / 9,
    camera: {
      type: 'perspective',
      position: [0, 1.2, 4],
      lookAt:   [0, 0, 0],
      fov:      50,
    },
    objects: [],
    tracks:   [],
  };
}
