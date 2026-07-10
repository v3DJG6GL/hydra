# Android TV display app — user guide

The `android/` app turns an Android TV device (XGIMI projector, Google TV
box, Raspberry Pi 5 on LineageOS ATV…) into a hydra **display**: a thin
kiosk shell around the system WebView that loads the renderer page in
display mode (`?display=1`) from your existing deployment. The page does
everything a renderer does — visuals, relay connection, deck control,
preview streaming — the app owns fullscreen, keep-awake, recovery, and the
native audio path. It pairs with the deck over the **short-code flow**, so
nothing security-sensitive ever appears on the projected screen.

## Before writing anything on the TV — the 1-hour hardware spike

WebView WebGL performance is the whole premise. Before relying on a device,
sideload any WebView-based kiosk browser (e.g. Fully Kiosk) or just install
this app, and check:

- `https://webglreport.com/?v=1` — WebGL1 must be available and the renderer
  string must name the real GPU (Mali/VideoCore/Tegra), **not SwiftShader**.
- Your hydra URL with a heavy feedback sketch — watch the fps for 15 min
  (thermal throttling shows up late on sticks and projectors).
- If a device can't hold ~30 fps at the 720 tier, drop to 540 or use a
  stronger box; the Pi-with-PiOS-Chromium kiosk remains a fine renderer.

## Install

CI builds a signed APK on every `tv-v*` tag (GitHub Releases). No Play
Store — sideloading is the distribution.

**Google TV / Android TV boxes and Pi 5 LineageOS (adb):**

```bash
# on the TV: Settings → System → About → click "Android TV OS build" 7× to
# unlock Developer options, then enable USB/network debugging
adb connect <tv-ip>
adb install -r hydra-tv-*.apk
# optional headless provisioning (skips the on-screen settings):
adb shell am start -n io.github.v3djg6gl.hydra.tv/.SettingsActivity \
  -e url "https://hydra-xxxx.example.org/?display=1" -e name "stage tv" --ez apply true
```

**XGIMI projectors:** newer XGIMI firmware often ships with adb disabled —
copy the APK onto a USB stick, open it with the built-in file manager, and
allow "install unknown apps" for that manager when prompted. Configure via
the on-screen settings (hold BACK).

## First run

1. The app opens its settings screen (no URL configured yet).
2. Enter the server URL — a bare `hydra.example.org` or `192.168.1.50:8080`
   is enough: https is probed first (then http), and `?display=1` is
   appended automatically. *Paste from clipboard* sits right under the
   field. The **same origin rule applies as everywhere else** (see
   remote-deck.md): all-LAN or all-WAN, never mix.
3. SAVE & OPEN KIOSK. The page boots to the pairing screen: a short code
   like `ABCD-2345`.
4. On a paired deck: toprail QR button → **LINK A TV / DISPLAY** → type the
   code → APPROVE. (Optionally tick *require OK on the TV* — then the TV
   asks for one OK press before finishing.)
5. Done. The TV holds its own revocable display credential in localStorage;
   the deck's QR overlay lists paired displays with UNPAIR/rename.

The code on the TV screen is single-use, expires in 10 minutes, and grants
nothing by itself — projecting it is harmless. That's the point.

Kiosk pinning still works instead of pairing: put
`?display=1&vjroom=…&vjtoken=…` in the URL and the page skips the pairing
screen entirely (that's the room credential though — treat that URL like a
password, and know that the newest renderer always wins the room).

## Remote control keys

| Key | Action |
| --- | --- |
| D-pad / OK | goes to the page (drives the pairing screen) |
| BACK ×1 | sends Escape to the page |
| BACK ×2 | exit the app |
| BACK (hold) or MENU | settings |

If you'd rather land in settings every time the app starts, flip *open
this settings screen on every app start* in settings (boot autostart
still goes straight to the kiosk). EXIT APP in settings closes the app
even before a URL is configured.

## Audio-reactive visuals on a TV

The TV has no usable browser microphone (WebView `getUserMedia` is
secure-context-gated and broken on several TV builds), so `a.fft` comes
from the **fft-bus** with three producers — pick in the deck's audio menu
(right-click/long-press the ∿ FFT button):

- **a deck's mic (∿ MIC button)** — the tablet captures and streams the
  processed bins over the relay. Needs a secure context on the deck (WAN
  https, or localhost); on plain LAN http the button explains itself.
