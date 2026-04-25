# FokkerPop Changelog

_Auto-generated from the last 25 Release commits. Newest first._

## v0.3.26 — 2026-04-24

**A "Reset Widgets to Default" button on the Layout page wipes `widgets.json` and restores the shipped layout from `widgets.example.json`. Right now, if Fokker (or anyone) has accumulated bad widget state — duplicated widgets, broken positions, stale theme references — the only fix was hand-editing `widgets.json` on disk. Now the new red button next to "Reset Positions" handles it in one click. The server backs the previous `widgets.json` up to `widgets.json.bak` first so a misclick is recoverable, and `widgets.json.bak` is added to both `.gitignore` and the release-zip user-data leak invariant so it can never ship in a release. Useful for Fokker right now: this is the cleanest way to get the legacy `w-dice-d20` widget out of his install since v0.3.25's default-layout fix only helps fresh installs.**


---

## v0.3.25 — 2026-04-24

**Stop the dice double-fire. The default shipped layout had two overlapping dice widgets — the legacy single-die `dice` widget AND the newer 3D `dice-tray`, both wired to fire on related-but-different events (`redeem` vs `dice-tray-roll`). When a Studio flow emitted both, you'd see one die in the tray and a second "shadow" die from the legacy widget rendered in its own canvas at a different screen position. The tray supersedes the legacy widget, so the legacy one is dropped from `widgets.example.json` (existing installs keep theirs — Fokker can hide or delete it via the Layout tab).**

While in there: `triggerDice` and `triggerDiceTray` used to fire on EVERY event when `cfg.triggerEvent` was unset (the unset case fell through the gate). Switched to gate-by-default so a freshly-added dice widget that hasn't been configured yet stays quiet instead of rolling on chat messages, follows, subs, and so on.

---

## v0.3.24 — 2026-04-24

**PolyPop import lands in the dashboard. The CLI from v0.3.23 (`node scripts/import-polypop.mjs`) still works, but its core logic has moved to `server/polypop-import.js` and is now also exposed at `POST /api/import-polypop`. A new "Import from PolyPop" card on the Setup page wraps it: pick a `.pop` file, click Import, and you get an inline review of every channel-point redeem, chat alias, and audio reference the project contained — each section has Append (skip collisions) and Replace (full overwrite) buttons that hit the existing `/api/redeems` and `/api/commands` endpoints. Body size is capped at 5 MB and the Origin gate already covers the new POST so it stays as locked-down as the rest of the API.**


---

## v0.3.23 — 2026-04-24

**PolyPop project importer (CLI).**

For streamers migrating from PolyPop, ships scripts/import-polypop.mjs
that reads a PolyPop .pop project file and emits three FokkerPop
configs alongside (never overwriting) the real ones:

  - redeems.from-polypop.json — every channel-point redeem from the
    .pop's twitch:Twitch Alerts source's ChannelPoints list, mapped
    to a FokkerPop effect via simple name heuristics:
      Roll/Dice/Dxx     → dice-tray-roll
      Bub/Balloon/Pop   → balloon (count: 10, sound: pop.wav)
      Fokker/Salvo/etc. → firework-salvo (count: 5, sound: boom.wav)
      Sticker/Confetti  → sticker-rain
      Sing/Cur/Word/Cam → alert-banner (mode-style timed alert)
      everything else   → alert-banner (generic 🎉)
  - commands.from-polypop.json — broadcaster-only !chat aliases for
    each redeem (slugified filenames). Fokker can rename + open up to
    "anyone" per command in Config → Commands.
  - audio-files.txt — names of all core-app:Audio Clip sources the
    .pop referenced; Fokker drops matching files from PolyPop's
    Sounds folder into assets/sounds/.

What it doesn't import: scenes, 3D models, Action Sequence graphs,
animations, hotkey bindings — different paradigms with no clean
mapping. The importer covers the 1:1 portion (redeem titles + audio
references) and leaves the visual/effect customization to the user.

Verified against LilFokker_Clean.pop:
  - 17 channel-point redeems extracted (BUBLOOONS, Fuel the Fokker,
    KarebeChaos, Karebec Slam Attack, Karebec Fully Loaded, Roll 6s,
    Roll 1s, Roll 7, Crit, Pop Off, Sing/cursing/word-ban modes,
    Kill a Jugger, Doggie Cam, Show Ardrali Some Love)
  - 17 chat aliases generated, no slug collisions
  - 27 audio clip references collected

Documented in RELEASING.md under "Importing from PolyPop" with the
exact command + file purposes + caveats.

Future: a Setup-page button could wrap the CLI for a no-terminal
import flow, but the CLI is enough for the migration use case
right now.

---

## v0.3.22 — 2026-04-24

**Layout-mode discoverability, mute fix, full CHANGELOG.**

Five small UX/correctness fixes batched together — none individually
release-worthy, all worth doing.

1. Auto-enable Drag Mode when adding a widget. Clicking + Counter /
   + Dice / + Hot Button etc. on the Layout tab used to leave Drag
   Mode off, which kept the new widget's resize handles + × delete
   badge invisible (CSS-gated to body.layout-mode). The handles were
   actually attached — verified via Playwright — but the user just
   couldn't see them. addWidget() now flips the Drag Mode checkboxes
   on and broadcasts the layout-mode state so the new widget is
   immediately positionable.

