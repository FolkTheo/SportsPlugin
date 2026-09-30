// Renders icons/icon*.png from scripts/icon.svg using Playwright's Chromium.
// Usage: node scripts/build-icons.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(`${process.env.NODE_PATH || '/opt/node22/lib/node_modules'}/playwright`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = await readFile(`${root}scripts/icon.svg`, 'utf8');
const browser = await playwright.chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: `${root}icons/icon${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
