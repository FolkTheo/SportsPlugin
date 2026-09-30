// Courtside UI. The same page runs in three places, selected by ?mode=:
//   popup   – the toolbar popup
//   overlay – inside the draggable frame the content script puts over a page
//   window  – the pop-out window, which can also float on top via Document PiP

import { LEAGUES, LEAGUE_ORDER, periodShort } from '../lib/leagues.js';
import { fetchConferences, fetchDraftKingsOdds, fetchScoreboard, fetchSummary, fetchTeamOverview, fetchTeams } from '../lib/api.js';
import { sortGames } from '../lib/espn.js';
import { matchDraftKings, mergeOdds, noVigProbabilities } from '../lib/odds.js';
import * as store from '../lib/storage.js';

const MODE = new URLSearchParams(location.search).get('mode') || 'window';
const root = document.getElementById('app');
const $ = (sel) => root.querySelector(sel);

const state = {
  ui: { ...store.DEFAULT_UI },
  settings: { ...store.DEFAULT_SETTINGS },
  favorites: [],
  dayOffset: 0,
  weekQuery: null,
  scoreboard: null, // { key, games, week }
  summary: null,
  dkOdds: new Map(), // gameId -> DraftKings odds
  oddsError: null,
  preview: null, // scoreboard game shown while its summary loads
  boxSide: 'away',
  loading: false,
  error: null,
  updatedAt: null,
  changed: new Set(), // "gameId:side" keys whose score just changed
  showSettings: false,
  picker: null, // { league, query, teams, error } while choosing favorite teams
  conferences: {}, // college league -> [{ id, name, label }]
  pip: null,
};

// ---------------------------------------------------------------------------
// Utilities

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const favKeys = () => new Set(state.favorites.map((f) => f.key));
const isFavTeam = (league, team) => favKeys().has(store.favoriteKey(league, team.id));

function ymd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function offsetDate(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
}

function dayLabel(offset) {
  const d = offsetDate(offset);
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (offset === 0) return `Today · ${date}`;
  if (offset === -1) return `Yesterday · ${date}`;
  if (offset === 1) return `Tomorrow · ${date}`;
  return date;
}

function kickoffLabel(game) {
  const d = new Date(game.date);
  if (Number.isNaN(d.getTime()) || /TBD/i.test(game.status.detail)) return game.status.detail || 'TBD';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const days = (d - now) / 86400000;
  const date =
    days > -6 && days < 6
      ? d.toLocaleDateString([], { weekday: 'short' })
      : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  return `${date} ${time}`;
}

function statusText(game) {
  const s = game.status;
  if (s.state === 'pre' && !s.delayed) return kickoffLabel(game);
  return s.detail || s.longDetail || '';
}

function logo(team, size = 22) {
  if (!team.logo) return `<span class="logo logo-fallback" style="width:${size}px;height:${size}px">${esc(team.abbr.slice(0, 3))}</span>`;
  return `<img class="logo" src="${esc(team.logo)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" />`;
}

let toastTimer = null;
function toast(message, ms = 3500) {
  const el = $('.toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Refresh scheduling (via a worker so hidden pages aren't throttled)

const ticker = (() => {
  let worker = null;
  let seq = 0;
  let callback = null;
  let fallback = null;
  try {
    worker = new Worker('tick-worker.js');
    worker.onmessage = ({ data }) => data === seq && callback?.();
  } catch {
    worker = null;
  }
  return {
    set(delayMs, fn) {
      callback = fn;
      seq += 1;
      clearTimeout(fallback);
      if (worker) worker.postMessage({ id: seq, delay: delayMs });
      else fallback = setTimeout(fn, delayMs);
    },
    clear() {
      seq += 1;
      callback = null;
      clearTimeout(fallback);
      worker?.postMessage({ id: seq, delay: -1 });
    },
  };
})();

function isPaused() {
  return document.hidden && !state.pip;
}

function nextDelayMs() {
  const games = state.ui.view === 'game' ? [state.summary].filter(Boolean) : state.scoreboard?.games || [];
  const live = games.some((g) => g.status.state === 'in');
  if (live) return state.settings.refreshSeconds * 1000;
  const soon = games.some((g) => g.status.state === 'pre' && new Date(g.date) - Date.now() < 20 * 60000);
  return (soon ? 30 : 120) * 1000;
}

function schedule() {
  if (isPaused()) return ticker.clear();
  ticker.set(state.error ? 20000 : nextDelayMs(), () => load({ quiet: true }));
}

// ---------------------------------------------------------------------------
// Data loading

function scoreboardQuery(leagueId) {
  const def = LEAGUES[leagueId];
  // A chosen conference replaces the league-wide group (all FBS / all D-I).
  const conference = selectedConference(leagueId);
  const query = conference ? { groups: conference } : {};
  if (def.weekly) {
    const w = state.weekQuery;
    if (w) Object.assign(query, { seasontype: w.seasontype, week: w.week, dates: w.year });
  } else if (state.dayOffset !== 0) {
    query.dates = ymd(offsetDate(state.dayOffset));
  }
  return query;
}

function selectedConference(leagueId) {
  return LEAGUES[leagueId]?.college ? state.settings.conferences?.[leagueId] || '' : '';
}

const top25Key = (leagueId) => `${leagueId}Top25Only`;

async function ensureConferences(leagueId) {
  if (!LEAGUES[leagueId]?.college || state.conferences[leagueId]) return;
  state.conferences[leagueId] = []; // mark as loading
  state.conferences[leagueId] = await fetchConferences(leagueId);
  if (state.ui.league === leagueId) render();
}

function scoreboardKey() {
  const league = state.ui.league;
  if (league === 'fav') return 'fav';
  return `${league}|${JSON.stringify(scoreboardQuery(league))}`;
}

// One overview per favorite team: record, standing, current/next game and
// last result. The next games double as the view's game list, so live
// refresh, score flashes and odds work just like a league scoreboard.
async function loadFavoriteTeams() {
  const favorites = state.favorites.filter((f) => LEAGUES[f.league]);
  const results = await Promise.allSettled(favorites.map((f) => fetchTeamOverview(f.league, f.teamId)));
  if (results.length && results.every((r) => r.status === 'rejected')) throw results[0].reason;
  const teams = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { ...favorites[i], id: favorites[i].teamId, fullName: favorites[i].name, error: true },
  );
  return { games: teams.map((t) => t.next).filter(Boolean), teams, week: null };
}

function recordChanges(prevGames, nextGames) {
  const prev = new Map();
  for (const g of prevGames) {
    prev.set(`${g.id}:away`, g.away.score);
    prev.set(`${g.id}:home`, g.home.score);
  }
  const changed = new Set();
  for (const g of nextGames) {
    for (const side of ['away', 'home']) {
      const before = prev.get(`${g.id}:${side}`);
      if (before !== undefined && before !== '' && before !== g[side].score) changed.add(`${g.id}:${side}`);
    }
  }
  if (changed.size) {
    state.changed = changed;
    setTimeout(() => {
      state.changed = new Set();
      root.querySelectorAll('.bump').forEach((el) => el.classList.remove('bump'));
    }, 2500);
  }
}

