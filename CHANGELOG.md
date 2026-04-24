# FokkerPop Changelog

_Auto-generated from the last 24 Release commits. Newest first._

## v0.2.110 — 2026-04-23

**Resize widgets from any edge or corner in Layout mode.**

Layout mode now supports 8-direction resize in addition to drag-to-move:
- Each widget gets 4 edge handles (N/S/E/W) with ns-resize/ew-resize cursors
- And 4 corner handles (NW/NE/SW/SE) with nwse-resize/nesw-resize cursors
- SE corner keeps its visible grip texture as the "primary" resize cue;
  other handles are transparent but the cursor change signals resizability
- Dragging any W/N-facing handle moves the widget's top-left position so
  the opposite edge stays pinned where the user grabbed it (standard
  window-resize behavior)
- Minimum size 80×40 so a widget can't be shrunk to invisibility

On release, the overlay sends `_dashboard.save-size` to persist
`config.width` and `config.height` to widgets.json (and
`_dashboard.save-position` if the resize moved the top-left). Server
handles the new message in both the dashboard and overlay branches.

Implementation notes:
- renderCustomWidgets in overlay.html injects all 8 handles per widget
- New resetWidgetContent(el) helper in overlay-widgets.js replaces the
  6 `el.innerHTML = ''` calls in mount functions. Before this, each 3D
  widget mount wiped the handles on remount, which in practice meant
  only 2D widgets had working resize; after, all widgets keep handles
  through re-mount cycles.
- 3D widgets pick up new dimensions via the usual overlay.widgets
  re-broadcast → renderCustomWidgets → remount pathway. No live
  renderer.setSize needed.

Verified via Playwright: 8 handles attach to every widget (counter,
physics-pit, dice-tray, model-3d), E-edge cursor is ew-resize, E-drag
of +60px persists 480x280, W-drag of -50px correctly grows width and
shifts position left so the right edge stays pinned.

---

## v0.2.109 — 2026-04-20

**Pin user-data protection as a release-zip invariant.**

Layout and other user customizations already survive updates because
widgets.json, state.json, goals.json, redeems.json, commands.json,
flows.json, and settings.json are all gitignored — so they never enter
the release zip, and NSIS's SetOverwrite can't clobber them.

But "already works" isn't "stays working." Adding an explicit assertion
to the zip-smoke step in release.yml: if any of those seven files ever
slip into a packaged zip, the release fails before it gets published,
protecting users from silently losing their Layout / Goals / Twitch
credentials on update.

Verified: v0.2.107 zip contains none of the seven. Layout is safe.

---

## v0.2.108 — 2026-04-20

**CI gates release on real-zip boot smoke.**

The release workflow now extracts the freshly-built Windows zip, boots
the server from the extracted copy with a throwaway port, and asserts
that /dashboard/, /shared/dice.js, /shared/semver.js, /overlay-widgets.js,
and /vendor/three.module.min.js all respond before the zip gets uploaded.

This catches the class of bug that shipped v0.2.103–106: files committed
in git but missing from the packaged artifact. verify.yml's html + unit
tests run against the dev tree, which always has shared/; only a test
against the zip itself can notice when packaging drops a directory.

Verified locally against the v0.2.107 zip — all 5 routes respond, server
boots without module-resolution errors.

---

## v0.2.107 — 2026-04-20

**Include shared/ in Windows release zip.**

v0.2.103 introduced shared/dice.js (imported by server/index.js and
server/pipeline/flow-engine.js) and v0.2.102 introduced shared/semver.js
(imported by server/update-checker.js and the dashboard). Both files are
committed in git, but the release workflow's packaging step copied only
server/ and dashboard/ — it never added shared/ to the Windows zip.

Result: every install of v0.2.103 through v0.2.106 crashes on boot with
ERR_MODULE_NOT_FOUND for ../shared/dice.js because the directory simply
isn't there. Confirmed by inspecting the published v0.2.106 zip: 1487
entries, zero under shared/.

Fix is the one-word addition to release.yml:
  cp -r server dashboard "${PKG}/"
→ cp -r server dashboard shared "${PKG}/"

Verified locally that shared/dice.js and shared/semver.js are tracked in
git (shipped in commits 84260b7 and cc38a35 respectively).

---

