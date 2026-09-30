import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTeamList, normalizeTeamOverview, teamScheduleUrl, teamsUrl, teamUrl } from '../../src/lib/espn.js';
import * as fx from '../fixtures/espn.js';

test('team URLs', () => {
  assert.equal(teamsUrl('nfl'), 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=1000');
  assert.equal(teamsUrl('cfb'), 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000&groups=80');
  assert.equal(teamUrl('nba', '2'), 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2');
  assert.equal(teamScheduleUrl('mlb', '10'), 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/10/schedule');
});

test('normalizeTeamList flattens and sorts teams', () => {
  const teams = normalizeTeamList(fx.TEAM_LISTS['football/nfl'], 'nfl');
  assert.equal(teams.length, 8);
  assert.equal(teams[0].fullName, 'Buffalo Bills');
  const kc = teams.find((t) => t.abbr === 'KC');
  assert.equal(kc.id, '12');
  assert.equal(kc.league, 'nfl');
  assert.equal(kc.logo, 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/kc.png');
  assert.deepEqual(normalizeTeamList({}, 'nfl'), []);
});

test('team overview: record, standing, live next game, last result', () => {
  const t = normalizeTeamOverview(fx.TEAM_DOCS['football/nfl'][12], fx.TEAM_SCHEDULES['football/nfl'][12], 'nfl');
  assert.equal(t.key, 'nfl:12');
  assert.equal(t.fullName, 'Kansas City Chiefs');
  assert.equal(t.record, '3-0');
  assert.equal(t.standing, '1st in AFC West');
  assert.equal(t.next.id, '401772001');
  assert.equal(t.next.status.state, 'in');
  assert.equal(t.next.away.score, '24'); // score objects are flattened
  // The live game is excluded from "last"; the most recent final is used.
  assert.deepEqual(t.last, { gameId: '401771902', date: '2026-09-21T20:25Z', result: 'W', score: '31-17', opponent: 'LV', home: true, detail: 'Final' });
});

test('team overview: loss on the road', () => {
  const t = normalizeTeamOverview(fx.TEAM_DOCS['football/nfl'][26], fx.TEAM_SCHEDULES['football/nfl'][26], 'nfl');
  assert.equal(t.next.status.state, 'pre');
  assert.equal(t.last.result, 'L');
  assert.equal(t.last.score, '20-24');
  assert.equal(t.last.home, false);
  assert.equal(t.last.opponent, 'LAR');
});

test('team overview without a next game or schedule', () => {
  const t = normalizeTeamOverview(fx.TEAM_DOCS['hockey/nhl'][21], fx.TEAM_SCHEDULES['hockey/nhl'][21], 'nhl');
  assert.equal(t.next, null);
  assert.equal(t.last.result, 'W');
  assert.equal(t.last.score, '3-2');
  assert.equal(t.last.detail, 'Final/OT');
  const bare = normalizeTeamOverview(fx.TEAM_DOCS['hockey/nhl'][21], null, 'nhl');
  assert.equal(bare.last, null);
  assert.equal(bare.record, '1-0-0');
});