let loadSeq = 0;
async function load({ quiet = false } = {}) {
  const seq = ++loadSeq;
  if (state.ui.view !== 'game') ensureConferences(state.ui.league);
  ticker.clear();
  if (!quiet) {
    state.loading = true;
    render();
  }
  try {
    if (state.ui.view === 'game' && state.ui.gameId) {
      const summary = await fetchSummary(state.ui.gameLeague, state.ui.gameId);
      if (seq !== loadSeq) return;
      recordChanges(state.summary && state.summary.id === summary.id ? [state.summary] : [], [summary]);
      state.summary = summary;
    } else {
      const key = scoreboardKey();
      const data = state.ui.league === 'fav' ? await loadFavoriteTeams() : await fetchScoreboard(state.ui.league, scoreboardQuery(state.ui.league));
      if (seq !== loadSeq) return;
      recordChanges(state.scoreboard?.key === key ? state.scoreboard.games : [], data.games);
      state.scoreboard = { key, ...data };
    }
    state.error = null;
    state.updatedAt = new Date();
  } catch (err) {
    if (seq !== loadSeq) return;
    state.error = err?.message || 'Could not load scores';
  }
  state.loading = false;
  render();
  schedule();
  if (!state.error) refreshOdds(seq);
}

// DraftKings lines load after the scores so a slow or blocked sportsbook
// request never holds up the scoreboard. ESPN's odds show in the meantime.
async function refreshOdds(seq) {
  if (!state.settings.showOdds) return;
  const games = (state.ui.view === 'game' ? [state.summary] : state.scoreboard?.games || []).filter(
    (g) => g && g.status.state !== 'post',
  );
  const leagues = [...new Set(games.map((g) => g.league))];
  if (!leagues.length) return;
  const results = await Promise.allSettled(leagues.map((l) => fetchDraftKingsOdds(l)));
  if (seq !== loadSeq) return;
  state.oddsError = null;
  results.forEach((r, i) => {
    const leagueGames = games.filter((g) => g.league === leagues[i]);
    for (const g of leagueGames) state.dkOdds.delete(g.id);
    if (r.status === 'fulfilled') {
      for (const [id, odds] of matchDraftKings(leagueGames, r.value)) state.dkOdds.set(id, odds);
    } else {
      state.oddsError = r.reason?.message || 'DraftKings odds unavailable';
    }
  });
  render();
}

function oddsFor(game) {
  if (!state.settings.showOdds || !game) return null;
  // Once a game ends, show ESPN's closing line rather than a stale live one.
  if (game.status.state === 'post') return game.odds;
  return mergeOdds(state.dkOdds.get(game.id), game.odds);
}

// ---------------------------------------------------------------------------
// Rendering: shell

function render() {
  renderTabs();
  const content = $('.content');
  const scrollTop = content.scrollTop;
  const sameView = content.dataset.view === viewKey();
  if (state.showSettings) content.innerHTML = renderSettings();
  else if (state.picker) content.innerHTML = renderPicker();
  else if (state.ui.view === 'game') content.innerHTML = renderGame();
  else if (state.ui.league === 'fav') content.innerHTML = renderFavorites();
  else content.innerHTML = renderScores();
  content.dataset.view = viewKey();
  if (sameView) content.scrollTop = scrollTop;
  renderStatusBar();
}

function viewKey() {
  if (state.showSettings) return 'settings';
  if (state.picker) return `picker:${state.picker.league}`;
  if (state.ui.view === 'game') return `game:${state.ui.gameId}:${state.ui.gameTab}:${state.boxSide}`;
  return `scores:${scoreboardKey()}`;
}

function renderTabs() {
  const tabs = ['fav', ...LEAGUE_ORDER];
  const active = state.ui.view === 'game' ? state.ui.gameLeague : state.ui.league;
  $('.league-tabs').innerHTML = tabs
    .map((id) => {
      const label = id === 'fav' ? '★<span class="tab-text"> Favorites</span>' : esc(LEAGUES[id].label);
      const title = id === 'fav' ? 'Your favorite teams' : LEAGUES[id].name;
      const selected = !state.showSettings && (state.picker ? id === 'fav' : state.ui.view === 'game' ? id === active : id === state.ui.league);
      return `<button role="tab" class="tab${selected ? ' active' : ''}" aria-selected="${selected}" data-action="league" data-league="${id}" title="${esc(title)}">${label}</button>`;
    })
    .join('');
}

function renderStatusBar() {
  const el = $('.statusbar');
  if (state.error && !state.loading) {
    el.innerHTML = `<span class="err">⚠ ${esc(state.error)}</span> <button class="link" data-action="refresh">Retry</button>`;
    return;
  }
  const games = state.ui.view === 'game' ? [state.summary].filter(Boolean) : state.scoreboard?.games || [];
  const live = games.some((g) => g.status.state === 'in');
  const time = state.updatedAt ? state.updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—';
  el.innerHTML =
    (state.loading ? '<span class="spinner" aria-hidden="true"></span> Updating…' : `Updated ${esc(time)}`) +
    (live ? ` <span class="live-dot" aria-hidden="true"></span> Live · every ${state.settings.refreshSeconds}s` : '') +
    ' <span class="source">Data: ESPN</span>';
}

// ---------------------------------------------------------------------------
// Rendering: scoreboard

function renderSubbar() {
  const league = state.ui.league;
  const def = LEAGUES[league];
  let nav;
  if (def.weekly) {
    const week = state.scoreboard?.key === scoreboardKey() ? state.scoreboard.week : null;
    const label = week ? `${week.label}${week.detail ? ` · ${week.detail}` : ''}` : 'Loading…';
    nav = `
      <button class="nav-btn" data-action="week" data-dir="prev" ${week?.prev ? '' : 'disabled'} aria-label="Previous week">‹</button>
      <span class="sub-label">${esc(label)}</span>
      <button class="nav-btn" data-action="week" data-dir="next" ${week?.next ? '' : 'disabled'} aria-label="Next week">›</button>
      ${state.weekQuery ? '<button class="chip" data-action="week" data-dir="current">This week</button>' : ''}`;
  } else {
    nav = `
      <button class="nav-btn" data-action="day" data-dir="-1" aria-label="Previous day">‹</button>
      <span class="sub-label">${esc(dayLabel(state.dayOffset))}</span>
      <button class="nav-btn" data-action="day" data-dir="1" aria-label="Next day">›</button>
      ${state.dayOffset ? '<button class="chip" data-action="day" data-dir="0">Today</button>' : ''}`;
  }
  return `<div class="subbar">${nav}</div>${def.college ? collegeFilters(league) : ''}`;
}

function conferenceLabel(leagueId, id) {
  return (state.conferences[leagueId] || []).find((c) => c.id === id)?.label || '';
}

