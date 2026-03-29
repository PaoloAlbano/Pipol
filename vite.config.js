import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Starts a plain HTTP server that redirects all requests to HTTPS.
 * Default: HTTP on port 5174 → HTTPS on port 5173.
 */
function httpRedirectPlugin({ httpPort = 5174, httpsPort = 5173 } = {}) {
  return {
    name: 'http-redirect',
    configureServer() {
      const redirectServer = http.createServer((req, res) => {
        const host = (req.headers.host || '').replace(/:\d+$/, '')
        res.writeHead(301, { Location: `https://${host}:${httpsPort}${req.url}` })
        res.end()
      })
      redirectServer.listen(httpPort, '0.0.0.0', () => {
        console.log(`  ➜  HTTP redirect: http://0.0.0.0:${httpPort} → https://*:${httpsPort}`)
      })
      redirectServer.on('error', (err) => {
        console.warn(`[http-redirect] Could not start on port ${httpPort}: ${err.message}`)
      })
    },
  }
}

const noSsl = process.env.VITE_NO_SSL === '1'

/** Convert render-blocking <link rel="stylesheet"> tags to async preload in production builds. */
function cssPreloadPlugin() {
  return {
    name: 'css-preload',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /<link rel="stylesheet" crossorigin href="([^"]+)">/g,
        '<link rel="preload" as="style" crossorigin href="$1" onload="this.onload=null;this.rel=\'stylesheet\'">'
      )
    },
  }
}

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    cssPreloadPlugin(),
    ...(noSsl ? [] : [basicSsl()]),
    ...(noSsl ? [] : [httpRedirectPlugin({ httpPort: 5174, httpsPort: 5173 })]),
    nodePolyfills({
      // Polyfill Node.js globals and built-in modules for browser
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
  ],

  define: {
    global: 'globalThis',
    __filename: JSON.stringify(''),
    __dirname: JSON.stringify(''),
  },

  resolve: {
    alias: {
      // sodium-universal tries to load sodium-native (Node.js C++ addon).
      // Redirect to the pure-JS implementation for the browser.
      'sodium-native': 'sodium-javascript',
      // node-gyp-build is used by native addons to load .node binaries.
      // In the browser there are no native binaries — stub it out.
      'node-gyp-build': path.resolve(__dirname, 'src/stubs/node-gyp-build.js'),
    },
  },

  optimizeDeps: {
    include: [
      'hyperswarm',
      'hypercore',
      'hyperbee',
      'corestore',
      'hyperbeam',
      'hypercore-crypto',
      'protomux',
      'compact-encoding',
      'b4a',
      'random-access-memory',
    ],
    esbuildOptions: {
      target: 'esnext',
      define: { global: 'globalThis' },
    },
  },

  server: {
    host: true,
    https: noSsl ? false : true,
    allowedHosts: true,
    proxy: {
      // WebSocket signaling proxied through Vite's HTTPS cert
      // Browser connects to wss://<host>:5173/signal → relay ws://localhost:8787/signal
      '/signal': {
        target: 'ws://localhost:8787',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },

  build: {
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
})
