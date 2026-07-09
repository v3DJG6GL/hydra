# Remote VJ deck — architecture plan

Goal: run the VJ deck on a separate device (Android tablet, laptop) while hydra
renders fullscreen on another machine (typically a Raspberry Pi driving a
projector). Status: **plan only** — nothing here is implemented yet.

Decisions this plan is built on: controllers are Android tablets and desktop
browsers (no iOS requirement), the rig must work **offline-first** (venue wifi
can't be trusted; own AP / travel router is the recommended setup), and v1
includes both the full control surface and a **live video preview** on the
remote.

## Why the current pop-out can't do this

The pop-out/PiP decks share the host tab's JS context (`window.open` +
direct DOM rendering, `src/panel/popup.js`) — every button is a closure into
the main realm. There is no message layer at all, so nothing crosses a device
boundary. A remote deck needs a real transport and protocol.

## Chosen architecture: WebSocket relay sidecar, host-authoritative

```
[tablet deck]  ──ws──►  ┌──────────────┐  ◄──ws──  [Pi browser, fullscreen hydra]
[laptop deck]  ──ws──►  │ relay sidecar │
                        │ (node, ~200LOC)│  ◄── nginx proxies /ws (same origin)
                        └──────────────┘
```

- A tiny Node `ws` relay runs as a second service in `compose.yaml`; the
  existing nginx serves it at a same-origin `/ws` path (`proxy_http_version
  1.1` + `Upgrade`/`Connection` headers in `docker/nginx.conf`). No published
  ports beyond the existing 8080.
- Everything stays **plain http / ws on the LAN** — `ws://` from an http page
  is allowed everywhere; no certificates to install on any device.
- The **host tab (Pi) is the single source of truth**. Remotes send *intents*
  (`setControl`, `scene.save/recall/reorder`, `shuffle`, `mutate`, `undo`,
  `redo`, `hush`, `evalCode`); the host applies them through the existing
  VJPanel/patcher/Mutator paths and rebroadcasts authoritative state with a
  monotonic `seq`. New/reconnecting clients request a full snapshot, then
  consume deltas; snapshot-on-gap when a seq is missed.
- The remote page is a **second Vite entry** (`deck.html`) bundling
  `sketch-model.js` (pure acorn → model), the panel renderer (already
  parameterized by host document), `patcher.js` edit constructors, and a
  transforms snapshot from the host. VJPanel's ~10 host touchpoints (cm
  buffer, emit, LiveBind/`window.__vj`, `hydraSynth` audio/captureStream/
  getScreenImage, `speed`/`bpm` globals, `window.eval` in freezeExpr,
  localStorage scenes, `state.panel` flags) get extracted behind an adapter
  interface: same-context adapter for today's dock/popup/pip, WS adapter for
  remotes.

### Rejected alternatives (all cross-checked)

- **Bundled rtc-patch-bay** (socket.io v2 + simple-peer 9.11): its default
  signaling server `patch-bay.glitch.me` is dead (Glitch ended app hosting
  2025-07-08; upstream hydra docs admit `initStream()` is broken), simple-peer
  is unmaintained, and socket.io-client v2 can't talk to modern servers.
  Don't build on it. (Its ideas live on: hydra's own `hydra-server` is
  self-hostable if inter-instance video streaming is ever revived.)
- **WebRTC as the control channel**: works without HTTPS (RTCPeerConnection is
  *not* secure-context-gated — verified against MDN/Chromium lists), but the
  signaling dependency defeats offline use and adds mDNS-ICE failure modes on
  LANs, with no latency benefit over a LAN relay. Reserved for the *video
  preview* only.
- **trystero / serverless P2P**: uses `crypto.subtle` (secure-context-only →
  broken on `http://<LAN-IP>`) and all its rendezvous strategies need
  internet.
- **Yjs/CRDT**: wrong shape — single writer, no offline merge wanted, and it
  fights the shared CodeMirror undo timeline. Reconsider only if collaborative
  *text* editing across devices becomes a goal (that's flok's territory).
- **MQTT/OSC**: keep as optional interop later — an OSC-over-UDP listener on
  the relay would let TouchOSC/open-stage-control/hardware drive the same op
  bus.

## Secure-context facts that shaped the design (verified)

- `ws://` from a plain-http page: fine. `wss://` needed only if the page ever
  goes https (mixed content).
- `getUserMedia` (mic for `a.fft`, camera for `initCam`) is secure-context
  only — works on `http://localhost`, **not** on `http://<LAN-IP>`. So the
  **Pi must load the app via localhost** (serve the container on the Pi
  itself, or an SSH tunnel). Hard requirement; document it.
- Web MIDI is secure-context only → MIDI on the *tablet* would need LAN HTTPS
  (mkcert + per-device CA install). Punt: MIDI hardware plugs into the host or
  desktop; tablet is touch-only in v1.
- Chrome's Local Network Access prompt (142+) doesn't gate LAN-page → LAN-WS.

## Hard prerequisites (do these first)

1. **Vendor the CDN dependencies.** `index.html` loads hydra-synth, p5.js, and
   Google Fonts from CDNs (and the favicon from the *dead* `cdn.glitch.com`) —
   today the app cannot even boot without internet. Move them into
   `public/`/npm deps. This alone is worth doing regardless of the remote
   deck.
2. **Decide where the stack runs at a gig**: recommended = the Pi runs the
   Docker stack itself (image is already built multi-arch via
   `--platform=$BUILDPLATFORM`; confirm an arm64 GHCR tag exists) and either
   joins a travel router or acts as its own AP.

