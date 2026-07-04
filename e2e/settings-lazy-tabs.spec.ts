import { test, expect } from '@playwright/test'

/**
 * Regression guard for the settings-open delay fix: heavy tab components now
 * mount lazily on first visit (not all-at-once on every open). Verifies the
 * panel still opens, the initial tab renders, and a heavy tab (MCP) mounts
 * only after it's visited.
 */
test('settings opens; MCP tab mounts lazily on visit', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.waitForTimeout(800)

  // Open settings via the Cmd/Ctrl+, shortcut.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${mod}+Comma`)

  const panel = page.locator('.settings-panel')
  await expect(panel).toBeVisible()

  // MCP tab NOT yet visited → its NodeView/content not mounted.
  const mcpPane = page.locator('.tab-pane').filter({ has: page.locator('.mcp-panel') })
  await expect(page.locator('.mcp-panel')).toHaveCount(0)

  // Visit the MCP tab → its component mounts.
  await panel.locator('button.nav-item', { hasText: 'MCP' }).click()
  await expect(page.locator('.mcp-panel')).toHaveCount(1)
  await expect(mcpPane.first()).toHaveClass(/active/)
})
