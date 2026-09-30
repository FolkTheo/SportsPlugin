// Hand-built responses in the shape of ESPN's site API
// (site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard|summary).
// They cover the fields the extension reads for each sport and game state.

const logo = (league, abbr) => `https://a.espncdn.com/i/teamlogos/${league}/500/scoreboard/${abbr.toLowerCase()}.png`;

function team(league, id, abbr, location, name, color) {
  return {
    id: String(id),
    abbreviation: abbr,
    location,
    name,
    displayName: `${location} ${name}`,
    shortDisplayName: name,
    color,
    logo: logo(league, abbr),
  };
}

function competitor(t, homeAway, { score, record, linescores, winner, rank, leaders, ...rest } = {}) {
  return {
    id: t.id,
    homeAway,
    team: t,
    score: score ?? '0',
    winner,
    records: record ? [{ name: 'overall', type: 'total', summary: record }] : [],
    linescores: (linescores || []).map((value) => ({ value })),
    ...(rank ? { curatedRank: { current: rank } } : {}),
    ...(leaders ? { leaders } : {}),
    ...rest,
  };
}

function status(state, { detail, period = 0, clock = '0:00', name } = {}) {
  return {
    clock: 0,
    displayClock: clock,
    period,
    type: {
      name: name || { pre: 'STATUS_SCHEDULED', in: 'STATUS_IN_PROGRESS', post: 'STATUS_FINAL' }[state],
      state,
      completed: state === 'post',
      description: { pre: 'Scheduled', in: 'In Progress', post: 'Final' }[state],
      detail,
      shortDetail: detail,
    },
  };
}

function event(id, away, home, st, extra = {}) {
  const { date = '2026-09-28T17:00Z', situation, leaders, broadcasts, odds, notes, venue, series } = extra;
  return {
    id: String(id),
    date,
    name: `${away.team.displayName} at ${home.team.displayName}`,
    shortName: `${away.team.abbreviation} @ ${home.team.abbreviation}`,
    competitions: [
      {
        id: String(id),
        date,
        venue: { fullName: venue || 'Stadium' },
        competitors: [home, away],
        status: st,
        ...(situation ? { situation } : {}),
        ...(leaders ? { leaders } : {}),
        broadcasts: broadcasts ? [{ market: 'national', names: broadcasts }] : [],
        ...(odds ? { odds } : {}),
        notes: notes || [],
        ...(series ? { series } : {}),
      },
    ],
    status: st,
  };
}

const athlete = (id, displayName, shortName, pos, jersey = '1') => ({
  id: String(id),
  displayName,
  shortName,
  jersey,
  position: { abbreviation: pos },
  headshot: { href: `https://a.espncdn.com/i/headshots/${id}.png` },
});

// ---------------------------------------------------------------- NFL

export const NFL = {
  KC: team('nfl', 12, 'KC', 'Kansas City', 'Chiefs', 'e31837'),
  BUF: team('nfl', 2, 'BUF', 'Buffalo', 'Bills', '00338d'),
  PHI: team('nfl', 21, 'PHI', 'Philadelphia', 'Eagles', '06424d'),
  DAL: team('nfl', 6, 'DAL', 'Dallas', 'Cowboys', '002a5c'),
  SF: team('nfl', 25, 'SF', 'San Francisco', '49ers', 'aa0000'),
  SEA: team('nfl', 26, 'SEA', 'Seattle', 'Seahawks', '002a5c'),
};

const footballCalendar = [
  {
    label: 'Preseason',
    value: '1',
    entries: [{ label: 'Hall of Fame Weekend', value: '1', detail: 'Jul 31-Aug 6' }],
  },
  {
    label: 'Regular Season',
    value: '2',
    entries: Array.from({ length: 18 }, (_, i) => ({
      label: `Week ${i + 1}`,
      value: String(i + 1),
      detail: i === 3 ? 'Sep 24-30' : i === 4 ? 'Oct 1-7' : '',
    })),
  },
  { label: 'Postseason', value: '3', entries: [{ label: 'Wild Card', value: '1', detail: 'Jan 9-15' }] },
];