## v0.2.106 — 2026-04-20

**Graceful WebGL context-exhaustion handling.**

Root cause of the "dice doesn't work" symptom: Chrome caps live WebGL
contexts at ~16 per process. Dashboard preview iframes (Test Effects,
Layout) + the main overlay tab + an OBS browser source each run multiple
3D widgets (dice-tray, model-3d, physics-pit-3d, hot-button-3d), which
cumulatively exhaust the pool. When `new T.WebGLRenderer(...)` threw for
model-3d, the uncaught rejection cascaded and the user saw dice-tray's
"no mounted entry" warning when they clicked Roll 2d6.

Two fixes:

1. overlay.html now wraps every widget mount in `.catch` — physics-pit,
   dice, model-3d, physics-pit-3d, dice-tray (already had one),
   hot-button-3d. Each failure logs with the widget type + id so it's
   obvious which widget died and why. No more cascading uncaught
   rejections.

2. overlay-widgets.js introduces createWebGLRenderer(T, el): a shared
   helper that catches the context-creation throw and renders a clear
   "3D widget unavailable" placeholder card in the widget slot, with
   the real error message and a prompt to close tabs / remove unused
   3D widgets. The five mount sites (mountDice, mountDiceTray,
   mountHotButton3D, mountPhysicsPit3D, mountModel3D) all use it.
   When the helper returns null, the mount throws a named error that
   the .catch in overlay.html surfaces to console.

Net effect for the user: one widget failing no longer kills the others.
If model-3d can't get a context, it renders a clear explanation card,
and the dice-tray gets its context and works normally.

---

## v0.2.105 — 2026-04-20

**Fix three.js bare-specifier import failure.**

/vendor/GLTFLoader.js does `import … from 'three'` (bare specifier). Browsers
can't resolve bare specifiers without an import map, so the module failed to
load — any code path that touched GLTFLoader silently broke, which notably
includes:

- model-3d widgets (GLB scenes)
- dice-tray themes with GLB meshUrls
- anywhere else downstream that lazy-imports GLTFLoader

Fix is three small changes:

1. Add `<script type="importmap">` to overlay.html and dashboard/index.html
   mapping `"three"` → `/vendor/three.module.min.js` so bare imports resolve.

2. Restructure the vendor allowlist so GLTFLoader's internal relative
   `../utils/BufferGeometryUtils.js` import resolves correctly:
     /vendor/three/loaders/GLTFLoader.js
     /vendor/three/utils/BufferGeometryUtils.js
     /vendor/three/utils/SkeletonUtils.js
   Flat /vendor/GLTFLoader.js and /vendor/BufferGeometryUtils.js aliases
   are kept for back-compat.

3. Update overlay-widgets.js's two dynamic imports to point at the new
   /vendor/three/loaders/GLTFLoader.js path.

Verified via a Playwright probe: before this change, overlay load logged
`Failed to resolve module specifier "three"`. After the change, the error
is gone and the dice tray still rolls cleanly for both the `dice-tray-roll`
event and the redeem → rollDiceTray flow path.

---

## v0.2.103 — 2026-04-20

**Completion of the Fokkerpop Quality Protocol.**

- Unified validation suite: HTML, Semver, Assets, Logic, and Smoke tests.
- Robust navigation fallback system in the Dashboard.
- Automated release gating.

---

## v0.2.104 — 2026-04-20

**Fix broken audio assets, add bubloon/firework SFX.**

Replaces the 3 corrupt primary sound files that were failing silent
playback since the v0.2.99 era, plus lays in audio for future flows:

- alert.wav  → mixkit-alert-bells-echo-765 (was a 301 KB HTML download)
- pop.wav    → mixkit-long-pop-2358        (was a 301 KB HTML download)
- boom.wav   → mixkit-fireworks-bang-in-sky-2989 (was 301 KB HTML)
- balloon-squeak.wav  (new) — for a planned bubloon action
- balloon-deflate.wav (new) — ditto
- firework-alt.wav     (new) — alternate firework texture
- firework-whistle.wav (new) — whistle firework variant

All six are Mixkit sounds under the Mixkit Sound Effects Free License
(commercial + personal use, attribution not required). Originals are
listed in assets/sounds/ATTRIBUTION.md for traceability.

