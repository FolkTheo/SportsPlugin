// End-to-end check: loads the unpacked extension in Chromium, serves ESPN
// fixtures in place of the live API, and drives the popup, game detail,
// in-page overlay and pop-out window. Screenshots go to tests/e2e/screenshots.
//
// Usage: node tests/e2e/run.mjs   (needs Playwright + Chromium installed)

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { dkFixtureFor, fixtureFor } from '../fixtures/espn.js';

// Lets context.route() also answer the background service worker's fetches.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(`${process.env.NODE_PATH || '/opt/node22/lib/node_modules'}/playwright`);
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = path.join(ROOT, 'tests/e2e/screenshots');
await mkdir(SHOTS, { recursive: true });

// The real extension injects the overlay using activeTab, which is only
// granted by a user gesture on the toolbar button. Tests can't click the
// toolbar, so run a copy whose manifest also grants <all_urls>.
const work = await mkdtemp(path.join(tmpdir(), 'courtside-e2e-'));
const extDir = path.join(work, 'ext');
for (const entry of ['manifest.json', 'src', 'icons']) await cp(path.join(ROOT, entry), path.join(extDir, entry), { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('<all_urls>');
await writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const context = await playwright.chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 760 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const errors = [];
const requests = [];

function teamLogoSvg(url) {
  const abbr = (/\/([a-z0-9]+)\.png$/i.exec(url)?.[1] || '?').toUpperCase().slice(0, 4);
  let hash = 0;
  for (const c of abbr) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="hsl(${hash} 60% 42%)"/><text x="20" y="25" font-family="Arial" font-weight="700" font-size="${abbr.length > 3 ? 9 : 12}" fill="#fff" text-anchor="middle">${abbr}</text></svg>`;
}

await context.route('https://site.api.espn.com/**', (route) => {
  const url = route.request().url();
  requests.push(url);
  const body = fixtureFor(url);
  if (!body) return route.fulfill({ status: 404, body: '{}' });
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
});
let dkBlocked = false;
await context.route('https://sportsbook-nash.draftkings.com/**', (route) => {
  requests.push(route.request().url());
  if (dkBlocked) return route.fulfill({ status: 403, body: 'Access Denied' });
  const body = dkFixtureFor(route.request().url());
  return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body || {}) });
});
await context.route('https://a.espncdn.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: teamLogoSvg(route.request().url()) }),
);
await context.route('https://stream.example/**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Game stream</title>
      <style>body{margin:0;background:#000;font-family:Arial;color:#fff}
      #player{position:relative;height:100vh;background:radial-gradient(circle at 40% 60%,#1d5c2e,#0b2412);display:grid;place-items:center}
      #player h1{font-size:42px;opacity:.5}#fs{position:absolute;left:16px;bottom:16px}</style></head>
      <body><div id="player"><h1>▶ Live game stream</h1><button id="fs">Fullscreen</button></div>
      <script>document.getElementById('fs').onclick=()=>document.getElementById('player').requestFullscreen()</script></body></html>`,
  }),
);

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const appUrl = (mode) => `chrome-extension://${extId}/src/app/app.html?mode=${mode}`;

function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
}

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log('ok');
};

// ------------------------------------------------------------------ popup
const popup = await context.newPage();
watch(popup, 'popup');
await popup.setViewportSize({ width: 380, height: 580 });

await step('popup renders NFL scoreboard with live game first', async () => {
  await popup.goto(appUrl('popup'));
  await popup.waitForSelector('.game.state-in');
  const first = await popup.locator('.game').first().innerText();
  assert.match(first, /Chiefs[\s\S]*24[\s\S]*Bills[\s\S]*20/);
  assert.match(first, /2nd & 7 · Red zone/);
  // DraftKings live lines arrive just after the scores.
  await popup.waitForSelector('.game.state-in .odds-line .live-tag');
  assert.match(await popup.locator('.game.state-in .odds-line').innerText(), /^DK\s*KC -3\.5 · O\/U 51\.5 · ML KC -180 BUF \+150\s*LIVE$/);
  assert.match(await popup.locator('.game.state-pre .odds-line').innerText(), /^DK\s*SF -2\.5 · O\/U 44\.5 · ML SF -135 SEA \+115$/);
  assert.equal(await popup.locator('.game.state-post .odds-line').count(), 0);
  assert.match(await popup.locator('.sub-label').innerText(), /Week 4/);
  assert.equal(await popup.locator('.game').count(), 3);
  await popup.screenshot({ path: `${SHOTS}/popup-nfl.png` });
});