export const nflScoreboard = {
  leagues: [{ abbreviation: 'NFL', season: { year: 2026, type: { type: 2 } }, calendar: footballCalendar }],
  season: { type: 2, year: 2026 },
  week: { number: 4 },
  events: [
    event(
      '401772001',
      competitor(NFL.KC, 'away', { score: '24', record: '3-0', linescores: [7, 10, 7] }),
      competitor(NFL.BUF, 'home', { score: '20', record: '2-1', linescores: [3, 7, 10] }),
      status('in', { detail: '4:12 - 3rd', period: 3, clock: '4:12' }),
      {
        date: '2026-09-28T20:25Z',
        broadcasts: ['CBS'],
        situation: {
          down: 2,
          distance: 7,
          yardLine: 18,
          downDistanceText: '2nd & 7 at BUF 18',
          shortDownDistanceText: '2nd & 7',
          possessionText: 'BUF 18',
          isRedZone: true,
          possession: '12',
          lastPlay: { text: 'P.Mahomes pass short right to T.Kelce for 12 yards', probability: { homeWinPercentage: 0.382 } },
        },
        leaders: [
          {
            name: 'passingYards',
            displayName: 'Passing Leader',
            shortDisplayName: 'PASS',
            leaders: [{ displayValue: '19/27, 241 YDS, 2 TD', athlete: athlete(3139477, 'Patrick Mahomes', 'P. Mahomes', 'QB'), team: { id: '12' } }],
          },
          {
            name: 'rushingYards',
            displayName: 'Rushing Leader',
            shortDisplayName: 'RUSH',
            leaders: [{ displayValue: '14 CAR, 77 YDS', athlete: athlete(4379399, 'James Cook', 'J. Cook', 'RB'), team: { id: '2' } }],
          },
          {
            name: 'receivingYards',
            displayName: 'Receiving Leader',
            shortDisplayName: 'REC',
            leaders: [{ displayValue: '7 REC, 92 YDS', athlete: athlete(15847, 'Travis Kelce', 'T. Kelce', 'TE'), team: { id: '12' } }],
          },
        ],
      },
    ),
    event(
      '401772002',
      competitor(NFL.DAL, 'away', { score: '17', record: '1-3', linescores: [0, 7, 3, 7], winner: false }),
      competitor(NFL.PHI, 'home', { score: '31', record: '4-0', linescores: [7, 14, 3, 7], winner: true }),
      status('post', { detail: 'Final', period: 4 }),
      { date: '2026-09-28T17:00Z', broadcasts: ['FOX'] },
    ),
    event(
      '401772003',
      competitor(NFL.SF, 'away', { score: '0', record: '2-1' }),
      competitor(NFL.SEA, 'home', { score: '0', record: '2-1' }),
      status('pre', { detail: '9/29 - 8:15 PM EDT' }),
      {
        date: '2026-09-30T00:15Z',
        broadcasts: ['ESPN', 'ABC'],
        odds: [{ details: 'SF -2.5', overUnder: 44.5 }],
      },
    ),
  ],
};

