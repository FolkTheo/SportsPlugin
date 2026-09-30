// Renders icons/icon*.png (extension) and the Mac app icon set from
// scripts/icon.svg using Playwright's Chromium.
// Usage: node scripts/build-icons.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

// Mac app icon set (mac/CourtsideApp/Assets.xcassets/AppIcon.appiconset).
const macDir = `${root}mac/CourtsideApp/Assets.xcassets/AppIcon.appiconset`;
await mkdir(macDir, { recursive: true });
await writeFile(`${root}mac/CourtsideApp/Assets.xcassets/Contents.json`, JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2));
const images = [];
for (const pt of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = pt * scale;
    const filename = `icon_${pt}x${pt}${scale === 2 ? '@2x' : ''}.png`;
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${px}px;height:${px}px;display:block}</style>${svg}`);
    await page.screenshot({ path: `${macDir}/${filename}`, omitBackground: true });
    images.push({ size: `${pt}x${pt}`, idiom: 'mac', filename, scale: `${scale}x` });
  }
}
await writeFile(`${macDir}/Contents.json`, JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2));

await browser.close();
console.log('icons written');