function collegeFilters(league) {
  const selected = selectedConference(league);
  const list = state.conferences[league] || [];
  const options = list.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''} title="${esc(c.name)}">${esc(c.label)}</option>`);
  // Keep a saved choice visible even before the list has loaded.
  if (selected && !list.some((c) => c.id === selected)) options.unshift(`<option value="${esc(selected)}" selected>Selected conference</option>`);
  const top25 = state.settings[top25Key(league)];
  return `
    <div class="filterbar">
      <label class="conf-filter${selected ? ' on' : ''}">
        <span class="sr-only">Conference</span>
        <select data-conference="${esc(league)}" aria-label="Filter by conference">
          <option value="">All conferences</option>
          ${options.join('')}
        </select>
      </label>
      <button class="chip${top25 ? ' on' : ''}" data-action="top25" aria-pressed="${!!top25}" title="Only show games with a ranked team">Top 25</button>
    </div>`;
}

function visibleGames() {
  let games = state.scoreboard?.games || [];
  if (LEAGUES[state.ui.league]?.college && state.settings[top25Key(state.ui.league)]) games = games.filter((g) => g.home.rank || g.away.rank);
  if (state.settings.hideFinal) games = games.filter((g) => g.status.state !== 'post');
  return sortGames(games, favKeys());
}

function renderScores() {
  const current = state.scoreboard?.key === scoreboardKey();
  let body;
  if (!current && state.loading) body = skeletonCards();
  else if (!current && state.error) body = `<div class="empty">Couldn't load games.<br /><button class="btn" data-action="refresh">Try again</button></div>`;
  else {
    const games = visibleGames();
    if (!games.length) {
      const conf = conferenceLabel(state.ui.league, selectedConference(state.ui.league));
      const msg =
        state.scoreboard?.games.length && LEAGUES[state.ui.league]?.college && state.settings[top25Key(state.ui.league)]
          ? `No games with a ranked team${conf ? ` in the ${conf}` : ''}.`
          : conf && !state.scoreboard?.games.length
            ? `No ${conf} games scheduled.`
            : state.settings.hideFinal && state.scoreboard?.games.length
            ? 'All games are final. (Finished games are hidden in settings.)'
            : 'No games scheduled.';
      body = `<div class="empty">${esc(msg)}</div>`;
    } else {
      const live = games.filter((g) => g.status.state === 'in').length;
      body =
        (live ? `<div class="section-label"><span class="live-dot"></span> ${live} live</div>` : '') +
        `<div class="games${state.settings.compact ? ' compact' : ''}">${games.map(gameCard).join('')}</div>`;
    }
  }
  return renderSubbar() + body;
}

function skeletonCards() {
  return `<div class="games">${'<div class="game skeleton"><div></div><div></div></div>'.repeat(4)}</div>`;
}

function teamRow(game, side) {
  const t = game[side];
  const other = game[side === 'home' ? 'away' : 'home'];
  const done = game.status.state === 'post';
  const loser = done && !t.winner && other.winner;
  const bump = state.changed.has(`${game.id}:${side}`) ? ' bump' : '';
  const fav = isFavTeam(game.league, t) ? '<span class="fav-mark" title="Favorite">★</span>' : '';
  return `
    <div class="team-row${loser ? ' loser' : ''}${t.winner && done ? ' winner' : ''}">
      ${logo(t)}
      ${t.rank ? `<span class="rank">${t.rank}</span>` : ''}
      <span class="team-name" title="${esc(t.fullName)}">${esc(state.settings.compact ? t.abbr : t.name)}</span>
      ${t.possession ? '<span class="poss" title="Possession">●</span>' : ''}
      ${fav}
      <span class="record">${esc(t.record)}</span>
      <span class="score${bump}">${game.status.state === 'pre' ? '' : esc(t.score)}</span>
    </div>`;
}

function situationLine(game) {
  const s = game.situation;
  if (!s) return '';
  if (game.sport === 'football' && s.downDistance) {
    return `<div class="situation${s.isRedZone ? ' redzone' : ''}">${esc(s.downDistance)}${s.isRedZone ? ' · Red zone' : ''}</div>`;
  }
  if (game.sport === 'baseball') {
    return `<div class="situation bases-line">${diamond(s)} <span>${s.balls}-${s.strikes}, ${s.outs} out${s.outs === 1 ? '' : 's'}</span>${
      s.batter ? ` <span class="muted">AB: ${esc(s.batter)}</span>` : ''
    }</div>`;
  }
  return '';
}

function diamond(s, size = 22) {
  const base = (on, x, y) =>
    `<rect x="${x}" y="${y}" width="7" height="7" transform="rotate(45 ${x + 3.5} ${y + 3.5})" class="${on ? 'on' : ''}"/>`;
  return `<svg class="diamond" viewBox="0 0 26 20" width="${size}" height="${(size * 20) / 26}" aria-label="Runners: ${
    [s.onFirst && '1st', s.onSecond && '2nd', s.onThird && '3rd'].filter(Boolean).join(', ') || 'none'
  }">${base(s.onSecond, 9.5, 2)}${base(s.onThird, 3, 9)}${base(s.onFirst, 16, 9)}</svg>`;
}

function cardLeaders(game) {
  if (game.status.state === 'pre') {
    if (game.probables.length) {
      return `<div class="leaders">${game.probables
        .map((p) => `<span><b>${esc(p.teamAbbr)}</b> ${esc(p.athlete)}${p.value ? ` <span class="muted">${esc(p.value)}</span>` : ''}</span>`)
        .join('')}</div>`;
    }
    return '';
  }
  if (!game.leaders.length) return '';
  return `<div class="leaders">${game.leaders
    .slice(0, 3)
    .map(
      (l) =>
        `<span title="${esc(l.categoryLong)}"><b>${esc(l.category)}</b> ${esc(l.athlete)}${l.teamAbbr ? ` <span class="muted">${esc(l.teamAbbr)}</span>` : ''} ${esc(l.value)}</span>`,
    )
    .join('')}</div>`;
}

function gameCard(game) {
  const s = game.status;
  const compact = state.settings.compact;
  const meta = [];
  if (s.state === 'pre') {
    if (game.broadcast) meta.push(esc(game.broadcast));
  }
  const note = game.note || game.series;
  const lastPlay = s.state === 'in' && game.situation?.lastPlay && !compact
    ? `<div class="last-play" title="${esc(game.situation.lastPlay)}">${esc(game.situation.lastPlay)}</div>`
    : '';
  return `
    <button class="game state-${s.state}" data-action="open-game" data-id="${esc(game.id)}" data-league="${esc(game.league)}"
      aria-label="${esc(`${game.away.fullName} ${game.away.score} at ${game.home.fullName} ${game.home.score}, ${statusText(game)}`)}">
      ${note && !compact ? `<div class="note">${esc(note)}</div>` : ''}
      <div class="game-main">
        <div class="teams">${teamRow(game, 'away')}${teamRow(game, 'home')}</div>
        <div class="game-status">
          <span class="status-text${s.state === 'in' ? ' live' : ''}">${esc(statusText(game))}</span>
          ${meta.length ? `<span class="meta">${meta.join(' · ')}</span>` : ''}
        </div>
      </div>
      ${compact ? '' : situationLine(game)}
      ${lastPlay}
      ${compact ? '' : oddsLine(game)}
      ${compact ? '' : cardLeaders(game)}
    </button>`;
}

