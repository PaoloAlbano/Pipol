import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    css: false,
    clearMocks: true,
    // Exclude the auth sub-package — it has its own vitest config and its own
    // dependencies (e.g. jose) that are not installed at the workspace root.
    exclude: ['auth/**', 'node_modules/**'],
    include: ['tests/**/*.{test,spec}.{js,jsx}'],
    coverage: {
      provider: 'v8',
      exclude: ['src/styles/**', 'src/main.jsx', 'src/stubs/**'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
    },
  },
  define: {
    __ALLOW_IDENTITY_RESET__: false,
  },
})
