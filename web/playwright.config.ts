import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 300000,        // 5 min per test (Fish API + WhisperX are slow)
  retries: 0,             // 不重试，失败就是失败
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: 'http://localhost:3010',
    screenshot: 'on',
    video: 'on',
    trace: 'on',
  },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
