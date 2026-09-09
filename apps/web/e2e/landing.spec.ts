import { expect, test } from '@playwright/test';

test.describe('landing page', () => {
  test('renders the hero and the primary landmarks', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Space/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeAttached();
    await expect(page.getByRole('contentinfo')).toBeAttached();
  });

  test('every section referenced by the navigation exists', async ({ page }) => {
    await page.goto('/');

    for (const id of ['overview', 'engine', 'roadmap']) {
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
  });

  test('sends the security headers configured for every response', async ({ page }) => {
    const response = await page.goto('/');

    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
  });

  test('returns a 404 page for an unknown route', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist');

    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('does not exist');
  });
});
