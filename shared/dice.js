// Dice spec parsing and percentile expansion.
//
// Two callers use this:
//   * server/index.js  — chat !roll / !r / /roll / /r
//   * server/pipeline/flow-engine.js — rollDiceTray studio action
//
// They differ only in which sides they accept. The percentile expansion
// (D100 → two D10s, tens die themed ruby, units die themed sapphire) is
// identical in both paths, so it lives here too.

const MAX_DICE_PER_GROUP = 20;

// Chat: anything a human might reasonably type. Wider bound so !roll 1d1000
// still returns a server-rolled number even if we can't render it in the tray.
export const CHAT_SIDES_MIN = 2;
export const CHAT_SIDES_MAX = 1000;

// Tray/Studio: only sides we have actual physics meshes + face textures for.
// Plus 100, which expands into two renderable D10s below.
export const TRAY_SIDES_ALLOWED = new Set([4, 6, 8, 10, 12, 20, 100]);

// Subset we render directly (without expanding). D100 is renderable via the
// percentile expansion — callers that care check explicitly.
export const TRAY_SIDES_DIRECT = new Set([4, 6, 8, 10, 12, 20]);

function parseOne(p, accept) {
  const m = /^(\d*)d(\d+)$/i.exec(p);
  if (!m) return null;
  const count = Math.max(1, Math.min(MAX_DICE_PER_GROUP, parseInt(m[1] || '1', 10)));
  const sides = parseInt(m[2], 10);
  if (!accept(sides)) return null;
  return { sides, count };
}

// Parse a dice spec like "2d6", "1d20+2d6", "1d100,1d6". Returns an array of
// { sides, count } groups, or null if any part is invalid or the input is empty.
// `allowedSides` is either a Set or a (sides) => boolean predicate.
export function parseDiceSpec(str, allowedSides) {
  if (!str || typeof str !== 'string') return null;
  const accept = typeof allowedSides === 'function'
    ? allowedSides
    : (s) => allowedSides.has(s);
  const parts = str.replace(/\s+/g, '').split(/[+,]/).filter(Boolean);
  if (!parts.length) return null;
  const groups = [];
  for (const p of parts) {
    const g = parseOne(p, accept);
    if (!g) return null;
    groups.push(g);
  }
  return groups;
}

// Chat-roll variant: accepts any sides in [2, 1000].
export function parseChatRollSpec(str) {
  return parseDiceSpec(str, (s) => s >= CHAT_SIDES_MIN && s <= CHAT_SIDES_MAX);
}

// Tray/Studio variant: accepts only the allowlist of meshable sides (+ D100).
export function parseTraySpec(str) {
  return parseDiceSpec(str, TRAY_SIDES_ALLOWED);
}

// Expand a D100 group into two D10 percentile dice: one ruby (tens), one
// sapphire (units). Non-D100 groups pass through untouched.
// count=N of D100 produces 2N dice (N tens + N units, interleaved per roll).
export function expandPercentile(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap(g => {
    if (g.sides !== 100) return [g];
    const out = [];
    for (let i = 0; i < g.count; i++) {
      out.push({ sides: 10, count: 1, isPercentile: true, theme: 'ruby' });     // Tens
      out.push({ sides: 10, count: 1, isPercentile: true, theme: 'sapphire' }); // Units
    }
    return out;
  });
}

// Can every group in this spec be rendered on the 3D tray (directly or via
// percentile expansion)? If not, callers fall back to a plain server-side
// rolled number + chat reply.
export function canRenderInTray(groups) {
  if (!Array.isArray(groups) || !groups.length) return false;
  return groups.every(g => TRAY_SIDES_DIRECT.has(g.sides) || g.sides === 100);
}
