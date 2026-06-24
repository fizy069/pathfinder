// Replayable Playwright tutorial — source of truth for this tutorial.
// Tutorial: How to search GitHub for a repository and open its issue label filter
// PDF output: github-filter-issues.pdf
// Run with: npx playwright test github-filter-issues.spec.ts

import { test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 } });

test('How to search GitHub for a repository and open its issue label filter', async ({ page }) => {
  // Open the starting page.
  await page.goto('https://github.com');

  // Step 1: Open the global search [verified]
  await page.getByRole('button', { name: 'Search or jump to…' }).first().click();

  // Step 2: Type the repository name [verified]
  await page.getByRole('combobox', { name: 'Search' }).first().fill('microsoft/playwright');

  // Step 3: Submit the search [verified]
  await page.getByRole('combobox', { name: 'Search' }).first().press('Enter');

  // Step 4: Open the repository from the results [verified]
  await page.getByRole('link', { name: 'microsoft/playwright' }).first().click();

  // Step 5: Go to the Issues tab [verified]
  await page.getByRole('link', { name: 'Issues' }).first().click();

  // Step 6: Open the label filter [verified]
  await page.getByTestId('labels-anchor-button').first().click();
});
