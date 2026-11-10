import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ROUTES } from './routes';

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    for (const r of ROUTES) {
      test(`${r.name} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await page.goto(r.path);
        await page.locator('h1').first().waitFor();
        const results = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'] }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`);
        expect(summary, summary.join('\n')).toEqual([]);
      });
    }
  });
}

test.describe('axe at 320px reflow width', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  for (const r of ROUTES) {
    test(`${r.name} has no violations at 320px`, async ({ page }) => {
      await page.goto(r.path);
      await page.locator('h1').first().waitFor();
      const results = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'] })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`);
      expect(summary, summary.join('\n')).toEqual([]);
    });
  }
});

test('keyboard: skip link moves focus to main content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('keyboard: chart exposes values with arrow keys', async ({ page }) => {
  await page.goto('/');
  const chart = page.getByRole('img', { name: 'Verified revenue' });
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.chart__tip')).toContainText('$0');
});

test('mobile navigation opens, traps nothing, and closes on route change', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
});