await step('week navigation requests the previous week', async () => {
  await popup.click('[data-action="week"][data-dir="prev"]');
  await popup.waitForSelector('[data-action="week"][data-dir="current"]');
  assert.ok(requests.some((u) => /seasontype=2&week=3&dates=2026/.test(u)), 'week query sent');
  await popup.click('[data-action="week"][data-dir="current"]');
});

for (const [league, check] of [
  ['nba', /Knicks[\s\S]*88[\s\S]*Celtics[\s\S]*91/],
  ['mlb', /Dodgers[\s\S]*3[\s\S]*Yankees[\s\S]*4/],
  ['nhl', /Canadiens[\s\S]*Maple Leafs[\s\S]*Final\/OT/],
  ['cfb', /4[\s\S]*Crimson Tide[\s\S]*2[\s\S]*Bulldogs/],
]) {
  await step(`${league.toUpperCase()} scoreboard`, async () => {
    await popup.click(`.tab[data-league="${league}"]`);
    await popup.waitForFunction((l) => document.querySelector('.game')?.dataset.league === l, league);
    assert.match(await popup.locator('.game').first().innerText(), check);
    await popup.screenshot({ path: `${SHOTS}/popup-${league}.png` });
  });
}

await step('CFB Top 25 filter hides unranked matchups', async () => {
  assert.equal(await popup.locator('.game').count(), 3);
  await popup.click('[data-action="top25"]');
  await popup.waitForFunction(() => document.querySelectorAll('.game').length === 2);
  await popup.click('[data-action="top25"]');
});

await step('MLB day navigation sends a date', async () => {
  await popup.click('.tab[data-league="mlb"]');
  await popup.waitForSelector('.game[data-league="mlb"]');
  await popup.click('[data-action="day"][data-dir="1"]');
  await popup.waitForSelector('[data-action="day"][data-dir="0"]');
  assert.ok(requests.some((u) => /baseball\/mlb\/scoreboard\?dates=\d{8}$/.test(u)), 'dates query sent');
  await popup.click('[data-action="day"][data-dir="0"]');
});

await step('MLB game detail: bases, count, R/H/E, batting + pitching', async () => {
  await popup.click('.game.state-in');
  await popup.waitForSelector('.scorebug');
  await popup.waitForSelector('.linescore');
  const text = await popup.locator('.content').innerText();
  assert.match(text, /2-1 · 1 out/);
  assert.match(text, /P: G\. Cole/);
  assert.equal(await popup.locator('.linescore thead th').count(), 1 + 9 + 3);
  assert.equal(await popup.locator('.diamond rect.on').count(), 2);
  assert.match(await popup.locator('table.box').first().innerText(), /S\. Ohtani/);
  assert.equal(await popup.locator('table.box').count(), 2);
  await popup.screenshot({ path: `${SHOTS}/game-mlb.png` });
  await popup.click('[data-action="back"]');
});

await step('NFL game detail: every tab renders', async () => {
  await popup.click('.tab[data-league="nfl"]');
  await popup.click('.game.state-in');
  await popup.waitForSelector('.gv-tabs');
  const tabs = await popup.locator('.gv-tab').allInnerTexts();
  assert.deepEqual(tabs, ['Box Score', 'Team Stats', 'Plays', 'Scoring', 'Odds', 'Leaders', 'Info']);
  assert.match(await popup.locator('.game-situation').innerText(), /KC · 2nd & 7 · Red zone/);
  assert.match(await popup.locator('.winprob').innerText(), /KC 61\.8%[\s\S]*38\.2% BUF/);
  await popup.screenshot({ path: `${SHOTS}/game-nfl-box.png` });
  for (const tab of ['team', 'plays', 'scoring', 'odds', 'leaders', 'info']) {
    await popup.click(`[data-action="game-tab"][data-tab="${tab}"]`);
    await popup.waitForSelector(`.gv-tab.active[data-tab="${tab}"]`);
    await popup.screenshot({ path: `${SHOTS}/game-nfl-${tab}.png` });
  }
  assert.match(await popup.locator('.gv-body').innerText(), /Highmark Stadium/);
});

await step('box score team toggle', async () => {
  await popup.click('[data-action="game-tab"][data-tab="box"]');
  await popup.click('[data-action="box-side"][data-side="home"]');
  await popup.waitForSelector('[data-action="box-side"][data-side="home"].active');
  assert.match(await popup.locator('table.box').first().innerText(), /J\. Allen/);
});

