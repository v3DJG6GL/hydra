import { defineConfig } from 'vite'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

// dev/preview servers carry the VJ relay on /ws themselves, so the remote
// deck works against `npm run dev` with no sidecar. In production the relay
// is its own compose service and nginx proxies /ws to it.
const vjRelay = () => {
    const attach = async (server) => {
        // computed specifier on purpose: esbuild's config bundling would
        // otherwise inline relay.mjs and resolve `ws` to its BROWSER stub
        const relayUrl = pathToFileURL(path.join(process.cwd(), 'server/relay.mjs')).href
        const { attachRelay } = await import(relayUrl)
        attachRelay(server.httpServer, { dataDir: '.vj-data' })
    }
    return {
        name: 'vj-relay',
        configureServer: attach,
        configurePreviewServer: attach
    }
}

export default defineConfig({
    //define: { global: {} },
    base: '',
    define: {
        'process.env': {},
        // 'global.window': 'window'
        // global: {}
    },
    plugins: [vjRelay()],
    optimizeDeps: {
        esbuildOptions: {
            define: {
                global: 'globalThis'
            }
        }
    }
})