Still broken (user is sourcing replacements): chime.wav, ding.wav,
follow.wav, sub.wav, yay.wav. The asset integrity check remains
advisory in CI until those are replaced.

Also: tmp_assets/ is now gitignored so staged-but-uncommitted audio
drops don't accidentally get committed to the repo.

---

## v0.2.102 — 2026-04-20

**Restore dashboard tabs and fix false UPDATE FAILED banner.**

- dashboard/index.html: the Assets-tab extraction in v0.2.99 dropped the
  closing </div> for the Visual Effects/Alerts/Custom Alert card, leaving
  #page-effects structurally unclosed. Every subsequent page (Assets,
  Goals, Layout, Config, Studio, Log, Setup) was nested inside it, so
  sidebar clicks toggled .active on hidden descendants and nothing
  rendered. Added the missing close tag so each .page is a sibling again.

- dashboard/app.js: setVersion()'s "are you on the latest?" guard used a
  string compare (v < '0.2.49'), which flipped once any component crossed
  99 — "0.2.100" < "0.2.49" is true lexicographically. Replaced with a
  numeric per-component compare so 0.2.100+ stops triggering the false
  "UPDATE FAILED" banner. (server/update-checker.js already used parseInt,
  so downloads were fine; this was purely a dashboard false alarm.)

---

## v0.2.101 — 2026-04-20

**Fix Dashboard navigation and blank tabs.**

- Exposed renderWidgetList, renderConfigEditors, and populateSimulatorRedeems to the window object.
- Updated navigation logic with try-catch blocks to prevent single-page errors from breaking the entire dashboard.
- Ensured Layout and Config pages refresh their content immediately on tab selection.

---

## v0.2.100 — 2026-04-20

**Fix Assets tab blank issue.**

- Fixed Assets tab by exposing populateGallery to window and calling it in the navigation logic.
- Added safety check to populateGallery to handle async asset loading.
- Centralized all media management in the new tab with improved sound testing UI.

---

## v0.2.99 — 2026-04-20

**Assets Tab and Mascot Visuals.**

- Dedicated Assets tab: Centralized media management with its own navigation entry.
- Enhanced Sound Testing: Gallery sounds now have per-item volume sliders and Test buttons.
- Mascot Visual Fixes: Replaced broken HTML-as-GIF files with valid star placeholders.
- Robust Asset Loading: Added intelligent extension fallback (.gif -> .png -> .webp -> .jpg) for mascots.

---

## v0.2.98 — 2026-04-20

**Mascot layout placeholder.**

- Added data-placeholder to character-wrap so the mascot is visible and grabbable in Dashboard Layout mode even if the image hasn't loaded.

---

## v0.2.97 — 2026-04-20

**Dice sync and percentile improvements.**

- Multi-Overlay Sync: Implemented Roll ID system to gate dice results, ensuring only the first result from multiple active overlays is processed.
- D100 Percentile: Updated d100 rolls to use Red (Ruby) Tens and Blue (Sapphire) Units. Results are now correctly summed as percentiles (1-100) and visually synced.
- Automated Chat Replies: FokkerPop now authoritatively replies to Twitch chat for tray-based rolls.
- Precision Settle: Tightened physics thresholds and increased dwell time for better accuracy on rounder dice like the D20.
- Bug Fixes: Fixed isTest propagation and expanded d100 support to Studio flows.

---

## v0.2.96 — 2026-04-19

**Roll for Pairs redeem. Rolls 2D6 and reacts to any matching pair (not just boxcars or snake eyes) — a balloon burst + yay.wav on a pair, a single chiming balloon on a miss. Pair probability is 6/36 (~17%), landing between the 1-in-36 boxcars/snake-eyes redeems and the 1-in-20 D20 crits. Implemented with a template-evaluated match node (field expression: {{ payload.dice[0].result === payload.dice[1].result ? 'pair' : 'none' }}) which doubles as a working example of the Studio engine's full JS expression support.**


---

## v0.2.95 — 2026-04-19

**Roll 6s! and Roll 1s! are now proper 2D6 rolls — Roll 6s! looks for boxcars (sum=12), Roll 1s! looks for snake eyes (sum=2). Plural reward titles now actually reflect plural dice. Misses still take the default branch so every roll gets a reaction.**


---

## v0.2.94 — 2026-04-19

