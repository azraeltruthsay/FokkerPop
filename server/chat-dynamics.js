// Chat-dynamics tracker (issue #4 cluster G). Derived stats over a rolling
// window of chat events — no Helix calls, no scopes, just aggregation of the
// chat events that already flow through the bus. Surfaces as state.twitch.chat
// for templates and widgets.
//
// Two windows:
//   - 1 min rate window  → messageRate (messages in the last 60 s)
//   - 5 min active window → activeChatters (unique users in the last 5 min)
//
// Plus session-lifetime top chatter (highest message count since the last
// session reset). All in-memory; resets on FokkerPop restart or when the
// dashboard fires Reset Session.

const RATE_WINDOW_MS   = 60_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
// 60 msg/min = full heat. Calibrated against PolyPop's "chat is on fire"
// threshold — at 60 mpm a typical 100-viewer chat is actively engaged, not
// just trickling. Tunable if Fokker's chat profile differs.
const HEAT_FULL_RATE   = 60;

let recentMessages = [];      // [{ ts, user }] trimmed to ACTIVE_WINDOW_MS
const userCounts   = new Map(); // user → lifetime message count (per session)

function trim(now) {
  const cutoff = now - ACTIVE_WINDOW_MS;
  let cut = 0;
  while (cut < recentMessages.length && recentMessages[cut].ts < cutoff) cut++;
  if (cut > 0) recentMessages.splice(0, cut);
}

export function recordChat(user) {
  if (!user || typeof user !== 'string') return;
  const now = Date.now();
  recentMessages.push({ ts: now, user });
  trim(now);
  userCounts.set(user, (userCounts.get(user) ?? 0) + 1);
}

export function compute() {
  const now = Date.now();
  trim(now);
  const rateCutoff = now - RATE_WINDOW_MS;
  let recentInRate = 0;
  const activeUsers = new Set();
  for (const m of recentMessages) {
    if (m.ts >= rateCutoff) recentInRate++;
    activeUsers.add(m.user);
  }
  let topUser  = '';
  let topCount = 0;
  for (const [user, count] of userCounts) {
    if (count > topCount) { topUser = user; topCount = count; }
  }
  return {
    activeChatters:  activeUsers.size,
    messageRate:     recentInRate,
    topChatter:      topUser,
    topChatterCount: topCount,
    heat:            Math.min(1, recentInRate / HEAT_FULL_RATE),
  };
}

export function reset() {
  recentMessages = [];
  userCounts.clear();
}

export default { recordChat, compute, reset };
