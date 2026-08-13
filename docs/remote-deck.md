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
  `hydra-relay` service in `compose.yaml`, proxied by nginx at `/ws`.

### Customizing the deployment

- **Arbitrary uid:gid**: both images run under any compose `user:` override
  (e.g. `user: "568:568"`). The relay's `/data` and nginx's rendered config
  dir are world-writable inside their single-purpose containers to make that
  work. Note for relay volumes created by an image from before this change:
  fix the mode once with
  `docker run --rm -v <volume>:/data alpine chmod 1777 /data`.
- **Relay service name**: nginx inside the `hydra` image dials
  `http://hydra-relay:8081` by default. If your relay service is named
  differently (or lives at another port), set `HYDRA_RELAY_HOST` /
  `HYDRA_RELAY_PORT` on the `hydra` service — or give the relay a network
  alias `hydra-relay`.
- The relay itself takes `HYDRA_RELAY_PORT` (default 8081), `HYDRA_RELAY_DATA_DIR` (default
  `/data`) and `HYDRA_RELAY_ALLOWED_ORIGINS` (comma-separated allowlist; default is
  same-host origin checking).
- **Preview bandwidth budgets** are also set on the relay service (delivered
  to the renderer when it connects; unset vars keep the mode-based defaults
  described under [Live preview](#live-preview)):
  - `HYDRA_PREVIEW_RTC_KBPS` — WebRTC sender bitrate cap (default 1200 WAN / 6000 LAN)
  - `HYDRA_PREVIEW_FRAME_KBPS` — relayed-frames rate budget in KB/s (default 150 / 400)
  - `HYDRA_PREVIEW_FRAME_WIDTH` — resolution ceiling for both paths (default 480 / 720)
  - `HYDRA_PREVIEW_MIN_FRAME_MS` — minimum gap between two frames in the
    frames-fallback mode, i.e. its top speed: 350 ms ≈ 3 fps, 200 ≈ 5 fps
    (default 350; the gap auto-stretches beyond it for heavy sketches, and
    the WebRTC video path is unaffected)

  Each also exists as a mode-scoped variant — `HYDRA_PREVIEW_LAN_*` /
  `HYDRA_PREVIEW_WAN_*` — for a stack that serves both modes (LAN http plus
  a TLS proxy in front): the renderer's scheme picks the scope, and a scoped
  var beats the unscoped one. Separate LAN and WAN deployments don't need
  this — just configure each relay. For `npm run dev` the same vars work as
  plain environment variables.

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

### Pairing a TV / display (short code)

A renderer loaded with `?display=1` (the Android TV app, or any browser you
point at that URL) that has no credentials shows a **pairing code** like
`ABCD-2345` instead of a QR. On a paired deck: toprail QR button → **LINK A
TV / DISPLAY** → type the code → APPROVE (optionally *require OK on the TV*).
The display then receives its own credential: render-only (it can never act
as a deck), individually revocable from the same overlay (PAIRED DISPLAYS →
UNPAIR) without rotating anything else.

Unlike the deck QR, the code is safe on a projected screen: single-use,
expires after 10 minutes (relay clock), and approval is bound to the exact
socket showing it — a photo of the wall redeems nothing.

One display renders at a time: the newest renderer in a room wins (same rule
as always). A display that gets replaced shows a "press OK to reclaim"
overlay rather than going dark. See docs/android-tv.md for the TV app.

### FFT sources (a.fft away from the renderer's mic)

Displays usually have no usable mic, so `a.fft` can come from three places —
pick via right-click/long-press on the deck's ∿ FFT button:

- **a deck's mic**: hit **∿ MIC** in the deck toprail; that deck captures and
  streams the bins (secure context required on the deck: https or localhost).
- **the display's own mic** (Android TV app): native capture, works on plain
  http, reaches built-in projector mics and USB mics.
- **the renderer's mic**: the classic behavior.

`auto` prefers deck → display → renderer among sources actually delivering,
and `a.setSmooth()/setCutoff()/setScale()/setBins()` follow the active
source, so sketches behave identically everywhere. Other decks' FFT meters
show whichever source is live.

## LAN mode vs WAN mode — one build, don't mix them

- **LAN / offline** (no venue internet needed): the Pi runs the compose stack
  and everyone loads `http://<pi>:8080`. All assets are vendored, so this
  works with zero internet — recommended rig is the Pi on its own travel
  router / access point. Note: for microphone reactivity the Pi's own browser
  must load the app via `http://localhost:8080` (secure-context rule), not
  its LAN IP.
- **LAN over https (`:8443`)**: the same stack also serves
  `https://<pi>:8443` with a self-signed certificate (generated on first
  start, persisted in the `hydra-certs` volume). Load the *deck* from there
  and accept the certificate warning once per device — the deck is then a
  secure context, so **Web MIDI, the deck's own mic (FFT source) and screen
  wake lock work on LAN** without browser flags. Caveats: the browser keeps
  its "not secure" badge, and Chrome refuses service workers on cert-error
  origins, so no PWA install/offline cache (install a real/mkcert cert into
  the volume to get those too).

  Clicking through the warning is enough for **Chromium-family** browsers
  (Chrome, Vivaldi, Brave, Edge). **Firefox/LibreWolf are stricter: they
  silently deny Web MIDI on a cert-override origin**, and they also reject
  a CA certificate presented as the server's own cert — so the stack
  generates a tiny local CA plus a CA-signed server certificate
  (mkcert-style). Make the CA genuinely trusted on each controlling
  device:

  0. **Give the rig a hostname — Firefox/LibreWolf refuse the Web MIDI
     permission on IP-address origins** ("SitePermsAddons install
     disallowed when the host is an IP address"), so `https://192.168.…`
     can never get MIDI there, trusted cert or not. Any LAN name works:
     a static DNS entry on the router (MikroTik:
     `/ip dns static add name=hydra.lan address=192.168.88.100`), an
     `/etc/hosts` line on the controlling machine
     (`192.168.88.100  hydra.lan`), or the host's mDNS name
     (`<hostname>.local`) where Avahi runs. Chromium-family browsers are
     fine with the bare IP.
  1. Set `HYDRA_TLS_SAN` (compose env) to every name/IP the rig is reached
     by, e.g. `localhost,127.0.0.1,192.168.88.100,hydra.lan` (bare entries
     get their `DNS:`/`IP:` prefixes automatically), then
     `docker compose up -d` — the server cert re-issues by itself whenever
     this value changes. A trusted import only validates when the SAN
     matches the URL in the address bar, so this step comes first.
  2. On each device, download the CA from `http://<pi>:8080/hydra.crt`
     (it serves `CN=hydra-lan CA`, not the server cert).
  3. Import it as trusted: Firefox/LibreWolf → Settings → Privacy &
     Security → Certificates → View Certificates → Authorities → Import →
     tick "Trust this CA to identify websites". Android → Settings →
     Security → Encryption & credentials → Install a certificate → CA.
     The CA is created once and survives SAN changes — adding a name/IP
     later re-issues only the server cert, no re-import needed.
  4. Reload the deck via the hostname —
     `https://hydra.lan:8443/deck.html…` — no warning, padlock closed, and
     Firefox's Web MIDI permission add-on prompt can finally appear.
     (Firefox side note: it only shows the MIDI prompt when a controller
     is already connected at browser start.)

  Keep the Pi's kiosk browser on
  `http://localhost:8080` — that also keeps the relay's preview budgets in
  LAN mode, which is detected from the *renderer's* origin scheme.
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

## Install the deck as an app (PWA)

The deck page is an installable web app: fullscreen (no browser chrome, no
status bar), its own icon, instant launches from a runtime cache, and the
pairing persisted on the device — a home-screen launch reconnects straight
away, no re-scanning.

- **Android (WAN/https mode)**: open the deck link once in Chrome, then
  choose **Install app** from the ⋮ menu (or the install prompt). The
  installed deck launches truly fullscreen.
- **iOS / iPadOS**: open the deck link in Safari, **Share → Add to Home
  Screen**. If iOS launches the installed app without the pairing (it starts
  apps from a clean URL and home-screen apps get their own storage), the
  pairing screen appears once — type the room and token by hand, or re-open
  the QR link in the app; it's remembered from then on.
- **LAN/http mode**: plain http is not a secure context, so Chrome offers no
  install and no offline cache — "Add to home screen" just makes a browser
  shortcut. iOS's Add to Home Screen still gives a standalone fullscreen
  deck. For the full app experience on Android, use WAN mode. (The `:8443`
  self-signed listener unlocks MIDI/mic/wake-lock but not PWA install —
  service workers require a certificate the browser actually trusts.)

Installing changes nothing about pairing or security: the app is just
`deck.html`, and **rotate pairing** logs installed decks out like any other.
The service worker only ever controls `/deck.html` — the renderer page talks
straight to the network, kiosk setups included.

## Touch gestures (phones and tablets)

The deck reshapes itself on phone widths — the top rail wraps into a
transport row and a toggles row, and the scene bank becomes a pad grid
(4 per row, wrapping as the bank grows) with the export/import/cycle
tools underneath. Everything a
right-click does on the desktop lives behind a **long-press** on touch:

- **Long-press** a scene pad, fader, or sequencer cell for its menu
  (MIDI learn, audio/mouse bind, move left/right, clear, cycle pace…).
- **Drag a fader** to scrub; slide your finger **above or below the
  track mid-drag** for up to 10× finer control (the track tints amber
  while fine mode is engaged). On touch devices a fader owns any touch
  that starts on it — drags can wander vertically without the page
  scrolling out from under the gesture. Scroll the deck from labels,
  chip headers or empty space instead.
- **Scene reorder** on touch is the long-press menu's move left/right
  (drag-to-reorder needs a mouse).
- **Hold a module's title bar (~⅓s)** to lift it for reorder; a plain
  sideways drag on the title bar pans the chain instead.

## MIDI control

Web MIDI needs a secure context: WAN/https decks, or the renderer machine
itself.

**⚡ MAP — one tap per mapping.** The fastest way to lay out a whole
controller: tap ⚡ MAP in the toprail, then tap any value row (or a scene
pad, or HUSH) and move a knob / hit a pad on the hardware. The mapping
lands, the mode stays on — tap the next row. ⚡ MAP again (or Esc) exits.

Right-click (long-press on touch) still opens the full menu per row:

- **Faders** — *midi learn (move a knob / hit a pad)* binds whatever the
  hardware sends first: a CC becomes a knob, a note becomes a toggle pad.
  A learned knob has **no range**: it moves the value exactly like the
  on-screen fader — relative and unbounded, with sensitivity scaled to the
  value's magnitude when you grab the knob (re-grab to recalibrate). If
  you'd rather have the knob's physical travel pinned to fixed bounds,
  *midi range…* in the same menu takes any min/max — including negatives
  and values far beyond the on-screen fader — and *clear range* goes back
  to unlimited.
- **Buttons mute** — pressing always goes toward 0. *midi button:
  mute / unmute* snaps the param to 0 on one hit and brings the previous
  level back on the next; *midi button: mute while held* holds it at 0
  and restores the previous level on release (release works with real
  note-offs and with vel-0 note-ons, both conventions). Whatever a knob
  or fader set in the meantime is what comes back.
- **Numbers inside expressions too** — the scale/offset rows of an audio
  or mouse binding and the mini-faders on any `() => …` formula (or a
  constant like `Math.PI/4`) learn the same way; the hardware drives them
  live without recompiling.
- **Scene pads** — *midi learn* on a scene slot recalls it on a pad hit.
- **HUSH** — right-click it and hit a pad: panic button on hardware.

**Controller LEDs** (opt-in): right-click ⚡ MAP → *controller LEDs:
light only assigned controls*. The deck darkens the board and echoes
each assigned control's own message back (note-on / CC, velocity 127),
which lights exactly the mapped knobs and pads on controllers whose
LEDs accept external MIDI — Korg nano* devices need their editor's LED
mode set to *external* first. It re-lights automatically when the
device reconnects, and it's off by default because a synth on the same
MIDI bus would interpret those note-ons as actual notes.

A learn that lands on a knob or pad which already drives something else
asks before stealing it ("CC7 already controls noise scale — reassign /
keep it"), so a slip of the hand can't silently unmap a control.

Mappings persist per browser and deactivate automatically when the sketch
structure changes underneath them (they're keyed to the function the
param belongs to).

## Live preview

The ◉ LIVE button on the deck streams the renderer's canvas. Compressed
frames over the relay (~3fps; WebP, or JPEG on renderers whose browser
can't encode WebP) start immediately — they travel the same path as
the controls, so the preview works wherever the deck works, WAN included.
In parallel the deck negotiates a WebRTC peer connection (signaled through
the relay; STUN handles most NATs) and switches to the smooth video the
moment P2P media actually flows; if the P2P route is blocked (symmetric
NAT / carrier-grade NAT — common on mobile networks; there is no TURN
server) the preview simply stays on the ~3fps frames, and if a live P2P
link later drops the frames resume automatically. The stream pauses while
the renderer's browser puts its tab fully to sleep.

The preview pane is **resizable**: drag the slim grip bar under the video
(touch or mouse), tap the ⤢ button on it to cycle size presets, double-tap
the grip to reset. The chosen size is remembered per device — and reported
to the renderer, which sizes its stream to the largest connected pane so a
big pane also means a *sharper* preview (within the budgets below).

The **OSD** button in the deck's top rail (next to ◉ LIVE — it appears
while LIVE is on) toggles a signal-status readout in the pane's corner,
like a broadcast monitor's on-screen display:
the active path (amber `● FRAMES` = relayed snapshots with their image
format, green `● WEBRTC P2P` = live video with its codec), the measured
resolution, framerate and bandwidth, plus the LAN/WAN mode, the P2P
negotiation state (`checking` / `connected` / `live` / `failed` — handy for
seeing whether WebRTC made it through a venue NAT) and the pixel width this
pane requested from the renderer. Bandwidth is shown in the units of the
matching budget — kb/s on the WebRTC line (`HYDRA_PREVIEW_RTC_KBPS`), KB/s
on the frames line (`HYDRA_PREVIEW_FRAME_KBPS`) — so the overlay doubles as
the live readout when tuning those variables. The toggle is remembered per
device.

Preview bandwidth is budgeted on both paths and degrades in
perceived-quality order — sharpness matters more than motion on a preview,
so dense sketches (high-frequency `voronoi` is essentially noise, the worst
case for any encoder) surrender framerate first (~3 → ~1.2 fps), then a
little compression quality, and resolution only as the last resort,
recovering in reverse when the sketch calms down. The budgets are picked by
mode — the two can't be mixed anyway, and they have very different
bandwidth realities:

|                          | WAN (https) | LAN (http) |
| ------------------------ | ----------- | ---------- |
| WebRTC bitrate cap       | 1.2 Mbit/s  | 6 Mbit/s   |
| Relayed-frames budget    | 150 KB/s    | 400 KB/s   |
| Resolution ceiling       | 480 px      | 720 px     |

Every value is overridable per deployment with the `HYDRA_PREVIEW_*`
variables on the relay service (see *Customizing the deployment*).

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

## Android TV / projector as the display

An Android TV device can be the renderer instead of (or alternating with)
the Pi: the `android/` app wraps the `?display=1` page in a kiosk shell with
watchdogs, boot autostart, short-code pairing and native TV-mic audio
reactivity. Full guide: **docs/android-tv.md**.

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
