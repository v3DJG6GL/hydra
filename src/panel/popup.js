// Pop-out window host. Same-origin window.open shares the JS context, so the
// panel renders straight into the child document — no message passing at all.
// A tiny bootstrap script in the child polls window.opener so that after the
// main tab reloads (new realm, dead handlers) the fresh page re-adopts the
// still-open popup within ~500ms. window.__vjGen identifies the current realm.

const BOOTSTRAP = `
setInterval(function () {
  try {
    var op = window.opener
    if (!op || op.closed) { document.body.classList.add('vj-orphan'); return }
    if (op.__vjAdopt && op.__vjGen && window.__vjAdoptedGen !== op.__vjGen) {
      op.__vjAdopt(window)
    }
    if (window.__vjAdoptedGen === op.__vjGen) document.body.classList.remove('vj-orphan')
  } catch (e) {}
}, 500)
`

// stylesheets the panel needs inside a child document (popup / pip window)
export const STYLE_MATCH = /panel\.css|fontawesome\.css|fonts\.css/

export function openPopup() {
    // must be called from a user gesture (popup blockers).
    // '_blank', not a fixed name: browsers REUSE a named browsing context, so
    // a stale deck tab from an earlier click would be silently re-targeted
    // instead of a new tab appearing. The controller tracks the open tab and
    // focuses it on repeat clicks, so _blank does not accumulate tabs.
    // No window features: a plain new tab (draggable to a second screen).
    // 'about:blank' MUST be explicit: Firefox resolves '' against the page's
    // base URL and navigates the popup to the app itself, and that pending
    // navigation clobbers a synchronously written document and its styles.
    const win = window.open('about:blank', '_blank')
    if (!win) return null
    if (win === window) {
        // a browser configured to open popups in the current tab would let
        // document.write destroy the running app — refuse instead
        return null
    }
    try { win.focus() } catch (e) { /* best effort */ }
    const doc = win.document
    if (!doc.getElementById('vj-popup-root')) {
        // everything — styles included — goes into one document.write so the
        // initial parse owns it; link.href is already resolved to absolute
        const styleLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
            .filter((link) => STYLE_MATCH.test(link.href))
            .map((link) => `<link rel="stylesheet" href="${link.href}">`)
            .join('')
        doc.open()
        doc.write('<!doctype html><html><head><meta charset="utf-8"><title>hydra · vj deck</title>' +
            styleLinks + '</head>' +
            '<body class="vj-popup-body"><div id="vj-popup-root" class="vj-panel vj-popup"></div>' +
            '<div class="vj-orphan-note">waiting for the hydra tab…</div>' +
            '<script>' + BOOTSTRAP + '<' + '/script></body></html>')
        doc.close()
    }
    return win
}