2. Show hidden ghosts toggle — the layout-mode "ghost" rendering of
   hidden elements (red dotted outline + "click × to restore" badge)
   is great for occasional hides but clutters Layout Mode if you've
   permanently removed several built-ins. New checkbox in the Layout
   tab's preview controls flips it: ON (default) keeps current
   ghosting behaviour; OFF makes hidden elements truly invisible in
   Layout Mode too, restorable by toggling back ON.

   Implementation: extended the existing `fokker.label-visibility`
   postMessage with a `showGhosts` field; overlay applies a
   `body.no-ghosts` CSS class that overrides the layout-mode-shows-
   ghosted rule with display:none. Pref persists in localStorage like
   the other preview toggles. Label includes a "(N hidden)" /
   "(nothing hidden yet)" hint so the toggle's effect is obvious
   without needing to experiment.

3. Asset Gallery sound test buttons honour mute. testSoundWithVol
   was using `parseFloat(vol) || 1.0` — which evaluates `0 || 1.0`
   to 1.0, so dragging the slider all the way down still played at
   full volume. Switched to a Number.isFinite check + clamp to
   [0,1] so 0 actually mutes.

4. CHANGELOG generator gets full git history. The release workflow
   was using GitHub's default checkout fetch-depth: 1, so
   scripts/gen-changelog.mjs only ever saw the current tag's commit
   and emitted a CHANGELOG with a single entry. Every shipped zip
   since v0.2.111 had a one-line release notes panel; the dashboard's
   Release Notes tab was perpetually showing only "the version you
   just installed." `fetch-depth: 0` on the checkout step gives the
   workflow the full log; the next zip (this one) ships the proper
   25-entry CHANGELOG. Also re-committing the in-repo CHANGELOG.md
   so GitHub.com viewers see it current too.

5. Side fixes from the security pass that landed in v0.3.21 are
   already live; this release just rounds out the trim.

Verified via probe: Drag Mode flips on after a new widget is added;
ghost count text reads "(nothing hidden yet)" before any hides and
"(N hidden)" after; testSoundWithVol with vol=0 sets audio.volume to
0 (was 1.0).

---

## v0.3.21 — 2026-04-24

**Origin gating, path-traversal fix, update-flush.**

Closes the highest-severity findings from the security + operational
review. None of these are exploitable in the typical "Fokker streaming
on his own machine" workflow, but they were latent foot-guns that
matter for a tool that binds to localhost on a viewer-facing PC.

