# Releasing FokkerPop

This is the 60-second checklist to run before tagging a release.

The automated tests in `test/` catch structural and regression bugs.
This checklist covers the things only a human can see: UI rendering,
animations, sound levels, layout drift.

## Before tagging

1. **Bump the version** in `package.json`.

2. **Run the gate:**
   ```
   npm test
   ```
   This runs the HTML validator and the semver unit tests. Both must be
   green.

   Optionally, run the end-to-end smoke test too. It boots the server
   and clicks every sidebar tab, asserting each page renders and that
   the version banner stays hidden for the current release:
   ```
   npm install --no-save playwright && npx playwright install chromium
   npm run test:smoke
   ```
   Playwright is kept out of `package.json` so it doesn't bloat the
   shipped Windows bundle; install it on demand for release verification.

3. **Manual dashboard pass** (browser at http://localhost:4747/dashboard/):
   - [ ] Click every sidebar item in order: Live → Chat → Test Effects →
         Goals → Assets → Layout → Config → Studio → Event Log → Setup.
         Every page must render content (not blank).
   - [ ] On Test Effects, fire one effect from each row (Fun Pack, Visual
         Effects, Alert Banners, Custom Alert). Preview iframe reacts.
   - [ ] On Assets, the sound / sticker / mascot galleries populate.
         Click a Test button on a sound — plays at the slider volume.
   - [ ] Studio loads — graph area shows nodes, side panels render.
   - [ ] Layout page's embedded overlay iframe renders widgets (not a blank box).
   - [ ] No console errors in DevTools.
   - [ ] Version badge in the sidebar matches `package.json`.
   - [ ] No gold "UPDATE FAILED" banner.

4. **Overlay check** (browser at http://localhost:4747/):
   - [ ] Open with `?demo=1` — mascot animates, dice tray boots, a
         sample firework or confetti fires from the top bar.
   - [ ] No console errors.

5. **Commit and tag:**
   ```
   git add -A
   git commit -m "Release vX.Y.Z: <one-liner>"
   git tag vX.Y.Z
   git push && git push --tags
   ```
   The `Build & Release` workflow publishes the Windows zip + NSIS
   updater EXE automatically.

## After release

- Watch the Actions tab for a green build.
- Update a clean test install via the Auto-Updater EXE — confirm it
  overwrites cleanly, restarts, and the new version badge shows.

## If something breaks

See `test/html-validate.mjs` and `test/semver.test.mjs` — add a new
regression test for whatever slipped through, so the gate catches it
next time.