- **the display's own mic (native)** — the app captures via AudioRecord
  (works on plain http, reaches XGIMI's built-in mics and USB mics),
  computes 8 bands natively, and feeds the page ~25×/s. Enable *allow
  native audio capture* in the TV settings once; the Android mic permission
  prompt appears the first time capture starts. `UNPROCESSED` /
  `VOICE_RECOGNITION` sources are preferred to dodge AGC. If Google
  Assistant grabs the mic the capture reports itself *silenced* on the deck
  OSD and resumes automatically.
- **the renderer's mic (local)** — the classic desktop/Pi behavior.

`auto` prefers deck → native → local among sources actually delivering.
`a.setSmooth()/setCutoff()/setScale()/setBins()` keep working — they are
forwarded to whichever device owns the mic.

## Quality tier

Budget TV GPUs (Mali-G31/G52) are roughly Raspberry Pi class. The display
renders internally at a **tier** — 540 / 720 (default) / 1080 / native —
and CSS-stretches to the panel (`image-rendering: pixelated`, the hydra
look). Change it from the deck: audio menu → *display quality*. The deck
OSD (enable ◉ LIVE + OSD) shows the display's real fps, resolution, GPU
string and active FFT source — tune with evidence, not vibes.

## Keeping the screen on

The app holds FLAG_KEEP_SCREEN_ON, but **Android 11+ "Energy saver" /
inattentive sleep overrides every app** and turns the display off anyway.
One-time, per device:

- Settings → System → Power & energy: disable "Turn off display" timers,
  screensaver/ambient mode, and any "no signal auto-off" (XGIMI defaults to
  10–20 min!).
- Or via adb: `adb shell settings put secure attentive_timeout -1`
- Developer options → "Stay awake while plugged in" also works.

## Autostart on boot

Enable *start on boot* in settings. Requirements the settings screen walks
you through:

- Launch the app manually once after every (re)install (Android's
  stopped-state rule; a force-stop disables autostart until the next
  manual launch).
- Android 10+: grant "display over other apps" (button in settings, or
  `adb shell appops set io.github.v3djg6gl.hydra.tv SYSTEM_ALERT_WINDOW allow`).

## Recovery behavior (what the app does on its own)

- Page heartbeat (5 s) → 3 missed beats = reload. Load errors → retry with
  backoff (2 s → 5 min), immediately on network-up. More than 3 reloads in
  10 min → a diagnostics overlay (URL, error, heartbeat age) with RETRY /
  SETTINGS, still retrying every 5 min in the background.
- WebView renderer process death (OOM on 2 GB boxes, WebView package
  updates mid-run) → the WebView is rebuilt in place.
- App crash → automatic relaunch in ~2 s (once; crash loops stop and wait).
- Another renderer takes the room → the page shows "OK to reclaim" instead
  of going silently dark.

## Per-device notes

**XGIMI (MT9629-era, Android TV 10/11, Mali-G52, 2 GB):** update Android
System WebView via the Play Store first — factory images ship stale ones,
the #1 source of WebGL weirdness. Expect the 720 tier for heavy scenes. USB
sideload; adb often disabled. Disable the no-signal shutdown. The 2025
models (Horizon 20 series, Aura 2 "New") have A73 CPUs + 4 GB and are much
more comfortable.

**Raspberry Pi 5 + KonstaKANG LineageOS ATV:** GPU is stronger than the
budget TV class (V3D hardware acceleration works), but the WebView is the
AOSP build **frozen per ROM release** — it only updates when you flash a
newer build (provider switching is broken in LineageOS; don't plan on
Google WebView via MindTheGapps). adb over network works out of the box.
Note KonstaKANG builds are licensed non-commercial.

## Updating

`adb install -r` the new APK (or USB stick on XGIMI) — same signing key, so
localStorage (pairing) survives. The app is a thin shell: most changes ship
server-side with the web app, no APK update needed.

## Building / releasing

```bash
cd android && ./gradlew assembleDebug          # local build (SDK required)
git tag tv-v1.0.0 && git push origin tv-v1.0.0 # CI: signed APK on the release
```

CI signing needs the `TV_KEYSTORE_*` secrets (see
`.github/workflows/android-tv.yml`). Generate the keystore once, keep it
backed up offline — losing it breaks update continuity on every TV.