await step('favorite a team → ★ Mine tab', async () => {
  await popup.click('.sb-team.away [data-action="favorite"]');
  await popup.waitForSelector('.sb-team.away .star.on');
  await popup.waitForSelector('.tab[data-league="fav"]');
  await popup.click('[data-action="back"]');
  await popup.click('.tab[data-league="fav"]');
  await popup.waitForFunction(() => document.querySelectorAll('.game').length === 1);
  assert.match(await popup.locator('.game').innerText(), /Chiefs/);
  // The background watcher picks up the favorite and flags the live game.
  const badge = await worker.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const text = await chrome.action.getBadgeText({});
      if (text) return text;
      await new Promise((r) => setTimeout(r, 100));
    }
    return '';
  });
  assert.equal(badge, 'LIVE');
});

await step('Odds tab: DraftKings live lines, implied chance, ESPN opener', async () => {
  await popup.click('.tab[data-league="nfl"]');
  await popup.click('.game.state-in');
  await popup.click('[data-action="game-tab"][data-tab="odds"]');
  await popup.waitForSelector('.odds-head .live-tag');
  const text = await popup.locator('.gv-body').innerText();
  assert.match(text, /DraftKings\s*LIVE/);
  assert.match(text, /KC\s+-3\.5\s+-115\s+O 51\.5\s+-110\s+-180/);
  assert.match(text, /BUF\s+\+3\.5\s+-105\s+U 51\.5\s+-110\s+\+150/);
  assert.match(text, /KC 61\.6%[\s\S]*38\.4% BUF/);
  assert.match(text, /Opened: KC -2\.5 · O\/U 49\.5 · ML KC -150 \/ BUF \+130/);
  assert.match(text, /1-800-GAMBLER/);
  assert.equal(await popup.locator('.odds-link').getAttribute('href'), 'https://sportsbook.draftkings.com/event/32001');
  await popup.waitForSelector('.toast', { state: 'hidden' });
  await popup.locator('.content').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await popup.screenshot({ path: `${SHOTS}/game-nfl-odds.png` });
  await popup.click('[data-action="back"]');
});

await step('NBA suspended live market is flagged', async () => {
  await popup.click('.tab[data-league="nba"]');
  await popup.waitForSelector('.game.state-in .odds-line');
  assert.match(await popup.locator('.game.state-in .odds-line').innerText(), /NY \+105 BOS -125\s*LIVE\s*suspended/);
});

