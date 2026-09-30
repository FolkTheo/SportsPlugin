// Network layer. Extension pages and the service worker both use this; the
// manifest's host permissions (ESPN, DraftKings) let them fetch cross-origin.

import { normalizeScoreboard, normalizeSummary, scoreboardUrl, summaryUrl } from './espn.js';
import { draftKingsUrl, normalizeDraftKings } from './odds.js';

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

// DraftKings lines for a whole league. Cached briefly so several views (and
// rapid live refreshes) share one request; after a failure (blocked, region
// restricted, format change) we back off and let callers use ESPN's odds.
const DK_FRESH_MS = 20000;
const DK_BACKOFF_MS = 2 * 60000;
const dkCache = new Map();

export async function fetchDraftKingsOdds(leagueId) {
  const url = draftKingsUrl(leagueId);
  if (!url) return [];
  const cached = dkCache.get(leagueId);
  if (cached) {
    const age = Date.now() - cached.at;
    if (cached.error && age < DK_BACKOFF_MS) throw cached.error;
    if (!cached.error && age < DK_FRESH_MS) return cached.promise;
  }
  const promise = getJson(url).then(normalizeDraftKings);
  dkCache.set(leagueId, { at: Date.now(), promise });
  try {
    return await promise;
  } catch (err) {
    const error = new Error(`DraftKings odds unavailable (${err.message})`);
    dkCache.set(leagueId, { at: Date.now(), error });
    throw error;
  }
}
