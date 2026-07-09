// Standalone entry for the VJ relay sidecar (compose service `relay`).
// In development the same relay is attached to the vite server instead —
// see the vjRelay plugin in vite.config.js.
import http from 'node:http'
import { attachRelay } from './relay.mjs'

const port = parseInt(process.env.HYDRA_RELAY_PORT || '8081', 10)

const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(relay.stats()))
        return
    }
    res.writeHead(404)
    res.end()
})

const relay = attachRelay(server)

server.listen(port, () => {
    console.log(`[vj-relay] listening on :${port} (ws path /ws, data ${process.env.HYDRA_RELAY_DATA_DIR || './vj-data'})`)
})

process.on('SIGTERM', () => { relay.close(); server.close(() => process.exit(0)) })
process.on('SIGINT', () => { relay.close(); server.close(() => process.exit(0)) })
