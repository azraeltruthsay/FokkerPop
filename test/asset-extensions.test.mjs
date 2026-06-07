import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_EXTS, hasAssetExt } from '../shared/asset-extensions.js';

// Regression: /api/assets once listed models with /\.(gl[bt]f)$/, which matched
// .gltf and the nonexistent .glbf but NOT .glb — so uploaded .glb models (the
// common case, and exactly what the client-side FBX/OBJ/STL/PLY→GLB converter
// emits) were saved to disk yet filtered out of every dropdown. Fixed in
// v0.4.24; this guards against it coming back.
test('model filter accepts .glb and .gltf, case-insensitively', () => {
  assert.ok(hasAssetExt('model', 'dragon.glb'),  '.glb must list');
  assert.ok(hasAssetExt('model', 'dragon.GLB'),  '.GLB must list');
  assert.ok(hasAssetExt('model', 'scene.gltf'),  '.gltf must list');
  assert.ok(hasAssetExt('model', 'a.b.glb'),     'double-dotted name must list');
});

test('model filter rejects non-models', () => {
  assert.ok(!hasAssetExt('model', 'notes.txt'));
  assert.ok(!hasAssetExt('model', 'dragon.glbf'), '.glbf is not a real model ext');
  assert.ok(!hasAssetExt('model', 'dragon.fbx'),  'fbx converts client-side, never stored raw');
  assert.ok(!hasAssetExt('model', 'glb'),         'no extension');
});

test('image filter includes avif (upload allows it, listing must too)', () => {
  for (const f of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'a.avif']) {
    assert.ok(hasAssetExt('image', f), `${f} should list`);
  }
  assert.ok(!hasAssetExt('image', 'a.bmp'));
});

// The core invariant: anything the upload allowlist accepts for an
// extension-filtered type must also pass the listing filter, or it's the
// "uploaded but unselectable" bug again.
test('upload allowlist and listing filter cannot drift', () => {
  for (const type of ['model', 'image']) {
    for (const ext of ASSET_EXTS[type]) {
      assert.ok(hasAssetExt(type, `probe${ext}`), `${type} ${ext} must pass the listing filter`);
    }
  }
});

test('unknown type returns false, never throws', () => {
  assert.equal(hasAssetExt('bogus', 'x.glb'), false);
  assert.equal(hasAssetExt(undefined, 'x.glb'), false);
});