**Consolation branches on the dice-result flows. Roll 6s!, Roll 1s!, and D20 Roll of Fate's result flows now switch from a pass-or-die filter to a match node with a default port, so a miss gets its own effect instead of silence. Roll 6s! miss → short sticker-rain + ding; Roll 1s! miss → a couple of chiming balloons; Roll for Luck rolls 2–19 → three balloons + chime, while crit (20) and fumble (1) keep their original payoffs.**


---

## v0.2.93 — 2026-04-19

**Glass-box the sound and the dice redeems. Studio's spawnEffect action now has a structured Sound dropdown + volume slider that write into payload.sound / payload.vol, so Fokker no longer has to edit raw JSON to change an effect's sound. rollDiceTray gains an optional Tag field that travels all the way through the bus (dice-tray-roll → widget → overlay → dice-tray.rolled), so follow-up flows can filter on payload.tag to react only to their own rolls. Roll 6s!, Roll 1s!, and Roll for Luck redeems are now Studio-handled with real 3D dice-tray rolls instead of static fireworks/confetti: each redeem fires a rollDiceTray with a distinct tag, and a paired result flow reacts on the settled sum.**


---

## v0.2.92 — 2026-04-19

**Ship three real dice-roll sounds (dice1/dice2/dice3.wav) sourced from SoundBible under CC-BY 3.0, with attribution recorded in assets/sounds/ATTRIBUTION.md. Dice widget + dice-tray widget now expose a "roll sound" dropdown in the dashboard so Fokker can pick any file under assets/sounds/ without editing JSON, and the default fallback moves from coin.wav to dice1.wav since we now actually have proper dice audio.**


---

## v0.2.91 — 2026-04-19

**Dice size default bumped from 0.45 → 0.55 (about 50% bigger on-screen area) — the old value was sized for a demo and read as pinched once the new materials and UV remap landed. Custom-colour theme: the theme dropdown now offers "custom" alongside the seven canvas presets, and picking it reveals face-colour + number-colour pickers plus metalness / roughness sliders so Fokker can dial in any palette without shipping a full image theme. Custom theme still gets the etched bump map and clearcoat.**


---

## v0.2.90 — 2026-04-19

**Dial back dice clearcoat a notch — clearcoat strength 0.75 → 0.45 and clearcoatRoughness 0.18 → 0.3 so the polished-resin sheen reads as subtle rather than showroom-fresh.**


---

## v0.2.89 — 2026-04-19

**Realistic dice — polished, engraved, and properly sized. Materials upgrade to MeshPhysicalMaterial with clearcoat + a PMREM-prefiltered procedural environment map so gold, silver, and obsidian themes pick up real metallic highlights instead of flat shading. Per-face UV remapping centers each face's texture on the face's actual geometry, and the glyph font scales adaptively by face shape (D20 triangle, D6 square, D12 pentagon, D10 kite), so numbers no longer look tiny on triangular faces or bulge on kites. A grayscale bump map carves the numerals (and pips) into the surface as true recessed engraving — paired with the clearcoat it reads as classic etched-and-inked resin dice.**


---

## v0.2.88 — 2026-04-19

**Dice tray readability + chat rolling. Camera tilts steeper toward the top face so settled numbers are actually visible, face textures doubled to 256px with bolder outlined glyphs and underlined 6/9, and a post-settle text overlay spells out the sum even when a die lands at a weird angle. Custom Dice Roll picker is now "X of Y" — pick a count (1–5) and a type (D4/D6/D8/D10/D12/D20/D100), where D100 rolls as 2× D10 percentile. Chat dice roller ships: viewers typing !r / !roll / /r / /roll <spec> (e.g. 2d6, 1d20+2d6, 1d100) roll on the 3D tray when the sides are renderable; otherwise the server rolls and posts the result back to Twitch chat.**


---

## v0.2.87 — 2026-04-19

**Hotfix — three.js 3D widgets were silently failing to mount because three.module.min.js's sibling three.core.min.js wasn't in the vendor allowlist, so the import 404'd and every dice / physics-pit-3d / model-3d / hot-button-3d widget dropped. Also upgrades the D20 Roll of Fate flow to roll on the 3D dice tray and adds a companion crit/fail flow triggered off dice-tray.rolled.**
