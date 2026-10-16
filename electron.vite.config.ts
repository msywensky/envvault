import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

// One CSP, injected as a <meta> tag. Production is strict. The dev server
// additionally needs inline <style> tags (Vite injects CSS that way) and the
// HMR websocket. Never send a second CSP as a header: browsers enforce the
// intersection of all policies, so the dev relaxation would be lost.
function cspPlugin(): Plugin {
  let serve = false
  return {
    name: 'envvault-csp',
    configResolved(config) {
      serve = config.command === 'serve'
    },
    transformIndexHtml() {
      const directives = [
        "default-src 'self'",
        "script-src 'self'",
        serve ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
        "img-src 'self' data:",
        serve ? "connect-src 'self' ws://localhost:*" : "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
      ]
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: directives.join('; ') },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [cspPlugin(), vue()]
  }
})