await step('NBA game detail: starters/bench, DNP row', async () => {
  await popup.click('.tab[data-league="nba"]');
  await popup.click('.game.state-in');
  await popup.click('[data-action="game-tab"][data-tab="box"]');
  await popup.waitForSelector('table.box');
  assert.equal(await popup.locator('tr.bench-start').count(), 1);
  assert.match(await popup.locator('td.dnp').innerText(), /COACH'S DECISION/);
  await popup.screenshot({ path: `${SHOTS}/game-nba.png` });
  await popup.click('[data-action="back"]');
});

await step('NHL final + CFB halftime detail', async () => {
  await popup.click('.tab[data-league="nhl"]');
  await popup.click('.game');
  await popup.waitForSelector('.linescore');
  assert.deepEqual(await popup.locator('.linescore thead th').allInnerTexts(), ['', '1', '2', '3', 'OT', 'T']);
  await popup.screenshot({ path: `${SHOTS}/game-nhl.png` });
  await popup.click('[data-action="back"]');
  await popup.click('.tab[data-league="cfb"]');
  await popup.click('.game.state-in');
  await popup.waitForSelector('.gv-tabs');
  // DraftKings lists this game reversed; its lines are flipped to ESPN's sides.
  await popup.waitForSelector('.gv-tab[data-tab="odds"]');
  assert.deepEqual(await popup.locator('.gv-tab').allInnerTexts(), ['Odds', 'Info']);
  await popup.click('[data-action="game-tab"][data-tab="odds"]');
  assert.match(await popup.locator('.odds-table').innerText(), /ALA\s+-2\.5[\s\S]*-140[\s\S]*UGA\s+\+2\.5[\s\S]*\+120/);
  await popup.click('[data-action="back"]');
});

await step('settings: compact mode', async () => {
  await popup.click('[data-action="settings"]');
  await popup.check('[data-setting="compact"]');
  await popup.click('.settings [data-action="settings"]');
  await popup.click('.tab[data-league="nfl"]');
  await popup.waitForSelector('.games.compact');
  await popup.screenshot({ path: `${SHOTS}/popup-compact.png` });
  await popup.click('[data-action="settings"]');
  await popup.screenshot({ path: `${SHOTS}/settings.png` });
  await popup.uncheck('[data-setting="compact"]');
  await popup.click('.settings [data-action="settings"]');
});

await step('network errors surface with a retry', async () => {
  await context.unroute('https://site.api.espn.com/**');
  await context.route('https://site.api.espn.com/**', (route) => route.fulfill({ status: 503, body: 'down' }));
  await popup.click('.tab[data-league="nhl"]');
  await popup.waitForSelector('.statusbar .err');
  assert.match(await popup.locator('.statusbar').innerText(), /ESPN returned 503/);
  await context.unroute('https://site.api.espn.com/**');
  await context.route('https://site.api.espn.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureFor(route.request().url())) }),
  );
  await popup.click('.statusbar [data-action="refresh"]');
  await popup.waitForSelector('.game:not(.skeleton)');
  assert.equal(await popup.locator('.statusbar .err').count(), 0);
});

// ------------------------------------------------------------------ overlay
const stream = await context.newPage();
watch(stream, 'stream');

// The overlay lives in a closed shadow root, which locators can't pierce, so
// reach the app iframe through the page's frame tree instead.
async function overlayFrame() {
  for (let i = 0; i < 50; i++) {
    const f = stream.frames().find((fr) => !fr.isDetached() && fr.url().includes('mode=overlay'));
    if (f) return f;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('overlay iframe not found');
}

async function toggleOverlay() {
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://stream.example/*' }))[0].id);
  return worker.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content/overlay.js'] }).then(() => true), tabId);
}

await step('overlay floats over a video page and loads the app', async () => {
  await stream.goto('https://stream.example/watch');
  await popup.click('.tab[data-league="nfl"]');
  await toggleOverlay();
  const host = stream.locator('[data-courtside-overlay]');
  await host.waitFor();
  const frame = await overlayFrame();
  await frame.locator('.game.state-in').first().waitFor();
  const box = await host.boundingBox();
  assert.ok(box.x > 800 && box.width === 360, `positioned top-right (${JSON.stringify(box)})`);
  await stream.screenshot({ path: `${SHOTS}/overlay.png` });
  await frame.locator('.game.state-in').first().click();
  await frame.locator('.scorebug').waitFor();
  await frame.locator('.gv-tabs').waitFor();
  await stream.screenshot({ path: `${SHOTS}/overlay-game.png` });
});

await step('overlay drags, resizes, fades and minimizes', async () => {
  const host = stream.locator('[data-courtside-overlay]');
  const before = await host.boundingBox();
  // Drag the title bar (inside a closed shadow root, so use coordinates).
  await stream.mouse.move(before.x + 60, before.y + 14);
  await stream.mouse.down();
  await stream.mouse.move(before.x - 300, before.y + 100, { steps: 8 });
  await stream.mouse.up();
  const moved = await host.boundingBox();
  assert.ok(Math.abs(moved.x - (before.x - 360)) < 3 && Math.abs(moved.y - (before.y + 86)) < 3, `moved ${JSON.stringify(moved)}`);
  // Resize from the bottom-right handle.
  await stream.mouse.move(moved.x + moved.width - 5, moved.y + moved.height - 5);
  await stream.mouse.down();
  await stream.mouse.move(moved.x + moved.width + 60, moved.y + moved.height - 105, { steps: 6 });
  await stream.mouse.up();
  const resized = await host.boundingBox();
  assert.ok(Math.abs(resized.width - 425) < 3 && Math.abs(resized.height - (moved.height - 100)) < 3, `resized ${JSON.stringify(resized)}`);
  // Transparency button (third from right), then move away so it applies.
  await stream.mouse.click(resized.x + resized.width - 67, resized.y + 14);
  await stream.mouse.move(10, 10);
  await stream.screenshot({ path: `${SHOTS}/overlay-faded.png` });
  // Minimize by double-clicking the title.
  await stream.mouse.dblclick(resized.x + 80, resized.y + 14);
  const mini = await host.boundingBox();
  assert.equal(mini.height, 30);
  await stream.mouse.dblclick(mini.x + 80, mini.y + 14);
});

await step('overlay position persists and follows the player into fullscreen', async () => {
  const saved = await worker.evaluate(() => chrome.storage.local.get('overlay'));
  assert.equal(Math.round(saved.overlay.width), 425);
  assert.equal(saved.overlay.opacity, 0.9);
  await stream.click('#fs');
  await stream.waitForFunction(() => !!document.fullscreenElement);
  await stream.waitForFunction(() => document.fullscreenElement.querySelector('[data-courtside-overlay]'));
  // Re-parenting reloads the iframe; the app restores the open game.
  await stream.waitForTimeout(300);
  await (await overlayFrame()).locator('.scorebug').waitFor();
  await stream.screenshot({ path: `${SHOTS}/overlay-fullscreen.png` });
  await stream.evaluate(() => document.exitFullscreen());
  await stream.waitForFunction(() => document.documentElement.lastElementChild.matches('[data-courtside-overlay]'));
});

await step('toggling again removes the overlay', async () => {
  await toggleOverlay();
  await stream.waitForFunction(() => !document.querySelector('[data-courtside-overlay]'));
  await toggleOverlay();
  await stream.locator('[data-courtside-overlay]').waitFor();
  await toggleOverlay();
});

await step('overlay on a protected page reports a friendly error', async () => {
  const res = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'toggle-overlay', tabId: -1 }));
  assert.equal(res.ok, false);
  assert.match(res.error, /pop-out/);
});

