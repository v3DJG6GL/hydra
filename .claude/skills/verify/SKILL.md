---
name: verify
description: Build, launch, and drive the hydra web editor to verify changes at the browser surface
---

# Verifying hydra (web editor)

## Build & launch
- `npm install` (no lockfile surprises; ~1 min)
- `npm run dev` → vite serves on http://localhost:5173 (run in background; readiness check: `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` → 200. The vite banner may not appear in piped output, poll the port instead).

## Drive (headless browser)
- No Playwright in the repo. Install `playwright-core` in the scratchpad and use the cached browser: `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` as `executablePath`.
- Launch args: `['--no-sandbox', '--use-angle=swiftshader']` — WebGL works headless with swiftshader (hydra needs it).
- Wait for `.CodeMirror`, then close the info modal via `#close-icon` before interacting.

## Useful handles
- `window.cm` is the live CodeMirror 5 instance (`getValue()`/`setValue()`), set in `src/views/editor/editor.js`.
- The ACTIVE editor is the CM5 one (`src/views/editor/`); `src/views/cm6-editor/` exists but is commented out in `src/views/main.js`.
- Toolbar icon ids: `#run-icon`, `#clear-icon`, `#shuffle-icon` (random sketch), `#mutator-icon` (random change), `#close-icon`.
- Keyboard shortcuts only fire with editor focus (`page.click('.CodeMirror')` first). They live in `src/views/editor/keymaps.js`; events flow editor → nanobus `*` → choo emitter → stores.
- Example sketches are bundled (`src/stores/examples.json`, base64+URI-encoded `code` field) — shuffle works offline. External fetches (gallery server, fonts) fail offline with ERR_NAME_NOT_RESOLVED; harmless noise.

## VJ panel (control deck)
- Toggle: `#panel-icon` toolbar click or `Ctrl+Shift+Y`; dock root is `#vj-dock` (hidden = `.vj-hidden` class). Pop-out: first `.vj-railbtn` in the toprail (catch with `context.waitForEvent('page')`; popup root `#vj-popup-root`).
- Faders are `.vj-fader` (pointer-drag, relative). Careful with selectors: a combine/modulate chip CONTAINS its nested subchain's faders — use `:scope > .vj-chip-params > .vj-param > .vj-fader` for the chip's own params.
- During a fader drag the buffer stays unchanged and `window.__vj` holds the live value (shadow-eval binding); the literal is spliced into `window.cm` on release with `history.replaceState` (history.length stays flat).
- Panel edits use CM origin `'+vjpanel'`; the panel rebuilds from CM `'changes'` (debounced 250ms) for any other origin.
- `window.vjPanel` is the controller (after first toggle). Scenes: `.vj-scene` slots, localStorage `hydra-vj-scenes`, keys 1-8/shift+1-8 with deck focus; right-click a slot opens a MENU (clear / midi pad learn), it does not clear directly. Bank export/import buttons: `.vj-scenetool` (1st = download `hydra-scenes.json`, 2nd = file input — catch with `page.waitForEvent('download'/'filechooser')`). MIDI: drive synthetically via `vjPanel.midi.onMessage([0xb0, cc, val])` after seeding `vjPanel.midi.mappings.params[path]` (paths like `s0.t0(rotate).a0` from `model.pathIndex`); note-on `[0x90, note, vel]` triggers scene pads via `mappings.scenes['n<note>c<ch>']`; commits to code after ~600ms idle. Audio/array/mouse widgets: `.vj-audio`, `.vj-seq-cell` (vertical drag), `.vj-seq-ease` (select), `.vj-mouse`. Bypassed steps render as `.vj-chip.vj-bypassed` (`.vj-byp-on` re-enables); source rows as `.vj-source-row`.
- Fader gestures are eval-free once a param is bound: first drag = 1 shadow eval, commits are quiet text splices, later drags on the same param = 0 evals (LiveBind persistent bindings). To count evals, wrap `window.eval` but count ONLY strings starting `'(async() => {'` — playwright's own utility scripts also route through `window.eval`.
- Runtime errors within ~500ms of a panel edit auto-revert it (`armRuntimeRevert` in `src/panel/patcher.js`) — e.g. `vjPanel.apply({from:0,to:3,text:'nosuchsrc'})` snaps back and the console line shows the error.
- Document PiP works in headless Chromium (`documentPictureInPicture` is available): the pip rail button is `.vj-railbtn:has(.fa-window-restore)`, deck root `#vj-pip-root` (`vjPanel.pipWin/pipRoot`).
- Fader fill is asymptotic: `|v| / (|v| + ref)` where ref is the function's DEFAULT (not the current value) — default sits at 50%, larger values keep filling toward 100%. Read it via `.vj-fader-fill` style.width.
- Every `.vj-value` readout is click-to-type: a single click swaps in a `.vj-value-input` (Enter commits, Escape cancels, blur commits only if edited; comma decimals accepted). Readouts display via fmtShort (≥1000 → integer, ≥100 → 1 decimal) while the code keeps fmtNumber's 3-decimal precision — don't assert readout text equals the literal for large values.
- Audio/mouse bindings render as a boxed group `.vj-bind` (also keeps `.vj-audio` / `.vj-mouse` classes): head `.vj-bind-row` with the source select + `.vj-audio-unbind`, then labeled scale/offset `.vj-bind-row`s (`.vj-bind-label` texts 'scale'/'offset'). The param row gets `.vj-bindparam`.
- There is NO speed fader in the toprail. Speed lives in the deck body: a real `.vj-setup-row` when the sketch has a `speed = N` line, else a ghost row (`.vj-ghostrow`) whose first commit inserts the line at the top (quiet splice, 0 evals, replace-URL). `a.setSmooth/setScale/setBins/setCutoff(n)` statements render as `.vj-audioset-row` fader rows; right-click the FFT button (`.vj-fft:not(.vj-codebtn)`) for a menu that inserts them. The CODE rail button (`.vj-codebtn`) emits 'ui: toggle code' → `state.showCode` hides editor+console+`#modal-header` but not the deck.
- Scene auto-cycle: play/stop is `.vj-scenetool.vj-cycle` (right-click → `.vj-rangeform input` sets the pace, persisted in localStorage `hydra-vj-cycle-secs`); cycling recalls with replace-mode URL saves (history stays flat) and the on-screen slot gets `.vj-scene.vj-active`.
- For `s0.initCam` flows add `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` to the launch args.
- Don't blind-click `#close-icon`: if the info window is already closed (e.g. after reload with `?code=` in URL) it REOPENS it and hides the toolbar icons. Check `#info-container` for the `hidden` class first.

## Gotchas
- Scene thumbnails: the FIRST getScreenImage capture can take ~2s under swiftshader (later ones ~0.7s). Poll `JSON.parse(localStorage.getItem('hydra-vj-scenes'))[n].thumb` with waitForFunction instead of a fixed sleep, or the check flakes under load. Also: saveScene re-renders the whole deck when the thumb lands — element handles (and open popovers) grabbed before that are detached after.
- The Mutator (`editor: randomize`) is stochastic — verify by diffing `window.cm.getValue()` before/after, and repeat a few times if chasing an anomaly.
- A random example loads on page open; content assertions should not assume a fixed initial sketch.
