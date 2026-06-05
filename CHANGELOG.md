# FokkerPop Changelog

_Auto-generated from the last 25 Release commits. Newest first._

## v0.4.20 — 2026-06-05

**Add SCENE as a Layout custom widget (issue #11)**

You could build scenes on the Scenes tab but had no way to place one on the Layout page — this adds a Scene widget that does exactly that.

New `scene` widget type:
- "+ Scene" button in Custom Widgets. Config is a scene dropdown (fed by the existing window.scenesCache, with a 🔄 refresh button to pull scenes created after the dashboard loaded) plus `autoplay` and `loop` toggles (both default on). Size via the usual drag-resize in Layout mode.
- On the overlay it renders as a transparent host box. When autoplay is on and a scene is picked, the scene mounts *into the box* — playScene is called with mountMode='widget' + targetWidgetId forced to this widget's id, so it ignores the scene's authored mount mode and always stages inside the box. Loop re-plays every scene.durationMs.
- Scenes are resolved on the overlay from a once-fetched /api/scenes cache (the overlay didn't previously need scene JSON); the cache and the loop timers are cleared/rebuilt on each widget re-render, so no timer leaks and config edits take effect on the next save.

Reuses the singleton scene-player rather than refactoring it (the chosen scope). Documented in the widget's help text: only one scene plays at a time per overlay, so a flow-triggered scene briefly preempts an autoplaying widget scene and the loop reclaims the stage on its next tick. Without autoplay, the widget is just a placed target a flow can play into (Scene → Mount: Widget → this widget) — the editor's existing widget picker already lists every widget type, so scene-host widgets show up there with no change.

renderCustomWidgets only runs on overlay.widgets changes (not position drags), so dragging a Scene widget in Layout mode doesn't restart playback.

Issue #11 closes the SCENE-editor polish trio (#9 viewport, #10 transform fields, #11 layout placement).

---

## v0.4.19 — 2026-06-04

**SCENE inspector transform fields + reclaim dead lower-third (issue #10)**

Two fixes for the SCENE editor's wasted bottom space and missing numeric object controls.

1. Dead lower-third removed. The Scenes page is authored as a full-height flex column (toolbar + a flex:1 grid), but the global `.page.active { display:block }` rule turned that off, so the inner grid only took its intrinsic height and left a large empty band below the columns. That same collapse is why the band "resized when an object was selected" — revealing the inspector grew the right column's content height. Added `#page-scenes.active { display:flex }` so the grid's 1fr row fills the viewport; the band is gone and the layout no longer jumps on selection.

2. Numeric Transform editor. The inspector showed Name/Opacity/Material/Morph/Path/Shake but no Position/Rotation/Scale — you could only place objects by dragging the gizmo. Added a Transform section (Position, Rotation in degrees, Scale, X/Y/Z each) shared by the model and light inspectors. Editing a field moves the live Three object and writes the same position/rotation/scale keyframe at the scrubber time that a gizmo drag-end writes — one source of truth. The fields sync back live while the gizmo drags (objectChange) and when you seek the timeline, skipping any field you're mid-edit so typing is never clobbered.

Covers both solutions the issue proposed: (1) remove the unused space, and (2) use it for transform fields of the selected object. The draggable-panels idea (issue's option 3) is left for later.

---

## v0.4.18 — 2026-06-04

**Fix SCENE viewport camera fighting object manipulation (issue #9)**

Dragging a transform gizmo in the SCENE editor also rotated the camera, making objects nearly impossible to position precisely. Root cause was a race, not the missing guard the issue suspected: the animate loop set `orbit.enabled` every frame from the camera-track state alone, so the `dragging-changed` handler's `orbit.enabled = false` was stomped on the very next frame and OrbitControls kept rotating mid-drag.

Fix makes the animate loop the single authority on `orbit.enabled` and folds the gizmo state into it: OrbitControls is suspended when the transform gizmo is being dragged (`transform.dragging`) OR merely hovered (`transform.axis != null`). Gating on hover — not just active drag — means the click that grabs a handle never also kicks off a camera rotate, which is what issue #9 asked for ("deactivate camera manipulation for left-click whenever the object gizmos are being manipulated").

Left/middle/right mouse behavior is otherwise unchanged everywhere else in the viewport, so existing muscle memory (left=orbit, middle=zoom, right=pan) is preserved when no gizmo is involved. The now-redundant `orbit.enabled` toggle was removed from the `dragging-changed` handler, which keeps only its keyframe-commit duty.

---

## v0.4.17 — 2026-05-26

**Cluster E — predictions + polls + hype train (full) + charity. Closes the last remaining cluster on issue #4. With this, every Twitch-side feature category we scoped is shipped.**

EventSub subscriptions for 10 new event types: prediction.{begin,progress,lock,end}, poll.{begin,progress,end}, hype_train.{begin,progress,end} (begin/end were already there, this adds progress full coverage), charity_campaign.{start,progress,stop,donate}. Each is normalized into a FokkerPop event with a flat payload — outcomes/choices flattened so templates don't have to dot-walk Twitch's nested API shapes. Charity amounts decoded to floats so {{ event.payload.amount.value }} reads as 5.00 not { value: 500, decimal_places: 2 }.

Three new OAuth scopes added — channel:read:predictions, channel:read:polls, channel:read:charity. Existing connects keep working unchanged for everything else; cluster E features show 'NEEDS RECONNECT' in the Health panel until Fokker hits Reconnect Twitch, which is the same QoL pattern v0.4.15 set up for the ads scope.

EventSub subscribe loop now reports per-feature scope failures to integration-status. If channel:read:polls is missing but other subs succeed, the Health panel marks 'Polls: NEEDS RECONNECT' specifically — no more guessing which feature is broken from a generic "1 subscription failed" log line.

Aggregated state surfaces via state.twitch.{prediction,poll,hypeTrain,charity} — separate from the event stream so widgets / templates can read 'is there an active prediction right now' without listening for events. Active prediction's title + per-outcome channel-points wagered, active poll's title + leading choice, current hype-train level + progress / goal, current charity campaign name + current/target amounts + last-donor + last-donation-amount. Twelve new widget fields on the Twitch Live widget cover the most common displays (active title, leading option, winner, level, progress).

Templates get prediction / poll / hypeTrain / charity shorthand alongside the existing twitch.X paths, so `{{ prediction.winningOutcome }}` works directly instead of needing twitch.prediction.winningOutcome.

TEST_PAYLOADS extended with realistic shape for each new event type so Studio's "Test This Trigger" produces banner text matching what real Twitch events deliver. Variables reference panel lists the new state paths.

**Issue #4 cluster status: 7 of 7 ✅** — A (live stats), B (totals), C (leaderboards), D (per-user role/tier), E (predictions/polls/hype/charity), F (schedule/ads/recent followers), G (chat dynamics). Net-new on-screen items also done: Twitch Live widget, Twitch Card effect, Twitch Integration Health panel.

---

## v0.4.16 — 2026-05-26

**Cluster C — persistent supporter leaderboards (weekly + all-time). Closes the only remaining longer-window cluster on issue #4. The current-stream leaderboard has lived in state.leaderboard since forever; this adds two longer windows that survive session resets.**

New persistent store at leaderboards.json — deliberately separate from state.json so Reset Session only wipes the current stream and never touches the longer windows. Rolling-week totals derive from a pruned event log (7-day retention, lazy-pruned on each recordSupport). All-time totals are maintained directly so we don't need to retain the full event history. Both atomically flushed with a .bak fallback, same pattern as state.json.

The existing Leaderboard widget gets a Scope dropdown — This Stream / This Week / All-Time — so a single widget covers all three windows by reconfiguring rather than needing three widget types. Defaults to This Stream so existing widgets behave the same.

Studio templates get {{ leaderboardWeek.bits.UserName }} and {{ leaderboardAllTime.bits.UserName }} for raw access, plus a topSupporter(category, scope) helper that returns the username with the highest tally — so flows can match on "current top bits donor across the week" without manual sorting in the template. Variables reference panel lists the new fields.

Two new reset endpoints + dashboard buttons (under Reset Session Stats): Reset Weekly clears the rolling 7-day totals, Reset All-Time wipes lifetime totals. Both are confirm-gated; copy makes clear what they do and don't touch.

leaderboards.json + .bak + .tmp added to .gitignore and to the release.yml smoke-test invariant list so we don't accidentally ship a populated file to users.

Cluster status (6 of 7): A, B, C, D, F, G shipped. Only E (predictions/polls/hype/charity) queued.

---

## v0.4.15 — 2026-05-26

**Cluster F (schedule + ads + recent followers) + Twitch Integration Health panel + cross-area QoL pass. Big one — bundles issue #4's cluster F with the professional-practices uplift Fokker asked for (logging, error handling, visible config + status, dashboard clarity).**

**Cluster F shipped**: Three new pollers feed state.twitch.{schedule, ads, recentFollowers}. Templates get {{ twitch.schedule.next.startAt/title/category }}, {{ twitch.ads.nextAdAt/snoozeCount }}, {{ twitch.recentFollowers.count24h/latest/list }}. The Twitch Live widget gets six new field options including two live-tick countdowns (Next Stream / Next Ad). Ads needs the new channel:read:ads scope — existing connects keep working unchanged; reconnecting picks up the scope and unlocks the ad-break data. Schedule = 1 h poll, ads = 60 s poll, recent followers = 60 s poll.

**Categorized Helix errors**: helixGet now throws HelixError { kind: 'scope'|'auth'|'rate-limit'|'not-monetized'|'network'|'unconfigured'|'data' } instead of bare Error("Helix /path → 401"). Pollers branch on kind, dashboard distinguishes "needs reconnect" from "transient network blip" without parsing strings.

**Rate-limited error logging**: log.once(key, value, level, ...args) — same error under the same key only logs first occurrence + state transitions, not every 60-second repeat. Used by all Twitch pollers. Was already cluttering long-stream logs with the same "401 stream-stats" line every minute.

**Twitch Integration Health panel** (Setup tab): One central status panel showing every Twitch-derived feature with status dot (ok/missing-scope/unavailable/unconfigured), last value summary, last error message, last-fetched timestamp, required scopes, and poll cadence. Reconnect-Twitch button auto-appears when any feature is missing-scope. Copy-as-JSON button for support diagnostics.

**Scope persistence**: OAuth callback now saves the actually-granted scope list to settings.twitch.scopes. Pollers pre-flight against this before making Helix calls, so the Health panel can show "needs reconnect" immediately without burning a request to discover it.

**Widget empty/error states**: Counter / Progress Bar widgets bound to invalid or unset metric paths now show "—" with a hover-tooltip explaining the problem instead of silently showing 0. readMetric returns undefined for missing paths (was 0) so callers can distinguish "no data yet" from "value is zero".

**Scenes editor save status**: The flash-on-save-success badge is now a four-state indicator — EDITING (debounced) / SAVING… / SAVED (fades) / SAVE FAILED (persistent with tooltip). Was previously silent on failure.

**Scene asset-load errors surface to dashboard**: scene-player.js now fires a scene-error event when a model 404s or GLB parse fails, instead of just console.warn + magenta wireframe. Dashboard Event Log picks it up so Fokker sees what went wrong.

**Flow node errors surface to Studio**: flow-engine catch-block now publishes a flow.node-error event with { flowId, nodeId, error }. Studio applies a red persistent border + corner badge to the failing node and adds an entry to the Event Log. Highlight clears on next successful fire of the same node.

---

## v0.4.14 — 2026-05-25

**Cluster G — chat dynamics (active chatters, message rate, top chatter, heat). Issue #4. Pure aggregation over the chat-event stream we already process — no new Helix endpoints, no new scopes, just a rolling-window tracker that surfaces as state.twitch.chat. Two windows feed it: 60 s for the messages/min rate, 5 min for the unique active-chatter count. Top chatter is session-lifetime and resets when you fire Reset Session.**

Available as Studio variables ({{ twitch.chat.activeChatters }} / .messageRate / .topChatter / .heat) and as widget fields on the existing Twitch Live widget (three new entries in the dropdown). The chat fields get a "heat-modulated" dot — its brightness pulses with chat rate so a single widget can be both "30 msgs/min" text AND a visible "chat is on fire" indicator without a separate effect.

Server broadcasts the snapshot every 5 s — fast enough that the heat feels responsive, slow enough that we're not flooding the WS bus with per-message updates. Always running even when Twitch is disconnected so dashboard previews work in offline dev.

---

## v0.4.13 — 2026-05-25

**Cluster B — channel totals (followers + subscribers + sub points). Issue #4. Mirrors the cluster A pattern: 120 s Helix poll (totals move on minutes-to-hours, no need for 60 s), surfaces as state.twitch.totals so templates can use {{ twitch.totals.followers }} / .subscribers / .subPoints in any Match node or banner text. The existing Twitch Live widget gets three new field options (Total Followers / Total Subscribers / Sub Points); totals display whether you're live or not since they're channel-level facts, not stream-session facts.**

Required Helix scopes (moderator:read:followers + channel:read:subscriptions) have been in the OAuth scope list since v0.3.30, so existing connected installs get the new poll for free without re-authing. New installs follow the same Save & Connect flow.

---

## v0.4.12 — 2026-05-25

**Twitch Card effect (issue #4 cluster A — PolyPop-style user callout). Closes the second of the two net-new items Fokker asked for; combined with v0.4.11's Twitch Live widget, the on-screen side of cluster A is now feature-complete pending his test pass.**

New `showTwitchCard` flow action and `twitch-card-show` effect. Drop the action into a flow and it pops a card on the overlay with the user's avatar, display name, and a Partner/Affiliate badge — same shape as the PolyPop "kill a jugger" callout Fokker described. Username field defaults to `{{ payload.user }}` so a Redeem trigger automatically cards the redeemer; Cheer trigger cards the cheerer; etc. Optional subtitle field for "Killed a Jugger!" / "Top Bits!" / whatever.

Avatars are fetched server-side via the existing Helix `getUser()` call and cached for 1 h to keep the Helix budget alive across long streams. The enrichment happens inside broadcastEffect via a fire-and-forget promise — callers don't need to await, and if Helix is unreachable or the user isn't found we fall back to a card with just the username (no broken-image). Bundled-deps from prior commits (ws 8.21.0, GH Actions v5, Node 22) all ship with this release.

Also added: Test Effects toolbar button so Fokker can preview the card without authoring a flow, default test uses `lilfokker` so his real avatar appears in the preview.

---

## v0.4.11 — 2026-05-25

**Twitch Live Stats widget (issue #4 cluster A — on-screen widget). The 60s Helix poll has been broadcasting `state.twitch.live` since v0.3.30 but only Studio variables could read it; Fokker explicitly asked for both variables AND an on-screen widget for viewer count. This ships the widget: a new "+ Twitch Live" button on the Custom Widgets toolbar with a field selector (Viewers / Uptime / Stream Title / Category), a pulsing red dot when live (gray when offline), and a custom-label override. Uptime ticks every second locally between server polls so the clock doesn't visibly freeze. Initial state is now pushed to overlays on connect so a freshly-loaded overlay sees the correct value immediately instead of waiting up to 60s for the next poll. As a free side-effect, the existing Counter and Progress Bar widgets can now also bind to `twitch.live.viewers`-style metric paths since I added `twitch` to readMetric's scope — useful for "viewers as a goal target" or "viewers > 50 triggers effect" via Match nodes.**


---

## v0.4.10 — 2026-05-24

**Scenes editor timeline relocated to top + motion-overview sparklines on tracks. Two user-requested improvements landing together since they're both about making the timeline more useful at a glance.**

Timeline relocation: the timeline strip moves from the bottom of the Scenes tab to the top. It was the first thing the streamer wanted to see (the primary authoring surface) but was buried 240px below the viewport. CSS grid template flips from `1fr 200px` to `240px 1fr`, and the three side panels (assets / viewport / scenes-list) shift to row 2. The toolbar with duration/mount/aspect controls comes with it. No content change — the timeline body, header, and all its keyframe diamonds/forks/branches/camera row render exactly as before, just in a more prominent place.

Motion-overview sparklines: each object track now renders a faint purple line behind its keyframe diamonds showing the shape of the object's position movement across the scene duration. New computeMotionPath() samples 60 points across the duration using resolvePositionAtTime() (a simplified, easing-free position lerp — easing nuance shows up in keyframe-diamond borders instead so the sparkline stays a "where does this thing move?" overview). Magnitude (Math.hypot of x/y/z) is normalized into the inner 60% of row height and rendered as an SVG path with vector-effect=non-scaling-stroke so it stays a thin 1.2px line regardless of how the row is sized.

Tracks with fewer than two position keyframes return an empty path — silent rather than rendering a misleading flat line. Tracks where every position is identical (zero motion across all samples) also return empty since `max - min < 0.001`. So the sparkline only appears when there's actual motion to visualize, which is the useful state.

---

## v0.4.9 — 2026-05-24

**Scenes editor gizmo + animation-jitter fixes. Two issues from first real-world use: (1) clicking-and-dragging an object only orbited the camera — the TransformControls gizmo was attached but the default handle size in three.js r0.184 is small enough that the colored arrows look like noise against a 1-unit auto-fit model, and clicks fall through to OrbitControls. Fixed by bumping `transform.size` from 1.0 → 1.5 so the handles are visibly larger than the object's silhouette. (2) Animated scenes visibly stuttered/flickered each frame — material + opacity setters in both shared/scene-player.js (runtime) and dashboard/scenes-editor.js (editor preview) were unconditionally writing every channel every frame, including `material.transparent = true` and float assignments to metalness/roughness/emissiveIntensity. Three.js's material setters bear dirty flags that force shader recompiles or rebind buffers when the new value differs from the current, but our writers didn't compare first — so an animated scene effectively recompiled materials every frame.**

Fix: every setObjOpacity / setObjMaterial / setOpacity / setMaterial write is now guarded against per-frame re-assignment. Colors are compared via the existing material's hex string so the cheap `Color.getHexString()` skips the more-expensive `Color.set(hex)` parse when the keyframe value matches what's already on the material. Float channels (metalness, roughness, emissiveIntensity, opacity) use `!==`. Boolean wireframe likewise. The `m.transparent = true` flag is set once on first opacity-touch and left alone after, so the depth-sort transparency pass only reconfigures once per material rather than per frame.

Side benefit: scenes with many animated objects or large GLBs should feel noticeably smoother on lower-spec hardware — the dirty-flag thrash was burning a non-trivial frame budget on materials that weren't actually changing.

---

## v0.4.8 — 2026-05-24

**Fix silent Twitch-disconnect after fresh OAuth. The Connect-to-Twitch flow stored the new access + refresh tokens but never resolved the broadcaster's user id from them, so the EventSub.isConfigured() check (which requires clientId AND accessToken AND userId) returned false, connect() hit its "Offline mode active" no-op branch, and the dashboard's Twitch badge stayed orange. No error appeared in the log because this is the documented offline-mode path — the badge just sat there. Existing installs with a userId already cached in settings.json (e.g. from older Setup-wizard versions) worked fine; any fresh install or settings.json reset would always look like "OAuth succeeded but it didn't connect."**

Fix: after the token exchange in handleOAuthCallback, call a new helix.getAuthenticatedUser(accessToken) helper that hits GET /users with no login param — Twitch returns the account whose token is on the request. Save .userId (and .userLogin for future debugging surfaces) into settings.twitch alongside the tokens, BEFORE saveSettings() + twitchEventSub.connect(). Now connect() sees isConfigured=true on the very first OAuth completion and dials EventSub straight through to the "session established" → setStatus('connected') path that flips the badge green.

Wrapped in try/catch so a transient /users 5xx doesn't kill the OAuth completion — token still gets stored, and the badge will turn green on the next manual Reconnect (or any subsequent OAuth refresh) once the lookup succeeds. New log line if the lookup returns no user (impossible in practice, but defensive) so future regressions in this path are visible rather than silent.

---

## v0.4.7 — 2026-05-24

**Scenes Phase 7b — in-scene branch clips with loop regions. Closes the original "choose-your-own-adventure within a scene" ask. A scene can now pause at an authored time, cycle a loop region (animation keeps playing while waiting) until a matching bus event arrives, then route to one of N branches based on the event's payload. v0.4.6's schema was already in place; this release ships the runtime + editor that make it usable.**

Server (server/index.js):
- Per-WS subscription set ws._busSubs. New handlers _overlay.subscribe-bus and _overlay.unsubscribe-bus add/remove event types. A single bus.on('*') listener forwards matching events back to subscribed overlays as { type:'bus-event', event }. We never broadcast the full bus to overlays — only the types they explicitly asked for — so the firehose stays contained even with many simultaneous scenes. Subscriptions live with the ws and disappear on close.

Runtime (shared/scene-player.js):
- branchClips pre-sorted by start at scene load; each gets a _fired flag so a clip only triggers once even if the playhead crosses its start time multiple times (which happens whenever a jump-target lands before the clip).
- Every RAF tick checks if realElapsed has crossed the next unfired branchClip.start. On crossing, enterBranchWait: subscribes to wait.eventType, arms a setTimeout for timeout.target if configured, stashes waitState on the scene.
- While in wait state: realElapsed keeps advancing (so the timeout fires in real time and audio/forks scheduled earlier still play out), but the displayElapsed used for animation/camera/path/shake folds into the loop region: loopRegion.from + ((now - enteredAt) % (to - from)). No loop region = freeze at clip.start. Natural scene end is suppressed while waiting so a wait that outlasts durationMs holds the scene open until resolution.
- Bus-event handler matches the wait's event type, evaluates branches[].match against payload first-match-wins (empty {} matches anything — fallback branch), and dispatches the winning target. matchesEvent checks each match key against event.payload[k], falling back to event[k] for top-level fields. Unmatched events keep waiting (so "any input that matches NO branch is invalid" is the implicit semantic).
- resolveBranchWait tears down subscription + timeout regardless of target, then dispatches: jump shifts startTime so future frames see elapsed = target.time; scene/scene-end/flow/effect round-trip through the server's existing _overlay.* command handlers; flow + effect targets resume the scene from clip.start so post-branch content plays next.

Editor (dashboard/scenes-editor.js + index.html):
- New "🌿 Add Branch" toolbar button. Default new clip has loopRegion = [start, start+1000ms], wait.eventType = 'dice-rolled', a single fallback branch with empty match + scene-end target, and a 30s timeout to scene-end. The defaults give an authored-but-not-yet-configured branch clip safe completion semantics rather than waiting forever.
- New "🌿 Branches" timeline row (red, distinct from the green Forks row). Each branch clip renders as a red diamond at its start, with a thin red bar under the diamond visualizing the loop region's span when one's authored.
- Drag-to-retime slides the loop region with the diamond — the streamer's usual authoring intent is "this loop happens right before the branch," so they stay anchored together. Shift snaps to 100ms.
- Right-click opens a wider editor panel (capped to fit on-screen, scrolls internally if many branches): wait event type input, loop region from/to fields with a toggle, a per-branch list (match JSON + target editor + delete) with + Add Branch, and an optional timeout with ms + target. The target editor is a reusable component (targetEditorHtml + bindTargetEditor) shared with branch row + timeout row, supporting jump / scene / scene-end / flow / effect.

CYOA model now has two equally-valid paths: scene → scene-end → flow → awaitResult → playScene (v0.4.6, server-side branching, lets the streamer reuse the rich flow editor for complex decision trees) OR in-scene branch clip with loop region (v0.4.7, timeline-native, the scene visibly holds while waiting for a dice/chat/redeem result and the streamer sees the loop on the scrubber). Same primitive underneath — both write to the bus, both wait via awaitBusEvent-like semantics — but the authoring surface is different per use case.

Scenes epic closed. The remaining roadmap items (chat-command / chat-vote / redeem as branch-clip wait kinds, visual scene-graph view) are derived shortcuts over the event primitive that work today via wait.eventType = 'chat' with a match on payload.message; they ship as syntactic sugar in a later release if Fokker hits friction.

---

## v0.4.6 — 2026-05-24

**Scenes Phase 7 — fork clips, scene-end, widget-mount, awaitResult. Closes the Scenes epic's main feature set: scenes can fork into flows/events/effects/other-scenes mid-playback without pausing; scene completion publishes a 'scene-end' bus event flows can trigger on; scenes can render into placed widgets instead of fullscreen; flows get an awaitResult node that pauses for a matching bus event (with the rollDice action now emitting dice-rolled results for it to wait on). CYOA-style "branch on dice → pick scene B/C/D" works end-to-end via scene-end → awaitResult → playScene chaining. In-scene branch clips with loop regions are schema-supported and deferred to v0.4.7 for runtime; they need a server↔overlay event bridge that's its own architecture (the flow-level approach in v0.4.6 covers the same authoring need without the server-side state).**

Server bus (server/bus.js):
- New awaitBusEvent(eventType, predicate, timeoutMs) primitive — one-shot promise that resolves with the first matching bus event or rejects on timeout. Cleanup is auto on resolve/reject so a flow that times out doesn't leak a listener.

Flow engine (server/pipeline/flow-engine.js):
- New 'awaitResult' logic node: pauses flow execution awaiting a matching bus event, exposes the matched event's payload via ctx.exprCtx.result. Default 30s timeout; on timeout result is null so downstream filter/match nodes can branch on the absence.
- 'scene-end' is now a known trigger type with a Specific Scene scoping field (sceneId on the flow — same back-compat pattern redeem's rewardTitle uses; empty = any scene, set = only that scene).
- rollDice action publishes a dice-rolled bus event with { value, sides, user } so awaitResult flows can listen for it without going through the heavier physics-tray path.
- TEST_PAYLOADS gains a scene-end entry for "▶ Test This Trigger" on scene-end flows.

Server routing (server/index.js):
- _overlay.event WS handler publishes the event onto the bus and routes through flowEngine.processEvent — the symmetric overlay-side equivalent of _dashboard.test-event. Used by scene-end emission.
- _overlay.run-flow / _overlay.fire-effect / _overlay.play-scene handlers route fork-clip dispatches to the same server primitives the flow engine uses, so a fork from a scene has the same semantics as the same action from a flow or a manual API call. Multi-overlay safe (broadcast effects reach every overlay, not just the sender).

Schema (server/pipeline/scenes.js):
- forkClips: [{ id, start, target: { type: 'flow'|'event'|'scene'|'effect', ...config } }]. Fire-and-forget timeline markers.
- branchClips: [{ id, start, loopRegion?: { from, to }, wait: { kind: 'event', eventType }, branches: [{ match, target }], timeout? }]. Schema lands now; runtime ships in v0.4.7.
- Widget mount mode is no longer schema-stubbed: mountMode='widget' requires targetWidgetId, validated; the editor's mount-mode dropdown enables the option.
- Shared validateTarget helper for fork/branch target validation — same enum + required-field checks across both clip types and branch timeouts.

Runtime (shared/scene-player.js):
- mountMode='widget': finds the widget element by data-id or DOM id, mounts the renderer inside it instead of a fullscreen layer. Falls back to fullscreen with a console warning if the widget isn't found (rather than failing silently).
- Fork clips scheduled via setTimeout per clip; each dispatches via WS back to the server (_overlay.run-flow / _overlay.fire-effect / _overlay.play-scene / _overlay.event). Round-tripping rather than dispatching locally means other overlays (multi-monitor, split browser source) all receive the same effects and the server's flow-engine state stays consistent.
- stopScene() now emits a scene-end bus event with { sceneId, sceneName } on natural completion. Silent on preempt (when another playScene tears down the current one) so the new scene's end is the only scene-end the user sees.
- Tracks forkTimeouts alongside audioTimeouts so a preempted scene cleans up both.

Editor (dashboard/scenes-editor.js + index.html):
- Toolbar: "🔀 Add Fork" button — adds a fork clip at scrubber time with a sensible default (effect: confetti). Mount-mode dropdown's 'widget' option is no longer disabled; selecting it surfaces a widget-id picker populated live from /api/widgets so the user can pick which placed widget to render into.
- New "🔀 Forks" timeline row pinned between Camera and object tracks. Green diamonds for each fork; drag-to-retime + right-click context menu mirroring the camera/object keyframe interaction patterns. Click on a fork diamond opens the same context menu (forks have no "playhead seek" semantic — there's nothing to scrub to). Menu includes a compact target editor: type dropdown (effect/flow/scene/event) with conditional config (effect name, flow picker from window.flows, scene picker from the current editor's scene list excluding self, or event-type free-text).
- studio.js exposes window.flows so the fork target's flow picker can render without re-fetching /api/flows when the menu opens.

CYOA in v0.4.6: scene A (with intro animation) → scene-end event → flow trigger='scene-end' (sceneId=A) → rollDice → awaitResult on dice-rolled → match-node on result → playScene B/C/D. Or use forks for mid-scene branching when the cue is time-based rather than event-based. v0.4.7 will add in-scene branch clips for the case where the streamer wants the loop-region wait-with-music UX described in the original ask.

---

## v0.4.5 — 2026-05-24

**Scenes Phase 6 — in-browser model conversion + expanded media formats. Streamers can now drop FBX / OBJ / STL / PLY models into the asset library and the dashboard converts them to GLB on the fly before upload; the server's allowlist stays glb/gltf-only so the overlay only ever needs GLTFLoader at runtime. Plus AVIF for modern web images and FLAC / Opus for high-quality audio.**

Vendor (server/index.js):
- New /vendor/three/loaders/{FBX,OBJ,STL,PLY}Loader.js + /vendor/three/exporters/GLTFExporter.js + FBXLoader transitive deps (fflate for binary FBX decompression, NURBSCurve + NURBSUtils for FBX curve data). Editor-only — the overlay never touches these so its bundle stays the same size for streamers who never convert anything.

Allowlist (/api/upload):
- images + stickers + character gain `.avif` (default modern web image format).
- sounds gain `.flac` and `.opus` (Chrome and Firefox both decode natively).
- Models stay glb/gltf only — by design, since the dashboard converts other formats client-side. The rejection message updates to explain that the dashboard auto-converts and that the rejection only fires for non-dashboard upload paths (curl, scripted uploads, etc.).

New module (shared/asset-conversion.js):
- convertModelToGlb(file, onProgress) → File: extension-based loader dispatch (FBXLoader / OBJLoader / STLLoader / PLYLoader), parse the buffer (decoded as text for OBJ, raw ArrayBuffer for the rest), GLTFExporter in binary mode produces an ArrayBuffer that becomes a new File with .glb extension swapped in. STL + PLY return raw BufferGeometry rather than scene-graph nodes — the converter wraps them in a Mesh with a neutral MeshStandardMaterial so GLTFExporter can serialize. All loader + exporter imports are lazy so the conversion module costs nothing until the first non-GLB model upload triggers it; users on glb-only workflows pay zero. Parse + export failures throw with the original loader's error message so the upload-dialog banner explains specifically why a file couldn't convert.

Dashboard (dashboard/app.js + index.html):
- The model upload input's accept attribute extends to .fbx/.obj/.stl/.ply so the OS file picker shows them; image input adds image/avif. handleFileUpload routes through asset-conversion when the file extension isn't already glb/gltf — conversion happens inline before the POST, so a failure stops the upload entirely (no orphan files on disk, no silent-success-then-vanish like the bug v0.3.33 was guarding against). Success alert now mentions the original filename when the file was auto-converted, so the streamer can see what just happened. On conversion failure the existing error-reporter banner surfaces the loader's specific error message — same path the server-side extension rejection uses.
- New showUploadProgress / updateUploadProgress / hideUploadProgress overlay: fixed-position modal with a CSS-spin loader and a status line. Shows during the multi-second parse + export phases on bigger files so the dashboard doesn't look frozen. Lazy-created on first show (no DOM cost when no conversion is happening).

Spritesheets and other non-3D asset import work deferred to a later release — they want their own asset type + listing path which is out of scope for "model conversion + media-format expansion." Phase 7 (v0.4.6) closes the Scenes epic with branch/fork clips for CYOA scenes, scene-end event into the flow engine, and widget-mount mode.

---

## v0.4.4 — 2026-05-24

**Scenes Phase 5 — morph targets, path-follow, shake. Three more primitive channels round out the animation set: character-style morph targets (Blender shape keys exported via glTF), spline path-following so objects can fly along authored curves, and additive shake/jitter on top of any other position animation. Every channel composes with prior phases — a path-followed character can still ease, shake, and lerp its emissive color.**

Schema (server/pipeline/scenes.js):
- Per-keyframe `morphTargets: { [shape-key-name]: weight }` — weight ∈ [0,1]. Names match Blender's shape-key names as exported in the GLB. Missing names lerp from/to 0 so unspecified morphs settle back to neutral instead of holding stale weights.
- Per-object `pathFollow: { points: [[x,y,z],...], loop?: bool, speed?: 1 }` — control points for a CatmullRomCurve3 (≥2 enforced). When present, overrides position-keyframe interpolation entirely. speed scales how fast the curve is traversed (default = full curve per scene duration); loop=true wraps alpha so the path cycles, false clamps at the end.
- Per-keyframe `shake: { amplitude: [x,y,z], frequency: number }` — additive sine displacement applied on top of position each frame. Amplitude and frequency interpolate between keyframes; shake state with all-zero amplitude effectively disables the channel.

Runtime (shared/scene-player.js):
- On GLB load, walks the subtree for meshes with morphTargetDictionary + morphTargetInfluences and stashes the (mesh, dict) pairs on the group's userData so per-frame keyframe application can look up indices by name in O(1). setMorphs(obj, weights) writes to mesh.morphTargetInfluences[index] for every name resolved against the dictionary.
- Path-follow: CatmullRomCurve3 built once per object at scene load (not per frame). Animate loop computes alpha = (elapsed/duration)*speed, wraps or clamps based on loop, and overrides obj.position from curve.getPoint(alpha) AFTER applyKeyframeAt — so a path-followed object's position-keyframes are silently ignored without the schema having to encode that.
- Shake: applyKeyframesAt interpolates amplitude/frequency between bracketing kfs, applyShakeDisplacement adds amp[i] * sin(2π*freq*elapsedSec + phase[i]) to each axis. Per-axis phase offsets (0, 1.7, 3.4 — arbitrary primes-ish so X/Y/Z don't sync) make the shake look chaotic rather than a single 1D oscillation. Applied after path-follow so shake works on top of curve motion too.

Editor (dashboard/scenes-editor.js):
- Object inspector grows three new collapsible sections: ▾ Morph Targets (one slider per shape-key name, only shown if the loaded GLB has any — re-renders the inspector after async GLB load so the rows appear), ▾ Path Follow (JSON textarea for points + Loop checkbox + speed input + Clear button; path-follow edits trigger rebuildViewportFromActive so the path curve + visualizer line refresh), ▾ Shake (X/Y/Z amplitude inputs + frequency Hz; all-zero values delete the channel from the keyframe to keep saved JSON tidy). Inspector resolveCurrent{Morphs,Shake} walk the track up to currentTime so the controls reflect what the viewport is actually showing at the scrubber.
- Path-follow visualizer: cyan THREE.Line drawn from curve.getPoints(64) so the streamer can see the path while authoring. Lines tagged via userData.isPathLine; clearPathLines() called at the top of rebuildViewportFromActive so stale lines from a prior scene/edit don't pile up. Same cleanup pattern used for light helpers (now also tagged with userData.isLightHelper so the same traversal-by-flag pattern works for both).
- Animate loop calls applyPathAndShake(currentTime) after applyTracksAtTime so the editor preview matches the runtime player frame-for-frame. Same call also added to the timeline scrubber-click + keyframe-click + camera-keyframe-click seek paths so seeking shows accurate path/shake state.

Phase 6 (v0.4.5) expands asset import compatibility — FBX / OBJ / STL / PLY converted to GLB in-browser via the Three.js loaders + GLTFExporter, with a progress UI and the existing error-reporter banner surfacing failures. Phase 7 closes the epic with branch/fork clips for CYOA-style scenes and widget-mount mode.

---

## v0.4.3 — 2026-05-24

**Scenes Phase 4 — material, light, and camera channels. Scenes get cinematic-looking in v0.4.3: object materials can be keyframed (tint/emissive/metalness/roughness/wireframe), scenes can author their own lights (ambient/directional/point) with keyframable intensity + color, and a per-scene camera track drives the rendered camera through scripted moves (position/lookAt/fov with easing). Everything composes with the existing transform/opacity tracks and the audio bus from Phase 3 — the scene player has one unified RAF loop that interpolates every channel from the same keyframe arrays.**

Schema (server/pipeline/scenes.js):
- Keyframes accept a `material` block (color/emissive as hex, emissiveIntensity 0–5, metalness/roughness 0–1, wireframe boolean) and a `light` block (intensity, color) on top of the existing position/rotation/scale/opacity channels. wireframe snaps (no lerp); everything else interpolates.
- New object type 'light' with a required `light: { kind, intensity?, color?, distance? }` block. kind ∈ {ambient, directional, point}. Light objects don't reference an `asset` (validator relaxes the asset-required rule for type='light').
- Scene-level `cameraTrack: { keyframes: [...] }` animates the camera. Each kf may set position, lookAt, fov, easing — all optional. When cameraTrack exists and is non-empty the player drives the camera from it; otherwise the initial scene.camera block stays in effect.
- New hex-color regex validates #rgb and #rrggbb on every color field — a typo'd color now gets rejected with a clear human message instead of rendering silently black.

Runtime (shared/scene-player.js):
- Builds lights per kind on scene load (AmbientLight / DirectionalLight / PointLight from THREE), applies initial transform to directional/point (ambient has no position). Default lighting now skips itself if the scene authors its own lights — author-driven scenes start dark and add exactly the lights they need; legacy scenes without lights still get the v0.4.0 3-point default so nothing existing renders flat-black.
- applyKeyframesAt interpolates material channels (color/emissive lerp in RGB via lerpHex helper, floats lerp normally, wireframe snaps with the FROM kf), light channels (intensity float, color RGB), and a new applyCameraAt drives the renderer camera each frame when cameraKeyframes is non-null. setMaterial walks the GLB subtree so material edits land on every mesh inside a loaded model. Camera updates use cam.updateProjectionMatrix() on fov change and cam.lookAt() after position to match Three.js's matrix-rederivation order.

Editor (dashboard/scenes-editor.js):
- Object inspector grows a "▾ Material" details section: tint color picker, emissive color picker, glow (emissiveIntensity) slider, metal/rough sliders, wireframe checkbox. Each edit writes a material keyframe at scrubber time and live-applies to the viewport so the streamer sees changes immediately. resolveCurrentVisualProps walks the track up to ed.currentTime so the inspector reflects what the viewport is actually showing at the scrubber rather than always seeding fresh defaults.
- Light inspector is a separate render path (renderLightInspectorHtml + bindLightInspector) with kind label, intensity slider, color picker, and distance field for point lights — writes light keyframes the same way. Asset-panel gets three "+ Directional / + Point / + Ambient" buttons (click-to-add at sensible per-kind default poses; not drag-to-place since lights aren't files). Viewport renders DirectionalLightHelper and PointLightHelper so the streamer can see + select lights (ambient has no visual representation; the timeline row is the only handle for it).
- Toolbar gets a "📷 Key Camera" button that captures the current OrbitControls camera state (position + .target as lookAt + .fov) as a cameraTrack keyframe at the scrubber time. Timeline gets a dedicated "📷 Camera" row pinned to the top with its own keyframe diamonds (gold-colored to distinguish from object keyframes); same drag-to-retime and right-click easing/delete menu as object keyframes. During ▶ Test, OrbitControls is suspended while cameraTrack drives the camera so user pan/zoom doesn't fight the animation — re-enables the instant playback stops or the track is emptied. Scrubbing also applies the camera at the seeked time so the viewport reflects exactly what the runtime would render.
- writeOpacity/Material/Light keyframe writers consolidated into a shared upsertKeyframe(objectId, t, mutate) — find-or-create track, find-or-create kf at t, mutate, sort-once-after-insert. Replaces three near-identical writers with one.

Phase 5 (v0.4.4) introduces morph targets, path-follow, and shake/jitter. Phase 6 expands asset import to FBX/OBJ/STL/PLY via in-browser conversion. Phase 7 ships branch/fork clips and widget-mount mode.

---

## v0.4.2 — 2026-05-23

**Scenes Phase 3 — audio bus with priority + ducking hierarchy. Adds a Web Audio bus that every overlay sound now flows through, retrofits the existing playSound() to route via the bus (defaults preserve current behavior so nothing existing changes audibly), wires per-scene audio entries through the bus with configurable priority/policy, and gives the Scenes editor an audio panel + preview so the streamer can hear the mix locally before going live. New file shared/audio-bus.js — single AudioContext + master GainNode per page; per-sound GainNode chain (MediaElementSource → gain → master → destination). Tracks every active sound in a list and on every play/end recomputes effective gain for each based on what higher-priority sounds are currently active. Four policies: `mix` (default, free layering — what every existing sound has been doing), `duck-below` (attenuates lower-priority by 0.2 = -14dB while playing), `solo` (mutes lower-priority entirely while playing, they resume on end), `cancel-below` (stops lower-priority immediately on play, no resume). Equal-priority sounds always coexist regardless of policy — only strictly-lower priorities are affected. Default priority 50; convention is ambient=20, sfx=50, scene-audio=60, alert=80, voice=90, but the scale is open. Gain transitions use `setTargetAtTime(target, now, 0.05)` for click-free ducking ramps when scene audio kicks in or releases. createMediaElementSource failures fall back to native HTMLAudioElement playback so the sound still happens — just bypasses bus mixing for that one entry, never silent.**

Overlay's playSound() is now a thin wrapper that delegates to the bus when it's loaded (lazy-imported on first call so import cost only paid on overlays that actually emit audio). Legacy HTMLAudioElement path remains as a fallback for the first few ms before the module finishes loading or in the rare case Web Audio is unavailable. Signature is unchanged — every existing call site (alerts, dice-roll, sticker-rain, crowd-explosion, etc.) continues to work with no modification and gets default priority=50/mix, so all existing flows behave identically. The bus's master gain syncs with overlay.volume state, so the existing dashboard volume slider continues to govern overall output.

Scene schema (server/pipeline/scenes.js) gains an optional `audio: []` array per scene. Each entry validates { id, src, start (ms), priority? (0–100), policy? (enum), vol? (0–1), loop? (bool) }; validator rejects bad enums, out-of-range numbers, duplicate ids, missing required fields with the same human-message-to-error-banner path as everything else. Schema documented in scenes.js's header comment block alongside the other fields.

shared/scene-player.js (the runtime, lazy-loaded on first scene-play) now schedules each scene.audio entry via setTimeout at its start time. Each play goes through the audio bus with the configured priority/policy — so a scene declaring a music track at priority=60, policy=duck-below will automatically attenuate any sfx (priority=50, mix) that fires during the scene without the streamer having to think about it. stopScene() explicitly clears all scheduled timeouts and stops every audio handle the player created — a scene that's preempted by another scene's playScene flow action no longer leaks audio.

Editor (dashboard/scenes-editor.js) gets a "🎵 Scene Audio" panel in the right-hand side of the Scenes tab, above the scenes list. + Add creates a new entry pre-populated with the first available sound, start=0, priority=60, policy=mix. Each row is a compact inline editor: sound dropdown, start-ms field, vol slider, priority slider, policy dropdown, loop checkbox, delete button. Edits queueSave-debounced like everything else. ▶ Test in the editor now also schedules audio through the bus so the mix Fokker hears in the editor matches what plays on overlay — stopEditorPreviewAudio() runs at scene end / scene-switch / re-test so looped tracks don't leak past the visible timeline.

Phase 3 wraps the audio layer. Phase 4 (v0.4.3) is material/light/camera channel keyframes.

---

## v0.4.1 — 2026-05-23

**Scenes Phase 2 — easing curves, keyframe handles, object inspector, aspect guide. The Scenes editor stops feeling like a toy in v0.4.1: animations can ease (linear is a robotic-looking default), keyframes are draggable on the timeline, selected objects expose an inspector with name/opacity/delete, and a configurable letterbox guide shows the user where the OBS frame will sit. Each piece is small on its own — the bundle is what makes scene authoring actually pleasant. New file shared/easing.js exports an 11-entry Penner easing map (linear, ease-in/out/in-out quad+cubic, ease-in-out-sine, ease-out-back/bounce/elastic) — same canonical set GSAP and After Effects use, so the curves match user expectation. resolveEasing(name) falls back to linear on unknown names so a hand-edited scenes.json with a misspelled easing doesn't crash the player. Schema (server/pipeline/scenes.js) gains an optional per-keyframe `easing` field validated against the easing module's keys. Convention is Blender-FCurve-style: the FROM keyframe's easing shapes the segment to the next keyframe, the TO keyframe's easing is ignored on that segment. Both shared/scene-player.js (runtime) and dashboard/scenes-editor.js (editor preview) compute `alpha = resolveEasing(a.easing)(rawAlpha)` before the lerp so what plays on overlay matches what scrubs in the editor. Editor keyframe diamonds now use mousedown-driven interaction so we can disambiguate click (seek + select) from drag (retime). Drag updates the keyframe's t live as you slide; shift snaps to 100ms increments for tidy placement; release sorts the track + queueSave. Refuses to drop on a t that already has a different keyframe (the player only accepts one kf per t and a duplicate would be silently shadowed). Right-click on a diamond opens a context menu listing all easing presets (✓ marks the current one), with a delete entry — replaces v0.4.0's shift-click delete with something discoverable. Eased keyframes get an orange outline so non-linear segments are visible at a glance without opening the menu. Object inspector card (right-hand panel above the scenes list, hidden when nothing selected) surfaces the selected object's editable name (defaults to asset basename, falls back to asset for display), live opacity slider 0–1 that writes an opacity keyframe at the scrubber position on every change (the slider is explicit edit, so auto-key on/off doesn't gate it), and a delete button that strips the object + its track and tears down the Three.js subtree. Timeline label uses `obj.name || obj.asset` so renames propagate. Aspect-ratio guide: a configurable letterbox overlay on the 3D viewport showing where the OBS browser source will frame the scene. Per-scene `aspectRatio: number?` (validator rejects ≤0); toolbar dropdown picks 16:9 (default for new scenes), 9:16 (vertical/mobile), 4:3, 1:1, or Off. Pointer-events:none so it never steals viewport interaction; resizes with the viewport via the existing ResizeObserver. Editor's applyKeyframesAt now also interpolates opacity (was runtime-only in v0.4.0) so scrubbing through opacity keyframes previews live in the editor viewport, not just on the real overlay. Phase 2 wraps the editor polish; Phase 3 (v0.4.2) introduces the audio bus with priority + ducking hierarchy.**


---

## v0.4.0 — 2026-05-23

**Scenes — author timeline-driven 3D scenes and trigger them from flows (Phase 1 of the Scenes epic; Phases 2–7 land in subsequent releases). New 🎬 Scenes tab in the dashboard mounts a Three.js viewport where the user drags assets from a left-side library onto the stage, manipulates them with a transform gizmo (move/rotate/scale, switchable via toolbar buttons), and scrubs a horizontal timeline at the bottom of the page. Auto-keyframe (toolbar checkbox, default on) writes a keyframe to the selected object's track on every gizmo drag-end at the current scrubber time — saved via debounced POST /api/scenes (matches the flows/widgets whole-array-replace pattern). Scene playback runs in two places that share the same JSON: a "▶ Test" button in the editor plays the active scene in the viewport for preview, and the new `playScene` flow action ships the full scene JSON over WS via `broadcastEffect('scene-play', { scene }, isTest)` so any trigger (redeem, chat command, hotkey, etc.) can fire a scene on real overlays. Sending the whole scene rather than just the id avoids a race where the user edits between flow-fire and overlay-load. The runtime in shared/scene-player.js is lazy-imported on first scene-play to keep Three.js out of the initial overlay bundle for setups that never use scenes; it mounts a fullscreen layer (z-index 9999, pointer-events:none so widgets underneath still get layout clicks), loads GLB/GLTF models via GLTFLoader with the same auto-fit-to-unit-bbox trick the model-3d widget uses (so arbitrary-scale models render at sane sizes), and renders image-plane objects as textured PlaneGeometry with transparent MeshBasicMaterial. Failed model loads render a magenta wireframe placeholder so missing assets are visible rather than silently absent. RAF loop interpolates position/rotation/scale/opacity linearly between bracketing keyframes; opacity walks the subtree and force-sets material.transparent=true since Three.js's opaque-by-default materials would otherwise ignore opacity writes. New file server/pipeline/scenes.js documents the v0.4.0 schema in a header comment block and exposes validateScene()/defaultScene(). Every POST is validated before the write; violations return a 400 + human message so the dashboard's error-reporter banner surfaces the rejection inline (same path v0.3.33 added for upload extension rejection). Schema is intentionally forward-compatible — unknown fields are preserved on save so later phases can add channels without breaking existing scenes. Studio's flow editor gets a 🎬 Play Scene action (toolbox button + context-menu entry + properties dropdown that lists every scene from a /api/scenes fetch seeded into window.scenesCache at app boot). Vendor allowlist in server/index.js extended to serve three's OrbitControls + TransformControls from /vendor/three/controls/ for the editor viewport (overlay doesn't need either). Smoke test (test/smoke.spec.mjs) updated to assert the new Scenes sidebar tab renders. Phase 1 scope is intentionally minimum-viable: linear interpolation only (easing curves in Phase 2), no audio bus hierarchy (Phase 3), no material/light/camera channel keyframes (Phase 4), no morph targets / path-follow / shake (Phase 5), no expanded asset-import format conversion (Phase 6), no branch/fork clips for CYOA scenes and no widget-mount mode (Phase 7).**


---

## v0.3.34 — 2026-05-23

**Per-widget "block overlap" flag for spatial widgets. Adds a claimsSpace property on widgets that opts them into footprint-reservation behavior in Layout mode: another claimsSpace widget can't be dragged or resized into the overlap. Defaults on for the physics/3D widgets where overlap looks visibly broken on stream (physics-pit, physics-pit-3d, dice, dice-tray, hot-button-3d, model-3d) — dice tumbling out of one pit and visually clipping into another is the original motivating case. Defaults off for everything else (text, stickers, banners, counters) since stacking is normal there. Per-widget checkbox in the widget config card lets the user override the default in either direction. Defaults live in `shared/widget-claims-space.js` as a plain script (loaded into both overlay and dashboard) so the marking and the check use the same source of truth. Overlay marks each rendered widget with `data-claims-space="1"` when applicable and the drag/resize handlers in overlay.html consult it. Drag clamp tries the proposed (x,y) and on collision falls back to x-only or y-only motion so widgets slide along an obstacle's edge instead of sticking dead at the contact point. Resize clamp uses the same axis-fallback to let a corner-handle drag past a blocked direction keep growing along the unobstructed axis. Both use an "escape mode": if two widgets are \*already\* overlapping (e.g. from a pre-v0.3.34 layout), movement that doesn't \*worsen\* the overlap is allowed — only non-overlap → overlap transitions get blocked — so the user isn't stuck. Non-claimsSpace widgets ignore the rule entirely on both ends (they don't reserve space, and they don't get blocked by anything).**


---

## v0.3.33 — 2026-05-04

**Reject silently-failing asset uploads, addressing issue #8. Fokker uploaded a 3D model exported from Blender — the file landed in `assets/models/` (the upload "succeeded") but the model didn't appear in the dashboard's selection dropdown. Root cause: the upload endpoint accepts any filename for any asset type without extension validation, while `/api/assets` (the listing endpoint that drives the selection dropdowns) filters models to `.glb`/`.gltf` only and images to a fixed extension allowlist. So an `.fbx` (or `.obj`, `.stl`, `.usd`, `.ply`, `.abc` — Blender's other export formats) write would succeed and then disappear from the UI, making it look like the upload broke. Same hole existed on every type, just less visibly. v0.3.33 adds a per-type extension allowlist on `/api/upload` (sound: wav/mp3/ogg/m4a, sticker+image: png/webp/gif/jpg/jpeg/svg, character: png/webp/jpg/jpeg, model: glb/gltf) and rejects mismatches with a 400 + a clear human message. The model rejection message specifically tells the user to re-export as `.glb` ("the universal 'JPEG of 3D' format" — Fokker's own framing) since Three.js's `GLTFLoader` is what FokkerPop ships, and the other formats would each need their own loader bundle. The error surfaces in the dashboard's existing `error-reporter` banner via the upload handler's `res.text()` path, so the user sees the rejection reason inline instead of the previous silent-success-then-vanish behavior. Closes #8 once Fokker re-exports as .glb.**


---

## v0.3.32 — 2026-05-04

**One-click Global Hotkey wizard, addressing follow-up on issue #3. Fokker tested v0.3.31's manual AHK flow and re-asked the original "make hotkeys work when OBS is foreground" question without picking up that the AutoHotkey route was the answer — too many steps (install AHK / Export script / Run script / flip Global toggle) for the test-loop he uses (between game respawns during live streaming). v0.3.32 collapses the whole flow behind a single "🛠️ Global Hotkeys…" button in the Studio toolbar that opens a guided wizard. The wizard runs four steps: (1) `GET /api/system/ahk-status` checks well-known AutoHotkey install paths (`%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe` first, then 32-bit, then user-local at `%LOCALAPPDATA%\Programs\…`, finally v1 installs which we explicitly flag as wrong-version since our generated scripts are v2-marked). If AHK isn't installed, the wizard shows a brief "what is AutoHotkey + why we don't bundle it (AV heuristics on unsigned binaries)" explainer with an "Open AutoHotkey download page" button that opens autohotkey.com in a new tab and an "I've installed it" recheck button. (2) `POST /api/system/install-ahk-script` writes the latest hotkey script into the user's Windows Startup folder (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\fokkerpop-hotkeys.ahk`) so it auto-launches at next login — re-runnable since we always overwrite the same file with the freshest set of hotkeys. (3) `POST /api/system/launch-ahk-script` spawns the AHK exe with the script path detached + unref'd so closing FokkerPop doesn't kill the running AHK instance, and the script body now carries `#SingleInstance Force` so re-running the wizard cleanly replaces any prior FokkerPop AHK instance instead of stacking duplicates. (4) The wizard auto-flips the dashboard hotkey listener's localStorage flag to off so a focused dashboard doesn't double-fire, then shows a success panel listing every active hotkey/flow pairing plus the script's on-disk path, and a small "🗑️ Disable global hotkeys" link that calls a new `POST /api/system/uninstall-ahk-script` endpoint to remove the Startup-folder file. The disable path deliberately doesn't `taskkill` AHK — that would nuke unrelated AHK scripts the user might have running for other reasons. Instead it tells them "right-click the AHK tray icon → Exit, or wait until next reboot." The previous toolbar layout (separate 📋 Export AHK link + 🌐 Global Off/On toggle button) is replaced by the single 🛠️ Global Hotkeys… entry — the wizard's footer keeps an "Advanced: download script manually" link for users who want the manual route. Internally, the AHK script generator was extracted from the GET endpoint into a `buildAhkScript()` helper that both the download endpoint and the new install endpoint reuse, so there's exactly one definition of what a FokkerPop hotkey script looks like.**


---

## v0.3.31 — 2026-05-04

**Global hotkeys via AutoHotkey export, follow-up to issue #3. Fokker came back asking if hotkeys could fire while OBS or a game is foreground (the v0.3.30 listener only worked while the dashboard tab was focused). Three options were on the table — native global key hook (`uiohook-napi` etc.), HTTP endpoint paired with AutoHotkey, or a hybrid where we ship the endpoint and \*also\* generate a ready-to-run AHK script. We went with hybrid because the native key-hook path adds a `.node` binary to the release zip and global keyboard hooks routinely trip Windows Defender heuristics on unsigned builds — false-positives that would spook a streamer mid-setup. Three pieces landed: (1) `POST /api/run-flow/:flowId` is the HTTP equivalent of the existing `_dashboard.run-flow` WebSocket message — same single-chain semantics from v0.3.29's testFlow path, `isTest:false` so the OBS overlay reacts. The existing same-Origin CSRF gate stays as-is; AHK passes the gate by setting `Origin: http://localhost:<port>` via `Msxml2.XMLHTTP.SetRequestHeader`. That's not a security hole — the gate is a browser-CSRF defense (browsers refuse to let scripts forge Origin), and any non-browser caller could already bypass it. (2) `GET /api/run-flow.ahk` generates an AutoHotkey v2 script with one binding per active flow that has a hotkey configured. The script embeds the current server port and uses a `comboToAhk()` translator to convert dashboard combo strings ("Alt+1", "Ctrl+Shift+F1") into AHK syntax (`!1`, `^+{F1}`). Function keys, navigation keys, and ordinary letters/digits are handled; combos that can't be safely encoded fall through as comment lines so a bad entry doesn't break the rest of the script. (3) Studio toolbar gets a `📋 Export AHK` link (downloads the generated script as `fokkerpop-hotkeys.ahk`) and a `🌐 Global Off / On` toggle. When Global is on, the dashboard-focused listener bows out, so AHK is the sole owner of hotkeys — without that, having both running while the dashboard window is focused would double-fire the flow. Toggle state persists in localStorage. The hotkey props field's helper text was rewritten to point users at the export button + AHK install link. Also tightened the recorder: it now refuses to bind a naked digit/letter (no modifier), since that would let an Alt-less keypress on a focused dashboard page accidentally fire flows.**
