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
    vue({
      template: {
        compilerOptions: {
          // movi-player 是 WebComponent 自定义元素，不需要 Vue 解析为组件
          isCustomElement: (tag: string) => tag === 'movi-player',
        },
      },
    }),
    tailwindcss(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            // vite-plugin-electron 默认按 package.json 的 "type":"module" 把
            // build.lib.formats 设成 ["es"]，而 lib 配置的优先级高于
            // rollupOptions.output，所以必须在这里显式改成 CJS。
            //
            // 主进程若以 ESM 运行，Node 的 ESM loader 会把
            // `import ... from 'electron'` 解析到 npm 包 node_modules/electron
            // （它导出的是一个可执行文件路径字符串），而非 Electron 内置模块，
            // 随后触发：
            //   TypeError: Cannot read properties of undefined (reading 'exports')
            //   at cjsPreparseModuleExports (node:internal/modules/esm/translators)
            // 走 CJS 时 require('electron') 才由 Electron 自身的 hook 接管。
            lib: {
              formats: ['cjs'],
              fileName: () => 'main.cjs',
            },
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
            // 同主进程：强制 CJS，输出 .cjs，避免被 root package.json 的
            // "type":"module" 影响而被 Electron 的 CJS 加载器拒绝。
            lib: {
              formats: ['cjs'],
              fileName: () => 'preload.cjs',
            },
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
