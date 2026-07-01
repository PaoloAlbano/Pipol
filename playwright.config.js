// @ts-check
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--no-sandbox',
          ],
        },
      },
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    ignoreHTTPSErrors: true,
  },
  // Start the dev server (plain HTTP) and the relay before tests run
  webServer: [
    {
      command: 'VITE_NO_SSL=1 pnpm vite --port 5173',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node relay/server.js',
      url: 'http://localhost:8787',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  // Run tests sequentially — P2P tests share a relay and need ordering
  workers: 1,
  retries: 1,
})
