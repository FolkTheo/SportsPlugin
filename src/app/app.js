// Courtside UI. The same page runs in three places, selected by ?mode=:
//   popup   – the toolbar popup
//   overlay – inside the draggable frame the content script puts over a page
//   window  – the pop-out window, which can also float on top via Document PiP

import { LEAGUES, LEAGUE_ORDER } from '../lib/leagues.js';
import { fetchScoreboard, fetchSummary } from '../lib/api.js';
import { sortGames } from '../lib/espn.js';
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
  preview: null, // scoreboard game shown while its summary loads
  boxSide: 'away',
  loading: false,
  error: null,
  updatedAt: null,
  changed: new Set(), // "gameId:side" keys whose score just changed
  showSettings: false,
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
  if (LEAGUES[leagueId].weekly) {
    const w = state.weekQuery;
    return w ? { seasontype: w.seasontype, week: w.week, dates: w.year } : {};
  }
  return state.dayOffset === 0 ? {} : { dates: ymd(offsetDate(state.dayOffset)) };
}

function scoreboardKey() {
  const league = state.ui.league;
  if (league === 'fav') return 'fav';
  return `${league}|${JSON.stringify(scoreboardQuery(league))}`;
}

async function loadFavoriteGames() {
  const leagues = [...new Set(state.favorites.map((f) => f.league))].filter((l) => LEAGUES[l]);
  const results = await Promise.allSettled(leagues.map((l) => fetchScoreboard(l)));
  const keys = favKeys();
  const games = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value.games : []))
    .filter((g) => keys.has(`${g.league}:${g.home.id}`) || keys.has(`${g.league}:${g.away.id}`));
  if (!games.length && results.length && results.every((r) => r.status === 'rejected')) {
    throw results[0].reason;
  }
  return { games, week: null };
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
      const data = state.ui.league === 'fav' ? await loadFavoriteGames() : await fetchScoreboard(state.ui.league, scoreboardQuery(state.ui.league));
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
}

// ---------------------------------------------------------------------------
// Rendering: shell

function render() {
  renderTabs();
  const content = $('.content');
  const scrollTop = content.scrollTop;
  const sameView = content.dataset.view === viewKey();
  if (state.showSettings) content.innerHTML = renderSettings();
  else if (state.ui.view === 'game') content.innerHTML = renderGame();
  else content.innerHTML = renderScores();
  content.dataset.view = viewKey();
  if (sameView) content.scrollTop = scrollTop;
  renderStatusBar();
}

function viewKey() {
  if (state.showSettings) return 'settings';
  if (state.ui.view === 'game') return `game:${state.ui.gameId}:${state.ui.gameTab}:${state.boxSide}`;
  return `scores:${scoreboardKey()}`;
}