function bookLabel(odds) {
  return /draft\s*kings/i.test(odds.provider) ? 'DK' : odds.provider;
}

// The favorite's spread, e.g. "KC -2.5" (or "PK").
function spreadText(game, odds) {
  const { away, home } = odds.spread;
  if (away.line === 'PK' || home.line === 'PK') return 'PK';
  const side = away.line.startsWith('-') ? 'away' : 'home';
  return `<b>${esc(game[side].abbr)}</b> ${esc(odds.spread[side].line)}`;
}

function oddsLine(game) {
  if (game.status.state === 'post') return '';
  const o = oddsFor(game);
  if (!o) return '';
  const parts = [];
  if (o.spread) parts.push(spreadText(game, o));
  else if (o.details) parts.push(esc(o.details));
  if (o.total?.line) parts.push(`O/U ${esc(o.total.line)}`);
  if (o.moneyline) {
    parts.push(`ML <b>${esc(game.away.abbr)}</b> ${esc(o.moneyline.away)} <b>${esc(game.home.abbr)}</b> ${esc(o.moneyline.home)}`);
  }
  if (!parts.length) return '';
  const live = o.live && game.status.state === 'in';
  return `<div class="odds-line" title="${esc(`${o.provider} odds${o.source === 'espn' ? ' via ESPN' : ''}`)}"><span class="book">${esc(bookLabel(o))}</span>${parts.join(
    ' · ',
  )}${live ? ' <span class="live-tag">LIVE</span>' : ''}${o.suspended ? ' <span class="muted">suspended</span>' : ''}</div>`;
}

// ---------------------------------------------------------------------------
// Rendering: favorites

const NEXT_ORDER = { in: 0, pre: 1, post: 2 };

function favoriteTeams() {
  // Filter by the live favorites list so removals show instantly; teams added
  // since the last load show as placeholders until the next refresh.
  const loaded = new Map((state.scoreboard?.key === 'fav' ? state.scoreboard.teams || [] : []).map((t) => [t.key || `${t.league}:${t.id}`, t]));
  return state.favorites
    .filter((f) => LEAGUES[f.league])
    .map((f) => loaded.get(f.key) || { ...f, id: f.teamId, fullName: f.name, pending: true })
    .sort(
      (a, b) =>
        (a.next ? NEXT_ORDER[a.next.status.state] : 3) - (b.next ? NEXT_ORDER[b.next.status.state] : 3) ||
        (a.next && b.next ? new Date(a.next.date) - new Date(b.next.date) : 0) ||
        a.fullName.localeCompare(b.fullName),
    );
}

function renderFavorites() {
  const head = `<div class="subbar"><span class="sub-label">Your teams</span><span class="spacer"></span><button class="chip" data-action="add-teams">+ Add teams</button></div>`;
  if (!state.favorites.length) {
    return (
      head +
      `<div class="empty">Follow your teams to see their live scores, next games and latest results here.<br />
        <button class="btn" data-action="add-teams">Choose teams</button></div>`
    );
  }
  if (state.scoreboard?.key !== 'fav' && state.error && !state.loading) {
    return head + `<div class="empty">Couldn't load your teams.<br /><button class="btn" data-action="refresh">Try again</button></div>`;
  }
  const teams = favoriteTeams();
  const live = teams.filter((t) => t.next?.status.state === 'in').length;
  return (
    head +
    (live ? `<div class="section-label"><span class="live-dot"></span> ${live} playing now</div>` : '') +
    `<div class="fav-teams">${teams.map(favoriteTeamCard).join('')}</div>`
  );
}

function favoriteTeamCard(t) {
  const meta = [LEAGUES[t.league]?.label, t.record, t.standing].filter(Boolean).join(' · ');
  let body;
  if (t.pending) body = '<div class="game skeleton"></div>';
  else if (t.error) body = `<div class="fav-none">Couldn't load this team right now.</div>`;
  else if (t.next) body = gameCard(t.next);
  else body = '<div class="fav-none">No upcoming games scheduled.</div>';
  const last = t.last
    ? `<button class="fav-last" data-action="open-game" data-id="${esc(t.last.gameId)}" data-league="${esc(t.league)}">
        Last: <b class="res res-${esc(t.last.result)}">${esc(t.last.result)}</b> ${esc(t.last.score)} ${t.last.home ? 'vs' : '@'} ${esc(t.last.opponent)}
        <span class="muted">· ${esc(new Date(t.last.date).toLocaleDateString([], { month: 'short', day: 'numeric' }))}${
          t.last.detail && t.last.detail !== 'Final' ? ` · ${esc(t.last.detail)}` : ''
        }</span>
      </button>`
    : '';
  return `
    <section class="fav-team" style="--team:${esc(t.color || 'var(--line)')}">
      <div class="fav-head">
        ${logo({ logo: t.logo, abbr: t.abbr || '' }, 30)}
        <div class="fav-title">
          <span class="fav-name">${t.rank ? `<span class="rank">${t.rank}</span> ` : ''}${esc(t.fullName)}</span>
          ${meta ? `<span class="fav-meta">${esc(meta)}</span>` : ''}
        </div>
        <button class="star on" data-action="unfavorite" data-key="${esc(t.key || `${t.league}:${t.id}`)}" title="Remove from favorites" aria-label="Remove ${esc(t.fullName)} from favorites">★</button>
      </div>
      ${body}
      ${last}
    </section>`;
}

function renderPicker() {
  const p = state.picker;
  return `
    <div class="gv-nav"><button class="back" data-action="close-picker">‹ Done</button><span class="gv-league">Add favorite teams</span></div>
    <div class="seg picker-leagues" role="tablist">${LEAGUE_ORDER.map(
      (id) => `<button class="${id === p.league ? 'active' : ''}" data-action="picker-league" data-league="${id}">${esc(LEAGUES[id].label)}</button>`,
    ).join('')}</div>
    <input class="picker-search" type="search" data-picker-search placeholder="Search ${esc(LEAGUES[p.league].label)} teams" value="${esc(p.query)}" autocomplete="off" />
    <ul class="team-picker">${pickerList()}</ul>`;
}

