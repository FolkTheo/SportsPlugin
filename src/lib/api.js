// Network layer. Extension pages and the service worker both use this; the
// manifest's host permissions (ESPN, DraftKings) let them fetch cross-origin.

import {
  normalizeConferences,
  normalizeScoreboard,
  normalizeSummary,
  normalizeTeamList,
  normalizeTeamOverview,
  scoreboardUrl,
  standingsUrl,
  summaryUrl,
  teamScheduleUrl,
  teamsUrl,
  teamUrl,
} from './espn.js';
import { draftKingsUrl, normalizeDraftKings } from './odds.js';
import { CONFERENCE_FALLBACK, LEAGUES } from './leagues.js';

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

// Past results change rarely; keep each team's schedule for 10 minutes.
const SCHEDULE_TTL_MS = 10 * 60000;
const scheduleCache = new Map();

function fetchSchedule(leagueId, teamId) {
  const key = `${leagueId}:${teamId}`;
  const hit = scheduleCache.get(key);
  if (hit && Date.now() - hit.at < SCHEDULE_TTL_MS) return hit.promise;
  const promise = getJson(teamScheduleUrl(leagueId, teamId)).catch((err) => {
    scheduleCache.delete(key);
    console.warn('Courtside: schedule unavailable', key, err);
    return null; // the card still works without a last result
  });
  scheduleCache.set(key, { at: Date.now(), promise });
  return promise;
}

export async function fetchTeamOverview(leagueId, teamId) {
  const [team, schedule] = await Promise.all([getJson(teamUrl(leagueId, teamId)), fetchSchedule(leagueId, teamId)]);
  return normalizeTeamOverview(team, schedule, leagueId);
}

// Team lists barely change, so the picker keeps them for a week.
const TEAMS_TTL_MS = 7 * 24 * 3600 * 1000;

export async function fetchTeams(leagueId) {
  const storageKey = `teams:${leagueId}`;
  const local = globalThis.chrome?.storage?.local;
  const cached = local ? (await local.get(storageKey))[storageKey] : null;
  if (cached && Date.now() - cached.at < TEAMS_TTL_MS && cached.teams?.length) return cached.teams;
  const teams = normalizeTeamList(await getJson(teamsUrl(leagueId)), leagueId);
  if (local && teams.length) await local.set({ [storageKey]: { at: Date.now(), teams } });
  return teams;
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

// Conference list for a college league (id -> name), cached for a week. If
// ESPN's standings can't be loaded, fall back to the built-in main conferences.
const CONFERENCES_TTL_MS = 7 * 24 * 3600 * 1000;

export async function fetchConferences(leagueId) {
  if (!LEAGUES[leagueId]?.college) return [];
  const storageKey = `conferences:${leagueId}`;
  const local = globalThis.chrome?.storage?.local;
  const cached = local ? (await local.get(storageKey))[storageKey] : null;
  if (cached && Date.now() - cached.at < CONFERENCES_TTL_MS && cached.list?.length) return cached.list;
  try {
    const list = normalizeConferences(await getJson(standingsUrl(leagueId)));
    if (!list.length) throw new Error('no conferences in standings');
    if (local) await local.set({ [storageKey]: { at: Date.now(), list } });
    return list;
  } catch (err) {
    console.warn('Courtside: using built-in conference list', err);
    return Object.entries(CONFERENCE_FALLBACK[leagueId] || {})
      .map(([id, label]) => ({ id, name: label, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
}