// ------------------------------------------------------------------ pop-out
await step('odds fall back to ESPN when DraftKings is blocked', async () => {
  dkBlocked = true;
  const page = await context.newPage(); // fresh page: no cached DraftKings response
  watch(page, 'fallback');
  await page.setViewportSize({ width: 380, height: 580 });
  await page.goto(appUrl('popup'));
  await page.click('.tab[data-league="nfl"]');
  await page.waitForSelector('.game.state-pre .odds-line');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.game.state-in .odds-line').count(), 0, 'no ESPN odds for the live game');
  assert.match(await page.locator('.game.state-pre .odds-line').innerText(), /^DK\s*SF -2\.5 · O\/U 44\.5 · ML SF -135 SEA \+115$/);
  await page.click('.game.state-in');
  await page.click('[data-action="game-tab"][data-tab="odds"]');
  await page.waitForFunction(() => /live feed is unavailable/.test(document.querySelector('.gv-body')?.innerText || ''));
  const text = await page.locator('.gv-body').innerText();
  assert.match(text, /DraftKings\s*Latest line/);
  assert.match(text, /KC\s+-3\s+-110\s+O 50\.5\s+-110\s+-160/);
  assert.match(text, /DraftKings line via ESPN\. The DraftKings live feed is unavailable right now\./);
  assert.equal(await page.locator('.odds-link').count(), 0);
  await page.screenshot({ path: `${SHOTS}/game-odds-espn-fallback.png` });
  await page.close();
  dkBlocked = false;
});

await step('odds can be turned off in settings', async () => {
  await popup.click('.tab[data-league="nfl"]');
  await popup.waitForSelector('.odds-line');
  await popup.click('[data-action="settings"]');
  await popup.uncheck('[data-setting="showOdds"]');
  await popup.click('.settings [data-action="settings"]');
  await popup.waitForSelector('.game');
  assert.equal(await popup.locator('.odds-line').count(), 0);
  await popup.click('[data-action="settings"]');
  await popup.check('[data-setting="showOdds"]');
  await popup.click('.settings [data-action="settings"]');
  await popup.waitForSelector('.odds-line');
});

await step('pop-out window opens once and is reused', async () => {
  const opened = context.waitForEvent('page');
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'open-popout' }));
  const win = await opened;
  watch(win, 'popout');
  await win.waitForLoadState();
  assert.match(win.url(), /mode=window/);
  await win.waitForSelector('.scorebug, .game');
  await win.screenshot({ path: `${SHOTS}/popout.png` });
  const pagesBefore = context.pages().length;
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'open-popout' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(context.pages().length, pagesBefore);
  const pipButton = await win.locator('[data-action="pip"]').isVisible();
  console.log(`(keep-on-top button ${pipButton ? 'shown' : 'hidden: Document PiP unavailable here'})`);
});

await context.close();
await rm(work, { recursive: true, force: true });

if (errors.length) {
  console.error('\nPage errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`\nAll e2e checks passed. Screenshots in ${path.relative(ROOT, SHOTS)}/`);
