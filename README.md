# FokkerPop

A Twitch overlay app built for streamer **LilFokker** — spiritual successor to PolyPop. Everything runs locally on your PC, nothing goes to the cloud.

## Features

- **Live alerts** — follows, subs, gifted subs, bits, raids, hype trains
- **Reactive Character** — mascot sprite that reacts to energy and events
- **Sound Effects Engine** — link custom sounds to any alert or effect
- **Balloons, fireworks, confetti, sticker rain** — CSS + canvas animations
- **Crowd energy meter** — builds up during events, drives ambient glow effects
- **Combo detector** — recognises sub and bit trains and signals them with a banner
- **Config Editor** — manage goals and redeems directly in the dashboard
- **Leaderboards** — rotating display of top bits donators and gift sub kings
- **Twitch Health** — real-time status of your Twitch connection in the sidebar
- **Twitch Simulator** — offline test bed to simulate specific redeems, cheers, and alerts
- **Demo mode** — press `?demo=1` in the overlay URL to see a full stream scenario

## Quick Start (Windows)

1. Download the latest `FokkerPop-vX.X.X-windows.zip` from the [Releases page](../../releases)
2. Extract it anywhere — Desktop, `C:\Apps`, wherever you like
3. Double-click **`start.bat`**
4. The dashboard opens automatically in your browser
5. Go to the **Setup** tab and paste your Twitch credentials (see below)
6. In OBS: **Add Source → Browser Source** → URL `http://localhost:4747/` → 1920×1080

Node.js is bundled inside the zip. Nothing else to install.

## Twitch Setup

You need a Twitch application to receive live events:

1. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application**
2. Name: anything (e.g. `FokkerPop`)
3. OAuth Redirect URL: `http://localhost:4747/auth/callback`
4. Category: **Chat Bot**
5. Copy the **Client ID** and generate a **Client Secret**
6. Paste both into the Dashboard → **Setup** tab → click **Connect**
7. Approve the Twitch permissions popup (the window will close itself when done)

Your `settings.json` is created automatically and is never uploaded anywhere.

## Updating

Download the new zip, and **extract it directly into your existing folder** (overwrite all files). 
Your `settings.json`, `goals.json`, `redeems.json`, and any custom stickers/sounds will be **preserved** during this process.

## Customisation

### Sound Effects
Drop your WAV or MP3 files into `assets/sounds/`. You can then select these sounds from the dropdown menus in the **Config** tab of the dashboard. Use the volume slider in the **Live** tab to adjust levels.

### Character Mascot
Place your character GIFs in `characters/lilfokkermascot/`. The app looks for these specific filenames:
- `idle.gif`: shown when energy is low (0-24%)
- `active.gif`: shown when energy is moderate (25-74%)
- `hype.gif`: shown when energy is high (75-98%)
- `explosion.gif`: shown during crowd explosions (99-100%)

### Stickers
Drop PNG or GIF stickers into `assets/stickers/` to have them appear during the "Sticker Rain" effect.

## Troubleshooting

### "Module 'ws' missing" or "node_modules missing"
This happens if you downloaded the **Source Code** zip from GitHub instead of the **Release** zip.
**Fix:** Go to the [Releases page](../../releases) and download the file ending in `-windows.zip`.

### Dashboard says "Twitch Offline" or "Twitch Error"
1. Check your **Setup** tab. Ensure your Client ID and Client Secret are correct.
2. Click **Connect** again to refresh your tokens.
3. Ensure your Twitch App has the Redirect URL set to `http://localhost:4747/auth/callback`.

### Sounds aren't playing
1. Check the volume slider in the Dashboard's **Live** tab.
2. Ensure the sound filename in the **Config** tab exactly matches the file in `assets/sounds/`.
3. In OBS, check the Browser Source properties and ensure **"Control audio via OBS"** is NOT checked (unless you want to manage the volume in the OBS mixer).

## Configuration Files

| File | Purpose |
|------|---------|
| `settings.json` | Twitch credentials and tuning (never commit this) |
| `goals.json` | Stream goals — targets, metrics, rewards |
| `redeems.json` | Maps Channel Point reward titles → visual effects |

## Architecture

```
Twitch EventSub WS
        │
        ▼
    eventsub.js  (normalises raw Twitch events)
        │
        ▼
      bus.js  (event bus with middleware pipeline)
        │
   ┌────┼────────────────────┐
   │    │                    │
enricher  combinator     throttler
(adds ts) (sub combos)  (rate limit)
                             │
                         router.js  (maps events → effects)
                             │
                    ┌────────┴────────┐
                    │                 │
               overlay.html      dashboard/
            (browser source)   (control panel)
```

## Security

- Server binds to `127.0.0.1` only — not accessible from your local network
- WebSocket server rejects any connection not from localhost
- Path traversal guard on all HTTP file requests
- Only one npm dependency (`ws`) — vendored in release zips

## Development

```bash
npm install
npm run dev   # starts with --watch (auto-restart on file changes)
```

Requires Node.js 20+.
