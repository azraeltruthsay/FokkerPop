// Client-side 3D model conversion. Lazy-loads the right Three.js loader
// based on file extension, parses the file into something exportable,
// runs it through GLTFExporter in binary mode, and returns a new File
// the upload handler can POST as a .glb.
//
// The dashboard runs conversion BEFORE the upload so:
//   1. The server's /api/upload allowlist stays glb/gltf-only — no
//      unsupported binaries land on disk;
//   2. Conversion failures surface inline (the upload never starts);
//   3. The overlay only ever needs the GLTFLoader at runtime, keeping
//      the overlay bundle small.
//
// Phase 6 supports .fbx, .obj, .stl, .ply. .usd/.abc/.blend deliberately
// not included — their Three.js loaders are either absent or heavy, and
// realistic users have ways to export to one of the four supported
// formats from any modeling tool.

const EXT_LOADER_PATH = {
  '.fbx': '/vendor/three/loaders/FBXLoader.js',
  '.obj': '/vendor/three/loaders/OBJLoader.js',
  '.stl': '/vendor/three/loaders/STLLoader.js',
  '.ply': '/vendor/three/loaders/PLYLoader.js',
};
const EXT_LOADER_CLASS = {
  '.fbx': 'FBXLoader',
  '.obj': 'OBJLoader',
  '.stl': 'STLLoader',
  '.ply': 'PLYLoader',
};

export const CONVERTIBLE_EXTS = Object.keys(EXT_LOADER_PATH);

let _THREE = null;
let _Exporter = null;
async function ensureLibs() {
  if (!_THREE)    _THREE    = await import('/vendor/three.module.min.js');
  if (!_Exporter) _Exporter = (await import('/vendor/three/exporters/GLTFExporter.js')).GLTFExporter;
}

// Returns the lowercased extension including the leading dot, or null
// for files without one. Used by the dashboard upload flow to decide
// whether to route a file through conversion.
export function extensionOf(filename) {
  const m = String(filename || '').toLowerCase().match(/(\.[^.]+)$/);
  return m ? m[1] : null;
}

// Main entry point. Takes a File (FBX/OBJ/STL/PLY), returns a Promise of
// a File renamed to .glb with the binary GLB payload. Throws with a
// human-readable Error on parse/export failure so the upload handler can
// surface the reason via the existing error-reporter banner.
export async function convertModelToGlb(file, onProgress) {
  const ext = extensionOf(file.name);
  if (!ext || !EXT_LOADER_PATH[ext]) {
    throw new Error(`No converter for extension ${ext || '(none)'}`);
  }

  onProgress?.('Loading converter…');
  await ensureLibs();
  const mod = await import(EXT_LOADER_PATH[ext]);
  const LoaderClass = mod[EXT_LOADER_CLASS[ext]];
  if (!LoaderClass) throw new Error(`Loader class ${EXT_LOADER_CLASS[ext]} not found in ${ext} module`);
  const loader = new LoaderClass();

  onProgress?.('Reading file…');
  const data = await file.arrayBuffer();

  onProgress?.(`Parsing ${ext.slice(1).toUpperCase()}…`);
  let parsed;
  try {
    if (ext === '.obj') {
      // OBJ is text, not binary — decode the buffer before parsing.
      parsed = loader.parse(new TextDecoder().decode(data));
    } else if (ext === '.fbx') {
      // FBXLoader.parse needs (ArrayBuffer, path). Path is used to resolve
      // referenced textures; passing '' is fine for single-file FBX which
      // is what the streamer's modeling-tool export usually produces.
      parsed = loader.parse(data, '');
    } else {
      // STL/PLY parsers auto-detect ascii vs binary from the buffer.
      parsed = loader.parse(data);
    }
  } catch (err) {
    throw new Error(`Failed to parse ${ext.slice(1).toUpperCase()}: ${err?.message || err}`);
  }

  // STL/PLY return a BufferGeometry rather than a scene-graph node.
  // Wrap in a Mesh with a neutral default material so GLTFExporter can
  // serialize them — without this the exporter throws on raw geometry.
  let exportable;
  if (parsed?.isBufferGeometry) {
    const mat = new _THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8, metalness: 0.1 });
    exportable = new _THREE.Mesh(parsed, mat);
  } else {
    exportable = parsed;
  }

  onProgress?.('Exporting GLB…');
  const exporter = new _Exporter();
  const arrayBuffer = await new Promise((resolve, reject) => {
    exporter.parse(
      exportable,
      result => resolve(result),
      err => reject(new Error(`GLTFExporter failed: ${err?.message || String(err)}`)),
      { binary: true },
    );
  });

  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new Error('GLTFExporter returned non-binary result — expected binary GLB');
  }

  const baseName = file.name.replace(/\.[^.]+$/, '');
  return new File([arrayBuffer], `${baseName}.glb`, { type: 'model/gltf-binary' });
}