export const nflSummary = {
  header: {
    id: '401772001',
    competitions: [
      {
        id: '401772001',
        date: '2026-09-28T20:25Z',
        competitors: [
          {
            id: '2',
            homeAway: 'home',
            score: '20',
            team: { ...NFL.BUF, logo: undefined, logos: [{ href: logo('nfl', 'BUF') }] },
            record: [{ type: 'total', summary: '2-1' }],
            linescores: [{ displayValue: '3' }, { displayValue: '7' }, { displayValue: '10' }],
          },
          {
            id: '12',
            homeAway: 'away',
            score: '24',
            possession: true,
            team: { ...NFL.KC, logo: undefined, logos: [{ href: logo('nfl', 'KC') }] },
            record: [{ type: 'total', summary: '3-0' }],
            linescores: [{ displayValue: '7' }, { displayValue: '10' }, { displayValue: '7' }],
          },
        ],
        status: status('in', { detail: '4:12 - 3rd', period: 3, clock: '4:12' }),
        broadcasts: [{ media: { shortName: 'CBS' } }],
      },
    ],
  },
  situation: {
    downDistanceText: '2nd & 7 at BUF 18',
    shortDownDistanceText: '2nd & 7',
    isRedZone: true,
    possession: '12',
    lastPlay: { text: 'P.Mahomes pass short right to T.Kelce for 12 yards' },
  },
  boxscore: {
    teams: [
      {
        team: NFL.KC,
        homeAway: 'away',
        statistics: [
          { name: 'firstDowns', displayValue: '19', label: '1st Downs' },
          { name: 'totalYards', displayValue: '338', label: 'Total Yards' },
          { name: 'netPassingYards', displayValue: '229', label: 'Passing' },
          { name: 'rushingYards', displayValue: '109', label: 'Rushing' },
          { name: 'turnovers', displayValue: '0', label: 'Turnovers' },
          { name: 'possessionTime', displayValue: '24:10', label: 'Possession' },
        ],
      },
      {
        team: NFL.BUF,
        homeAway: 'home',
        statistics: [
          { name: 'firstDowns', displayValue: '15', label: '1st Downs' },
          { name: 'totalYards', displayValue: '301', label: 'Total Yards' },
          { name: 'netPassingYards', displayValue: '188', label: 'Passing' },
          { name: 'rushingYards', displayValue: '113', label: 'Rushing' },
          { name: 'turnovers', displayValue: '1', label: 'Turnovers' },
          { name: 'possessionTime', displayValue: '16:38', label: 'Possession' },
        ],
      },
    ],
    players: [
      {
        team: NFL.KC,
        statistics: [
          {
            name: 'passing',
            text: 'Kansas City Passing',
            labels: ['C/ATT', 'YDS', 'AVG', 'TD', 'INT', 'SACKS', 'QBR', 'RTG'],
            descriptions: ['Completions/Attempts', 'Passing Yards', 'Yards Per Pass', 'Touchdowns', 'Interceptions', 'Sacks-Yards Lost', 'QBR', 'Passer Rating'],
            athletes: [{ athlete: athlete(3139477, 'Patrick Mahomes', 'P. Mahomes', 'QB', '15'), stats: ['19/27', '241', '8.9', '2', '0', '1-6', '78.1', '124.3'] }],
            totals: ['19/27', '235', '8.7', '2', '0', '1-6', '--', '124.3'],
          },
          {
            name: 'rushing',
            text: 'Kansas City Rushing',
            labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'],
            athletes: [
              { athlete: athlete(4361529, 'Isiah Pacheco', 'I. Pacheco', 'RB', '10'), stats: ['13', '71', '5.5', '1', '19'] },
              { athlete: athlete(3139477, 'Patrick Mahomes', 'P. Mahomes', 'QB', '15'), stats: ['4', '38', '9.5', '0', '14'] },
            ],
            totals: ['17', '109', '6.4', '1', '19'],
          },
          {
            name: 'receiving',
            text: 'Kansas City Receiving',
            labels: ['REC', 'YDS', 'AVG', 'TD', 'LONG', 'TGTS'],
            athletes: [
              { athlete: athlete(15847, 'Travis Kelce', 'T. Kelce', 'TE', '87'), stats: ['7', '92', '13.1', '1', '28', '9'] },
              { athlete: athlete(4426515, 'Rashee Rice', 'R. Rice', 'WR', '4'), stats: ['6', '81', '13.5', '1', '33', '8'] },
            ],
            totals: ['19', '241', '12.7', '2', '33', '27'],
          },
        ],
      },
      {
        team: NFL.BUF,
        statistics: [
          {
            name: 'passing',
            text: 'Buffalo Passing',
            labels: ['C/ATT', 'YDS', 'AVG', 'TD', 'INT', 'SACKS', 'QBR', 'RTG'],
            athletes: [{ athlete: athlete(3918298, 'Josh Allen', 'J. Allen', 'QB', '17'), stats: ['16/24', '196', '8.2', '1', '1', '1-8', '55.0', '92.4'] }],
            totals: ['16/24', '188', '7.8', '1', '1', '1-8', '--', '92.4'],
          },
        ],
      },
    ],
  },
  drives: {
    previous: [
      {
        id: 'd1',
        team: NFL.BUF,
        plays: [{ id: 'p1', text: 'J.Allen pass deep left to K.Coleman for 38 yards, TOUCHDOWN.', period: { number: 3 }, clock: { displayValue: '9:02' }, scoringPlay: true, awayScore: 17, homeScore: 20 }],
      },
    ],
    current: {
      id: 'd2',
      team: NFL.KC,
      plays: [
        { id: 'p2', text: 'I.Pacheco left guard for 6 yards', period: { number: 3 }, clock: { displayValue: '5:01' } },
        { id: 'p3', text: 'P.Mahomes pass short right to T.Kelce for 12 yards', period: { number: 3 }, clock: { displayValue: '4:12' } },
      ],
    },
  },
  scoringPlays: [
    { text: 'Isiah Pacheco 3 Yd Run (Harrison Butker Kick)', scoringType: { abbreviation: 'TD' }, period: { number: 1 }, clock: { displayValue: '8:41' }, team: NFL.KC, awayScore: 7, homeScore: 0 },
    { text: 'Tyler Bass 45 Yd Field Goal', scoringType: { abbreviation: 'FG' }, period: { number: 1 }, clock: { displayValue: '2:10' }, team: NFL.BUF, awayScore: 7, homeScore: 3 },
    { text: 'Keon Coleman 38 Yd pass from Josh Allen (Tyler Bass Kick)', scoringType: { abbreviation: 'TD' }, period: { number: 3 }, clock: { displayValue: '9:02' }, team: NFL.BUF, awayScore: 24, homeScore: 20 },
  ],
  winprobability: [{ homeWinPercentage: 0.45 }, { homeWinPercentage: 0.382 }],
  leaders: [
    {
      team: NFL.KC,
      leaders: [{ name: 'passingYards', displayName: 'Passing Yards', leaders: [{ displayValue: '19/27, 241 YDS, 2 TD', athlete: athlete(3139477, 'Patrick Mahomes', 'P. Mahomes', 'QB') }] }],
    },
    {
      team: NFL.BUF,
      leaders: [{ name: 'passingYards', displayName: 'Passing Yards', leaders: [{ displayValue: '16/24, 196 YDS, 1 TD, 1 INT', athlete: athlete(3918298, 'Josh Allen', 'J. Allen', 'QB') }] }],
    },
  ],
  gameInfo: { venue: { fullName: 'Highmark Stadium', address: { city: 'Orchard Park', state: 'NY' } }, attendance: 70241 },
};

