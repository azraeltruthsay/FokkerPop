# FokkerPop

A Twitch overlay app built for streamer **LilFokker** — spiritual successor to PolyPop. Everything runs locally on your PC, nothing goes to the cloud.

## Features

- **Live alerts** — follows, subs, gifted subs, bits, raids, hype trains
- **Balloons, fireworks, confetti, sticker rain** — CSS + canvas animations
- **Crowd energy meter** — builds up during events, drives ambient glow effects
- **Combo detector** — recognises sub trains and signals them with a banner
- **Channel Point redeems** — maps reward titles to visual effects
- **Goals tracker** — progress bars that fire effects when completed
- **Leaderboards** — top bits donators and gift sub kings
- **Dashboard** — control panel to test effects, monitor events, manage goals
- **Demo mode** — press `?demo=1` in the overlay URL to see a full stream scenario without Twitch connected

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
7. Approve the Twitch permissions popup

Your `settings.json` is created automatically and is never uploaded anywhere.

## Updating

Download the new zip, extract it next to your old folder, then copy your `settings.json` into the new folder. The old folder can be deleted.

## Manual Setup (for developers)

```bash
git clone https://github.com/azraeltruthsay/FokkerPop.git
cd FokkerPop
npm install
cp settings.example.json settings.json
# edit settings.json with your credentials
npm start
```

## Configuration Files

| File | Purpose |
|------|---------|
| `settings.json` | Twitch credentials and tuning (never commit this) |
| `settings.example.json` | Template — copy to `settings.json` to start |
| `goals.json` | Stream goals — targets, metrics, rewards |
| `redeems.json` | Maps Channel Point reward titles → visual effects |

### goals.json

```json
[
  {
    "id": "first-100-subs",
    "label": "100 Subs",
    "metric": "session.subCount",
    "target": 100,
    "reward": { "type": "effect", "effect": "crowd-explosion" },
    "active": true,
    "completed": false
  }
]
```

Valid metrics: `session.subCount`, `session.bitsTotal`, `session.followCount`, `session.raidCount`.  
Valid reward effects: `balloon`, `firework`, `firework-salvo`, `confetti`, `sticker-rain`, `crowd-explosion`.

### redeems.json

```json
{
  "BUBLOOONS!!": { "effect": "balloon", "count": 10 },
  "Fuel The Fokker": { "effect": "firework-salvo", "count": 3 }
}
```

The key must exactly match the Channel Point reward title in Twitch (case-sensitive).

### settings.example.json tuning options

| Key | Default | Description |
|-----|---------|-------------|
| `server.port` | `4747` | HTTP/WS port |
| `crowd.drainPerSec` | `1` | Energy drain per second when idle |
| `crowd.followBoost` | `1` | Energy boost per follow |
| `crowd.subBoost` | `10` | Energy boost per sub |
| `crowd.raidBoost` | `20` | Base energy boost per raid |

## Asset Folders

| Folder | Purpose |
|--------|---------|
| `assets/stickers/` | PNG/GIF stickers shown during `sticker-rain` effect |
| `assets/sounds/` | WAV/MP3 played by sound effects (future feature) |
| `characters/` | Character sprite sheets (future feature) |

## Logs

Log files are written to `logs/fokkerpop-YYYY-MM-DD.log`. Set the environment variable `LOG_LEVEL=debug` for verbose output.

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

All communication between server, overlay, and dashboard uses a local WebSocket on `127.0.0.1`. No external services beyond the Twitch API.

## Security

- Server binds to `127.0.0.1` only — not accessible from your local network
- WebSocket server rejects any connection not from localhost
- Path traversal guard on all HTTP file requests
- Only one npm dependency (`ws`) — vendored in release zips
- `settings.json` is gitignored and never committed

## Development

```bash
npm run dev   # starts with --watch (auto-restart on file changes)
```

Requires Node.js 20+.
