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
//   camera: {
//     type:     'perspective',            // 'orthographic' deferred to Phase 4
//     position: [x, y, z],
//     lookAt:   [x, y, z],
//     fov:      number                    // degrees
//   },
//   objects: [
//     {
//       id:    string,                    // unique within scene
//       type:  'model' | 'image-plane',   // Phase 4+: text/sticker-emitter/light/audio-emitter/group
//       asset: string,                    // filename in assets/{models,images}; resolved by type at load
//       transform: {                      // initial pose; tracks override per-frame
//         position: [x, y, z],
//         rotation: [x, y, z],            // euler radians, XYZ order
//         scale:    [x, y, z]
//       }
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
//           opacity?:  number             // 0..1
//         }
//       ]
//     }
//   ]
// }

const VALID_MOUNT_MODES   = new Set(['fullscreen', 'widget']);
const VALID_OBJECT_TYPES  = new Set(['model', 'image-plane']);
const VALID_CAMERA_TYPES  = new Set(['perspective']);

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
    if (!isNonEmptyString(obj.asset))          return { ok: false, error: `scene "${scene.id}" object "${obj.id}": asset is required` };
    if (obj.transform) {
      const t = obj.transform;
      if (t.position && !isVec3(t.position))   return { ok: false, error: `scene "${scene.id}" object "${obj.id}": transform.position must be [x,y,z]` };
      if (t.rotation && !isVec3(t.rotation))   return { ok: false, error: `scene "${scene.id}" object "${obj.id}": transform.rotation must be [x,y,z]` };
      if (t.scale    && !isVec3(t.scale))      return { ok: false, error: `scene "${scene.id}" object "${obj.id}": transform.scale must be [x,y,z]` };
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
