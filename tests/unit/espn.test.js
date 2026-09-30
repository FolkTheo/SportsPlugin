import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeScoreboard, normalizeSummary, scoreboardUrl, sortGames, summaryUrl } from '../../src/lib/espn.js';
import { periodLabel } from '../../src/lib/leagues.js';
import * as fx from '../fixtures/espn.js';

test('urls include league path and CFB defaults to all FBS games', () => {
  assert.equal(scoreboardUrl('nba'), 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?');
  assert.equal(scoreboardUrl('nba', { dates: '20261001' }), 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261001');
  assert.match(scoreboardUrl('cfb'), /college-football\/scoreboard\?groups=80&limit=400$/);
  assert.equal(summaryUrl('nhl', '401800001'), 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event=401800001');
});

test('NFL scoreboard: teams, live situation, possession, leaders', () => {
  const { games, week } = normalizeScoreboard(fx.nflScoreboard, 'nfl');
  assert.equal(games.length, 3);
  const live = games[0];
  assert.equal(live.status.state, 'in');
  assert.equal(live.status.detail, '4:12 - 3rd');
  assert.equal(live.periodLabel, 'Q3');
  assert.equal(live.away.abbr, 'KC');
  assert.equal(live.home.abbr, 'BUF');
  assert.equal(live.away.score, '24');
  assert.equal(live.away.record, '3-0');
  assert.equal(live.away.color, '#e31837');
  assert.equal(live.situation.downDistance, '2nd & 7');
  assert.equal(live.situation.isRedZone, true);
  assert.equal(live.situation.possession, 'away');
  assert.equal(live.away.possession, true);
  assert.equal(live.home.possession, false);
  assert.equal(live.situation.homeWinPct, 0.382);
  assert.deepEqual(
    live.leaders.map((l) => [l.category, l.athlete, l.teamAbbr]),
    [
      ['PASS', 'P. Mahomes', 'KC'],
      ['RUSH', 'J. Cook', 'BUF'],
      ['REC', 'T. Kelce', 'KC'],
    ],
  );
  assert.equal(live.broadcast, 'CBS');

  const final = games[1];
  assert.equal(final.status.state, 'post');
  assert.equal(final.home.winner, true);
  assert.equal(final.situation, null);

  const pre = games[2];
  assert.equal(pre.broadcast, 'ESPN, ABC');
  assert.deepEqual(pre.odds, { details: 'SF -2.5', overUnder: '44.5' });

  assert.equal(week.label, 'Week 4');
  assert.equal(week.detail, 'Sep 24-30');
  assert.deepEqual(week.prev, { seasontype: '2', week: '3', label: 'Week 3', detail: '', year: '2026' });
  assert.equal(week.next.week, '5');
});

test('week navigation crosses season-type boundaries', () => {
  const json = { ...fx.nflScoreboard, week: { number: 1 } };
  const { week } = normalizeScoreboard(json, 'nfl');
  assert.equal(week.prev.seasontype, '1');
  assert.equal(week.prev.label, 'Hall of Fame Weekend');
});

test('week navigation falls back to +/-1 without a calendar', () => {
  const json = { ...fx.cfbScoreboard, leagues: [{}] };
  const { week } = normalizeScoreboard(json, 'cfb');
  assert.equal(week.label, 'Week 5');
  assert.equal(week.prev.week, '4');
  assert.equal(week.next.week, '6');
});

test('NBA scoreboard uses competitor-level leaders', () => {
  const { games, week } = normalizeScoreboard(fx.nbaScoreboard, 'nba');
  assert.equal(week, null);
  assert.deepEqual(
    games[0].leaders.map((l) => `${l.teamAbbr} ${l.category} ${l.athlete} ${l.value}`),
    ['NY PTS J. Brunson 27', 'BOS PTS J. Tatum 24'],
  );
});

test('MLB scoreboard: count, bases, R/H/E, probables, series', () => {
  const { games } = normalizeScoreboard(fx.mlbScoreboard, 'mlb');
  const live = games[0];
  assert.deepEqual(
    { ...live.situation },
    { lastPlay: 'Betts singled to left, Freeman to third.', balls: 2, strikes: 1, outs: 1, onFirst: true, onSecond: false, onThird: true, batter: 'S. Ohtani', pitcher: 'G. Cole' },
  );
  assert.equal(live.home.hits, 8);
  assert.equal(live.home.errors, 1);
  assert.equal(live.series, 'NYY leads series 1-0');
  assert.deepEqual(
    games[1].probables.map((p) => `${p.teamAbbr} ${p.athlete} ${p.value}`),
    ['SEA L. Gilbert 12-7, 3.21 ERA', 'HOU F. Valdez 14-8, 3.05 ERA'],
  );
});

test('CFB ranks ignore the unranked sentinel (99)', () => {
  const { games } = normalizeScoreboard(fx.cfbScoreboard, 'cfb');
  assert.equal(games[0].away.rank, 4);
  assert.equal(games[0].home.rank, 2);
  assert.equal(games[1].away.rank, null);
  assert.equal(games[1].home.rank, 1);
  assert.equal(games[0].note, 'SEC Game of the Week');
});

test('sortGames puts favorites, then live, then upcoming, then finals first', () => {
  const { games } = normalizeScoreboard(fx.nflScoreboard, 'nfl');
  assert.deepEqual(sortGames(games).map((g) => g.status.state), ['in', 'pre', 'post']);
  const favFirst = sortGames(games, new Set(['nfl:6']));
  assert.equal(favFirst[0].away.abbr, 'DAL');
});

test('NFL summary: linescore, team stats, box score, plays, scoring, win probability', () => {
  const g = normalizeSummary(fx.nflSummary, 'nfl');
  assert.equal(g.away.abbr, 'KC');
  assert.equal(g.away.logo, 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/kc.png');
  assert.equal(g.away.possession, true);
  assert.deepEqual(g.linescore, { labels: ['1', '2', '3'], away: ['7', '10', '7'], home: ['3', '7', '10'] });
  assert.equal(g.situation.downDistance, '2nd & 7');
  assert.equal(g.homeWinPct, 0.382);
  assert.equal(g.teamStats.length, 1);
  assert.deepEqual(g.teamStats[0].rows[0], { label: '1st Downs', away: '19', home: '15' });
  assert.deepEqual(g.teamStats[0].rows.at(-1), { label: 'Possession', away: '24:10', home: '16:38' });

  assert.equal(g.players.length, 2);
  assert.equal(g.players[0].team.abbr, 'KC');
  const passing = g.players[0].groups[0];
  assert.equal(passing.title, 'Kansas City Passing');
  assert.equal(passing.labels[0], 'C/ATT');
  assert.equal(passing.descriptions[0], 'Completions/Attempts');
  assert.deepEqual(passing.rows[0].stats.slice(0, 2), ['19/27', '241']);
  assert.equal(passing.rows[0].jersey, '15');

  assert.deepEqual(
    g.plays.map((p) => p.text),
    ['P.Mahomes pass short right to T.Kelce for 12 yards', 'I.Pacheco left guard for 6 yards', 'J.Allen pass deep left to K.Coleman for 38 yards, TOUCHDOWN.'],
  );
  assert.equal(g.plays[0].teamId, '12');
  assert.equal(g.plays[2].scoring, true);

  assert.equal(g.scoringPlays.length, 3);
  assert.equal(g.scoringPlays[0].type, 'TD');
  assert.equal(g.scoringPlays[0].teamId, '12');
  assert.equal(g.leaders.length, 2);
  assert.equal(g.venue, 'Highmark Stadium');
  assert.equal(g.venueCity, 'Orchard Park, NY');
  assert.equal(g.broadcast, 'CBS');
});

test('NBA summary: starters, DNP, totals; no per-basket scoring list', () => {
  const g = normalizeSummary(fx.nbaSummary, 'nba');
  const ny = g.players.find((p) => p.team.abbr === 'NY').groups[0];
  assert.equal(ny.labels.at(-1), 'PTS');
  assert.equal(ny.rows[0].starter, true);
  assert.equal(ny.rows[2].starter, false);
  assert.equal(ny.rows[3].dnp, true);
  assert.equal(ny.rows[3].reason, "COACH'S DECISION");
  assert.equal(ny.totals.at(-1), '88');
  assert.equal(g.scoringPlays.length, 0);
  assert.equal(g.plays[0].text, 'Jayson Tatum makes driving layup');
  assert.deepEqual(g.teamStats[0].rows[0], { label: 'FG', away: '33-71', home: '34-70' });
});

test('MLB summary: nine-inning linescore, grouped team stats, batting & pitching', () => {
  const g = normalizeSummary(fx.mlbSummary, 'mlb');
  assert.equal(g.linescore.labels.length, 9);
  assert.deepEqual(g.linescore.away, ['0', '1', '0', '2', '0', '0', '', '', '']);
  assert.equal(g.home.hits, 8);
  assert.deepEqual(
    g.teamStats.map((s) => s.title),
    ['Batting', 'Pitching'],
  );
  assert.deepEqual(g.teamStats[0].rows[1], { label: 'Home Runs', away: '1', home: '2' });
  assert.deepEqual(
    g.players[0].groups.map((gr) => gr.title),
    ['batting', 'pitching'],
  );
  assert.equal(g.situation.pitcher, 'G. Cole');
  assert.equal(g.scoringPlays.length, 1);
  assert.equal(g.plays[0].period, 'Top 7th');
  assert.equal(g.series, 'NYY leads series 1-0');
});

test('NHL summary: OT linescore labels and scoring plays', () => {
  const g = normalizeSummary(fx.nhlSummary, 'nhl');
  assert.deepEqual(g.linescore.labels, ['1', '2', '3', 'OT']);
  assert.equal(g.status.detail, 'Final/OT');
  assert.equal(g.home.winner, true);
  assert.equal(g.scoringPlays.at(-1).text, 'Auston Matthews (1) Snap Shot');
  assert.deepEqual(
    g.players[0].groups.map((gr) => gr.title),
    ['Forwards', 'Goalies'],
  );
  assert.equal(g.situation, null);
});

test('CFB summary with an empty box score falls back to the predictor', () => {
  const g = normalizeSummary(fx.cfbSummary, 'cfb');
  assert.equal(g.away.rank, 4);
  assert.deepEqual(g.players, []);
  assert.deepEqual(g.teamStats, []);
  assert.equal(g.note, 'SEC Game of the Week');
  // Game is in progress, so no pre-game projection is used.
  assert.equal(g.homeWinPct, null);
  const pre = normalizeSummary(
    { ...fx.cfbSummary, header: { competitions: [{ ...fx.cfbSummary.header.competitions[0], status: { type: { state: 'pre' } } }] } },
    'cfb',
  );
  assert.equal(pre.homeWinPct, 0.552);
});

test('normalizers survive empty and malformed payloads', () => {
  for (const league of ['nfl', 'nba', 'mlb', 'nhl', 'cfb']) {
    assert.deepEqual(normalizeScoreboard({}, league).games, []);
    assert.deepEqual(normalizeScoreboard(null, league).games, []);
    const s = normalizeSummary({}, league);
    assert.equal(s.status.state, 'pre');
    assert.deepEqual(s.players, []);
  }
});

test('period labels per sport', () => {
  assert.equal(periodLabel('football', 5), 'OT');
  assert.equal(periodLabel('basketball', 6), '2OT');
  assert.equal(periodLabel('hockey', 2), '2nd');
  assert.equal(periodLabel('hockey', 4), 'OT');
  assert.equal(periodLabel('baseball', 11), '11th');
  assert.equal(periodLabel('baseball', 0), '');
});
