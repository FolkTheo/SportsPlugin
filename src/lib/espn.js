// Pure functions that turn ESPN site API responses into the small, stable
// shapes the UI renders. Everything here is defensive: ESPN's payloads vary by
// sport and by game state, and fields come and go without notice.

import { LEAGUES, periodLabel } from './leagues.js';
import { oddsFromEspn } from './odds.js';

const API_ROOT = 'https://site.api.espn.com/apis/site/v2/sports';

// ---------------------------------------------------------------------------
// URLs

export function scoreboardUrl(leagueId, query = {}) {
  const league = LEAGUES[leagueId];
  const params = new URLSearchParams({ ...(league.scoreboardParams || {}), ...query });
  return `${API_ROOT}/${league.path}/scoreboard?${params}`;
}

export function summaryUrl(leagueId, eventId) {
  return `${API_ROOT}/${LEAGUES[leagueId].path}/summary?event=${encodeURIComponent(eventId)}`;
}

export function teamsUrl(leagueId) {
  const params = new URLSearchParams({ limit: '1000', ...(LEAGUES[leagueId].teamsParams || {}) });
  return `${API_ROOT}/${LEAGUES[leagueId].path}/teams?${params}`;
}

export function teamUrl(leagueId, teamId) {
  return `${API_ROOT}/${LEAGUES[leagueId].path}/teams/${encodeURIComponent(teamId)}`;
}

export function teamScheduleUrl(leagueId, teamId) {
  return `${API_ROOT}/${LEAGUES[leagueId].path}/teams/${encodeURIComponent(teamId)}/schedule`;
}

// ---------------------------------------------------------------------------
// Small helpers

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === undefined || v === null ? '' : String(v));

function logoOf(team) {
  if (!team) return '';
  return team.logo || arr(team.logos)[0]?.href || '';
}

function scoreOf(c) {
  const s = c?.score;
  if (s && typeof s === 'object') return str(s.displayValue ?? s.value);
  return str(s);
}

function recordOf(c) {
  const records = arr(c.records).length ? c.records : arr(c.record);
  const total =
    records.find((r) => r.type === 'total') ||
    records.find((r) => /overall|all splits/i.test(r.name || '')) ||
    records[0];
  return str(total?.summary ?? total?.displayValue);
}

function rankOf(c) {
  const rank = c.curatedRank?.current ?? c.rank;
  return rank && rank <= 25 ? rank : null;
}

function athleteName(a) {
  if (!a) return '';
  return a.shortName || a.displayName || a.fullName || '';
}

function lastPlayText(situation) {
  return str(situation?.lastPlay?.text).trim();
}

// ---------------------------------------------------------------------------
// Status

export function normalizeStatus(status) {
  const type = status?.type || {};
  const state = type.state || 'pre';
  return {
    state, // 'pre' | 'in' | 'post'
    completed: !!type.completed,
    name: type.name || '',
    detail: type.shortDetail || type.detail || type.description || '',
    longDetail: type.detail || type.shortDetail || '',
    clock: status?.displayClock || '',
    period: status?.period || 0,
    delayed: /DELAY|POSTPONED|CANCELED|SUSPENDED/.test(type.name || ''),
  };
}

// ---------------------------------------------------------------------------
// Competitors & situation

export function normalizeCompetitor(c = {}) {
  const team = c.team || {};
  return {
    id: str(team.id || c.id),
    abbr: team.abbreviation || team.shortDisplayName || '',
    name: team.shortDisplayName || team.name || team.displayName || '',
    fullName: team.displayName || team.name || '',
    nickname: team.name || '',
    location: team.location || '',
    logo: logoOf(team),
    color: team.color ? `#${team.color}` : '',
    score: scoreOf(c),
    record: recordOf(c),
    rank: rankOf(c),
    winner: c.winner === true,
    homeAway: c.homeAway || '',
    possession: c.possession === true,
    linescores: arr(c.linescores).map((l) => str(l.displayValue ?? l.value)),
    hits: c.hits ?? null,
    errors: c.errors ?? null,
  };
}

function splitHomeAway(competitors) {
  const list = arr(competitors).map(normalizeCompetitor);
  const home = list.find((t) => t.homeAway === 'home') || list[1] || normalizeCompetitor();
  const away = list.find((t) => t.homeAway === 'away') || list[0] || normalizeCompetitor();
  return { home, away };
}

