import { test, expect } from '@playwright/test';
import { ROUTES, VIEWPORTS } from './routes';

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    for (const r of ROUTES) {
      test(`${r.name}: no horizontal page scroll, targets usable`, async ({ page }) => {
        await page.goto(r.path);
        await page.locator('h1').first().waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(0);
        // Buttons and form controls meet the 24px minimum target size (WCAG 2.5.8).
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('button, select, [role="button"]')]
            .filter((el) => (el as HTMLElement).offsetParent !== null)
            .map((el) => el.getBoundingClientRect())
            .filter((b) => b.width < 24 || b.height < 24).length,
        );
        expect(small).toBe(0);
      });
    }
  });
}

test('every metric on the portfolio shows its period and freshness', async ({ page }) => {
  await page.goto('/');
  await page.locator('.stat').first().waitFor();
  const stats = page.locator('.stat');
  const n = await stats.count();
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < n; i++) await expect(stats.nth(i).locator('.provenance')).toBeVisible();
});
