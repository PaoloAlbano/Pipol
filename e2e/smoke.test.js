// @ts-check
/**
 * Smoke tests — verify the app loads and login works.
 * These run with a single browser context and don't need P2P.
 */
import { test, expect } from '@playwright/test'
import { loginAsGuest } from './helpers.js'

test.describe('App smoke', () => {
  test('loads the login screen', async ({ page }) => {
    await page.goto('/')
    // LoginScreen should be visible (no identity in fresh localStorage)
    await expect(page.locator('.login-screen')).toBeVisible({ timeout: 10000 })
  })

  test('guest login shows home screen', async ({ page }) => {
    await page.goto('/')
    await loginAsGuest(page, 'alice-smoke')
    // After login the home screen or workspace view renders
    await expect(page.locator('.login-screen')).toHaveCount(0)
  })

  test('quick room URL skips home and opens room', async ({ page }) => {
    await page.goto('/?room=smoke-room-test')
    await loginAsGuest(page, 'alice-room')
    // Chat input (contenteditable div) appears = Room component mounted
    await expect(page.locator('[data-placeholder]')).toBeVisible({ timeout: 10000 })
  })

  test('can type and submit a message (local echo)', async ({ page }) => {
    await page.goto('/?room=smoke-msg-test')
    await loginAsGuest(page, 'alice-msg')
    const input = page.locator('[data-placeholder]')
    await input.click()
    await input.fill('hello world')
    await page.keyboard.press('Enter')
    // Own message should appear immediately (no P2P needed for self-echo)
    await expect(page.getByText('hello world', { exact: false })).toBeVisible({ timeout: 8000 })
  })
})