function renderTabs() {
  const tabs = [...LEAGUE_ORDER];
  if (state.favorites.length) tabs.unshift('fav');
  const active = state.ui.view === 'game' ? state.ui.gameLeague : state.ui.league;
  $('.league-tabs').innerHTML = tabs
    .map((id) => {
      const label = id === 'fav' ? '★<span class="tab-text"> Mine</span>' : esc(LEAGUES[id].label);
      const title = id === 'fav' ? 'Your favorite teams' : LEAGUES[id].name;
      const selected = !state.showSettings && (state.ui.view === 'game' ? id === active : id === state.ui.league);
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
  if (league === 'fav') return `<div class="subbar"><span class="sub-label">Today's games for your teams</span></div>`;
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
  const top25 =
    league === 'cfb'
      ? `<button class="chip${state.settings.cfbTop25Only ? ' on' : ''}" data-action="top25" title="Only show games with a ranked team">Top 25</button>`
      : '';
  return `<div class="subbar">${nav}<span class="spacer"></span>${top25}</div>`;
}

function visibleGames() {
  let games = state.scoreboard?.games || [];
  if (state.ui.league === 'cfb' && state.settings.cfbTop25Only) games = games.filter((g) => g.home.rank || g.away.rank);
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
      const msg =
        state.ui.league === 'fav'
          ? 'None of your teams play today.'
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
    if (game.odds?.details && !compact) meta.push(esc(game.odds.details));
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
      ${compact ? '' : cardLeaders(game)}
    </button>`;
}

// ---------------------------------------------------------------------------
// Rendering: game detail

function gameTabs(g) {
  const tabs = [];
  if (g.players.some((p) => p.groups.length)) tabs.push(['box', 'Box Score']);
  if (g.teamStats.some((s) => s.rows.length)) tabs.push(['team', 'Team Stats']);
  if (g.plays.length) tabs.push(['plays', 'Plays']);
  if (g.scoringPlays.length) tabs.push(['scoring', 'Scoring']);
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
      const period = p.periodNumber && g.sport !== 'baseball' ? periodShort(g, p.periodNumber) : p.period;
      return `<li class="${p.scoring ? 'scoring' : ''}"><span class="when">${esc([period, p.clock].filter(Boolean).join(' '))}</span>${
        team ? logo(team, 14) : ''
      }<span class="text">${esc(p.text)}${score}</span></li>`;
    })
    .join('')}</ol>`;
}

function periodShort(g, n) {
  if (g.sport === 'hockey') return n <= 3 ? `P${n}` : n === 4 ? 'OT' : 'SO';
  return n <= 4 ? `Q${n}` : n === 5 ? 'OT' : `${n - 4}OT`;
}

function scoringList(g) {
  let lastPeriod = null;
  return `<ol class="plays scoring-list">${g.scoringPlays
    .map((p) => {
      const heading = p.period !== lastPeriod && p.period ? `<li class="period-head">${esc(g.sport === 'baseball' ? `Inning ${p.period}` : periodShort(g, p.period))}</li>` : '';
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

function gameInfo(g) {
  const rows = [];
  const d = new Date(g.date);
  if (!Number.isNaN(d.getTime())) rows.push(['Date', d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })]);
  if (g.venue) rows.push(['Venue', g.venue + (g.venueCity ? `, ${g.venueCity}` : '')]);
  if (g.broadcast || state.preview?.broadcast) rows.push(['TV', g.broadcast || state.preview.broadcast]);
  if (g.attendance) rows.push(['Attendance', Number(g.attendance).toLocaleString()]);
  const odds = state.preview?.id === g.id ? state.preview.odds : null;
  if (odds?.details) rows.push(['Line', odds.details + (odds.overUnder ? ` · O/U ${odds.overUnder}` : '')]);
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
    : '<p class="muted">Open any game and tap ★ next to a team to follow it.</p>';
  return `
    <div class="settings">
      <div class="gv-nav"><button class="back" data-action="settings">‹ Done</button><span class="gv-league">Settings</span></div>
      <h3>Display</h3>
      ${check('compact', 'Compact scoreboard', 'Just teams, scores and clock — best for small overlays')}
      ${check('hideFinal', 'Hide finished games')}
      ${check('cfbTop25Only', 'College football: Top 25 only')}
      <h3>Updates</h3>
      <label class="set-row"><span>Live refresh every</span>
        <select data-setting="refreshSeconds">${[10, 15, 30, 60]
          .map((n) => `<option value="${n}" ${s.refreshSeconds === n ? 'selected' : ''}>${n} seconds</option>`)
          .join('')}</select></label>
      ${check('notifyFavorites', 'Notify me when my teams score', 'Also shows live favorite games on the toolbar icon')}
      <h3>My teams</h3>
      ${favs}
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
    state.settings = await store.saveSettings({ cfbTop25Only: !state.settings.cfbTop25Only });
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
    if (!state.favorites.length && state.ui.league === 'fav') await setUi({ league: 'nfl' });
    render();
  },
  settings() {
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

root.addEventListener('change', async (e) => {
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
  if (!LEAGUES[state.ui.league] && !(state.ui.league === 'fav' && favorites.length)) state.ui.league = 'nfl';
  if (state.ui.view === 'game' && !(state.ui.gameId && LEAGUES[state.ui.gameLeague])) state.ui.view = 'scores';
  render();
  load();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      const before = state.settings;
      state.settings = { ...store.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (before.refreshSeconds !== state.settings.refreshSeconds) schedule();
      render();
    }
    if (area === 'sync' && changes.favorites) {
      state.favorites = changes.favorites.newValue || [];
      render();
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
      else if (state.ui.view === 'game') actions.back();
    } else if (e.key === 'r') {
      load();
    }
  });
}

init();
