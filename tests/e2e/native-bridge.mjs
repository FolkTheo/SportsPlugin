// Runs the shared web UI the way the Mac app does: the native shim
// (mac/CourtsideApp/Web/native-shim.js) injected first, and a stand-in for the
// Swift "courtside" message handler. This checks the bridge contract the Swift
// code relies on without needing a Mac:
//   - storage areas are JSON dictionaries (favorites land in sync.favorites)
//   - ESPN / DraftKings requests go through the bridge
//   - storage changes reach every open web view
//   - the Mac-only settings and "Float on desktop" call the right actions
//
// Usage: node tests/e2e/native-bridge.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { dkFixtureFor, fixtureFor } from '../fixtures/espn.js';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(`${process.env.NODE_PATH || '/opt/node22/lib/node_modules'}/playwright`);
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = path.join(ROOT, 'tests/e2e/screenshots');
const ORIGIN = 'https://courtside-app.test'; // stands in for courtside-app://app
const shim = await readFile(path.join(ROOT, 'mac/CourtsideApp/Web/native-shim.js'), 'utf8');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ---- the stand-in for the Swift side (NativeBridge.swift) ----
const defaults = { sync: {}, local: {}, session: {} }; // App Group UserDefaults
const calls = [];
let loginItem = true;
const pages = new Set();

async function broadcast(area, changes) {
  for (const p of pages) await p.evaluate(([a, c]) => window.__courtsideStorageChanged?.(a, c), [area, changes]).catch(() => {});
}

async function handle(msg) {
  calls.push(msg);
  switch (msg.type) {
    case 'storage-get':
      return JSON.stringify(defaults[msg.area] || {});
    case 'storage-set': {
      const items = JSON.parse(msg.items);
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: defaults[msg.area][k], newValue: v };
        defaults[msg.area][k] = v;
      }
      await broadcast(msg.area, changes);
      return true;
    }
    case 'storage-remove': {
      const changes = {};
      for (const k of msg.keys) {
        changes[k] = { oldValue: defaults[msg.area][k] };
        delete defaults[msg.area][k];
      }
      await broadcast(msg.area, changes);
      return true;
    }
    case 'fetch': {
      const body = /draftkings/.test(msg.url) ? dkFixtureFor(msg.url) : fixtureFor(msg.url);
      return { status: body ? 200 : 404, body: JSON.stringify(body || {}) };
    }
    case 'get-login-item':
      return loginItem;
    case 'set-login-item':
      loginItem = msg.enabled;
      return true;
    case 'open-floating':
    case 'open-url':
    case 'quit':
      return true;
    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

const browser = await playwright.chromium.launch({ channel: 'chromium' }); // full Chromium, same fonts as the extension run
const context = await browser.newContext();
const errors = [];

await context.route(`${ORIGIN}/**`, async (route) => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !/^(src|icons)\//.test(rel)) return route.fulfill({ status: 404 });
  try {
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: await readFile(file) });
  } catch {
    return route.fulfill({ status: 404 });
  }
});
// Any direct network request means the shim didn't route it through Swift.
const direct = [];
await context.route(/site\.api\.espn\.com|draftkings\.com/, (route) => {
  direct.push(route.request().url());
  return route.fulfill({ status: 599, body: 'should have gone through the bridge' });
});
await context.route('https://a.espncdn.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#556"/></svg>' }));

await context.exposeFunction('__nativeCall', handle);
await context.addInitScript(() => {
  window.webkit = { messageHandlers: { courtside: { postMessage: (m) => window.__nativeCall(m) } } };
});
await context.addInitScript(shim);

