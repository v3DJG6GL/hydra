// Sketches that assign to a bare `a` (e.g. `a = () => shape(...)` in the
// bundled eerie_ear example) clobber the hydra-synth audio object that
// makeGlobal exposed on window, so a.fft / a.setBins / a.show stop working
// for the rest of the session. The synth keeps its own reference, so re-point
// the global after every eval; the sketch's own uses of `a` run during the
// eval itself and are unaffected.
export function restoreAudioGlobal() {
  const synth = window.hydraSynth && window.hydraSynth.synth
  if (synth && synth.a && window.a !== synth.a) window.a = synth.a
}
