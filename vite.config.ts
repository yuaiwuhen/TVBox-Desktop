import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import tailwindcss from '@tailwindcss/vite';

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
    electron([
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
      {
        entry: 'electron/preload.ts',
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
              },
            },
          },
        },
      },
    ]),
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
