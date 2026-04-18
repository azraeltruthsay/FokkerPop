# Feature Improvements Plan

This plan details the implementation of 4 major usability and visual improvements for FokkerPop: a Sound Effects Engine, Dashboard Configurator, Twitch Health Indicator, and Character Integration.

## Objective
To enrich the viewer experience with audio and dynamic character reactions, while vastly improving LilFokker's ability to configure and monitor the overlay via the dashboard.

## Scope & Impact
- **Audio:** `overlay.html` will be capable of playing concurrent sound effects linked to events.
- **Visuals:** `overlay.html` will support dynamic character sprites that react to crowd energy.
- **Configurability:** The Dashboard will have full visual editors for Goals and Redeems.
- **Monitoring:** The Dashboard will display real-time Twitch EventSub connection health.
- **Impact:** Significant quality-of-life upgrade for the streamer and improved stream production value.

## Implementation Steps

### Phase 1: Twitch Health Indicator
1. **`server/twitch/eventsub.js`:**
   - Expose connection state via an `EventEmitter` or a callback to `server/index.js`.
   - Track states: `disconnected`, `connecting`, `connected`, `error`.
2. **`server/index.js`:**
   - Track `twitchStatus` in state or broadcast it directly to the dashboard whenever it changes.
3. **`dashboard/app.js` & `dashboard/index.html`:**
   - Add a new badge or status text next to the local WS connection dot indicating Twitch EventSub status.

### Phase 2: Sound Effects Engine
1. **`overlay.html`:**
   - Implement an audio manager (e.g., `playSound(filename)`) that handles concurrent playback and volume.
2. **`server/pipeline/router.js`:**
   - Attach a `sound` payload property to effects (e.g., `alert-banner` gets `sound: 'sub-alert.wav'`).
3. **Dashboard:**
   - Add a global volume slider to control overlay sound levels (sent via WS to `overlay.html`).

### Phase 3: Character Integration
1. **`overlay.html`:**
   - Add a DOM element for the character sprite (e.g., bottom-left corner).
   - Use `state.crowdEnergy` to dynamically switch the character state (e.g., `idle.gif` when energy < 50, `hype.gif` when energy >= 50, `explosion.gif` for S-tier events).
2. **Assets:**
   - Ensure the `characters/lilfokkermascot/` folder structure is respected. (We will use placeholders if actual assets aren't provided yet).

### Phase 4: Dashboard Config Editor
1. **`server/index.js`:**
   - Create HTTP endpoints (`GET /api/goals`, `POST /api/goals`, `GET /api/redeems`, `POST /api/redeems`) to read/write `goals.json` and `redeems.json`.
2. **`dashboard/index.html`:**
   - Add a new "Config" or "Settings" tab in the sidebar.
   - Build a UI grid/list to view, edit, add, and delete Goals and Redeems.
3. **`dashboard/app.js`:**
   - Handle form submissions and REST API calls for the new configurators.

## Verification
- Test Twitch disconnects and verify the dashboard updates immediately.
- Test alerts and verify overlapping sounds play without clipping.
- Verify character sprite changes as crowd energy crosses thresholds (using the dashboard to spoof energy).
- Create a new Goal and Redeem via the dashboard, refresh the page, and ensure they persisted to the JSON files and appear in the overlay.
