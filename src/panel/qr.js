// QR rendering for deck pairing. Loaded lazily by pairing screens only —
// keep it out of the main bundle path.
import qrcode from 'qrcode-generator'

export function drawQr(el, text) {
    const qr = qrcode(0, 'M') // type 0 = pick the smallest fitting version
    qr.addData(text)
    qr.make()
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true })
    const svg = el.querySelector('svg')
    if (svg) {
        svg.removeAttribute('width')
        svg.removeAttribute('height')
    }
}