function pickerList() {
  const p = state.picker;
  if (p.error) return `<li class="empty small">Couldn't load teams.<br /><button class="btn" data-action="picker-league" data-league="${esc(p.league)}">Try again</button></li>`;
  if (!p.teams) return '<li class="empty small"><span class="spinner"></span></li>';
  const q = p.query.trim().toLowerCase();
  const teams = q ? p.teams.filter((t) => [t.fullName, t.abbr, t.location].some((v) => v.toLowerCase().includes(q))) : p.teams;
  if (!teams.length) return '<li class="empty small">No teams match.</li>';
  return teams
    .map((t) => {
      const on = isFavTeam(p.league, t);
      return `<li><button class="pick${on ? ' on' : ''}" data-action="pick-team" data-id="${esc(t.id)}" aria-pressed="${on}" title="${on ? 'Remove from' : 'Add to'} favorites">
        ${logo(t, 24)}<span class="pick-name">${esc(t.fullName)}</span><span class="pick-abbr">${esc(t.abbr)}</span><span class="pick-star">★</span></button></li>`;
    })
    .join('');
}

async function loadPickerTeams() {
  const league = state.picker.league;
  try {
    const teams = await fetchTeams(league);
    if (state.picker?.league !== league) return;
    state.picker.teams = teams;
  } catch (err) {
    if (state.picker?.league !== league) return;
    state.picker.error = err.message || 'Could not load teams';
  }
  const list = $('.team-picker');
  if (list) list.innerHTML = pickerList();
}

function openPicker(league) {
  state.showSettings = false;
  state.picker = { league: LEAGUES[league] ? league : 'nfl', query: '', teams: null, error: null };
  render();
  $('.picker-search')?.focus();
  loadPickerTeams();
}

// ---------------------------------------------------------------------------
// Rendering: game detail

function gameTabs(g) {
  const tabs = [];
  if (g.players.some((p) => p.groups.length)) tabs.push(['box', 'Box Score']);
  if (g.teamStats.some((s) => s.rows.length)) tabs.push(['team', 'Team Stats']);
  if (g.plays.length) tabs.push(['plays', 'Plays']);
  if (g.scoringPlays.length) tabs.push(['scoring', 'Scoring']);
  if (oddsFor(g)) tabs.push(['odds', 'Odds']);
  if (g.leaders.length) tabs.push(['leaders', 'Leaders']);
  tabs.push(['info', 'Info']);
  return tabs;
}

function renderGame() {
  const g = state.summary && state.summary.id === state.ui.gameId ? state.summary : null;
  const head = g || state.preview;
  const back = `<div class="gv-nav"><button class="back" data-action="back">‹ Scores</button><span class="gv-league">${esc(
    LEAGUES[state.ui.gameLeague]?.label || '',
  )}${head?.note ? ` · ${esc(head.note)}` : ''}${head?.series ? ` · ${esc(head.series)}` : ''}</span></div>`;
  if (!head) {
    return back + (state.error ? `<div class="empty">Couldn't load this game.<br /><button class="btn" data-action="refresh">Try again</button></div>` : '<div class="empty"><span class="spinner"></span></div>');
  }
  let body = '';
  if (g) {
    const tabs = gameTabs(g);
    const tab = tabs.some(([id]) => id === state.ui.gameTab) ? state.ui.gameTab : tabs[0][0];
    body = `
      ${linescoreTable(g)}
      <div class="gv-tabs" role="tablist">${tabs
        .map(([id, label]) => `<button role="tab" class="gv-tab${id === tab ? ' active' : ''}" aria-selected="${id === tab}" data-action="game-tab" data-tab="${id}">${label}</button>`)
        .join('')}</div>
      <div class="gv-body">${renderGameTab(g, tab)}</div>`;
  } else {
    body = '<div class="empty"><span class="spinner"></span></div>';
  }
  return back + scorebug(head) + gameSituation(head) + winProbability(g) + body;
}

function scorebugTeam(game, side) {
  const t = game[side];
  const fav = isFavTeam(game.league, t);
  return `
    <div class="sb-team ${side}" style="--team:${esc(t.color || 'transparent')}">
      ${logo(t, 40)}
      <div class="sb-name">${t.rank ? `<span class="rank">${t.rank}</span>` : ''}${esc(t.abbr)}${t.possession ? ' <span class="poss">●</span>' : ''}</div>
      <div class="sb-record">${esc(t.record)}</div>
      <button class="star${fav ? ' on' : ''}" data-action="favorite" data-side="${side}" title="${fav ? 'Remove from' : 'Add to'} favorites" aria-pressed="${fav}">★</button>
    </div>`;
}

function scorebug(g) {
  const pre = g.status.state === 'pre';
  const score = (side) =>
    `<div class="sb-score${state.changed.has(`${g.id}:${side}`) ? ' bump' : ''}${g.status.state === 'post' && !g[side].winner ? ' loser' : ''}">${pre ? '' : esc(g[side].score)}</div>`;
  return `
    <section class="scorebug">
      ${scorebugTeam(g, 'away')}
      ${score('away')}
      <div class="sb-status${g.status.state === 'in' ? ' live' : ''}">${esc(statusText(g))}</div>
      ${score('home')}
      ${scorebugTeam(g, 'home')}
    </section>`;
}

function gameSituation(g) {
  const s = g.situation;
  if (!s) return '';
  const parts = [];
  if (g.sport === 'football' && s.downDistance) {
    const who = s.possession ? g[s.possession].abbr : '';
    parts.push(`<div class="gs-main${s.isRedZone ? ' redzone' : ''}">${who ? `<b>${esc(who)}</b> · ` : ''}${esc(s.downDistance)}${s.isRedZone ? ' · Red zone' : ''}</div>`);
  }
  if (g.sport === 'baseball') {
    parts.push(`<div class="gs-main bases-line">${diamond(s, 34)}
      <span class="count"><b>${s.balls}-${s.strikes}</b> · ${s.outs} out${s.outs === 1 ? '' : 's'}</span>
      <span class="matchup">${s.pitcher ? `P: ${esc(s.pitcher)}` : ''}${s.batter ? `<br />AB: ${esc(s.batter)}` : ''}</span></div>`);
  }
  if (s.lastPlay) parts.push(`<div class="gs-last"><span class="muted">Last play:</span> ${esc(s.lastPlay)}</div>`);
  return parts.length ? `<section class="game-situation">${parts.join('')}</section>` : '';
}

function winProbability(g) {
  if (!g || typeof g.homeWinPct !== 'number' || g.status.state === 'post') return '';
  const home = Math.round(g.homeWinPct * 1000) / 10;
  const away = Math.round((100 - home) * 10) / 10;
  return `
    <section class="winprob" title="${g.status.state === 'pre' ? 'Projected' : 'Live'} win probability (ESPN)">
      <span class="wp-label">${esc(g.away.abbr)} ${away}%</span>
      <div class="wp-bar"><div style="width:${away}%;background:${esc(g.away.color || 'var(--accent)')}"></div><div style="width:${home}%;background:${esc(g.home.color || 'var(--muted)')}"></div></div>
      <span class="wp-label">${home}% ${esc(g.home.abbr)}</span>
    </section>`;
}

