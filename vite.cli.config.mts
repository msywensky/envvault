import { defineConfig } from 'vite'

// The envvault command (src/cli): one self-contained ESM file for plain
// Node. It runs outside Electron, so the packaged copy is unpacked from
// app.asar (electron-builder.yml).
export default defineConfig({
  build: {
    ssr: 'src/cli/index.ts',
    outDir: 'out/cli',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'envvault.mjs',
        banner: '#!/usr/bin/env node'
      }
    }
  }
})
