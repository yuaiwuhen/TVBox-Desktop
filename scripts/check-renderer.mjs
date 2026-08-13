#!/usr/bin/env node
/**
 * Launch Playwright browser, navigate to our Vite URL, capture console errors.
 * This helps diagnose renderer-side issues without needing CDP access.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:5174/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const logs = [];
  page.on('console', (msg) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    logs.push(`[PAGE_ERROR] ${err.message}\n${err.stack || ''}`);
  });
  page.on('requestfailed', (req) => {
    logs.push(`[REQ_FAIL] ${req.url()} - ${req.failure()?.errorText}`);
  });

  console.log(`Navigating to ${URL}...`);
  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log(`Navigation error: ${e.message}`);
  }

  // Wait a bit for any async errors
  await page.waitForTimeout(5000);

  console.log('\n=== Captured Logs ===');
  for (const log of logs) {
    console.log(log);
  }

  // Try to get the page title and any error messages
  const title = await page.title();
  console.log(`\nPage title: ${title}`);

  // Check if there's an error overlay
  const errorOverlay = await page.evaluate(() => {
    const overlay = document.querySelector('vite-error-overlay');
    return overlay ? overlay.shadowRoot?.querySelector('pre')?.textContent : null;
  });
  if (errorOverlay) {
    console.log(`\n=== Vite Error Overlay ===`);
    console.log(errorOverlay);
  }

  // Get the visible text content
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log(`\n=== Body Text ===`);
  console.log(bodyText.substring(0, 1000));

  await browser.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