function linescoreTable(g) {
  const ls = g.linescore;
  if (!ls || g.status.state === 'pre') return '';
  const rhe = g.sport === 'baseball' && g.away.hits !== null && g.home.hits !== null;
  const row = (side) => {
    const t = g[side];
    return `<tr><th>${esc(t.abbr)}</th>${ls[side].map((v) => `<td>${esc(v)}</td>`).join('')}<td class="total">${esc(t.score)}</td>${
      rhe ? `<td>${esc(t.hits)}</td><td>${esc(t.errors)}</td>` : ''
    }</tr>`;
  };
  return `
    <div class="table-wrap"><table class="linescore">
      <thead><tr><th></th>${ls.labels.map((l) => `<th>${esc(l)}</th>`).join('')}<th class="total">${g.sport === 'baseball' ? 'R' : 'T'}</th>${rhe ? '<th>H</th><th>E</th>' : ''}</tr></thead>
      <tbody>${row('away')}${row('home')}</tbody>
    </table></div>`;
}

function renderGameTab(g, tab) {
  switch (tab) {
    case 'box':
      return boxScore(g);
    case 'team':
      return teamStats(g);
    case 'plays':
      return playsList(g);
    case 'scoring':
      return scoringList(g);
    case 'odds':
      return oddsPanel(g);
    case 'leaders':
      return leadersList(g);
    default:
      return gameInfo(g);
  }
}

function boxScore(g) {
  const side = state.boxSide;
  const team = g[side];
  const entry = g.players.find((p) => p.team.id === team.id);
  const toggle = `
    <div class="seg" role="tablist">
      ${['away', 'home']
        .map((s) => `<button class="${s === side ? 'active' : ''}" data-action="box-side" data-side="${s}">${logo(g[s], 16)} ${esc(g[s].abbr)}</button>`)
        .join('')}
    </div>`;
  if (!entry || !entry.groups.length) return toggle + '<div class="empty small">No player stats yet.</div>';
  return (
    toggle +
    entry.groups
      .map((group) => {
        const cols = group.labels.length;
        const head = `<tr><th class="player">${esc(group.title)}</th>${group.labels
          .map((l, i) => `<th title="${esc(group.descriptions[i] || l)}">${esc(l)}</th>`)
          .join('')}</tr>`;
        let lastStarter = null;
        const rows = group.rows
          .map((r) => {
            // Basketball lists starters then bench; mark the break.
            const divider = lastStarter === true && !r.starter ? ' class="bench-start"' : '';
            lastStarter = r.starter;
            const name = `<th class="player" title="${esc(r.fullName)}">${esc(r.name)}${r.position ? ` <span class="pos">${esc(r.position)}</span>` : ''}</th>`;
            if (r.dnp || !r.stats.length) {
              return `<tr${divider}>${name}<td class="dnp" colspan="${cols}">${esc(r.reason || 'DNP')}</td></tr>`;
            }
            return `<tr${divider}>${name}${r.stats.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`;
          })
          .join('');
        const totals =
          group.totals.length && group.totals.some((t) => t !== '')
            ? `<tr class="totals"><th class="player">Team</th>${group.totals.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`
            : '';
        return `<div class="table-wrap"><table class="box"><thead>${head}</thead><tbody>${rows}${totals}</tbody></table></div>`;
      })
      .join('')
  );
}