export function normalizeSituation(situation, sport, { home, away } = {}) {
  if (!situation) return null;
  const out = { lastPlay: lastPlayText(situation) };
  const winPct = situation.lastPlay?.probability?.homeWinPercentage;
  if (typeof winPct === 'number') out.homeWinPct = winPct;

  if (sport === 'football') {
    out.downDistance = situation.shortDownDistanceText || situation.downDistanceText || '';
    out.possessionText = situation.possessionText || '';
    out.isRedZone = !!situation.isRedZone;
    const pos = str(situation.possession);
    if (pos) out.possession = pos === home?.id ? 'home' : pos === away?.id ? 'away' : '';
  } else if (sport === 'baseball') {
    out.balls = situation.balls ?? 0;
    out.strikes = situation.strikes ?? 0;
    out.outs = situation.outs ?? 0;
    out.onFirst = !!situation.onFirst;
    out.onSecond = !!situation.onSecond;
    out.onThird = !!situation.onThird;
    out.batter = athleteName(situation.batter?.athlete);
    out.pitcher = athleteName(situation.pitcher?.athlete);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaders

const SKIP_LEADER_CATEGORIES = new Set(['rating']);

function leaderEntries(categories, { perCategory = 1, maxCategories = 3 } = {}) {
  const out = [];
  for (const cat of arr(categories)) {
    if (SKIP_LEADER_CATEGORIES.has(cat.name)) continue;
    if (out.length >= maxCategories) break;
    for (const l of arr(cat.leaders).slice(0, perCategory)) {
      out.push({
        category: cat.shortDisplayName || cat.abbreviation || cat.displayName || cat.name || '',
        categoryLong: cat.displayName || cat.shortDisplayName || cat.name || '',
        athlete: athleteName(l.athlete),
        athleteFull: l.athlete?.displayName || athleteName(l.athlete),
        position: l.athlete?.position?.abbreviation || '',
        headshot: l.athlete?.headshot?.href || l.athlete?.headshot || '',
        value: str(l.displayValue ?? l.value),
        teamId: str(l.team?.id || l.athlete?.team?.id),
      });
    }
  }
  return out;
}

function gameLeaders(comp, home, away) {
  if (arr(comp.leaders).length) {
    const leaders = leaderEntries(comp.leaders);
    for (const l of leaders) {
      l.teamAbbr = l.teamId === home.id ? home.abbr : l.teamId === away.id ? away.abbr : '';
    }
    return leaders;
  }
  // NBA / NHL / MLB put leaders on each competitor instead.
  // Listed away-then-home to match the card layout.
  const out = [];
  for (const team of [away, home]) {
    const c = arr(comp.competitors).find((x) => str(x.team?.id || x.id) === team.id);
    for (const l of leaderEntries(c?.leaders, { maxCategories: 1 })) {
      out.push({ ...l, teamId: team.id, teamAbbr: team.abbr });
    }
  }
  return out;
}

function probablePitchers(comp, home, away) {
  const out = [];
  for (const team of [away, home]) {
    const c = arr(comp.competitors).find((x) => str(x.team?.id || x.id) === team.id) || {};
    const p = arr(c.probables)[0];
    if (!p?.athlete) continue;
    out.push({
      teamAbbr: c.team?.abbreviation || '',
      athlete: athleteName(p.athlete),
      value: str(p.record || arr(p.statistics).find((s) => s.abbreviation === 'ERA')?.displayValue),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoreboard

export function normalizeEvent(event, leagueId) {
  const league = LEAGUES[leagueId];
  const comp = arr(event.competitions)[0] || {};
  const { home, away } = splitHomeAway(comp.competitors);
  const status = normalizeStatus(comp.status || event.status);
  const situation = status.state === 'in' ? normalizeSituation(comp.situation, league.sport, { home, away }) : null;
  if (situation?.possession) {
    home.possession = situation.possession === 'home';
    away.possession = situation.possession === 'away';
  }
  const broadcast =
    arr(comp.broadcasts).flatMap((b) => arr(b.names)).join(', ') ||
    arr(comp.geoBroadcasts)
      .map((b) => b.media?.shortName)
      .filter(Boolean)
      .join(', ');

  return {
    id: str(event.id),
    league: leagueId,
    sport: league.sport,
    date: event.date || comp.date || '',
    name: event.name || '',
    shortName: event.shortName || `${away.abbr} @ ${home.abbr}`,
    status,
    periodLabel: periodLabel(league.sport, status.period),
    home,
    away,
    situation,
    leaders: gameLeaders(comp, home, away),
    probables: league.sport === 'baseball' ? probablePitchers(comp, home, away) : [],
    broadcast,
    odds: oddsFromEspn(comp.odds),
    venue: comp.venue?.fullName || '',
    note: arr(comp.notes)[0]?.headline || '',
    series: comp.series?.summary || '',
    neutralSite: !!comp.neutralSite,
  };
}

const STATE_ORDER = { in: 0, pre: 1, post: 2 };

export function sortGames(games, favorites = new Set()) {
  const isFav = (g) => favorites.has(`${g.league}:${g.home.id}`) || favorites.has(`${g.league}:${g.away.id}`);
  return [...games].sort(
    (a, b) =>
      isFav(b) - isFav(a) ||
      STATE_ORDER[a.status.state] - STATE_ORDER[b.status.state] ||
      new Date(a.date) - new Date(b.date) ||
      a.shortName.localeCompare(b.shortName),
  );
}

// Football leagues expose a season calendar we can page through week by week.
export function weekCalendar(json) {
  const calendar = arr(json?.leagues?.[0]?.calendar);
  const weeks = [];
  for (const block of calendar) {
    if (typeof block !== 'object') continue;
    for (const e of arr(block.entries)) {
      weeks.push({
        seasontype: str(block.value),
        week: str(e.value),
        label: e.label || `Week ${e.value}`,
        detail: e.detail || '',
      });
    }
  }
  return weeks;
}

export function normalizeScoreboard(json, leagueId) {
  const games = arr(json?.events).map((e) => normalizeEvent(e, leagueId));
  const out = { games, week: null };
  if (LEAGUES[leagueId].weekly) {
    const weeks = weekCalendar(json);
    const seasontype = str(json?.season?.type ?? json?.leagues?.[0]?.season?.type?.type);
    const week = str(json?.week?.number);
    const year = str(json?.season?.year ?? json?.leagues?.[0]?.season?.year);
    let index = weeks.findIndex((w) => w.seasontype === seasontype && w.week === week);
    out.week = {
      year,
      label: index >= 0 ? weeks[index].label : week ? `Week ${week}` : '',
      detail: index >= 0 ? weeks[index].detail : '',
      prev: index > 0 ? { ...weeks[index - 1], year } : null,
      next: index >= 0 && index < weeks.length - 1 ? { ...weeks[index + 1], year } : null,
    };
    if (index < 0 && week && seasontype) {
      const n = Number(week);
      out.week.prev = n > 1 ? { seasontype, week: String(n - 1), year } : null;
      out.week.next = { seasontype, week: String(n + 1), year };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Game summary (box score, team stats, plays)

function linescoreLabels(sport, count) {
  const labels = [];
  for (let i = 1; i <= count; i++) {
    if (sport === 'baseball') labels.push(String(i));
    else if (sport === 'hockey') labels.push(i <= 3 ? String(i) : i === 4 ? 'OT' : i === 5 ? 'SO' : `${i - 3}OT`);
    else labels.push(i <= 4 ? String(i) : i === 5 ? 'OT' : `${i - 4}OT`);
  }
  return labels;
}

function statRows(stats) {
  return arr(stats).map((s) => ({
    key: s.name || s.label || s.abbreviation || '',
    label: s.label || s.displayName || s.shortDisplayName || s.abbreviation || s.name || '',
    value: str(s.displayValue ?? s.value),
  }));
}

// Team stat comparison. Most sports give a flat list; baseball groups stats
// into batting / pitching / fielding sections.
export function teamStatComparison(boxTeams, home, away) {
  const teams = arr(boxTeams);
  const find = (t) =>
    teams.find((bt) => str(bt.team?.id) === t.id) || teams.find((bt) => bt.homeAway === t.homeAway);
  const awayBox = find(away) || teams[0];
  const homeBox = find(home) || teams[1];
  if (!awayBox || !homeBox) return [];

  const sectionsOf = (bt) => {
    const stats = arr(bt.statistics);
    if (stats.some((s) => Array.isArray(s.stats))) {
      return stats.map((g) => ({ title: g.displayName || g.name || '', rows: statRows(g.stats) }));
    }
    return [{ title: '', rows: statRows(stats) }];
  };

  const awaySections = sectionsOf(awayBox);
  const homeSections = sectionsOf(homeBox);
  return awaySections.map((section, i) => {
    const homeSection = homeSections.find((s) => s.title === section.title) || homeSections[i] || { rows: [] };
    const homeByKey = new Map(homeSection.rows.map((r) => [r.key, r.value]));
    return {
      title: section.title,
      rows: section.rows
        .filter((r) => r.label && r.value !== '')
        .map((r) => ({ label: r.label, away: r.value, home: homeByKey.get(r.key) ?? '' })),
    };
  });
}

export function playerStatGroups(boxPlayers, teamOrder) {
  const out = [];
  for (const t of teamOrder) {
    const entry = arr(boxPlayers).find((p) => str(p.team?.id) === t.id);
    if (!entry) continue;
    const groups = arr(entry.statistics)
      .map((g) => {
        const labels = arr(g.labels).length ? g.labels : arr(g.names);
        const rows = arr(g.athletes)
          .map((a) => ({
            id: str(a.athlete?.id),
            name: athleteName(a.athlete),
            fullName: a.athlete?.displayName || athleteName(a.athlete),
            position: a.athlete?.position?.abbreviation || a.position?.abbreviation || '',
            jersey: str(a.athlete?.jersey),
            starter: !!a.starter,
            dnp: !!a.didNotPlay || (!arr(a.stats).length && !!a.reason),
            reason: a.reason || '',
            stats: arr(a.stats).map(str),
          }))
          .filter((r) => r.name);
        return {
          title: g.text || g.displayName || g.name || g.type || '',
          labels: labels.map(str),
          descriptions: arr(g.descriptions).map(str),
          rows,
          totals: arr(g.totals).map(str),
        };
      })
      .filter((g) => g.rows.length);
    out.push({ team: t, groups });
  }
  return out;
}

function recentPlays(json, sport, limit = 12) {
  let plays = [];
  if (sport === 'football') {
    const drives = json?.drives || {};
    const all = [...arr(drives.previous), ...(drives.current ? [drives.current] : [])];
    // The current drive is often also the last "previous" drive; dedupe by id.
    const seen = new Set();
    for (const d of all) {
      for (const p of arr(d.plays)) {
        const id = str(p.id) || `${d.id}:${p.sequenceNumber}:${p.text}`;
        if (seen.has(id)) continue;
        seen.add(id);
        plays.push({ ...p, team: p.team || d.team });
      }
    }
  } else {
    plays = arr(json?.plays);
  }
  return plays
    .filter((p) => str(p.text).trim())
    .slice(-limit)
    .reverse()
    .map((p) => ({
      text: str(p.text).trim(),
      period: p.period?.displayValue || (p.period?.number ? String(p.period.number) : ''),
      periodNumber: p.period?.number || 0,
      clock: p.clock?.displayValue || '',
      scoring: !!p.scoringPlay,
      awayScore: p.awayScore ?? null,
      homeScore: p.homeScore ?? null,
      teamId: str(p.team?.id),
    }));
}

function scoringSummary(json, sport) {
  let plays = arr(json?.scoringPlays);
  if (!plays.length && sport !== 'football') plays = arr(json?.plays).filter((p) => p.scoringPlay);
  // Basketball "scoring plays" would be every basket; not useful.
  if (sport === 'basketball') return [];
  return plays.map((p) => ({
    text: str(p.text).trim(),
    type: p.scoringType?.abbreviation || p.scoringType?.displayName || p.type?.abbreviation || '',
    period: p.period?.number || 0,
    clock: p.clock?.displayValue || '',
    teamId: str(p.team?.id),
    teamAbbr: p.team?.abbreviation || '',
    teamLogo: logoOf(p.team),
    awayScore: p.awayScore ?? null,
    homeScore: p.homeScore ?? null,
  }));
}

function summaryLeaders(json, teamOrder) {
  return teamOrder
    .map((t) => {
      const entry = arr(json?.leaders).find((l) => str(l.team?.id) === t.id);
      return entry ? { team: t, leaders: leaderEntries(entry.leaders, { maxCategories: 6 }) } : null;
    })
    .filter((l) => l && l.leaders.length);
}

export function normalizeSummary(json, leagueId) {
  const league = LEAGUES[leagueId];
  const sport = league.sport;
  const comp = arr(json?.header?.competitions)[0] || {};
  const { home, away } = splitHomeAway(comp.competitors);
  const status = normalizeStatus(comp.status);

  // Live football situation lives at the top level of the summary.
  const situation =
    status.state === 'in' ? normalizeSituation(json?.situation || comp.situation, sport, { home, away }) : null;
  if (situation?.possession) {
    home.possession = situation.possession === 'home';
    away.possession = situation.possession === 'away';
  }

  const periods = Math.max(away.linescores.length, home.linescores.length, sport === 'baseball' ? 9 : 0);
  const pad = (ls) => Array.from({ length: periods }, (_, i) => ls[i] ?? '');
  const linescore = periods
    ? {
        labels: linescoreLabels(sport, periods),
        away: pad(away.linescores),
        home: pad(home.linescores),
      }
    : null;

  const winProb = arr(json?.winprobability);
  const lastProb = winProb[winProb.length - 1];
  let homeWinPct = typeof lastProb?.homeWinPercentage === 'number' ? lastProb.homeWinPercentage : null;
  if (homeWinPct === null && typeof situation?.homeWinPct === 'number') homeWinPct = situation.homeWinPct;
  if (homeWinPct === null && status.state === 'pre') {
    const pred = json?.predictor;
    const h = Number(pred?.homeTeam?.gameProjection);
    if (Number.isFinite(h)) homeWinPct = h / 100;
  }

  const info = json?.gameInfo || {};
  const teamOrder = [away, home];

  return {
    id: str(json?.header?.id || comp.id),
    league: leagueId,
    sport,
    date: comp.date || '',
    status,
    periodLabel: periodLabel(sport, status.period),
    home,
    away,
    situation,
    linescore,
    homeWinPct,
    teamStats: teamStatComparison(json?.boxscore?.teams, home, away),
    players: playerStatGroups(json?.boxscore?.players, teamOrder),
    leaders: summaryLeaders(json, teamOrder),
    scoringPlays: scoringSummary(json, sport),
    plays: recentPlays(json, sport),
    venue: info.venue?.fullName || '',
    venueCity: [info.venue?.address?.city, info.venue?.address?.state].filter(Boolean).join(', '),
    attendance: info.attendance || null,
    broadcast: arr(comp.broadcasts)
      .map((b) => b.media?.shortName || b.media?.name)
      .filter(Boolean)
      .join(', '),
    note: arr(comp.notes)[0]?.headline || '',
    series: comp.series?.summary || '',
    odds: oddsFromEspn(arr(json?.pickcenter).length ? json.pickcenter : json?.odds),
  };
}

// ---------------------------------------------------------------------------
// Teams (favorites)

function teamInfo(t = {}, leagueId) {
  return {
    id: str(t.id),
    league: leagueId,
    abbr: t.abbreviation || t.shortDisplayName || '',
    name: t.shortDisplayName || t.name || t.displayName || '',
    fullName: t.displayName || t.name || '',
    nickname: t.name || '',
    location: t.location || '',
    logo: logoOf(t),
    color: t.color ? `#${t.color}` : '',
  };
}

// Every team in a league, for the favorites picker.
export function normalizeTeamList(json, leagueId) {
  const leagues = arr(json?.sports).flatMap((s) => arr(s.leagues));
  return leagues
    .flatMap((l) => arr(l.teams))
    .map((entry) => teamInfo(entry.team || entry, leagueId))
    .filter((t) => t.id && t.fullName && t.fullName !== 'TBD')
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

// A team's record, standing, current/next game and last result, from the
// team endpoint (live `nextEvent`) plus its schedule (past results).
export function normalizeTeamOverview(teamJson, scheduleJson, leagueId) {
  const t = teamJson?.team || {};
  const info = teamInfo(t, leagueId);
  const records = arr(t.record?.items);
  const record = records.find((r) => r.type === 'total') || records[0];
  const rank = t.rank && t.rank <= 25 ? t.rank : null;

  const nextEvent = arr(t.nextEvent)[0];
  const next = nextEvent ? normalizeEvent(nextEvent, leagueId) : null;

  let last = null;
  const completed = arr(scheduleJson?.events)
    .map((e) => normalizeEvent(e, leagueId))
    .filter((g) => g.status.completed && g.id !== next?.id)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const lastGame = completed[completed.length - 1];
  if (lastGame) {
    const side = lastGame.home.id === info.id ? 'home' : 'away';
    const us = lastGame[side];
    const them = lastGame[side === 'home' ? 'away' : 'home'];
    const a = Number(us.score);
    const b = Number(them.score);
    last = {
      gameId: lastGame.id,
      date: lastGame.date,
      result: us.winner ? 'W' : them.winner ? 'L' : Number.isFinite(a) && Number.isFinite(b) && a !== b ? (a > b ? 'W' : 'L') : 'T',
      score: `${us.score}-${them.score}`,
      opponent: them.abbr,
      home: side === 'home',
      detail: lastGame.status.detail,
    };
  }

  return {
    ...info,
    key: `${leagueId}:${info.id}`,
    rank,
    record: str(record?.summary),
    standing: t.standingSummary || '',
    next,
    last,
  };
}
