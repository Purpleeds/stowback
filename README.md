# Stowaway server

The online game server for **Stowaway** (v0.5.0, protocol 5). Players connect to it from the Stowaway app (Windows) with **Play online**. It runs rooms, moves everyone, checks every action and sends each player only what they're allowed to see. All game state is in memory; there's no database.

## Deploy on Render

1. On Render: **New → Blueprint**, pick this repository. `render.yaml` sets up a free web service called `stowaway-game` in Singapore.
2. When it's live, check `https://<your-service>.onrender.com/healthz`. It should show `"ok":true` and `"protocol":5`.
3. The app connects to `https://stowaway-game.onrender.com` by default. If your address is different, type it in the app under **Settings → Online server address**.

The free plan sleeps after about 15 minutes with nobody playing. The first player to connect sees **"Waking up the server…"** for up to a minute.

Pushing a new version to this repository redeploys the server. The app and the server must be the same version: an older app shows "This game version doesn't match the server".

## Run it yourself

Needs Node.js 20 or newer.

```bash
npm install
npm start        # listens on port 3000 (or $PORT)
```

## What's here

```
server/   index.js (entry point), server.js (HTTP + Socket.IO), room.js (one game room),
          rooms.js, motion.js (movement steps), lan.js, static.js, util.js
shared/   rules, map collision, map checks and drawing checks (the app uses the same files)
maps/     kestrel-station.map.json
```

Health check: `GET /healthz` → `{ ok, version, protocol, rooms, players, uptimeS }`. Logs are one JSON line per event.
