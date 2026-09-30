import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConferences, normalizeScoreboard, normalizeSummary, scoreboardUrl, standingsUrl } from '../../src/lib/espn.js';
import { LEAGUE_ORDER, LEAGUES, periodLabel, periodShort } from '../../src/lib/leagues.js';
import { draftKingsUrl, matchDraftKings, normalizeDraftKings } from '../../src/lib/odds.js';
import * as fx from '../fixtures/espn.js';

test("men's college basketball is a league with all Division I games by default", () => {
  assert.ok(LEAGUE_ORDER.includes('cbb'));
  assert.equal(LEAGUES.cbb.sport, 'basketball');
  assert.equal(
    scoreboardUrl('cbb'),
    'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=50&limit=400',
  );
  assert.match(draftKingsUrl('cbb'), /\/leagues\/92483$/);
});

test('a conference replaces the league-wide group', () => {
  assert.equal(
    scoreboardUrl('cbb', { groups: '2', dates: '20260928' }),
    'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=2&limit=400&dates=20260928',
  );
  assert.equal(
    scoreboardUrl('cfb', { groups: '8', seasontype: '2', week: '5', dates: '2026' }),
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=8&limit=400&seasontype=2&week=5&dates=2026',
  );
});

test('college basketball uses halves', () => {
  assert.equal(periodLabel('basketball', 2, { halves: true }), '2H');
  assert.equal(periodLabel('basketball', 2, { halves: true, short: false }), '2nd Half');
  assert.equal(periodLabel('basketball', 3, { halves: true }), 'OT');
  assert.equal(periodLabel('basketball', 5, { halves: true }), '3OT');
  assert.equal(periodShort('cbb', 1), 'H1');
  assert.equal(periodShort('cbb', 4), '2OT');
  assert.equal(periodShort('nba', 5), 'OT');
  assert.equal(periodShort('nhl', 2), 'P2');

  const { games } = normalizeScoreboard(fx.cbbScoreboard, 'cbb');
  assert.equal(games[0].periodLabel, '2H');
  assert.equal(games[0].status.detail, '12:04 - 2nd Half');
  assert.equal(games[0].home.rank, 3);
  assert.equal(games[0].home.conferenceId, '2');

  const g = normalizeSummary(fx.cbbSummary, 'cbb');
  assert.deepEqual(g.linescore.labels, ['1', '2']);
  const ot = normalizeSummary(
    {
      ...fx.cbbSummary,
      header: {
        competitions: [
          {
            ...fx.cbbSummary.header.competitions[0],
            competitors: fx.cbbSummary.header.competitions[0].competitors.map((c) => ({ ...c, linescores: [...c.linescores, { displayValue: '9' }, { displayValue: '4' }] })),
          },
        ],
      },
    },
    'cbb',
  );
  assert.deepEqual(ot.linescore.labels, ['1', '2', 'OT', '2OT']);
  assert.deepEqual(g.scoringPlays, []);
});

test('conference list from standings', () => {
  assert.equal(standingsUrl('cfb'), 'https://site.api.espn.com/apis/v2/sports/football/college-football/standings');
  assert.deepEqual(normalizeConferences(fx.STANDINGS['basketball/mens-college-basketball']), [
    { id: '2', name: 'Atlantic Coast Conference', label: 'ACC' },
    { id: '8', name: 'Big 12 Conference', label: 'Big 12' },
    { id: '4', name: 'Big East Conference', label: 'Big East' },
    { id: '23', name: 'Southeastern Conference', label: 'SEC' },
  ]);
  assert.deepEqual(normalizeConferences({ children: [{ id: '99', name: 'Western Athletic Conference' }] }), [
    { id: '99', name: 'Western Athletic Conference', label: 'Western Athletic' },
  ]);
  assert.deepEqual(normalizeConferences({}), []);
});

test('DraftKings college basketball names match ESPN schools', () => {
  const { games } = normalizeScoreboard(fx.cbbScoreboard, 'cbb');
  const odds = matchDraftKings(games, normalizeDraftKings(fx.DK_FIXTURES[92483]));
  assert.deepEqual([...odds.keys()], ['401820001']);
  assert.deepEqual(odds.get('401820001').moneyline, { away: '+120', home: '-145' });
});
