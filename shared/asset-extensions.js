// Single source of truth for which file extensions each asset type accepts.
//
// Both the upload allowlist (/api/upload) and the listing filters (/api/assets)
// derive from this table so they can never drift apart. Drift was the root of
// the recurring "uploaded the file but can't select it" bug: the upload handler
// accepted .glb while the listing regex /\.(gl[bt]f)$/ silently dropped it
// (matched .gltf and the nonexistent .glbf, never .glb), so the model landed on
// disk but never appeared in any dropdown. Same shape bit .avif images, which
// upload allowed but the old image listing regex excluded.
//
// Note: sounds, stickers, and characters are listed permissively in /api/assets
// (any non-dot file) so manually-dropped files still show; this table governs
// their *upload* allowlist only. Models and images are the types whose listings
// filter by extension, so for those the upload and listing sets are identical
// by construction.

export const ASSET_EXTS = {
  sound:     ['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.opus'],
  sticker:   ['.png', '.webp', '.gif', '.jpg', '.jpeg', '.svg', '.avif'],
  image:     ['.png', '.webp', '.gif', '.jpg', '.jpeg', '.svg', '.avif'],
  character: ['.png', '.webp', '.jpg', '.jpeg', '.avif'],
  model:     ['.glb', '.gltf'],
};

// True if `filename` ends with one of the allowed extensions for `type`
// (case-insensitive). Returns false for unknown types rather than throwing.
export function hasAssetExt(type, filename) {
  const exts = ASSET_EXTS[type];
  if (!exts) return false;
  const lower = String(filename).toLowerCase();
  return exts.some(ext => lower.endsWith(ext));
}