function numeric(v) {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function teamStats(g) {
  const header = `<div class="ts-head"><span>${logo(g.away, 18)} ${esc(g.away.abbr)}</span><span>${esc(g.home.abbr)} ${logo(g.home, 18)}</span></div>`;
  return (
    header +
    g.teamStats
      .filter((s) => s.rows.length)
      .map(
        (section) =>
          (section.title ? `<div class="ts-section">${esc(section.title)}</div>` : '') +
          section.rows
            .map((r) => {
              const a = numeric(r.away);
              const h = numeric(r.home);
              const bar =
                a !== null && h !== null && a >= 0 && h >= 0 && a + h > 0
                  ? `<div class="ts-bar"><div class="a" style="width:${(a / (a + h)) * 100}%"></div><div class="h" style="width:${(h / (a + h)) * 100}%"></div></div>`
                  : '';
              return `<div class="ts-row"><span class="v">${esc(r.away)}</span><span class="l">${esc(r.label)}</span><span class="v">${esc(r.home)}</span>${bar}</div>`;
            })
            .join(''),
      )
      .join('')
  );
}

function teamById(g, id) {
  return g.home.id === id ? g.home : g.away.id === id ? g.away : null;
}

function playsList(g) {
  return `<ol class="plays">${g.plays
    .map((p) => {
      const team = teamById(g, p.teamId);
      const score = p.scoring && p.awayScore !== null ? ` <span class="play-score">${esc(g.away.abbr)} ${esc(p.awayScore)}–${esc(p.homeScore)} ${esc(g.home.abbr)}</span>` : '';
      const period = p.periodNumber && g.sport !== 'baseball' ? periodShort(g.league, p.periodNumber) : p.period;
      return `<li class="${p.scoring ? 'scoring' : ''}"><span class="when">${esc([period, p.clock].filter(Boolean).join(' '))}</span>${
        team ? logo(team, 14) : ''
      }<span class="text">${esc(p.text)}${score}</span></li>`;
    })
    .join('')}</ol>`;
}

function scoringList(g) {
  let lastPeriod = null;
  return `<ol class="plays scoring-list">${g.scoringPlays
    .map((p) => {
      const heading = p.period !== lastPeriod && p.period ? `<li class="period-head">${esc(g.sport === 'baseball' ? `Inning ${p.period}` : periodShort(g.league, p.period))}</li>` : '';
      lastPeriod = p.period;
      const team = teamById(g, p.teamId);
      return `${heading}<li><span class="when">${esc(p.clock)}</span>${team ? logo(team, 16) : p.teamLogo ? `<img class="logo" src="${esc(p.teamLogo)}" width="16" height="16" alt="" />` : ''}<span class="text">${
        p.type ? `<b>${esc(p.type)}</b> ` : ''
      }${esc(p.text)}${p.awayScore !== null ? ` <span class="play-score">${esc(p.awayScore)}–${esc(p.homeScore)}</span>` : ''}</span></li>`;
    })
    .join('')}</ol>`;
}

function leadersList(g) {
  return g.leaders
    .map(
      ({ team, leaders }) => `
      <div class="ld-team">${logo(team, 18)} ${esc(team.fullName || team.name)}</div>
      <ul class="leaders-list">${leaders
        .map(
          (l) => `<li>
            ${l.headshot ? `<img class="headshot" src="${esc(l.headshot)}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="headshot"></span>'}
            <span class="ld-cat">${esc(l.categoryLong)}</span>
            <span class="ld-name">${esc(l.athleteFull)}${l.position ? ` <span class="pos">${esc(l.position)}</span>` : ''}</span>
            <span class="ld-val">${esc(l.value)}</span>
          </li>`,
        )
        .join('')}</ul>`,
    )
    .join('');
}

function oddsPanel(g) {
  const o = oddsFor(g);
  const phase = g.status.state;
  const live = o.live && phase === 'in';
  const label = live ? '<span class="live-tag">LIVE</span>' : `<span class="muted">${phase === 'post' ? 'Closing line' : phase === 'in' ? 'Latest line' : 'Pre-game line'}</span>`;
  const cell = (main, price) => (main ? `${esc(main)}${price ? `<small>${esc(price)}</small>` : ''}` : '—');
  const row = (side) => {
    const t = g[side];
    const total = o.total ? cell(`${side === 'away' ? 'O' : 'U'} ${o.total.line}`, side === 'away' ? o.total.over : o.total.under) : '—';
    return `<tr><th>${logo(t, 16)} ${esc(t.abbr)}</th><td>${o.spread ? cell(o.spread[side].line, o.spread[side].price) : '—'}</td><td>${total}</td><td>${
      o.moneyline ? cell(o.moneyline[side]) : '—'
    }</td></tr>`;
  };

  let implied = '';
  const p = noVigProbabilities(o.moneyline);
  if (p) {
    const a = Math.round(p.away * 1000) / 10;
    const h = Math.round((100 - a) * 10) / 10;
    implied = `
      <div class="odds-sub">Implied win chance <span class="muted">(moneyline, vig removed)</span></div>
      <section class="winprob">
        <span class="wp-label">${esc(g.away.abbr)} ${a}%</span>
        <div class="wp-bar"><div style="width:${a}%;background:${esc(g.away.color || 'var(--accent)')}"></div><div style="width:${h}%;background:${esc(g.home.color || 'var(--muted)')}"></div></div>
        <span class="wp-label">${h}% ${esc(g.home.abbr)}</span>
      </section>`;
  }

  let open = '';
  if (o.open) {
    const bits = [];
    if (o.open.spread) {
      const side = o.open.spread.away.startsWith('-') ? 'away' : 'home';
      bits.push(`${g[side].abbr} ${o.open.spread[side]}`);
    }
    if (o.open.total) bits.push(`O/U ${o.open.total}`);
    if (o.open.moneyline) bits.push(`ML ${g.away.abbr} ${o.open.moneyline.away} / ${g.home.abbr} ${o.open.moneyline.home}`);
    if (bits.length) open = `<div class="odds-sub">Opened: ${esc(bits.join(' · '))}</div>`;
  }

  const source =
    o.source === 'espn'
      ? `<div class="odds-sub muted">${esc(o.provider)} line via ESPN${state.oddsError && phase !== 'post' ? '. The DraftKings live feed is unavailable right now.' : '.'}</div>`
      : '';

  return `
    <div class="odds-head"><span class="book-badge">${esc(o.provider)}</span>${label}${o.suspended ? '<span class="muted">Betting suspended</span>' : ''}</div>
    <div class="table-wrap"><table class="odds-table">
      <thead><tr><th></th><th>Spread</th><th>Total</th><th>Moneyline</th></tr></thead>
      <tbody>${row('away')}${row('home')}</tbody>
    </table></div>
    ${implied}${open}${source}
    ${o.url ? `<a class="odds-link" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">Open this game on DraftKings ↗</a>` : ''}
    <p class="rg">Odds are for information only and can change at any moment. 21+. Gambling problem? Call 1-800-GAMBLER.</p>`;
}

function gameInfo(g) {
  const rows = [];
  const d = new Date(g.date);
  if (!Number.isNaN(d.getTime())) rows.push(['Date', d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })]);
  if (g.venue) rows.push(['Venue', g.venue + (g.venueCity ? `, ${g.venueCity}` : '')]);
  if (g.broadcast || state.preview?.broadcast) rows.push(['TV', g.broadcast || state.preview.broadcast]);
  if (g.attendance) rows.push(['Attendance', Number(g.attendance).toLocaleString()]);
  if (g.series) rows.push(['Series', g.series]);
  rows.push(['Status', g.status.longDetail]);
  return `<dl class="info">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

// ---------------------------------------------------------------------------
// Rendering: settings

function renderSettings() {
  const s = state.settings;
  const check = (key, label, hint = '') =>
    `<label class="set-row"><input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''} /><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;
  const favs = state.favorites.length
    ? `<ul class="fav-list">${state.favorites
        .map(
          (f) => `<li>${f.logo ? `<img class="logo" src="${esc(f.logo)}" width="18" height="18" alt="" />` : ''}<span>${esc(f.name)}</span><span class="muted">${esc(
            LEAGUES[f.league]?.label || '',
          )}</span><button class="link" data-action="unfavorite" data-key="${esc(f.key)}">Remove</button></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">No teams yet. You can also tap ★ next to a team in any game.</p>';
  return `
    <div class="settings">
      <div class="gv-nav"><button class="back" data-action="settings">‹ Done</button><span class="gv-league">Settings</span></div>
      <h3>Display</h3>
      ${check('compact', 'Compact scoreboard', 'Just teams, scores and clock — best for small overlays')}
      ${check('hideFinal', 'Hide finished games')}
      ${check('showOdds', 'Show DraftKings odds', 'Spread, total and moneyline on each game, updated live during play')}
      ${check('cfbTop25Only', 'College football: Top 25 only')}
      ${check('cbbTop25Only', 'College basketball: Top 25 only')}
      <h3>Updates</h3>
      <label class="set-row"><span>Live refresh every</span>
        <select data-setting="refreshSeconds">${[10, 15, 30, 60]
          .map((n) => `<option value="${n}" ${s.refreshSeconds === n ? 'selected' : ''}>${n} seconds</option>`)
          .join('')}</select></label>
      ${check('notifyFavorites', 'Notify me when my teams score', 'Also shows live favorite games on the toolbar icon')}
      <h3>My teams</h3>
      ${favs}
      <button class="btn" data-action="add-teams">+ Add teams</button>
      <h3>Shortcuts</h3>
      <p class="muted">Alt+Shift+S toggles the overlay on the current page. Alt+Shift+P opens the pop-out window.
      <button class="link" data-action="shortcuts">Change shortcuts</button></p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions

async function setUi(patch) {
  Object.assign(state.ui, patch);
  await store.saveUiState(patch);
}

function findGame(id) {
  return state.scoreboard?.games.find((g) => g.id === id) || null;
}

const actions = {
  async league(el) {
    const league = el.dataset.league;
    state.showSettings = false;
    state.picker = null;
    if (league !== state.ui.league) {
      state.dayOffset = 0;
      state.weekQuery = null;
    }
    await setUi({ league, view: 'scores' });
    load();
  },
  day(el) {
    const dir = Number(el.dataset.dir);
    state.dayOffset = dir === 0 ? 0 : state.dayOffset + dir;
    load();
  },
  week(el) {
    const dir = el.dataset.dir;
    const week = state.scoreboard?.week;
    if (dir === 'current') state.weekQuery = null;
    else if (week?.[dir]) state.weekQuery = week[dir];
    load();
  },
  async top25() {
    const key = top25Key(state.ui.league);
    state.settings = await store.saveSettings({ [key]: !state.settings[key] });
    render();
  },
  async 'open-game'(el) {
    state.preview = findGame(el.dataset.id);
    state.summary = null;
    state.boxSide = state.preview && isFavTeam(el.dataset.league, state.preview.home) && !isFavTeam(el.dataset.league, state.preview.away) ? 'home' : 'away';
    await setUi({ view: 'game', gameId: el.dataset.id, gameLeague: el.dataset.league });
    $('.content').scrollTop = 0;
    load();
  },
  async back() {
    await setUi({ view: 'scores' });
    render();
    load({ quiet: state.scoreboard?.key === scoreboardKey() });
  },
  async 'game-tab'(el) {
    await setUi({ gameTab: el.dataset.tab });
    render();
  },
  'box-side'(el) {
    state.boxSide = el.dataset.side;
    render();
  },
  async favorite(el) {
    const g = state.summary || state.preview;
    if (!g) return;
    const team = g[el.dataset.side];
    state.favorites = await store.toggleFavorite(g.league, team);
    toast(isFavTeam(g.league, team) ? `Following ${team.fullName || team.name}` : `Unfollowed ${team.fullName || team.name}`);
    render();
  },
  async unfavorite(el) {
    const f = state.favorites.find((x) => x.key === el.dataset.key);
    if (!f) return;
    state.favorites = await store.toggleFavorite(f.league, { id: f.teamId });
    toast(`Unfollowed ${f.name}`);
    render();
  },
  'add-teams'() {
    // Start the picker on the league being browsed, if any.
    openPicker(state.ui.view === 'game' ? state.ui.gameLeague : state.ui.league);
  },
  'picker-league'(el) {
    Object.assign(state.picker, { league: el.dataset.league, query: '', teams: null, error: null });
    render();
    loadPickerTeams();
  },
  async 'pick-team'(el) {
    const p = state.picker;
    const team = p.teams?.find((t) => t.id === el.dataset.id);
    if (!team) return;
    state.favorites = await store.toggleFavorite(p.league, team);
    toast(isFavTeam(p.league, team) ? `Following ${team.fullName}` : `Unfollowed ${team.fullName}`);
    $('.team-picker').innerHTML = pickerList();
  },
  async 'close-picker'() {
    state.picker = null;
    await setUi({ league: 'fav', view: 'scores' });
    load();
  },
  settings() {
    state.picker = null;
    state.showSettings = !state.showSettings;
    render();
    if (!state.showSettings) load({ quiet: true });
  },
  refresh() {
    load();
  },
  shortcuts() {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  },
  async overlay() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.runtime.sendMessage({ type: 'toggle-overlay', tabId: tab?.id });
    if (res?.ok) window.close();
    else toast(res?.error || "Can't overlay this page. Try the pop-out window instead.", 5000);
  },
  async popout() {
    await chrome.runtime.sendMessage({ type: 'open-popout' });
    if (MODE === 'popup') window.close();
  },
  pip() {
    enterPip().catch((err) => toast(`Couldn't keep on top: ${err.message}`));
  },
};

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !root.contains(el) || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    Promise.resolve(fn(el)).catch((err) => toast(err.message || String(err)));
  }
});

root.addEventListener('input', (e) => {
  if (!state.picker || !e.target.matches?.('[data-picker-search]')) return;
  state.picker.query = e.target.value;
  $('.team-picker').innerHTML = pickerList();
});

root.addEventListener('change', async (e) => {
  const confLeague = e.target.dataset?.conference;
  if (confLeague) {
    state.settings = await store.saveSettings({ conferences: { ...state.settings.conferences, [confLeague]: e.target.value } });
    load();
    return;
  }
  const key = e.target.dataset?.setting;
  if (!key) return;
  const value = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
  state.settings = await store.saveSettings({ [key]: value });
});

// ---------------------------------------------------------------------------
// Always-on-top via Document Picture-in-Picture (pop-out window only)

async function enterPip() {
  if (state.pip) return state.pip.focus();
  const pip = await documentPictureInPicture.requestWindow({
    width: Math.max(320, root.offsetWidth),
    height: Math.max(420, Math.min(root.offsetHeight, 720)),
  });
  // The PiP document is about:blank, so copy the rules in rather than linking.
  const style = pip.document.createElement('style');
  style.textContent = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText)).join('\n');
  pip.document.head.append(style);
  // Relative URLs would resolve against about:blank once moved.
  root.querySelectorAll('img').forEach((img) => img.setAttribute('src', img.src));
  pip.document.title = 'Courtside';
  pip.document.body.className = document.body.className;
  pip.document.body.append(root);
  root.classList.add('in-pip');
  state.pip = pip;

  const placeholder = document.createElement('div');
  placeholder.className = 'pip-placeholder';
  placeholder.innerHTML = '<p>Scores are floating on top of your other windows.</p><button class="btn">Bring them back here</button>';
  placeholder.querySelector('button').addEventListener('click', () => pip.close());
  document.body.append(placeholder);

  pip.addEventListener('pagehide', () => {
    placeholder.remove();
    root.classList.remove('in-pip');
    document.body.append(root);
    state.pip = null;
    schedule();
  });
}

