// Replayable Playwright tutorial — source of truth for this tutorial.
// Tutorial: How to search on Wikipedia
// PDF output: wikipedia-search.pdf
// Run with: npx playwright test wikipedia-search.spec.ts

import { test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 } });

test('How to search on Wikipedia', async ({ page }) => {
  // Open the starting page.
  await page.goto('https://www.wikipedia.org');

  // Step 1: Click the search box
  await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().click();

  // Step 2: Type your search query
  await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().fill('Playwright (software)');

  // Step 3: Submit the search
  await page.getByRole('button', { name: 'Search' }).first().click();
});
