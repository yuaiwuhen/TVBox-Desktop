import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // 启用SharedArrayBuffer支持（h265web.js多线程解码需要）
  // 使用credentialless策略，既启用SharedArrayBuffer又不阻止跨域资源加载
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless', // 不阻止跨域资源，但启用SharedArrayBuffer
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
        onstart(options) {
          options.reload();
        },
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
});
