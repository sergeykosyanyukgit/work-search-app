import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve('src/main/index.ts') } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: resolve('src/preload/index.ts'), capture: resolve('src/preload/capture.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: {
    root: 'src', plugins: [react(), {
      name: 'development-csp',
      transformIndexHtml: { order: 'pre', handler(html, context) {
        return context.server ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*") : html
      } }
    }],
    build: { minify: 'esbuild', rollupOptions: { input: { overlay: resolve('src/renderer/index.html'), capture: resolve('src/capture/index.html') } } }
  }
})
