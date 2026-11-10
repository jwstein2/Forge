import { test } from '@playwright/test';
import { ROUTES } from './routes';

// Evidence screenshots for review. Output: test-results/screens/
const SHOTS = [
  { vp: { width: 1440, height: 900 }, tag: 'desktop' },
  { vp: { width: 390, height: 844 }, tag: 'phone' },
];

for (const s of SHOTS) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${s.tag} ${scheme}`, () => {
      test.use({ viewport: s.vp, colorScheme: scheme, deviceScaleFactor: 2 });
      for (const r of ROUTES) {
        if (scheme === 'dark' && s.tag === 'phone' && r.name !== 'portfolio') continue;
        test(r.name, async ({ page }) => {
          await page.goto(r.path);
          await page.locator('h1').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({ path: `test-results/screens/${s.tag}-${scheme}-${r.name}.png`, fullPage: true });
        });
      }
    });
  }
}
