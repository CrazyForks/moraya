import { test, expect, type Page } from '@playwright/test'

/**
 * Real-WebKit regression guard for Typora-style in-place math editing.
 *
 * Reproduces the exact flow that repeatedly "looked done" in unit tests but
 * failed in the WKWebView: click a rendered formula → its LaTeX source must
 * open IN PLACE and hold focus (the focus race closed it in the same frame).
 */

async function bootEditor(page: Page) {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.waitForTimeout(1000)
  // Insert a math block by pasting markdown source (also exercises the paste plugin).
  await page.click('.ProseMirror')
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', '$$\nR_m = x_0 + y\n$$')
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForSelector('.math-block-nodeview', { timeout: 5000 })
}

test('click formula → source opens in place and holds focus', async ({ page }) => {
  await bootEditor(page)

  await page.click('.math-block-nodeview .math-preview')

  // Source row visible, populated, and the textarea actually has focus
  // (the focus-race bug closed it immediately — this is the core assertion).
  const row = page.locator('.math-src-row')
  await expect(row).toBeVisible()
  const ta = page.locator('textarea.math-src-input')
  await expect(ta).toBeVisible()
  await expect(ta).toBeFocused()
  await expect(ta).toHaveValue('R_m = x_0 + y')

  // It must STAY open across a short delay (not close in a later frame).
  await page.waitForTimeout(400)
  await expect(row).toBeVisible()
  await expect(ta).toBeFocused()
})

test('open source shows a syntax-highlighted backdrop with colored tokens', async ({ page }) => {
  await bootEditor(page)
  await page.click('.math-block-nodeview .math-preview')
  await page.fill('textarea.math-src-input', '\\frac{a}{b}^2')

  const backdrop = page.locator('.math-src-highlight')
  await expect(backdrop.locator('.tok-cmd')).toContainText('\\frac')
  await expect(backdrop.locator('.tok-brace').first()).toHaveText('{')
  await expect(backdrop.locator('.tok-script')).toHaveText('^')

  // The command token must actually render in a non-default color.
  const cmdColor = await backdrop.locator('.tok-cmd').evaluate(
    (el) => getComputedStyle(el).color,
  )
  const plainColor = await backdrop.evaluate((el) => getComputedStyle(el).color)
  expect(cmdColor).not.toBe(plainColor)
})

test('edit + blur commits, formula re-renders', async ({ page }) => {
  await bootEditor(page)
  await page.click('.math-block-nodeview .math-preview')
  await page.fill('textarea.math-src-input', 'z^3 + \\alpha')
  await page.evaluate(() => (document.querySelector('textarea.math-src-input') as HTMLTextAreaElement).blur())

  // Source row hidden again; rendered preview reflects the new formula.
  await expect(page.locator('.math-src-row')).toBeHidden()
  await expect(page.locator('.math-preview')).toContainText('α')
})

test('Escape reverts without committing', async ({ page }) => {
  await bootEditor(page)
  await page.click('.math-block-nodeview .math-preview')
  await page.fill('textarea.math-src-input', 'WILL_BE_DISCARDED')
  await page.locator('textarea.math-src-input').press('Escape')

  await expect(page.locator('.math-src-row')).toBeHidden()
  // Re-open: original value is intact.
  await page.click('.math-block-nodeview .math-preview')
  await expect(page.locator('textarea.math-src-input')).toHaveValue('R_m = x_0 + y')
})
