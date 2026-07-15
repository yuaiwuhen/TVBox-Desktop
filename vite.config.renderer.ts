import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// Renderer-only Vite config (no electron plugin) to avoid main.ts build hang.
// Usage: npx vite --config vite.config.renderer.ts
// Then start Electron separately: npx electron .
export default defineConfig({
  server: {
    headers: {},
  },
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {},
  },
});
