# Remote VJ deck — user guide

Run the VJ deck on a tablet or laptop while hydra renders fullscreen on
another machine (typically a Raspberry Pi driving a projector). The remote
deck is the full control surface: faders with live scrubbing, the function
palette, patch points, scene bank with thumbnails, shuffle/dice, undo/redo,
HUSH, MIDI-learn (on https), plus a live preview of the visuals.

The design behind all of this is in [remote-deck-plan.md](remote-deck-plan.md).

## How it works

- The **renderer** ("host") is a normal hydra tab. On boot it generates a
  pairing — an unguessable room id and token — keeps it in localStorage, and
  connects to the relay at `/ws` on its own origin.
- A **deck** is `deck.html` on any device, paired via URL fragment:
  `https://<origin>/deck.html#room=…&token=…`. Decks send intents; the
  renderer applies them through the exact same code paths as the built-in
  deck and broadcasts the authoritative state back.
- The **relay** is a small sidecar (`server/relay.mjs`) that authenticates
  sockets into rooms and forwards messages. It also stores each room's scene
  bank so a kiosk browser with wiped storage gets its scenes back. In
  development `npm run dev` serves the relay itself; in production it's the
  `relay` service in `compose.yaml`, proxied by nginx at `/ws`.

### Customizing the deployment

- **Arbitrary uid:gid**: both images run under any compose `user:` override
  (e.g. `user: "568:568"`). The relay's `/data` and nginx's rendered config
  dir are world-writable inside their single-purpose containers to make that
  work. Note for relay volumes created by an image from before this change:
  fix the mode once with
  `docker run --rm -v <volume>:/data alpine chmod 1777 /data`.
- **Relay service name**: nginx inside the `hydra` image dials
  `http://relay:8081` by default. If your relay service is named differently
  (or lives at another port), set `VJ_RELAY_HOST` / `VJ_RELAY_PORT` on the
  `hydra` service — or give the relay a network alias `relay`.
- The relay itself takes `VJ_PORT` (default 8081), `VJ_DATA_DIR` (default
  `/data`) and `VJ_ALLOWED_ORIGINS` (comma-separated allowlist; default is
  same-host origin checking).

## Pairing

1. On the machine that runs the visuals, click the **QR button** in the VJ
   deck's top rail (next to the pop-out button) — or open
   `https://<origin>/deck.html` directly in any browser that has run the
   renderer (the pairing lives in that browser's localStorage). This is the
   **pairing screen**: it shows a QR code and the full deck URL.
2. Scan the QR (or open the URL) on the tablet/laptop. Done.
3. From a running deck, the QR-code button in the top rail shows the same
   pairing to enroll further devices.
4. "rotate pairing" on the pairing screen invalidates the credentials;
   reload the hydra tab afterwards and re-pair every deck.

**Never show the pairing screen on the projector.** The link is full remote
control of the renderer — evaluating code included. That is the whole point,
and also why it must stay off the wall.

For kiosk setups the pairing can be pinned in the renderer URL instead:
`http://localhost:8080/?vjroom=<room>&vjtoken=<token>` (both persist to
localStorage, so subsequent plain loads keep them).

## LAN mode vs WAN mode — one build, don't mix them

- **LAN / offline** (no venue internet needed): the Pi runs the compose stack
  and everyone loads `http://<pi>:8080`. All assets are vendored, so this
  works with zero internet — recommended rig is the Pi on its own travel
  router / access point. Note: for microphone reactivity the Pi's own browser
  must load the app via `http://localhost:8080` (secure-context rule), not
  its LAN IP.
- **WAN** (deck and renderer can be on different networks entirely): everyone
  — the Pi's kiosk browser *and* the decks — loads the public HTTPS
  deployment. All connections go outbound over `wss://`, so no port
  forwarding anywhere. Bonus: https is a secure context, which unlocks mic
  and camera on the Pi without the localhost trick, and Web MIDI + screen
  wake lock on an Android tablet deck.
- Don't mix: a page loaded over https cannot talk `ws://` to a LAN relay
  (mixed content). The relay is always the one behind the origin the page
  came from.
- WAN checklist for the reverse proxy in front: it must pass the WebSocket
  `Upgrade` on `/ws` (standard `proxy_http_version 1.1` + `Upgrade`/
  `Connection` headers). The relay pings every 25s, which keeps sockets
  under typical idle timeouts.

## Live preview

The ◉ LIVE button on the deck streams the renderer's canvas. It tries
WebRTC first (peer-to-peer, signaled through the relay; STUN handles most
NATs over WAN) and falls back automatically to JPEG frames over the relay
(~3fps) when P2P can't connect. The stream pauses while the renderer's
browser puts its tab fully to sleep.

## What happens when things drop

- Deck loses the relay: red banner, automatic reconnect with backoff, full
  resync from a fresh snapshot.
- Renderer dies or reloads: decks show "waiting for the renderer" and
  reattach as soon as it's back (a reloaded renderer takes its room over).
- A deck disconnects mid-fader-drag: the renderer pins the last live values
  into the code, so what's on the wall always matches the sketch.
- An edit from a stale deck (raced by another controller) is rejected by a
  code hash check and the deck resyncs — never misapplied.
- Eval errors and the 500ms runtime auto-revert show up as toasts on every
  deck.

## Raspberry Pi kiosk notes

- Use Pi OS (Bookworm or newer, 64-bit) and its packaged Chromium (it carries
  the Pi's acceleration patches). Verify `chrome://gpu` says hardware
  accelerated; a corrupted Chromium profile is a known cause of ~10fps WebGL
  — a fresh profile fixes it.
- Autostart (labwc/wayfire autostart or systemd user unit):

  ```
  chromium --kiosk --noerrdialogs --disable-infobars --no-first-run \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream \
    http://localhost:8080/
  ```

  `--use-fake-ui-for-media-stream` auto-grants the microphone so
  audio-reactive sketches work unattended (feed the venue audio into the Pi).
- **Do not use `--incognito`** — it wipes localStorage on every boot: scene
  bank, MIDI mappings, cycle pace and the pairing all gone. (If a kiosk does
  wipe storage, the relay restores the scene bank, and `?vjroom=&vjtoken=`
  in the autostart URL pins the pairing.)
- Disable screen blanking (raspi-config, or swayidle/wlopm on Wayland).
- If the Pi struggles at full resolution, `setResolution(1280, 720)` in the
  sketch (CSS upscales) and hydra's `fps: 30` are the two biggest levers.
- A systemd watchdog that restarts Chromium if it exits is worth having;
  WebGL context loss on an overheating Pi has no in-page recovery.

## Security model, in one paragraph

Joining a room requires the room id *and* its token — both unguessable,
carried only in the URL fragment (never in server logs). The relay binds a
room's token on first use (constant-time compares), validates the `Origin`
header, rate-limits handshakes per IP, and drops sockets that don't
authenticate within 5s. On plain-http LAN the traffic is sniffable by the
local network — that's the accepted trade-off for zero-certificate setup;
use your own AP/travel router. Over WAN, TLS covers transport privacy. The
control channel is remote code execution *by design* — treat the deck URL
like a password, rotate it per session if strangers were near it.
