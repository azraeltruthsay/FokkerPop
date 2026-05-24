// Easing functions for scene keyframe interpolation.
//
// Each function takes a normalized alpha (0..1, where 0 is the FROM
// keyframe and 1 is the TO keyframe) and returns a re-mapped alpha that
// the interpolator then uses for the lerp. Robert Penner's standard
// equations — same set that After Effects, GSAP, and three.js easing
// helpers use, so user expectation matches.
//
// Convention: a keyframe's `easing` value determines how the curve from
// THAT keyframe to the next feels. Matches Blender's FCurve interpolation
// model. The TO keyframe's easing is ignored on this segment.
//
// Imported by both shared/scene-player.js (runtime, lazy-loaded on first
// scene-play) and dashboard/scenes-editor.js (editor viewport preview)
// so the curve the user sees in the editor matches what fires on overlay.

export const easingFns = {
  // ── No-op ──
  'linear':           t => t,

  // ── Quadratic (gentle) ──
  'ease-in-quad':     t => t * t,
  'ease-out-quad':    t => 1 - (1 - t) * (1 - t),
  'ease-in-out-quad': t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,

  // ── Cubic (default for most "feels right" cases) ──
  'ease-in-cubic':    t => t * t * t,
  'ease-out-cubic':   t => 1 - Math.pow(1 - t, 3),
  'ease-in-out-cubic':t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,

  // ── Sine (very subtle) ──
  'ease-in-out-sine': t => -(Math.cos(Math.PI * t) - 1) / 2,

  // ── Back (overshoots slightly past the target, then settles) ──
  'ease-out-back':    t => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },

  // ── Bounce (decaying bounces at the end of an ease-out) ──
  'ease-out-bounce':  t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1)     return n1 * t * t;
    if (t < 2 / d1) { t -= 1.5  / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1;
    return n1 * t * t + 0.984375;
  },

  // ── Elastic (oscillates near the target before settling) ──
  'ease-out-elastic': t => {
    const c4 = (2 * Math.PI) / 3;
    if (t === 0) return 0;
    if (t === 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};

export const EASING_NAMES = Object.keys(easingFns);

// Resolve an easing name to its function, falling back to linear if the
// name is missing or unknown. Used during interpolation so an unknown
// easing value (from a hand-edited scenes.json) doesn't blow up the
// player — it silently degrades to linear and the scene still plays.
export function resolveEasing(name) {
  return easingFns[name] || easingFns['linear'];
}