// ---------------------------------------------------------------------------
// Boot

function applyMode() {
  root.classList.add(`mode-${MODE}`);
  document.body.classList.add(`mode-${MODE}`);
  for (const el of root.querySelectorAll('[data-only]')) {
    el.hidden = !el.dataset.only.split(' ').includes(MODE);
  }
  if (MODE === 'window' && !('documentPictureInPicture' in window)) $('[data-action="pip"]').hidden = true;
}

async function init() {
  applyMode();
  const [ui, settings, favorites] = await Promise.all([store.getUiState(), store.getSettings(), store.getFavorites()]);
  state.ui = ui;
  state.settings = settings;
  state.favorites = favorites;
  if (!LEAGUES[state.ui.league] && state.ui.league !== 'fav') state.ui.league = 'nfl';
  if (state.ui.view === 'game' && !(state.ui.gameId && LEAGUES[state.ui.gameLeague])) state.ui.view = 'scores';
  render();
  load();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      const before = state.settings;
      state.settings = { ...store.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (before.refreshSeconds !== state.settings.refreshSeconds) schedule();
      render();
      if (!before.showOdds && state.settings.showOdds) load({ quiet: true });
    }
    if (area === 'sync' && changes.favorites) {
      state.favorites = changes.favorites.newValue || [];
      render();
      // Fetch newly added teams when the favorites list is on screen.
      if (state.ui.league === 'fav' && state.ui.view === 'scores' && !state.picker && !state.showSettings) load({ quiet: true });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (isPaused()) ticker.clear();
    else load({ quiet: true });
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'Escape' || e.key === 'Backspace') {
      if (state.showSettings) actions.settings();
      else if (state.picker) actions['close-picker']();
      else if (state.ui.view === 'game') actions.back();
    } else if (e.key === 'r') {
      load();
    }
  });
}

init();
