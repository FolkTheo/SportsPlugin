// Network layer. Extension pages and the service worker both use this; the
// manifest's host permission for site.api.espn.com lets them fetch cross-origin.

import { normalizeScoreboard, normalizeSummary, scoreboardUrl, summaryUrl } from './espn.js';

const TIMEOUT_MS = 10000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// `query` is either {dates: 'YYYYMMDD'} for daily leagues or
// {seasontype, week, dates: year} for football weeks. Empty means "current".
export async function fetchScoreboard(leagueId, query = {}) {
  return normalizeScoreboard(await getJson(scoreboardUrl(leagueId, query)), leagueId);
}

export async function fetchSummary(leagueId, eventId) {
  return normalizeSummary(await getJson(summaryUrl(leagueId, eventId)), leagueId);
}
