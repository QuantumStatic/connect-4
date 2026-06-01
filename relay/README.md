# Connect 4 signaling relay (Cloudflare Worker)

Stateless WebRTC signaling + ICE/TURN for "Play a friend". Stores only ephemeral
SDP in KV — never any game state.

## Deploy

```bash
cd relay
npm install
wrangler kv:namespace create ROOMS      # paste the printed id into wrangler.toml
wrangler secret put TURN_KEY_ID          # from Cloudflare dashboard → Realtime → TURN
wrangler secret put TURN_KEY_API_TOKEN
wrangler deploy
```

To serve the relay on the same origin as the Pages app (recommended, no CORS),
add a Worker route binding the deployed Worker to your Pages domain for the
`/ice`, `/room*` paths (Cloudflare dashboard → Workers Routes), or use Pages
Functions. Otherwise set `VITE_RELAY_URL` in the web build to the Worker URL.

## WebSocket relay (Durable Object)

`RoomDO` relays game messages between the two players in a room over a WebSocket
and caches the last sync for instant resync. Endpoint: `GET /ws/:id` (Upgrade:
websocket). It stores no game logic — clients enforce Connect-4 rules.

Deploy includes the DO automatically (binding `ROOMS_DO`, migration `v1`,
SQLite-backed — free-tier eligible):

```bash
cd relay && npx wrangler deploy
```

The web app uses relay mode by default; "Direct (P2P)" in the friend UI switches
to the WebRTC path (`/ice`, `/room*`).

## Test

```bash
npm test
```
