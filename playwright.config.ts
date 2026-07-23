import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/multi-config-e2e.spec.ts',
  timeout: 60 * 60 * 1000, // 60分钟总超时
  expect: {
    timeout: 30000, // 期望超时30秒
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { output: 'test-results/report' }],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
