import { test, expect } from "@playwright/test";

// Regression guard for the PR #40 bug: `--bg-elevated` defaulted to `#ffffff`
// at :root and was never overridden under [data-theme="dark"], so the compose
// modal rendered a bright white panel over the dark theme. Locked variant
// override in `_dark-mode.scss` sets `--bg-elevated: #111a2c`; this spec
// asserts the modal's background luminance is below the "obviously white"
// threshold, so a future regression of that token surfaces immediately.

test("compose modal renders dark in dark theme", async ({ page }) => {
  await page.goto("/");

  // Wait for the shell.
  await expect(page.locator("aside.sidebar")).toBeVisible({ timeout: 10_000 });

  // Force dark theme deterministically (the theme toggle persists via the
  // theme module; setting the attribute directly is enough for SCSS variants).
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });

  // Click the sidebar compose CTA to open the modal.
  await page.locator(".sidebar-post-btn").click();

  const modal = page.locator(".compose-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  const bg = await modal.evaluate(
    (el) => window.getComputedStyle(el).backgroundColor,
  );

  // Parse "rgb(r, g, b)" / "rgba(r, g, b, a)" and compute luminance avg.
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(match, `unexpected background-color: ${bg}`).not.toBeNull();
  const [r, g, b] = [
    Number(match![1]),
    Number(match![2]),
    Number(match![3]),
  ];
  const avg = (r + g + b) / 3;

  // Light theme `--bg-elevated` is #ffffff (avg 255). Dark override is
  // #111a2c (avg ~28). Bright-white regression would land near 255, so any
  // value above 80 fails — comfortably catches the bug while tolerating
  // future palette tweaks within the dark surface family.
  expect(avg).toBeLessThan(80);
});
