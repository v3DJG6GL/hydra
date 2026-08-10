// Service worker for the remote VJ deck. Registered with scope '/deck.html'
// (the literal page, not a directory) so it never controls the renderer page
// at / — a kiosk renderer must keep talking straight to the network.
//
// Strategy: network-first for the page itself (a fresh deck.html names the
// current hashed bundle), stale-while-revalidate for everything it pulls in.
// All caching happens at runtime, so one successful load makes the installed
// deck launch instantly and survive venue-wifi dropouts. The /ws relay socket
// is a WebSocket upgrade and never hits the fetch handler.
const CACHE = 'hydra-deck-v2'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hydra-deck-') && k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    )
})

self.addEventListener('fetch', (e) => {
    const req = e.request
    if (req.method !== 'GET') return
    const url = new URL(req.url)
    if (url.origin !== location.origin) return
    if (url.pathname === '/ws' || url.pathname === '/healthz') return

    // network-first for the page AND unhashed stylesheets: deck.html names
    // the current hashed JS bundle, but /css/*.css keeps its name across
    // deploys — stale-while-revalidate would pair fresh JS with last
    // deploy's CSS for one whole load (new UI renders unstyled)
    if (req.mode === 'navigate' || req.destination === 'style' || url.pathname.startsWith('/css/')) {
        e.respondWith(
            fetch(req).then((res) => {
                if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {})
                return res
            }).catch(() =>
                caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/deck.html') : undefined))
            )
        )
        return
    }

    e.respondWith(
        caches.open(CACHE).then((c) =>
            c.match(req).then((hit) => {
                const refresh = fetch(req).then((res) => {
                    if (res.ok) c.put(req, res.clone()).catch(() => {})
                    return res
                })
                // swallow refresh failures only when the cache already answered
                if (hit) refresh.catch(() => {})
                return hit || refresh
            })
        )
    )
})
