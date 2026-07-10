import html from 'choo/html'
import toolbar from './toolbar.js'

export default ({ content, header }, state, emit) => {
  const { t, languages } = state.translation
  const textDirection = state.translation.selectedLanguage === 'ar' && state.showInfo === true ? 'rtl' : 'ltr'
  // "hide all" (ctrl+shift+h) and the deck's CODE toggle take the whole
  // overlay down — including this window, not just its header buttons
  const chromeVisible = state.showUI === true && state.showCode !== false

  return html`
<div id="info-container" class="${state.showInfo && chromeVisible ? "" : "hidden"}" style="direction:${textDirection}">
  <div id="modal">
    <div id="modal-header" class="${chromeVisible ? "" : "ui-hidden"}">
     ${header}
      ${toolbar(state, emit)}
    </div>
    <div id="modal-body">
     ${content}
    </div>
  </div>
</div>
`
}