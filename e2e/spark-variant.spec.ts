import { expect, test } from '@playwright/test';

/**
 * Spark variant E2E tests — verifies Spark theme, Cn* panels,
 * login/register pages, and basic panel interactions.
 */

test.describe('Spark variant', () => {
  test.beforeEach(async ({ page }) => {
    // Bypass auth gate for main page tests
    await page.addInitScript(() => {
      localStorage.setItem('wm_token', 'test-token');
      localStorage.setItem('wm_user', JSON.stringify({
        email: 'test@example.com',
        role: 'user',
        status: 'approved',
      }));
    });
  });

  test('loads with [data-variant="spark"] on html element', async ({ page }) => {
    await page.goto('/');
    const variant = await page.evaluate(() => document.documentElement.dataset.variant);
    expect(variant).toBe('spark');
  });

  test('applies Spark theme CSS variables', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);

    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    );
    // Spark theme uses amber gold accent
    expect(accent).toBeTruthy();
  });

  test('CnPolicyPanel mounts and shows tabs', async ({ page }) => {
    await page.goto('/');
    // Wait for panels to mount
    await page.waitForTimeout(2000);

    // Check for policy panel tabs
    const tabs = page.locator('.cn-policy-tab');
    const count = await tabs.count();
    // Should have at least the main tabs (overview, opprisk, live, industry)
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('CnPolicyPanel tab switching works', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Click "政策雷达" tab
    const liveTab = page.locator('.cn-policy-tab', { hasText: '政策雷达' });
    if (await liveTab.count() > 0) {
      await liveTab.click();
      await page.waitForTimeout(300);
      // The tab should be active
      await expect(liveTab).toHaveClass(/active/);
    }
  });
});

test.describe('Spark login page', () => {
  test('renders login form', async ({ page }) => {
    await page.goto('/login.html');
    await page.waitForTimeout(500);

    // Should have email and password inputs
    const email = page.locator('#email');
    const password = page.locator('#password');
    const submitBtn = page.locator('#submitBtn');

    await expect(email).toBeVisible();
    await expect(password).toBeVisible();
    await expect(submitBtn).toBeVisible();
  });
});

test.describe('Spark register page', () => {
  test('renders registration form with industry chips', async ({ page }) => {
    await page.goto('/register.html');
    await page.waitForTimeout(500);

    // Should have industry chip container
    const chips = page.locator('#industryChips .chip');
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);

    // Should have form fields
    const email = page.locator('input[name="email"]');
    await expect(email).toBeVisible();
  });
});
