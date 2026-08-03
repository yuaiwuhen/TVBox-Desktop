import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import tailwindcss from '@tailwindcss/vite';

// When VITE_RENDERER_ONLY=1, skip the electron plugin to avoid the rollup
// build hanging on "transforming..." for large electron main bundles.
// The electron main is built separately by the dev launcher (esbuild).
const rendererOnly = process.env.VITE_RENDERER_ONLY === '1';

export default defineConfig({
  // hevc.js不需要SharedArrayBuffer和COOP/COEP headers（单线程解码）
  server: {
    headers: {
      // 移除COOP/COEP headers，hevc.js不需要这些配置
    },
  },
  plugins: [
    vue(),
    tailwindcss(),
    ...(rendererOnly ? [] : [electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: [
                'vm',
                'http',
                'https',
                'url',
                'fs',
                'path',
                'os',
                'child_process',
                'crypto',
                'module',
                'net',
                'dns',
                'stream',
                'zlib',
              ],
            },
          },
        },
      },
      // Preload is NOT built by Vite — it's a static CJS file (electron/preload.cjs)
      // copied to dist-electron/preload.cjs by run-dev.mjs / build scripts.
      // Vite's rollup was outputting ESM syntax (import/export) in a .cjs file,
      // which Electron's CJS loader cannot parse, breaking ipcRenderer exposure.
    ])]),
  ],
  build: {
    rollupOptions: {
      external: [
        'vm',
        'http',
        'https',
        'url',
        'fs',
        'path',
        'os',
        'child_process',
        'crypto',
        'module',
        'net',
        'dns',
        'stream',
        'zlib',
      ],
    },
  },
  resolve: {
    alias: {
      // Ensure Node.js modules resolve correctly in Electron
    },
  },
  // Removed optimizeDeps.exclude for @hevcjs/core
  // Vite needs to pre-build this package to resolve exports correctly
});
