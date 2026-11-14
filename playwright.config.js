// @ts-check
import { defineConfig, devices } from '@playwright/test'

// E2E_BASE_URL=http://localhost:8080 runs the tests against an app that is already up (for instance the Docker
// stack: `make docker-e2e`) instead of starting the dev server and the relay
const externalApp = process.env.E2E_BASE_URL

// E2E_BROWSERS=firefox,webkit (or "all") adds those browsers to the default Chromium, to find what only breaks
// there: `make e2e-browsers`. They are not run by default: it takes three times as long.
const wanted = (process.env.E2E_BROWSERS ?? '').split(',').map((b) => b.trim())
const withBrowser = (name) => wanted.includes('all') || wanted.includes(name)

// Tests with a call. WebKit on Linux (WebKitGTK, what runs on GitHub) cannot play the video of a call in a container:
// the picture stalls and the page sometimes crashes. WebKit on macOS runs them all.
const NEED_VIDEO_PLAYBACK = [
  '**/video-call.test.js',
  '**/video-quality.test.js',
  '**/screen-share.test.js',
  '**/ice-restart.test.js',
  '**/call-reconnect.test.js',
  '**/wake-lock.test.js',
  '**/no-devices.test.js',
]
// Pictures to compare with are only kept for Chromium on macOS
const VISUAL = ['**/visual.test.js']

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
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
    ...(withBrowser('firefox')
      ? [
          {
            name: 'firefox',
            testIgnore: VISUAL,
            use: {
              ...devices['Desktop Firefox'],
              launchOptions: {
                // A fake camera and microphone, with no permission prompt
                firefoxUserPrefs: {
                  'media.navigator.streams.fake': true,
                  'media.navigator.permission.disabled': true,
                  // Two browsers on one machine: use real addresses (not mDNS names) and the loopback interface
                  'media.peerconnection.ice.obfuscate_host_addresses': false,
                  'media.peerconnection.ice.loopback': true,
                },
              },
            },
          },
        ]
      : []),
    ...(withBrowser('webkit')
      ? [
          {
            name: 'webkit',
            testIgnore: [...VISUAL, ...(process.platform === 'linux' ? NEED_VIDEO_PLAYBACK : [])],
            // WebKit serves a mock camera and microphone once the permission is granted
            use: { ...devices['Desktop Safari'], permissions: ['camera', 'microphone'] },
          },
        ]
      : []),
  ],
  use: {
    baseURL: externalApp || 'http://localhost:5173',
    ignoreHTTPSErrors: true,
  },
  // Start the dev server (plain HTTP) and the relay before tests run
  webServer: externalApp ? undefined : [
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