Security fixes:

  1. WebSocket Origin gate. Any website the streamer visited could
     `new WebSocket("ws://127.0.0.1:4747")`, register as a dashboard,
     and trigger _dashboard.shutdown / _dashboard.update-apply /
     _dashboard.save-position / _dashboard.element-visibility / etc.
     verifyClient now requires Origin to match the server's own host
     (the dashboard, the overlay, and OBS browser sources all set it
     correctly to http://localhost:PORT or http://127.0.0.1:PORT).

  2. HTTP cross-origin write protection. POST/PUT/PATCH/DELETE on
     /api/* require the same Origin match. Stops simple-CORS POSTs
     from a malicious page to /api/upload (file write), /api/widgets
     (config overwrite), /api/shutdown (kill the server), etc. GETs
     stay open — browser SOP already protects response confidentiality
     for read endpoints.

  3. Path traversal guard tightened. The previous startsWith check
     didn't enforce a separator boundary, so a sibling directory like
     "<ROOT>-backup" would match. Switched to path.relative() — any
     result starting with '..' or that's absolute means outside ROOT.

stop.bat updated to send Origin so its graceful curl path still works
under the new HTTP gate. (If it doesn't, the existing taskkill /F
fallback still handles shutdown — no regression.)

Operational fixes:

  4. applyUpdate now calls state.flush() before spawning the NSIS
     updater. The 150ms-then-process.exit window meant any debounced
     state writes (widget drags within the last 300ms before "Install
     Now") were lost. Both call sites — the dashboard's
     _dashboard.update-apply WS message and the auto-install-on-stream-
     end handler — go through the new flush.

  5. state.flush() no longer fully-silently swallows write errors.
     The first failure of a session prints a one-shot console error
     so a permission flip / antivirus lock / disk-full doesn't go
     undiagnosed for an entire stream. Subsequent failures stay quiet
     to avoid spam.

Verified with a probe matrix:
  - Same-origin POST → 200
  - Cross-origin POST → 403 BLOCKED
  - GET (no Origin)  → 200
  - WS bad Origin    → 403 REJECTED
  - WS good Origin   → CONNECTED
  - Path traversal   → 404 (relative() guard catches)

Followups noted in the audit but not in this release:
  - H1 update signature/hash verification (needs publishing infra change)
  - H2 template-eval sandbox (needs hand-written evaluator; mitigated
    significantly by C1/H4 above since only the trusted dashboard can
    write redeems/flows now)
  - Op#10 rollId race for concurrent !roll (needs Map<rollId, user>)

---

## v0.3.20 — 2026-04-24

**Auto-refresh state.json.bak on boot.**

Cleans up the stray state.json.bak that v0.3.18 leaked into the
release zip (and any other stale .bak from prior runs). On every
server boot, after loading state.json, copy it over state.json.bak
unconditionally. Two effects:

  1. The dev-leak .bak from v0.3.18 (containing my local positions
     like "test-widget" and "another") gets overwritten with the
     user's actual current state on the first v0.3.20 boot. No more
     risk of falling back to garbage if state.json ever gets
     corrupted.
  2. Recovery worst-case is bounded: if state.json corrupts mid-
     session, .bak is at most "state at boot" stale, never months-old
     stale.

The flush() write path is unchanged (also still copies state.json →
.bak before each write), so .bak continues to track within ~300 ms
of the latest in-memory state. The boot-time copy is purely belt-and-
braces against stale-from-prior-version data.

---

## v0.3.19 — 2026-04-24

**Hotfix — gitignore state.json.bak, tighten zip-smoke.**

v0.3.18 accidentally committed a state.json.bak file because the v0.3.17
atomic-write change creates one and my local probe ran during the commit
window. Without this hotfix, that .bak (containing my dev-tree state)
would ship in the v0.3.18 release zip, get installed on every user's
machine, and overwrite their actual recovery backup.

Fix:
  - .gitignore now lists state.json.bak and state.json.tmp alongside
    state.json itself.
  - The release.yml zip-smoke invariant gains both files to its
    "user-data must NEVER be in the zip" check, so this class of
    leak fails the build before publishing.
  - Removed state.json.bak from the repo (git rm --cached).

Anyone who happened to install v0.3.18 in the ~minutes between
release and this hotfix should run the v0.3.19 updater to clean up
the stray .bak file (NSIS won't auto-delete it, but it's harmless on
disk — just stale).

---

## v0.3.18 — 2026-04-24

**Version renders server-side; Check for Updates; Stop overlay.**

Three small but visible UX gaps on the Setup / Live tab.

Version display correctness — every place that shows the FokkerPop
version (sidebar badge, Setup About card) used to start as the
literal placeholder "v..." and rely on a JS round-trip after the
WebSocket connected to swap in the real number. If the WS hadn't
connected yet, or the browser had a stale tab, viewers saw "v..." or
the wrong number. The server now substitutes ${VERSION} into the HTML
when it serves /dashboard/, so first paint already shows the correct
number, no JS or WS dependency. Cache-Control: no-cache so the
substitution stays current across updates.

Manual "Check for Updates" button on the Setup page. Wires to a new
_dashboard.check-update WS handler which calls the existing
update-checker checkForUpdate() function. The dashboard listens for
update.available / update.checked-at / update.check-error state
broadcasts via a new fokker-update-state CustomEvent and updates the
Status text inline. 15-second timeout with a clear error message.

Stop FokkerPop now produces actual feedback. When the dashboard
receives _system.shutdown:
  - The auto-reconnect loop checks window.__fokkerStopped and bails
    instead of pinging a dead server every 1-3 seconds forever.
  - A full-screen overlay appears explaining the server is stopped,
    listing the three ways to restart (Start Menu shortcut /
    FokkerPop.exe / start.bat). Backdrop-blur so the dashboard
    underneath is dimmed but readable.
  - A 2-second polling probe against /api/state silently waits for
    the server to come back. When it does, the dashboard reloads
    automatically.

Wording on the Stop card itself updated to mention the Start Menu
shortcut and FokkerPop.exe alongside start.bat — three valid restart
paths now that v0.3.0 / v0.3.4 shipped them.

Verified: server-rendered v-badge matches package.json; Setup tab
has Check for Updates button; clicking it reports "you're up to
date" via the new state-event flow.

---

## v0.3.17 — 2026-04-24

**Reset Session preserves layout; configurable sticker pool.**

The "Reset Session Stats" button on the Live tab was wiping the
entire overlay layout — every widget position, the resize-saved
dimensions, the per-element hidden flags. Root cause:
state.resetSession() replaces this.#data with structuredClone(DEFAULTS),
and DEFAULTS has no `overlay` key. Goals were the only branch
explicitly preserved.

Most likely sequence behind the v0.3.15 "the update reset his
layout" report: Fokker had hit Reset Session some time before the
update (it's labelled like a stat-zero button), the next debounced
flush wrote the wiped layout to state.json, and the next server
boot (whether after an update or any restart) loaded the empty
positions and broadcast them to the overlay. The update wasn't the
cause; it just made the prior wipe visible.

Fix:
  - resetSession now also preserves this.#data.overlay (positions,
    widgets, elementVisibility, layoutMode). Schedules a flush so
    the cleared session/leaderboard/crowd state hits disk in 300 ms
    instead of waiting for the periodic interval.
  - Confirm dialog added to the Reset Session Stats button. Spells
    out exactly what gets cleared and what's preserved so a
    misclick doesn't cost a stream's layout work.

Defense in depth — atomic writes + rolling backup:
  - flush() now writes to state.json.tmp then atomically renames to
    state.json. Even a kill mid-write leaves state.json fully old
    or fully new — never partially overwritten.
  - Before the rename, the previous state.json is copied to
    state.json.bak. On the next boot, if state.json is missing,
    empty, or unparseable, #loadInitial() falls back to the .bak.
  - The initial load logic was inlined; it's now #loadInitial()
    which iterates [state.json, state.json.bak] and returns the
    first that parses successfully.

Sticker Rain — configurable pool. The rain previously always used
"all uploaded stickers + emoji fallback". Now the spawn payload
takes an optional `pool`:
  - null / "*"            → all uploaded + emoji (default)
  - "emoji"               → emoji only
  - "uploads"             → uploaded image stickers only
  - "prefix-"             → uploaded stickers whose filename starts
                            with that prefix (group-by-name pattern)
  - ["a.png","b.png","🎉"] → exactly these (filenames + raw emoji)

Configure on a per-redeem or per-flow basis by adding `pool` to the
spawnEffect payload:

  "Holiday Rain": {
    "effect": "sticker-rain",
    "duration": 6000,
    "pool": "holiday-"
  }

Verified: session-reset run against a state.json with seeded
positions left positions intact AND zeroed session counters; sticker
pool resolution returns the right counts for each of the five
selector modes.

---

## v0.3.16 — 2026-04-24

**Commands editor exposes allow/redeem/random sound.**

Three follow-ups to the v0.3.13/14 chat-command work, all so Fokker
can manage commands from Config → Commands without ever opening
commands.json in a text editor.

UI additions to each row:

  - Allow dropdown (Broadcaster only / Mods+ / VIPs+ / Subs+ / Anyone)
    with a clear label so the safer default is obvious. Surfaces what
    was previously a default-deny invisible behavior.
  - Mode radio (Fire effect | Alias a redeem) toggles between the
    two row layouts. Effect mode shows the existing effect+sound
    selectors; Redeem mode shows a dropdown populated from the
    broadcaster's actual redeems.json so there's no typo risk on the
    rewardTitle.
  - "🎲 Random (any uploaded sound)" option in every sound dropdown,
    mapping to sound:"*" — same wildcard the server already
    understands (v0.3.13). Pair with effect:'play-sound' for
    soundboard / out-of-context-style commands.

play-sound added to the effect dropdown so Fokker can pick it
without typing.

Server-side: when a command is rejected by the allow gate, log it at
INFO instead of silently returning. "Why isn't !bub working" now
takes a look at server.log instead of a code dive — the log line
names the trigger, the user, and the required tier. Cuts the
diagnostic loop from "stare at code" to "scroll log".

renderCommandsConfig now fetches /api/redeems alongside
/api/commands so the redeem dropdown is always populated against the
current real redeem set.

Verified with a Playwright probe: all 4 of Fokker's existing
commands render with the allow dropdown defaulted to broadcaster,
mode radio set to "Fire effect", redeem dropdown present (hidden
until mode flips), random-sound option present in the sound select.

Practical consequence: Fokker can fix !bub and !pop in two clicks
each — Config → Commands → set allow to "Anyone" → Save. No
file editing required.

---

## v0.3.15 — 2026-04-24

**Mascot ships as .gif so it overwrites existing placeholders.**

The v0.3.14 mascot replacement landed as .webp, banking on the
overlay's extension-fallback chain (.gif → .png → .webp → .jpg) to
find the new file. That works for fresh installs, but it broke the
update path — NSIS only OVERWRITES files, never DELETES — so existing
installs kept the stale yellow-star idle.gif on disk and the overlay
found that one first.

Also missed: the state-swap code at overlay.html:1363 hardcodes
${state}.gif, not the fallback chain. Even if a viewer's overlay
loaded the .webp mascot at boot, the first energy-state change would
swap to the .gif (still the star).

Fix: convert the four mascot states from .webp back to .gif
(static, 256-color, alpha-on-transparent). Same source image,
correct extension. NSIS extraction now overwrites Fokker's stale
star idle.gif/active.gif/hype.gif/explosion.gif with the real
mascot — no manual cleanup required, no need to teach the updater
about deletions.

Asset-integrity stays clean (4 valid GIF files; the only remaining
failures are the unfilled audio placeholders).

---

## v0.3.14 — 2026-04-24

**Command permission gates + FokkerPop mascot replaces star.**

Two themed changes that ship together — both follow up on yesterday's
v0.3.12/13 chat-command + redeem-alias work and the v0.3.7 branding
pass.

Permission gates on chat commands:

  - New `allow` field on commands.json entries: "anyone",
    "subscriber", "vip", "mod" (each tier implicitly grants the
    higher ones — mod includes vip+sub).
  - Default-deny: commands without an explicit `allow` are now
    broadcaster-only. This is the safer default — any !command Fokker
    pastes from the example file or copies from a tutorial doesn't
    accidentally hand viewers a free trigger that would otherwise
    cost channel points.
  - The chat event payload already carries Twitch's badges array
    (eventsub.js:47), so the gate reads `badges.set_id` directly.
  - Dashboard simulator events (`source: 'dashboard'`) are treated
    as broadcaster — Fokker can always test his own commands from
    the Test Effects page.
  - Updated commands.example.json: !bub and !pop demonstrate
    "allow":"anyone" (free for viewers); !coin and !yay show
    subscriber / vip gating; !ooc and !bigbub default to broadcaster
    so they don't bypass channel point costs by accident.

Existing commands (without `allow` set) become broadcaster-only on
this release. Fokker needs to add `"allow": "anyone"` to !bub and
!pop in his commands.json to keep them free for viewers.

Mascot upgrade:

  - characters/lilfokkermascot/{idle,active,hype,explosion}.gif were
    placeholder yellow stars (PNG-as-GIF, asset-integrity flagged
    them as warnings since v0.2.106). Replaced with the real
    LilFokker mascot (extracted from build-assets/fokkerpop.ico's
    256×256 layer — same image as the launcher icon and the
    sidebar-logo mascot face).
  - Saved as .webp so the existing extension-fallback chain
    (.gif → .png → .webp → .jpg, added in v0.2.99) finds them.
  - Added image/webp to the server MIME table so browsers get the
    right content-type instead of application/octet-stream.

Asset integrity: 4 PNG-as-GIF warnings cleared; only the 4 broken
audio placeholders (ding/follow/sub/yay) remain.

Side: command cooldown logic switched from `|| 5` to `?? 5` in
v0.3.13 so cooldown:0 actually means immediate-refire. Same deal
applies to the permission gate — fail-closed is only triggered by
genuinely unknown allow values.

Verified with a probe matrix: 8 permission scenarios all match
expected behavior; mascot files serve correctly at the 4 state URLs.

---

## v0.3.13 — 2026-04-24

**Random-sound effects + play-sound (!ooc-style commands).**

Adds the building blocks Fokker needs to turn !ooc into a soundboard
that picks a random clip from his uploaded library — and lets him
optionally constrain the pool when he wants tighter curation.

Two pieces:

1. Wildcard / list resolution in the sound payload field. Anywhere a
   sound is configured (commands.json, redeems.json, Studio playSound
   action), the value can now be:
     * "filename.wav"         — fixed (existing)
     * "*"                    — pick any uploaded sound from
                                assets/sounds/
     * ["a.wav","b.wav",...]  — pick from this exact list,
                                filtered to ones still on disk

   Resolution happens server-side in broadcastEffect, so by the time
   a payload reaches an overlay it carries a real filename. The same
   fallback to alert.wav kicks in if a list is empty after disk
   filtering.

2. New "play-sound" effect type. Sound-only — no banner, no balloon,
   no other visual side effect. Pair with sound:"*" for the
   classic out-of-context-button pattern:

     "!ooc": { "effect": "play-sound", "sound": "*", "cooldown": 5 }

   The overlay's dispatchEffect already plays p.sound in its prelude,
   so the play-sound case is just a no-op visual that prevents the
   "unknown effect" path from firing.

Side fix: command cooldown was using `cmd.cooldown || 5`, which
treated cooldown:0 as "use default 5s" instead of "no cooldown".
Switched to ?? so 0 actually means immediate refire (useful for
soundboards and testing).

Verified: !ooctest fired 6× produced varied picks across the full
sound library; !subset configured with sound:["coin.wav","dice1.wav"]
fired 4× only ever produced coin.wav (it picked the first option
each time in this random sample, but never wandered outside the
allowlist).

---

## v0.3.12 — 2026-04-24

**Chat commands can alias channel-point redeems.**

Fokker tried to wire `!bub` to the BUBLOON redeem so chat-typed
commands and channel-point redemptions would behave identically — same
balloons, same flows, same Studio effects. The previous command schema
only supported direct effect firing (effect/count/sound/cooldown),
which forced him to duplicate the redeem's config in commands.json
and watch them drift apart over time.

Adds a `redeem` field to commands.json entries:

  "!bub": { "redeem": "BUBLOOONS!!", "cooldown": 10 }

When a user types !bub in chat, the server publishes a synthetic
'redeem' bus event with rewardTitle: "BUBLOOONS!!" and source:
'chat-command'. Everything downstream — redeems.json effect array,
Studio flows triggered on type:'redeem' with that rewardTitle, the
state.set('session.redeemCount') counter — fires identically to a
real channel-point redemption. Single source of truth for the
visual + audio + flow logic; the chat command is just an alias.

If the named redeem doesn't exist in redeems.json, a clear warning
goes to the log naming the offending command and the missing key
(rewardTitle case + punctuation must match exactly).

Legacy commands with `effect:` keep working — both modes coexist in
fireCommand(). The example file demonstrates both:

  "!yay":    { "effect": "confetti", "sound": "yay.wav", "cooldown": 15 },
  "!bigbub": { "redeem": "BUBLOOONS!!", "cooldown": 10 }

Verified: simulated `!testbub` over the chat event path emits
event type=redeem source=chat-command and the balloon effect dispatch
matches the redeem's count (10), not the legacy direct config (5).

---

## v0.3.11 — 2026-04-24

**Layout-mode chrome no longer leaks to OBS.**

Diagnosing the "the game seemed to shrink down" report — Fokker had
Layout Mode toggled on while streaming, which made every layout-mode
artifact paint over his game capture in the OBS source. Specifically:

  - Auto-hide built-ins (timer, leaderboard, goals, combo) become
    visible at full opacity with a 160×60 minimum bounding box, so
    previously-clear regions over the game suddenly carry opaque
    placeholder boxes.
  - Dashed outlines, type-name placeholder chips, resize handles,
    × delete badges all render on top of the game.

Net effect: more pixels of the game surface are covered, which
reads as "the game shrank to make room." The game itself never
moves; FokkerPop never resizes anything outside its browser-source
dimensions.

Fix: live overlays (?live=1, the URL OBS uses) now ignore the
overlay.layoutMode state entirely. The body never gets the
layout-mode class, so none of the layout-mode CSS rules apply and
the OBS source stays production-clean even if Fokker forgets to
toggle Layout Mode off before going live.

Drag/resize/hide editing still works as before — the dashboard
preview iframes (Test Effects + Layout) and any plain /?demo=0 tab
he opens for editing all receive the layout-mode state and react
to it. Position changes from those edit surfaces broadcast to the
live OBS overlay just like always; only the editor chrome itself
is suppressed on the live URL.

Verified with a probe: with layoutMode broadcast as true, the
?live=1 overlay's body class is empty, .delete-handle is
display:none, and no .draggable carries an outline. The ?demo=0
overlay simultaneously shows all editor chrome.

---

## v0.3.10 — 2026-04-24

**Sticker Rain uses uploads; layout-mode shape matches live.**

Two visible fixes plus a small infrastructure piece for asset
hot-reload.

Sticker Rain — was hardcoded to a 16-emoji array, ignoring everything
LilFokker had uploaded under assets/stickers/. Now:

  - On overlay boot the overlay GETs /api/assets and caches the
    sticker filename list.
  - spawnStickerRain mixes the uploaded stickers (rendered as <img>
    inside the .sticker container, sized via width/height in rem
    instead of font-size) with the emoji fallback list, so streams
    that have a few uploads still get visual variety.
  - When a sticker file is missing entirely, the rain falls back to
    pure emoji (preserves prior behavior on a fresh install).

Layout-mode shape parity — the data-placeholder text (COUNTER /
DICE-TRAY / MASCOT / etc.) used to render as ::before content INSIDE
the widget with 14 px of padding. That visibly inflated each widget
in layout mode, so a counter that read 60×30 in live read ~120×60
in layout. Now ::before is positioned: absolute, top: -22px — it
sits as a small purple chip ABOVE the widget, occupying zero space
inside it. Same change applies the layout-mode outline-offset from
4 → 0 so the dashed outline hugs the widget's actual edge instead
of floating 4 px outside.

Net result: positions and dimensions a streamer arranges in Layout
mode match what viewers see in OBS to within a couple of pixels.

Asset hot-reload — when a new file lands via /api/upload, the
server now broadcasts {type:'assets-updated', kind} to every
connected overlay AND dashboard. Overlays use it to refresh their
sticker pool without needing a full reload; dashboards can hook in
later for the same purpose (gallery refresh, etc.).

---

## v0.3.9 — 2026-04-24

**Hide/restore any overlay element from Layout mode.**

Layout mode now puts a small red × badge in the top-right corner of
every draggable element — built-in (mascot, crowd meter, combo,
goals, leaderboard, timer) and custom (counter, dice tray, model 3D,
physics pit, etc.). Click it to remove that element from the live
overlay; the slot stays in Layout mode as a red-dotted ghost with a
green + badge so Fokker can bring it back.

Wiring:

  - overlay.html injects a `.delete-handle` into every `.draggable`
    on DOMContentLoaded. renderCustomWidgets and renderGoals also
    call the same injectDeleteHandle helper after rebuilding their
    DOM, so widget remounts and goal rerenders don't strand the
    badge.
  - resetWidgetContent (overlay-widgets.js) now preserves both
    .resize-handle AND .delete-handle through the el.innerHTML wipe
    that 3D widget mount functions do — same bug class as v0.2.110
    where resize handles were being eaten on re-mount.
  - Click on the badge sends `_dashboard.element-visibility` over
    the existing WS, with visible:false to hide and visible:true
    to restore.
  - Server stores the per-id map under overlay.elementVisibility.
    visible:true entries are deleted from the map on save so
    state.json only contains the explicitly-hidden ids — keeps the
    file compact and easy to inspect.
  - State broadcasts to all overlays (OBS source, dashboard preview
    iframes); each applies/removes the .element-hidden class via the
    new applyElementVisibility() handler.
  - The handler is wired in BOTH the overlay-path branch AND the
    dashboard switch in server/index.js — the badge sits in overlay
    DOM so the message comes from the overlay's WS, which is the
    bug I caught in the first probe (handler was only in dashboard
    path; overlay-sent messages fell through silently).

CSS makes the hidden state self-explanatory: live overlay
display:none, layout mode shows the element ghosted at 32% opacity
with a red dotted outline and a "HIDDEN — click × to restore"
center badge. The × badge itself flips to a green + on hidden
elements.

State persists via the v0.3.6 debounced 300 ms flush, so hidden
elements survive any restart, including taskkill /F from the NSIS
updater.

---

## v0.3.8 — 2026-04-24

**README hero with the FP Studios logo.**

Landing on github.com/azraeltruthsay/FokkerPop now opens with the
real FP Studios wordmark centered at the top instead of a plain "#
FokkerPop" heading. Three small release badges underneath (latest
release, total downloads, open issues) for at-a-glance repo health.

Logo reused from dashboard/fps-logo.webp — no duplicate committed;
GitHub renders it inline from the existing path. Purple (#9147FF)
accents on the badges match the app's theme, so the repo page, the
launcher icon, and the running dashboard read as the same product
visually.

---

## v0.3.7 — 2026-04-24

**Official FokkerPop branding + chime.wav.**

LilFokker dropped real brand art. Replacing my purple-circle-F
stand-in across the app:

  - build-assets/fokkerpop.ico — now the mascot (ginger-bearded
    pilot with propeller beanie + goggles, winking) on the purple
    burst background. Multi-res .ico (16/32/48/64/128/256) generated
    from FPS_Icon.webp, center-padded to square so the rounded
    corners survive every size. Flows through to FokkerPop.exe (via
    the launcher NSIS build) and the Start Menu shortcuts the
    updater creates.

  - dashboard/fps-logo.webp — served at /dashboard/fps-logo.webp
    via the existing static route. Replaces the bare "FokkerPop" H1
    at the top of the dashboard sidebar with the "FP Studios"
    wordmark. Sizing: max-width 180px, centered, with the version
    badge and nav items untouched below.

Also fills one of the last broken-audio slots:

  - assets/sounds/chime.wav — was a 14-byte ASCII placeholder since
    the v0.2.99 era. Replaced with mixkit-alert-quick-chime-766
    (same Mixkit license already declared in ATTRIBUTION.md).
    confetti / default-misses that called playSound('chime.wav')
    now actually play a chime.

npm run test:assets now reports 4 failures, down from 5: ding.wav,
follow.wav, sub.wav, and yay.wav are still placeholders/broken.
Those can be filled next time Fokker drops more audio.

---

## v0.3.6 — 2026-04-23

**State writes hit disk within 300 ms, surviving hard kills.**

Fokker reported that layout positions reset on every server reboot —
specifically, after running the NSIS updater or otherwise restarting.
Root cause: StateStore.set() only mutated the in-memory copy and
relied on a 5-minute periodic flush (plus one on graceful shutdown)
to persist state.json. But:

  - The NSIS updater uses `taskkill /F /IM FokkerPop.exe` to release
    the node.exe lock before overwriting files. /F is a hard kill;
    node's SIGTERM / process.on('exit') graceful-shutdown path does
    not get to run, so state never flushes.
  - Same applies to any other force-kill, crash, or stop.bat fallback
    that couldn't reach /api/shutdown first.

Net effect: anything a user did in the 5 minutes before their last
ungraceful termination — drag a widget, resize one, change a goal,
save widget config — stayed only in RAM and was lost.

Fix: StateStore.set() (and addChatter()) now schedule a 300 ms
debounced flush. Bursts (the 1-per-second crowd.energy drain, rapid
leaderboard updates during a cheer storm) collapse into a single
write. A single user action like a drag-to-position is on disk ~300
ms after mouseup — fast enough that the NSIS updater's 1500 ms
taskkill window can't race it.

flush() itself clears the pending timer so explicit shutdown flushes
don't double-fire. The original 5-minute setInterval stays as belt-
and-braces.

Verified: booted server with a fresh state.json, sent
_dashboard.save-position via WebSocket, waited 1 s, then `kill -9`
on the server process. state.json on disk contained the saved
position. Previous behavior under the same test lost the write.

---

## v0.3.5 — 2026-04-23

**Asset filenames with spaces round-trip cleanly.**

Two spots on both ends of the pipe were string-concatenating raw
filenames into URL paths without percent-encoding. Once any uploaded
asset had a space (or any other URL-unsafe char) in its name, sound
playback and the dashboard gallery silently 404'd.

Fixes:

  - overlay.html playSound() — now encodeURIComponent(file) when
    building the /assets/sounds/... path. This is the critical one;
    it's the single function every audio path eventually reaches
    (default effect sounds, dice-tray roll sounds, Studio playSound
    actions, chat command sounds).

  - dashboard/app.js populateGallery() — the Asset Gallery's
    <img src> lines for stickers and mascot characters now encode
    the filename too. Without this, gallery previews broke visibly
    on upload of any space-named image.

  - server/index.js serveFile() — decodeURIComponent the incoming
    path before resolving to disk. `new URL().pathname` leaves
    percent-encoding intact, so a request for
    /assets/sounds/has%20space.wav was being resolved against the
    literal filename "has%20space.wav" which doesn't exist.
    Decoding once at the serveFile boundary covers every static
    route consistently (/assets, /characters, /shared, /dashboard,
    /vendor), and paths without %-encoding are unchanged by
    decodeURIComponent, so it's safe for all existing files.

Upload path was already fine — the server stores filenames verbatim
on disk and spaces in HTTP header values are allowed by RFC 7230.
So any existing asset Fokker has already uploaded with a space works
on this release without further action.

Verified with a Playwright probe: upload "has space.wav" and
"yay!.wav" via /api/upload, request them back via the URL-encoded
path — both 200 OK, right byte count. Browser-side playSound()
builds the correct /assets/sounds/has%20space.wav URL and the
server returns the audio data.

---

## v0.3.4 — 2026-04-23

**Ship a real FokkerPop.exe launcher in the zip.**

Answers Fokker's "is there an EXE I can run?" directly. The install
folder now contains a tiny FokkerPop.exe at root that he can
double-click from Explorer, drag to the desktop, or pin to the
taskbar like any normal Windows app.

Implementation:

- build-assets/fokkerpop.ico — 6-size (16/32/48/64/128/256) Windows
  icon: purple circle (#9147FF, matching the dashboard's accent) with
  a white "F" in the center. Generated via ImageMagick from Liberation
  Sans Bold.

- Release workflow builds FokkerPop.exe via a one-section NSIS script
  before the zip is assembled. The launcher is configured
  SilentInstall silent (no install UI appears at all), dispatches
  wscript launch-hidden.vbs, and exits. Version info block populated
  from the git tag so the Properties dialog shows the right
  "Product version" / "File version".

- FokkerPop.exe + fokkerpop.ico are copied into the zip root. The
  zip-smoke gate asserts both are present, so shipping a build without
  them fails the release before upload.

- NSIS updater's Start Menu shortcuts now point at FokkerPop.exe
  instead of wscript directly. Double-clicking the Start Menu entry
  and double-clicking the exe in Explorer now do the exact same thing
  through the exact same code path.

- Post-install auto-launch also goes through FokkerPop.exe now, so
  the single-instance guard + browser-open logic runs via one route
  only.

Both install paths converge: zip-extract users now have a visible
FokkerPop.exe to double-click; NSIS-updater users have matching Start
Menu shortcuts with the same icon. The launcher binary is separate
from node\FokkerPop.exe (the renamed node runtime) — during launch
there's a ~1-second overlap where Task Manager shows two FokkerPop.exe
processes, then the launcher exits and only the server remains.

Icon size: 370 KB. Could be further optimized but this is a one-time
install asset so not worth squeezing.

---

## v0.3.3 — 2026-04-23

**Lazy-mount preview iframes.**

The Resources page in v0.2.112 made it visible that opening the
dashboard always spawned two hidden overlay instances — one per
preview iframe (Test Effects + Layout) — regardless of which tab the
user was actually looking at. Each one claimed a WebSocket, 2 WebGL
contexts (one for the default dice-tray + one for model-3d), and
~25 MB of heap.

Now:

  - Both iframes boot at about:blank (no WebSocket, no WebGL, no node
    on the server side).
  - The nav chokepoint (__navigate) calls syncPreviewIframes(page):
      * if the newly-active page owns the iframe and it isn't loaded,
        set src = dataset.src → iframe boots its overlay
      * if another page is active, any loaded iframe gets src =
        'about:blank' → overlay shuts down, server notices the
        disconnect, the Resources page drops the entry
  - data-loaded="0"/"1" tracks the intended state so repeated
    navigates are idempotent.

Probe confirms the connection count: 0 overlays while on Live, 1
while on Test Effects, 1 while on Layout (different one), 0 again
after switching back to Live. Previously this held at 2 continuously
for the lifetime of the dashboard.

Side benefit: WebGL context pressure (the bug from v0.2.106) is now
one context per 3D widget * 1 preview iframe instead of * 2. Easier
on machines with integrated GPUs.

---

## v0.3.2 — 2026-04-23

**Start Menu shortcuts and single-instance guard.**

Fokker's answer to "how do I start the app?" is now just "open the
Start Menu and type FokkerPop" — no more hunting for start.bat in
Explorer, and no more worrying about whether it's already running.

NSIS updater now creates three Start Menu entries in a FokkerPop
folder every time it runs (delete + recreate, so future changes
propagate cleanly):

  - FokkerPop  — wscript.exe launch-hidden.vbs. Normal day-to-day
    entry point. No CMD flash at all.
  - FokkerPop (Diagnostics)  — start.bat. Same behavior as 0.3.1 for
    troubleshooting — keeps the CMD open to show diagnostic output
    until the hidden launch completes.
  - Stop FokkerPop  — stop.bat. Companion for stopping without
    opening the dashboard first.

All three use node\FokkerPop.exe as their icon source so they're
visually grouped in Start Menu results.

launch-hidden.vbs rewritten as the single source of truth for the
launch sequence — start.bat now just delegates to it after diagnostic
checks pass. Also adds a single-instance guard via WMI:

  Set procs = wmi.ExecQuery(
    "Select ProcessId from Win32_Process Where Name = 'FokkerPop.exe'")
  If procs.Count > 0 Then ... skip server launch ...

So double-clicking any FokkerPop shortcut when the server is already
running just opens a new dashboard tab instead of spawning a doomed
second node process that silently loses the port race.

NSIS also now runs launch-hidden.vbs directly after install instead
of start.bat — the updater already did the file copy cleanly, so the
diagnostic checks are redundant and the CMD flash is avoidable.
