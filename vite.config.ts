import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    electron([
      {
        entry: 'electron/main.ts',
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
      },
    ]),
  ],
  build: {
    rollupOptions: {
      external: ['vm', 'http', 'https', 'url', 'fs', 'path', 'os', 'child_process', 'crypto', 'module', 'net', 'dns', 'stream', 'zlib'],
    },
  },
  resolve: {
    alias: {
      // Ensure Node.js modules resolve correctly in Electron
    },
  },
})