// ---------------------------------------------------------------- NBA

export const NBA = {
  BOS: team('nba', 2, 'BOS', 'Boston', 'Celtics', '008348'),
  NY: team('nba', 18, 'NY', 'New York', 'Knicks', '1d428a'),
  LAL: team('nba', 13, 'LAL', 'Los Angeles', 'Lakers', '552583'),
  DEN: team('nba', 7, 'DEN', 'Denver', 'Nuggets', '0e2240'),
};

const nbaLeader = (id, name, short, pos, value, category = 'points', abbr = 'PTS') => ({
  name: category,
  displayName: category === 'points' ? 'Points' : 'Rebounds',
  shortDisplayName: abbr,
  abbreviation: abbr,
  leaders: [{ displayValue: value, athlete: athlete(id, name, short, pos) }],
});

export const nbaScoreboard = {
  leagues: [{ abbreviation: 'NBA', calendar: [] }],
  events: [
    event(
      '401810001',
      competitor(NBA.NY, 'away', { score: '88', record: '2-1', linescores: [28, 30, 30], leaders: [nbaLeader(3934672, 'Jalen Brunson', 'J. Brunson', 'G', '27')] }),
      competitor(NBA.BOS, 'home', { score: '91', record: '3-0', linescores: [25, 33, 33], leaders: [nbaLeader(4065648, 'Jayson Tatum', 'J. Tatum', 'F', '24')] }),
      status('in', { detail: '2:31 - 3rd', period: 3, clock: '2:31' }),
      { broadcasts: ['TNT'] },
    ),
    event(
      '401810002',
      competitor(NBA.DEN, 'away', { score: '0', record: '1-2' }),
      competitor(NBA.LAL, 'home', { score: '0', record: '2-1' }),
      status('pre', { detail: '10:30 PM EDT' }),
      { date: '2026-09-29T02:30Z', broadcasts: ['ESPN'], odds: [{ details: 'DEN -3.5', overUnder: 229.5 }] },
    ),
  ],
};

