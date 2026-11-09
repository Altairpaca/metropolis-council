#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 * Boots the built web app in headless Chrome with software WebGL, lets the
 * simulation advance a fixed number of months, then writes a PNG plus the
 * measured renderer statistics. Used to prove the 3D view actually renders
 * (no hand-made mock-ups).
 *
 * Usage: node scripts/screenshot.mjs [url] [outfile] [months]
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ['playwright', '/usr/lib/node_modules/playwright']) {
    try { return require(p); } catch { /* try next */ }
  }
  throw new Error('playwright not found; install it or set NODE_PATH');
}

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const out = process.argv[3] ?? 'results/screenshot.png';
const months = Number(process.argv[4] ?? 36);

const { chromium } = loadPlaywright();
mkdirSync(dirname(resolve(out)), { recursive: true });

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--window-size=1600,900',
  ],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

console.log('navigating to', url);
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction('window.__MC_STATE__ !== undefined', { timeout: 30000 });

// Dismiss the tutorial so the city is visible.
const skip = await page.$('#tut-skip');
if (skip) await skip.click();
const mode = process.env.SHOT_MODE ?? 'standard';
const timeOfDay = Number(process.env.SHOT_TIME ?? 0.74);
const zoom = Number(process.env.SHOT_ZOOM ?? 1);
await page.evaluate(
  ({ mode, timeOfDay, zoom }) => window.__MC_SET_VIEW__ && window.__MC_SET_VIEW__({ mode, timeOfDay, zoom }),
  { mode, timeOfDay, zoom },
);

if (months > 0) {
  console.log('advancing', months, 'months...');
  const t0 = Date.now();
  const res = await page.evaluate(m => window.__MC_STEP__(m), months);
  console.log('after', months, 'months:', JSON.stringify(res), 'wall', Date.now() - t0, 'ms');
}

await page.waitForTimeout(900);
const stats = await page.evaluate(() => window.__MC_STATS__);
const hash = await page.evaluate(() => window.__MC_HASH__);
await page.screenshot({ path: resolve(out), fullPage: false });

console.log('screenshot ->', resolve(out));
console.log('state hash :', hash);
console.log('render stats:', JSON.stringify(stats));
if (errors.length) {
  console.log('console errors (' + errors.length + '):');
  for (const e of errors.slice(0, 10)) console.log('  -', e);
} else {
  console.log('console errors: none');
}

await browser.close();
