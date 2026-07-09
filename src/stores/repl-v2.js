import { restoreAudioGlobal } from '../lib/restore-audio.js'

export default {
  eval: (arg, callback = () => {}) => {
    const info = {
      isError: false,
      codeString: '',
      errorMessage: ''
    }

    // wrap everything in an async function
    var jsString = `(async() => {
    ${arg}
})().catch(${(err) => { window._reportError(err) }})`
    try {
      window.eval(jsString)
    } catch (err) {
      info.errorMessage = err.message
    }
    restoreAudioGlobal()
    info.codeString = jsString
    if (info.errorMessage.length > 0) info.isError = true
    callback(info)
  }
}
