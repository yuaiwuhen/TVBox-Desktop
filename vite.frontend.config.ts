// Frontend-only Vite config for dev mode.
// The main vite.config.ts includes vite-plugin-electron which rebuilds
// electron/main.ts on every dev start — this was hanging on "transforming...".
// This config skips the electron plugin entirely; Electron is started
// separately via scripts/launch-dev.mjs using the pre-built main.js.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// pnpm uses junctions on Windows. If a junction target becomes stale
// (e.g. after a failed pnpm add), Node.js cannot replace it. Resolve
// vue-router directly from the pnpm store as a workaround.
function resolvePnpmPackage(name: string): string | undefined {
  const pnpmDir = resolve(__dirname, 'node_modules/.pnpm');
  if (!existsSync(pnpmDir)) return undefined;
  for (const entry of readdirSync(pnpmDir)) {
    if (entry.startsWith(`${name}@`)) {
      const pkgPath = resolve(pnpmDir, entry, 'node_modules', name);
      if (existsSync(resolve(pkgPath, 'package.json'))) return pkgPath;
    }
  }
  return undefined;
}

const vueRouterPath = resolvePnpmPackage('vue-router');

export default defineConfig({
  server: {
    headers: {},
  },
  plugins: [
    vue(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      ...(vueRouterPath ? { 'vue-router': vueRouterPath } : {}),
    },
  },
});