## Protocol notes (the details that will bite otherwise)

- **Edits**: reuse the `{from,to,text}` splice objects from `patcher.js` and
  extend `applyEdit`'s existing text-equality guard with a **base-text hash**
  in every remote edit, so a stale splice from a laggy deck is rejected, not
  misapplied. Host pushes full code text after every accepted change.
- **Fader drags**: LiveBind's `ensure()` must shadow-eval on the host before
  streamed values do anything → the deck needs an `ensure → ack` round trip
  before streaming `liveSet` (coalesced latest-per-path). **On controller
  disconnect, the host auto-commits the last live values** — otherwise the
  wall shows X while the code says Y until the next commit.
- **Error/revert feedback**: eval errors, the 500ms runtime auto-revert
  (`armRuntimeRevert`), and mutate retry-exhaustion are invisible off-host
  today. The protocol needs `evalResult`/`reverted` events + a deck toast, or
  a failed scene recall reads as "the deck is broken" mid-set.
- **State a snapshot must carry** (beyond code + scenes): `historySize`
  (undo/redo button state), `showCode`, `fftShown`, cycle `{on, secs, pos}`,
  current `speed` global, transforms snapshot (refresh it if a sketch
  `setFunction()`s new GLSL), a.fft frames for a deck-local FFT meter (the
  host's FFT canvas draws on the projector!).
- **Scene bank**: move to **relay-persisted storage** as the single
  authoritative bank (host localStorage dies with `--incognito` kiosks and
  can't be shared). Thumbnails still come from the host (`getScreenImage`
  round trip, up to ~3s — keep the existing "code unchanged" guard).
- **Multi-client**: per-control last-writer-wins, src-tagged ops for echo
  suppression, relay roster + "X is dragging Y" hints. Shared undo timeline
  means A's undo reverts B's change — acceptable for v1 (same as two hands on
  one deck), but tag ops per client for a later confirm-on-foreign-undo.
- **Reconnect**: server ping every ~25s (below nginx's 60s proxy timeout),
  10s pong timeout, client exponential backoff + jitter, visible
  connected/disconnected indicator, build-hash hello so stale tabs reload.
- **Host reload/crash**: relay marks the host dead → decks show "no renderer";
  on host hello, the deck holding the newest text re-pushes code + scene
  pointers (the remote twin of the popup's `__vjAdopt` re-adoption).

## Pairing & security (the channel is remote code execution *by design*)

- Random 128-bit token in the deck URL, enforced at WS handshake; relay
  validates `Origin`; single-active-controller lock with explicit takeover.
- **Never project the pairing secret.** The obvious "QR on the hydra page"
  puts the token on the wall for the whole audience. Pairing QR/room-code
  lives on a **separate admin route** (open it on the Pi before the show, or
  on any already-paired device), tokens rotate per session.
- Plain ws on shared wifi is sniffable — that's the accepted trade-off for
  zero-cert setup. Mitigate by defaulting to own-AP/travel-router, and offer
  optional HMAC on ops (works without TLS) if venue wifi must be used.

## Live preview on the remote (v1, per decision)

- Reuse `hydra.captureStream` (canvas.captureStream(25) — already feeds the
  pop-out ◉ LIVE preview) over a **WebRTC peer connection signaled through
  the same relay** (no extra server; works offline on the LAN). Use a
  maintained simple-peer fork (`@thaunknown/simple-peer`) — not the bundled
  9.11.
- Fallback if RTC misbehaves on the Pi: throttled JPEG frames
  (`getScreenImage` at 2–4 fps) over the WS — ugly but dependable.

## Raspberry Pi appliance notes

- Pi OS Bookworm/Trixie 64-bit, labwc autostart:
  `chromium --kiosk --noerrdialogs --disable-infobars --no-first-run
  --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream
  http://localhost:8080` (fake-ui auto-grants the mic for audio-reactive
  sketches; venue audio feed goes into the Pi).
- **Do not use `--incognito`** (a common kiosk recipe) — it wipes
  localStorage: scene bank, MIDI mappings, cycle pace, all gone on reboot.
- Disable screen blanking via raspi-config (Wayland: swayidle/wlopm).
- Use the Pi-OS-packaged Chromium (Debian's lacks Pi acceleration patches);
  verify `chrome://gpu`; a corrupted Chromium profile is a known cause of
  ~10fps WebGL — fresh profile fixes it.
- Biggest performance levers, worth exposing as deck controls later:
  `setResolution(1280,720)` (or lower) with CSS upscale, hydra `fps: 30` cap.
- systemd watchdog to restart Chromium if it dies; note WebGL context loss on
  an overheating Pi has no recovery path in hydra-synth — the watchdog +
  boot-into-current-state (from relay-persisted state) is the answer.

## Suggested milestones

1. Vendor CDN deps (offline boot works on a bare LAN).
2. Relay sidecar + nginx `/ws` + compose service; token + Origin checks.
3. Adapter extraction in VJPanel (no behavior change for dock/popup/pip).
4. `deck.html` remote entry: snapshot/delta sync, intents, scenes
   (relay-persisted), shuffle/mutate/undo, error toasts, reconnect UX.
5. Live preview via WebRTC over the relay.
6. Pairing admin route + QR; Pi kiosk docs; touch polish (long-press = the
   deck's right-click menus, bigger touch targets, viewport meta).
