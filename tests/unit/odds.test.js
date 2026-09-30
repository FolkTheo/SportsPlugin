import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeScoreboard, normalizeSummary } from '../../src/lib/espn.js';
import {
  draftKingsUrl,
  formatAmerican,
  formatLine,
  impliedProbability,
  matchDraftKings,
  mergeOdds,
  noVigProbabilities,
  normalizeDraftKings,
  oddsFromEspn,
  teamMatchScore,
} from '../../src/lib/odds.js';
import * as fx from '../fixtures/espn.js';

test('DraftKings league URLs cover all five leagues', () => {
  for (const league of ['nfl', 'nba', 'mlb', 'nhl', 'cfb']) {
    assert.match(draftKingsUrl(league), /^https:\/\/sportsbook-nash\.draftkings\.com\/api\/sportscontent\/\w+\/v1\/leagues\/\d+$/);
  }
  assert.equal(draftKingsUrl('xfl'), null);
});

test('formatting American odds and lines', () => {
  assert.equal(formatAmerican('−110'), '-110');
  assert.equal(formatAmerican(150), '+150');
  assert.equal(formatAmerican('+100'), '+100');
  assert.equal(formatAmerican('even'), 'EVEN');
  assert.equal(formatAmerican(''), '');
  assert.equal(formatLine(-3.5), '-3.5');
  assert.equal(formatLine('3'), '+3');
  assert.equal(formatLine(0), 'PK');
});

test('implied and no-vig probabilities', () => {
  assert.equal(impliedProbability('-110').toFixed(4), '0.5238');
  assert.equal(impliedProbability('+150'), 0.4);
  assert.equal(impliedProbability('EVEN'), 0.5);
  const p = noVigProbabilities({ away: '-180', home: '+150' });
  assert.equal(Math.round(p.away * 1000), 616);
  assert.equal(Math.round((p.away + p.home) * 1e6), 1e6);
  assert.equal(noVigProbabilities({ away: '', home: '+150' }), null);
});

test('normalizeDraftKings reads main lines and ignores props', () => {
  const events = normalizeDraftKings(fx.dkNfl);
  assert.equal(events.length, 3);
  const kc = events[0];
  assert.equal(kc.live, true);
  assert.deepEqual(kc.away, { name: 'KC Chiefs' });
  assert.deepEqual(kc.spread, { away: { line: '-3.5', price: '-115' }, home: { line: '+3.5', price: '-105' } });
  assert.deepEqual(kc.total, { line: '51.5', over: '-110', under: '-110' });
  assert.deepEqual(kc.moneyline, { away: '-180', home: '+150' });
  assert.equal(events[1].live, false);
  assert.equal(events[2].spread, null);
  assert.equal(normalizeDraftKings(fx.dkNba)[0].suspended, true);
  assert.deepEqual(normalizeDraftKings({}), []);
});

test('team name matching', () => {
  const { games } = normalizeScoreboard(fx.nflScoreboard, 'nfl');
  const kc = games[0].away;
  assert.equal(teamMatchScore('KC Chiefs', kc), 3);
  assert.equal(teamMatchScore('Kansas City Chiefs', kc), 4);
  assert.equal(teamMatchScore('BUF Bills', kc), 0);
  const cfb = normalizeScoreboard(fx.cfbScoreboard, 'cfb').games;
  assert.equal(teamMatchScore('Alabama', cfb[0].away), 2);
  assert.equal(teamMatchScore('Alabama Crimson Tide', cfb[0].away), 4);
  assert.equal(teamMatchScore('Georgia', cfb[0].away), 0);
});

test('matchDraftKings pairs events with ESPN games', () => {
  const { games } = normalizeScoreboard(fx.nflScoreboard, 'nfl');
  const matched = matchDraftKings(games, normalizeDraftKings(fx.dkNfl));
  assert.deepEqual([...matched.keys()].sort(), ['401772001', '401772003']);
  const live = matched.get('401772001');
  assert.equal(live.source, 'draftkings');
  assert.equal(live.live, true);
  assert.equal(live.url, 'https://sportsbook.draftkings.com/event/32001');
  assert.equal(live.moneyline.away, '-180');
});

test('matchDraftKings flips sides when DraftKings lists home/away the other way', () => {
  const { games } = normalizeScoreboard(fx.cfbScoreboard, 'cfb');
  const odds = matchDraftKings(games, normalizeDraftKings(fx.dkCfb)).get('401760001');
  // ESPN: Alabama (away) at Georgia (home).
  assert.deepEqual(odds.moneyline, { away: '-140', home: '+120' });
  assert.equal(odds.spread.away.line, '-2.5');
  assert.equal(odds.spread.home.line, '+2.5');
});

test('matchDraftKings rejects events far from the game time', () => {
  const { games } = normalizeScoreboard(fx.nflScoreboard, 'nfl');
  const far = normalizeDraftKings(fx.dkNfl).map((e) => ({ ...e, start: '2026-12-01T00:00:00Z' }));
  assert.equal(matchDraftKings(games, far).size, 0);
});

test('oddsFromEspn prefers DraftKings and reads open/close lines', () => {
  const o = oddsFromEspn([{ provider: { name: 'numberfire' }, details: 'x' }, fx.espnDkOdds]);
  assert.equal(o.provider, 'DraftKings');
  assert.equal(o.source, 'espn');
  assert.deepEqual(o.moneyline, { away: '-135', home: '+115' });
  assert.deepEqual(o.spread, { away: { line: '-2.5', price: '-110' }, home: { line: '+2.5', price: '-110' } });
  assert.deepEqual(o.total, { line: '44.5', over: '-110', under: '-110' });
  assert.deepEqual(o.open, { spread: { home: '+1.5', away: '-1.5' }, total: '43.5', moneyline: { away: '-120', home: '+100' } });
});

test('oddsFromEspn handles the older flat format', () => {
  const o = oddsFromEspn([{ provider: { name: 'ESPN BET' }, details: 'BOS -4.5', spread: -4.5, overUnder: 220.5, awayTeamOdds: { moneyLine: 160 }, homeTeamOdds: { moneyLine: -190 } }]);
  assert.equal(o.provider, 'ESPN BET');
  assert.deepEqual(o.spread, { away: { line: '+4.5', price: '' }, home: { line: '-4.5', price: '' } });
  assert.deepEqual(o.moneyline, { away: '+160', home: '-190' });
  assert.equal(o.total.line, '220.5');
  assert.equal(o.open, null);
  assert.equal(oddsFromEspn([]), null);
  assert.equal(oddsFromEspn([{ provider: { name: 'x' } }]), null);
});

test('summary odds come from pickcenter; merge keeps DraftKings numbers', () => {
  const g = normalizeSummary(fx.nflSummary, 'nfl');
  assert.equal(g.odds.provider, 'DraftKings');
  assert.deepEqual(g.odds.moneyline, { away: '-160', home: '+135' });
  const dk = matchDraftKings([g], normalizeDraftKings(fx.dkNfl)).get(g.id);
  const merged = mergeOdds(dk, g.odds);
  assert.equal(merged.source, 'draftkings');
  assert.deepEqual(merged.moneyline, { away: '-180', home: '+150' });
  assert.equal(merged.details, 'KC -3');
  assert.equal(mergeOdds(null, g.odds), g.odds);
  assert.equal(mergeOdds(null, null), null);
});
