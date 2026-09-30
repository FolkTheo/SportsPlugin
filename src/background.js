// Service worker: opens the overlay / pop-out window, and watches favorite
// teams in the background to update the toolbar badge and send score alerts.

import { LEAGUES } from './lib/leagues.js';
import { fetchScoreboard } from './lib/api.js';
import { getFavorites, getSettings, saveUiState } from './lib/storage.js';

const APP_PAGE = 'src/app/app.html';
const POLL_ALARM = 'poll-favorites';

// ---------------------------------------------------------------------------
// Overlay & pop-out

async function toggleOverlay(tabId) {
  if (!tabId) return { ok: false, error: 'No active tab to overlay.' };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/overlay.js'] });
    return { ok: true };
  } catch (err) {
    console.warn('Courtside: overlay injection failed', err);
    return {
      ok: false,
      error: "Chrome doesn't allow overlays on this page (browser and Web Store pages are protected). Use the pop-out window instead.",
    };
  }
}

async function openPopout() {
  const { popoutWindowId } = await chrome.storage.session.get('popoutWindowId');
  if (popoutWindowId) {
    try {
      await chrome.windows.update(popoutWindowId, { focused: true, state: 'normal' });
      return { ok: true };
    } catch {
      // Window was closed; fall through and make a new one.
    }
  }
  const width = 400;
  const height = 660;
  let left;
  let top;
  try {
    const current = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    left = Math.max(0, current.left + current.width - width - 24);
    top = Math.max(0, current.top + 80);
  } catch {
    // Use Chrome's default placement.
  }
  const options = { url: chrome.runtime.getURL(`${APP_PAGE}?mode=window`), type: 'popup', width, height, focused: true };
  let win;
  try {
    win = await chrome.windows.create({ ...options, left, top });
  } catch {
    // Chrome rejects bounds that are mostly off-screen (e.g. multi-monitor setups).
    win = await chrome.windows.create(options);
  }
  await chrome.storage.session.set({ popoutWindowId: win.id });
  return { ok: true };
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { popoutWindowId } = await chrome.storage.session.get('popoutWindowId');
  if (popoutWindowId === windowId) await chrome.storage.session.remove('popoutWindowId');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'toggle-overlay') {
    toggleOverlay(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg?.type === 'open-popout') {
    openPopout().then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-overlay') {
    const result = await toggleOverlay(tab?.id);
    // The shortcut can't show a popup, so fall back to the pop-out window.
    if (!result.ok) await openPopout();
  } else if (command === 'open-popout') {
    await openPopout();
  }
});

// ---------------------------------------------------------------------------
// Favorite-team watcher

function scoreLine(g) {
  return `${g.away.abbr} ${g.away.score} – ${g.home.abbr} ${g.home.score}`;
}

async function pollFavorites() {
  const [favorites, settings] = await Promise.all([getFavorites(), getSettings()]);
  const keys = new Set(favorites.map((f) => f.key));
  const leagues = [...new Set(favorites.map((f) => f.league))].filter((l) => LEAGUES[l]);

  if (!leagues.length || !settings.notifyFavorites) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Courtside live scores' });
    await chrome.storage.local.remove('watch');
    return false;
  }

  const results = await Promise.allSettled(leagues.map((l) => fetchScoreboard(l)));
  const games = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value.games : []))
    .filter((g) => keys.has(`${g.league}:${g.home.id}`) || keys.has(`${g.league}:${g.away.id}`));

  const { watch: previous = {} } = await chrome.storage.local.get('watch');
  const next = {};
  for (const g of games) {
    const key = `${g.league}:${g.id}`;
    const snap = { state: g.status.state, away: g.away.score, home: g.home.score };
    next[key] = snap;
    const before = previous[key];
    if (!before) continue; // first sighting: record a baseline, don't alert

    const favSide = keys.has(`${g.league}:${g.home.id}`) ? 'home' : 'away';
    if (before.state === 'pre' && snap.state === 'in') {
      notify(key, g, `${g.away.name} at ${g.home.name} has started`, g.broadcast ? `On ${g.broadcast}` : g.status.detail);
    } else if (snap.state !== 'pre' && (before.away !== snap.away || before.home !== snap.home)) {
      const scorer = Number(snap.home) - Number(before.home) > 0 ? g.home : Number(snap.away) - Number(before.away) > 0 ? g.away : null;
      const title = scorer ? `${scorer.name} score${scorer === g[favSide] ? '!' : ''}` : 'Score update';
      notify(key, g, `${title} ${scoreLine(g)}`, g.situation?.lastPlay || g.status.detail);
    }
    if (before.state !== 'post' && snap.state === 'post') {
      notify(key, g, `Final: ${scoreLine(g)}`, g.status.detail);
    }
  }
  await chrome.storage.local.set({ watch: next });

  const live = games.filter((g) => g.status.state === 'in');
  await chrome.action.setBadgeBackgroundColor({ color: '#d93636' });
  await chrome.action.setBadgeText({ text: live.length ? (live.length === 1 ? 'LIVE' : String(live.length)) : '' });
  await chrome.action.setTitle({
    title: live.length
      ? `Courtside – your teams are playing\n${live.map((g) => `${scoreLine(g)} (${g.status.detail})`).join('\n')}`
      : 'Courtside live scores',
  });
  return live.length > 0;
}

function notify(key, game, title, message) {
  chrome.notifications.create(`game|${key}|${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: message || '',
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const [kind, key = ''] = id.split('|');
  const [league, gameId] = key.split(':');
  if (kind !== 'game' || !LEAGUES[league]) return;
  await saveUiState({ view: 'game', gameId, gameLeague: league, league });
  await openPopout();
  chrome.notifications.clear(id);
});

async function runPoll() {
  let live = false;
  try {
    live = await pollFavorites();
  } catch (err) {
    console.warn('Courtside: favorite poll failed', err);
  }
  // Poll every 30s while a favorite is live, otherwise every 2 minutes.
  const period = live ? 0.5 : 2;
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: period, delayInMinutes: period });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) runPoll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.favorites || changes.settings)) runPoll();
});

chrome.runtime.onInstalled.addListener(runPoll);
chrome.runtime.onStartup.addListener(runPoll);