const nbaLabels = ['MIN', 'FG', '3PT', 'FT', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', '+/-', 'PTS'];

export const nbaSummary = {
  header: {
    id: '401810001',
    competitions: [
      {
        competitors: [
          { homeAway: 'home', score: '91', team: NBA.BOS, record: [{ type: 'total', summary: '3-0' }], linescores: [{ displayValue: '25' }, { displayValue: '33' }, { displayValue: '33' }] },
          { homeAway: 'away', score: '88', team: NBA.NY, record: [{ type: 'total', summary: '2-1' }], linescores: [{ displayValue: '28' }, { displayValue: '30' }, { displayValue: '30' }] },
        ],
        status: status('in', { detail: '2:31 - 3rd', period: 3, clock: '2:31' }),
      },
    ],
  },
  boxscore: {
    teams: [
      {
        team: NBA.NY,
        statistics: [
          { name: 'fieldGoalsMade-fieldGoalsAttempted', displayValue: '33-71', label: 'FG' },
          { name: 'fieldGoalPct', displayValue: '46.5', label: 'Field Goal %' },
          { name: 'totalRebounds', displayValue: '34', label: 'Rebounds' },
          { name: 'assists', displayValue: '19', label: 'Assists' },
        ],
      },
      {
        team: NBA.BOS,
        statistics: [
          { name: 'fieldGoalsMade-fieldGoalsAttempted', displayValue: '34-70', label: 'FG' },
          { name: 'fieldGoalPct', displayValue: '48.6', label: 'Field Goal %' },
          { name: 'totalRebounds', displayValue: '37', label: 'Rebounds' },
          { name: 'assists', displayValue: '22', label: 'Assists' },
        ],
      },
    ],
    players: [
      {
        team: NBA.NY,
        statistics: [
          {
            names: nbaLabels,
            labels: nbaLabels,
            athletes: [
              { starter: true, athlete: athlete(3934672, 'Jalen Brunson', 'J. Brunson', 'G', '11'), stats: ['30', '10-19', '3-7', '4-4', '0', '3', '3', '6', '1', '0', '2', '2', '-3', '27'] },
              { starter: true, athlete: athlete(3062679, 'Josh Hart', 'J. Hart', 'G', '3'), stats: ['29', '4-8', '1-3', '0-0', '3', '7', '10', '4', '2', '0', '1', '3', '+1', '9'] },
              { starter: false, athlete: athlete(4351851, 'Miles McBride', 'M. McBride', 'G', '2'), stats: ['14', '2-5', '2-4', '0-0', '0', '1', '1', '1', '0', '0', '0', '1', '-4', '6'] },
              { starter: false, didNotPlay: true, reason: 'COACH\'S DECISION', athlete: athlete(4433218, 'Tyler Kolek', 'T. Kolek', 'G', '13'), stats: [] },
            ],
            totals: ['', '33-71', '10-27', '12-15', '8', '26', '34', '19', '6', '3', '9', '14', '', '88'],
          },
        ],
      },
      {
        team: NBA.BOS,
        statistics: [
          {
            labels: nbaLabels,
            athletes: [
              { starter: true, athlete: athlete(4065648, 'Jayson Tatum', 'J. Tatum', 'F', '0'), stats: ['31', '8-18', '3-8', '5-6', '1', '8', '9', '5', '1', '1', '3', '2', '+4', '24'] },
            ],
            totals: ['', '34-70', '12-35', '11-13', '9', '28', '37', '22', '5', '4', '10', '15', '', '91'],
          },
        ],
      },
    ],
  },
  plays: [
    { id: '1', text: 'Jalen Brunson makes 18-foot pullup jump shot', period: { number: 3, displayValue: '3rd Quarter' }, clock: { displayValue: '2:52' }, scoringPlay: true, awayScore: 88, homeScore: 89, team: { id: '18' } },
    { id: '2', text: 'Jayson Tatum makes driving layup', period: { number: 3, displayValue: '3rd Quarter' }, clock: { displayValue: '2:31' }, scoringPlay: true, awayScore: 88, homeScore: 91, team: { id: '2' } },
  ],
  winprobability: [{ homeWinPercentage: 0.61 }],
  gameInfo: { venue: { fullName: 'TD Garden', address: { city: 'Boston', state: 'MA' } } },
};

// ---------------------------------------------------------------- MLB

export const MLB = {
  NYY: team('mlb', 10, 'NYY', 'New York', 'Yankees', '132448'),
  LAD: team('mlb', 19, 'LAD', 'Los Angeles', 'Dodgers', '005a9c'),
  HOU: team('mlb', 18, 'HOU', 'Houston', 'Astros', '002d62'),
  SEA: team('mlb', 12, 'SEA', 'Seattle', 'Mariners', '0c2c56'),
};

export const mlbScoreboard = {
  leagues: [{ abbreviation: 'MLB', calendar: [] }],
  events: [
    event(
      '401700001',
      competitor(MLB.LAD, 'away', { score: '3', record: '93-66', linescores: [0, 1, 0, 2, 0, 0], hits: 7, errors: 0 }),
      competitor(MLB.NYY, 'home', { score: '4', record: '91-68', linescores: [2, 0, 0, 0, 2, 0], hits: 8, errors: 1 }),
      status('in', { detail: 'Top 7th', period: 7 }),
      {
        broadcasts: ['FOX'],
        series: { summary: 'NYY leads series 1-0' },
        situation: {
          balls: 2,
          strikes: 1,
          outs: 1,
          onFirst: true,
          onSecond: false,
          onThird: true,
          batter: { athlete: athlete(3033, 'Shohei Ohtani', 'S. Ohtani', 'DH') },
          pitcher: { athlete: athlete(4000, 'Gerrit Cole', 'G. Cole', 'SP') },
          lastPlay: { text: 'Betts singled to left, Freeman to third.' },
        },
      },
    ),
    event(
      '401700002',
      {
        ...competitor(MLB.SEA, 'away', { score: '0', record: '85-74' }),
        probables: [{ athlete: athlete(5000, 'Logan Gilbert', 'L. Gilbert', 'SP'), record: '12-7, 3.21 ERA' }],
      },
      {
        ...competitor(MLB.HOU, 'home', { score: '0', record: '88-71' }),
        probables: [{ athlete: athlete(5001, 'Framber Valdez', 'F. Valdez', 'SP'), record: '14-8, 3.05 ERA' }],
      },
      status('pre', { detail: '8:10 PM EDT' }),
      { date: '2026-09-29T00:10Z' },
    ),
  ],
};

export const mlbSummary = {
  header: {
    id: '401700001',
    competitions: [
      {
        competitors: [
          { homeAway: 'home', score: '4', hits: 8, errors: 1, team: MLB.NYY, linescores: [2, 0, 0, 0, 2, 0].map((v) => ({ displayValue: String(v) })) },
          { homeAway: 'away', score: '3', hits: 7, errors: 0, team: MLB.LAD, linescores: [0, 1, 0, 2, 0, 0].map((v) => ({ displayValue: String(v) })) },
        ],
        status: status('in', { detail: 'Top 7th', period: 7 }),
        series: { summary: 'NYY leads series 1-0' },
      },
    ],
  },
  situation: {
    balls: 2,
    strikes: 1,
    outs: 1,
    onFirst: true,
    onThird: true,
    batter: { athlete: athlete(3033, 'Shohei Ohtani', 'S. Ohtani', 'DH') },
    pitcher: { athlete: athlete(4000, 'Gerrit Cole', 'G. Cole', 'SP') },
  },
  boxscore: {
    teams: [
      {
        team: MLB.LAD,
        statistics: [
          { name: 'batting', displayName: 'Batting', stats: [{ name: 'hits', displayValue: '7', abbreviation: 'H', displayName: 'Hits' }, { name: 'homeRuns', displayValue: '1', abbreviation: 'HR', displayName: 'Home Runs' }] },
          { name: 'pitching', displayName: 'Pitching', stats: [{ name: 'strikeouts', displayValue: '6', abbreviation: 'K', displayName: 'Strikeouts' }] },
        ],
      },
      {
        team: MLB.NYY,
        statistics: [
          { name: 'batting', displayName: 'Batting', stats: [{ name: 'hits', displayValue: '8', abbreviation: 'H', displayName: 'Hits' }, { name: 'homeRuns', displayValue: '2', abbreviation: 'HR', displayName: 'Home Runs' }] },
          { name: 'pitching', displayName: 'Pitching', stats: [{ name: 'strikeouts', displayValue: '9', abbreviation: 'K', displayName: 'Strikeouts' }] },
        ],
      },
    ],
    players: [
      {
        team: MLB.LAD,
        statistics: [
          {
            type: 'batting',
            labels: ['H-AB', 'AB', 'R', 'H', 'RBI', 'HR', 'BB', 'K', 'AVG'],
            athletes: [
              { starter: true, athlete: athlete(3033, 'Shohei Ohtani', 'S. Ohtani', 'DH', '17'), stats: ['2-3', '3', '1', '2', '1', '1', '0', '1', '.301'] },
              { starter: true, athlete: athlete(3034, 'Mookie Betts', 'M. Betts', 'SS', '50'), stats: ['1-3', '3', '0', '1', '0', '0', '1', '0', '.289'] },
            ],
            totals: ['7-24', '24', '3', '7', '3', '1', '2', '6', ''],
          },
          {
            type: 'pitching',
            labels: ['IP', 'H', 'R', 'ER', 'BB', 'K', 'HR', 'PC-ST', 'ERA'],
            athletes: [{ starter: true, athlete: athlete(3035, 'Yoshinobu Yamamoto', 'Y. Yamamoto', 'SP', '18'), stats: ['5.0', '6', '4', '4', '1', '7', '2', '88-58', '3.05'] }],
            totals: ['6.0', '8', '4', '4', '2', '9', '2', '', ''],
          },
        ],
      },
      {
        team: MLB.NYY,
        statistics: [
          {
            type: 'batting',
            labels: ['H-AB', 'AB', 'R', 'H', 'RBI', 'HR', 'BB', 'K', 'AVG'],
            athletes: [{ starter: true, athlete: athlete(3036, 'Aaron Judge', 'A. Judge', 'RF', '99'), stats: ['2-3', '3', '2', '2', '3', '2', '1', '1', '.322'] }],
            totals: ['8-25', '25', '4', '8', '4', '2', '3', '6', ''],
          },
        ],
      },
    ],
  },
  plays: [
    { id: '1', text: 'Judge homered to left center (402 feet), Soto scored.', period: { number: 5, displayValue: 'Bottom 5th' }, scoringPlay: true, awayScore: 3, homeScore: 4, team: { id: '10' } },
    { id: '2', text: 'Betts singled to left, Freeman to third.', period: { number: 7, displayValue: 'Top 7th' }, team: { id: '19' } },
  ],
  gameInfo: { venue: { fullName: 'Yankee Stadium', address: { city: 'Bronx', state: 'NY' } }, attendance: 47102 },
};

// ---------------------------------------------------------------- NHL

export const NHL = {
  TOR: team('nhl', 21, 'TOR', 'Toronto', 'Maple Leafs', '00205b'),
  MTL: team('nhl', 10, 'MTL', 'Montreal', 'Canadiens', 'c41230'),
};

export const nhlScoreboard = {
  leagues: [{ abbreviation: 'NHL', calendar: [] }],
  events: [
    event(
      '401800001',
      competitor(NHL.MTL, 'away', { score: '2', record: '1-0-0', linescores: [1, 1, 0, 0], winner: false }),
      competitor(NHL.TOR, 'home', { score: '3', record: '0-0-1', linescores: [0, 2, 0, 1], winner: true }),
      status('post', { detail: 'Final/OT', period: 4 }),
      { broadcasts: ['SN'] },
    ),
  ],
};

export const nhlSummary = {
  header: {
    id: '401800001',
    competitions: [
      {
        competitors: [
          { homeAway: 'home', score: '3', winner: true, team: NHL.TOR, linescores: [0, 2, 0, 1].map((v) => ({ displayValue: String(v) })) },
          { homeAway: 'away', score: '2', winner: false, team: NHL.MTL, linescores: [1, 1, 0, 0].map((v) => ({ displayValue: String(v) })) },
        ],
        status: status('post', { detail: 'Final/OT', period: 4 }),
      },
    ],
  },
  boxscore: {
    teams: [
      { team: NHL.MTL, statistics: [{ name: 'shotsTotal', displayValue: '28', label: 'Shots' }, { name: 'powerPlayPct', displayValue: '50.0', label: 'Power Play %' }] },
      { team: NHL.TOR, statistics: [{ name: 'shotsTotal', displayValue: '34', label: 'Shots' }, { name: 'powerPlayPct', displayValue: '25.0', label: 'Power Play %' }] },
    ],
    players: [
      {
        team: NHL.TOR,
        statistics: [
          { name: 'forwards', text: 'Forwards', labels: ['G', 'A', '+/-', 'S', 'TOI'], athletes: [{ athlete: athlete(6001, 'Auston Matthews', 'A. Matthews', 'C', '34'), stats: ['2', '0', '+1', '7', '21:40'] }] },
          { name: 'goalies', text: 'Goalies', labels: ['SA', 'GA', 'SV', 'SV%', 'TOI'], athletes: [{ athlete: athlete(6002, 'Joseph Woll', 'J. Woll', 'G', '60'), stats: ['28', '2', '26', '.929', '62:14'] }] },
        ],
      },
    ],
  },
  scoringPlays: [
    { text: 'Cole Caufield (1) Wrist Shot', period: { number: 1 }, clock: { displayValue: '11:02' }, team: NHL.MTL, awayScore: 1, homeScore: 0 },
    { text: 'Auston Matthews (1) Snap Shot', period: { number: 4 }, clock: { displayValue: '2:14' }, team: NHL.TOR, awayScore: 2, homeScore: 3 },
  ],
  gameInfo: { venue: { fullName: 'Scotiabank Arena' } },
};

// ---------------------------------------------------------------- CFB

export const CFB = {
  UGA: team('college-football', 61, 'UGA', 'Georgia', 'Bulldogs', 'ba0c2f'),
  ALA: team('college-football', 333, 'ALA', 'Alabama', 'Crimson Tide', '9e1b32'),
  OSU: team('college-football', 194, 'OSU', 'Ohio State', 'Buckeyes', 'ce1141'),
  PUR: team('college-football', 2509, 'PUR', 'Purdue', 'Boilermakers', 'b89d29'),
  KSU: team('college-football', 2306, 'KSU', 'Kansas State', 'Wildcats', '3c0969'),
  BAY: team('college-football', 239, 'BAY', 'Baylor', 'Bears', '004834'),
};

export const cfbScoreboard = {
  leagues: [
    {
      abbreviation: 'NCAAF',
      season: { year: 2026, type: { type: 2 } },
      calendar: [{ label: 'Regular Season', value: '2', entries: Array.from({ length: 15 }, (_, i) => ({ label: `Week ${i + 1}`, value: String(i + 1), detail: i === 4 ? 'Sep 23-29' : '' })) }],
    },
  ],
  season: { type: 2, year: 2026 },
  week: { number: 5 },
  events: [
    event(
      '401760001',
      competitor(CFB.ALA, 'away', { score: '21', record: '4-0', rank: 4, linescores: [7, 14] }),
      competitor(CFB.UGA, 'home', { score: '17', record: '4-0', rank: 2, linescores: [10, 7] }),
      status('in', { detail: 'Halftime', period: 2, clock: '0:00', name: 'STATUS_HALFTIME' }),
      { broadcasts: ['CBS'], notes: [{ headline: 'SEC Game of the Week' }] },
    ),
    event(
      '401760002',
      competitor(CFB.PUR, 'away', { score: '10', record: '1-3', curatedRank: { current: 99 } }),
      competitor(CFB.OSU, 'home', { score: '45', record: '4-0', rank: 1, winner: true }),
      status('post', { detail: 'Final' }),
    ),
    event(
      '401760003',
      competitor(CFB.BAY, 'away', { score: '0', record: '2-2', curatedRank: { current: 99 } }),
      competitor(CFB.KSU, 'home', { score: '0', record: '3-1', curatedRank: { current: 99 } }),
      status('pre', { detail: '7:30 PM EDT' }),
      { date: '2026-09-28T23:30Z', broadcasts: ['FS1'] },
    ),
  ],
};

export const cfbSummary = {
  header: {
    id: '401760001',
    competitions: [
      {
        competitors: [
          { homeAway: 'home', score: '17', rank: 2, team: CFB.UGA, linescores: [{ displayValue: '10' }, { displayValue: '7' }] },
          { homeAway: 'away', score: '21', rank: 4, team: CFB.ALA, linescores: [{ displayValue: '7' }, { displayValue: '14' }] },
        ],
        status: status('in', { detail: 'Halftime', period: 2, name: 'STATUS_HALFTIME' }),
        notes: [{ headline: 'SEC Game of the Week' }],
      },
    ],
  },
  boxscore: { teams: [], players: [] },
  predictor: { homeTeam: { gameProjection: '55.2' } },
  gameInfo: { venue: { fullName: 'Sanford Stadium', address: { city: 'Athens', state: 'GA' } } },
};

// ---------------------------------------------------------------- routing helper

export const FIXTURES = {
  'football/nfl': { scoreboard: nflScoreboard, summary: nflSummary },
  'basketball/nba': { scoreboard: nbaScoreboard, summary: nbaSummary },
  'baseball/mlb': { scoreboard: mlbScoreboard, summary: mlbSummary },
  'hockey/nhl': { scoreboard: nhlScoreboard, summary: nhlSummary },
  'football/college-football': { scoreboard: cfbScoreboard, summary: cfbSummary },
};

// Resolve an ESPN API URL to a fixture body (or null).
export function fixtureFor(url) {
  const m = /\/sports\/([^/]+\/[^/]+)\/(scoreboard|summary)/.exec(url);
  if (!m) return null;
  return FIXTURES[m[1]]?.[m[2]] ?? null;
}
