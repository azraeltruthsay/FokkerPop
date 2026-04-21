// Numeric semver compare.
//
// String compare on dotted versions works only while every component is
// single-digit-within-the-same-width: "0.2.48" < "0.2.49" is fine, but
// "0.2.100" < "0.2.49" is *also* true lexicographically. Anything that
// gates on version order must compare per-component as integers.

export function parseVersion(v) {
  return String(v ?? '0')
    .replace(/^v/, '')
    .split('.')
    .map(n => parseInt(n, 10) || 0);
}

// Packs major/minor/patch into one integer for cheap ordering comparisons.
// Components can each hold up to 999 before collisions — that buys us years
// even on a rapid-release cadence.
export function versionScore(v) {
  const [maj = 0, min = 0, patch = 0] = parseVersion(v);
  return maj * 1_000_000 + min * 1_000 + patch;
}

export function semverGt(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
