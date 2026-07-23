import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30 * 60 * 1000, // 30 分钟超时
    hookTimeout: 60000,
  },
});