async function open(mode, size) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${mode}: ${m.text()}`));
  await page.setViewportSize(size);
  pages.add(page);
  await page.goto(`${ORIGIN}/src/app/app.html?mode=${mode}`);
  return page;
}

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log('ok');
};

const menubar = await open('menubar', { width: 380, height: 580 });

await step('menu bar panel loads scores through the bridge', async () => {
  await menubar.click('.tab[data-league="nfl"]');
  await menubar.waitForSelector('.game.state-in .odds-line');
  assert.equal(await menubar.locator('.game').count(), 3);
  assert.ok(calls.some((c) => c.type === 'fetch' && /football\/nfl\/scoreboard/.test(c.url)));
  assert.ok(calls.some((c) => c.type === 'fetch' && /draftkings/.test(c.url)));
  assert.deepEqual(direct, []);
  assert.equal(JSON.parse(JSON.stringify(defaults.local.ui)).league, 'nfl');
  await menubar.screenshot({ path: `${SHOTS}/mac-menubar.png` });
});

await step('Mac mode: no page overlay, pop-out means float on desktop', async () => {
  assert.equal(await menubar.locator('[data-action="overlay"]').isHidden(), true);
  assert.equal(await menubar.locator('[data-action="popout"]').getAttribute('title'), 'Float on desktop (stays on top of other windows)');
  await menubar.click('.topbar [data-action="popout"]');
  await menubar.waitForFunction(() => true);
  assert.ok(calls.some((c) => c.type === 'open-floating'));
});

await step('settings show the Mac section and drive the login item', async () => {
  await menubar.click('.topbar [data-action="settings"]');
  await menubar.waitForSelector('[data-native-login]');
  await menubar.waitForFunction(() => document.querySelector('[data-native-login]').checked === true);
  assert.equal(await menubar.locator('text=Change shortcuts').count(), 0);
  assert.match(await menubar.locator('.settings').innerText(), /Also shows live favorite games on the menu bar/);
  await menubar.uncheck('[data-native-login]');
  await menubar.waitForFunction(() => true);
  assert.ok(calls.some((c) => c.type === 'set-login-item' && c.enabled === false));
  assert.equal(loginItem, false);
  await menubar.click('.settings [data-action="native-quit"]');
  assert.ok(calls.some((c) => c.type === 'quit'));
  await menubar.click('.settings [data-action="settings"]');
});

const floating = await open('window', { width: 400, height: 660 });

await step('favorites saved from one window reach the other and the widget store', async () => {
  await floating.click('.tab[data-league="fav"]');
  await floating.waitForSelector('.empty [data-action="add-teams"]');
  await menubar.click('.game.state-in');
  await menubar.click('.sb-team.away [data-action="favorite"]');
  await menubar.waitForSelector('.sb-team.away .star.on');
  // The shape NativeBridge.swift / SharedStore.swift read for the widget and menu bar.
  const fav = defaults.sync.favorites[0];
  assert.deepEqual(Object.keys(fav).sort(), ['abbr', 'key', 'league', 'logo', 'name', 'teamId']);
  assert.equal(fav.key, 'nfl:12');
  // The other open window updates from the broadcast.
  await floating.waitForSelector('.fav-team .game.state-in');
  assert.match(await floating.locator('.fav-name').innerText(), /Kansas City Chiefs/);
});

await step('widget deep link: native writes ui state, reload opens that game', async () => {
  defaults.local.ui = { ...defaults.local.ui, view: 'game', gameId: '401772001', gameLeague: 'nfl', league: 'nfl' };
  await floating.reload();
  await floating.waitForSelector('.scorebug');
  assert.match(await floating.locator('.scorebug').innerText(), /KC[\s\S]*24[\s\S]*20[\s\S]*BUF/);
  await floating.screenshot({ path: `${SHOTS}/mac-floating.png` });
});

await step('a failed native request rejects like a browser network error', async () => {
  // Swift answers with an error string when URLSession fails.
  const result = await menubar.evaluate(async () => {
    const bridge = window.webkit.messageHandlers.courtside;
    const saved = bridge.postMessage;
    bridge.postMessage = () => Promise.reject(new Error('offline'));
    try {
      await fetch('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard');
      return 'resolved';
    } catch (err) {
      return `${err.name}: ${err.message}`;
    } finally {
      bridge.postMessage = saved;
    }
  });
  assert.equal(result, 'TypeError: Network request failed: offline');
});

await browser.close();
if (errors.length) {
  console.error('\nPage errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nNative bridge checks passed.');
